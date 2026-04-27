/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Guardrail Write Scanner — before_message_write hook (UNIVERSAL)
 *
 * Scans ALL messages before they are written to the conversation transcript
 * (the JSONL file that the LLM reads from). This is the universal guardrail
 * layer — it fires for EVERY message regardless of source:
 *   - Tool results (shell output, file content, web fetches, DB queries, etc.)
 *   - User messages
 *   - Assistant messages
 *   - System messages
 *
 * Since before_message_write is a BLOCKING hook that fires before the message
 * enters the conversation, modifying content here prevents the LLM from ever
 * seeing the original malicious content on subsequent turns.
 *
 * Return values (OpenClaw 2026.4.x before_message_write contract):
 *   { message: <newMessage> } → replace the persisted message (redact / rewrite)
 *   { block: true }           → drop the message entirely (prevent write)
 *   undefined                 → pass through unchanged
 *
 * Fail-open: errors never block or corrupt messages.
 */

import { GuardrailScanner, ConfigStore, GuardrailConfig } from './index.js';
import { logger } from '../../shared/Logger.js';
import { DecisionLog } from './storage/DecisionLog.js';
import { detectRoleImpersonation, neutralizeImpersonation } from './guards/role-impersonation.js';
import { detectAgentInterrogation, neutralizeInterrogation } from './guards/agent-interrogation.js';
import { registerCanary, detectCanaries } from './guards/canary-tracker.js';
import { checkContentModeration, getOverallSeverity } from './guards/content-moderation.js';
import { consumeModerationResult } from './ModerationGuardHook.js';
import { MessageWriteContext, MessageWriteResult, LifecycleContext } from '../../types.js';

/** Internal shape matching `MessageWriteContext.message` for content rewrites. */
type MessageShape = { role?: string; content?: unknown; [key: string]: unknown };

/**
 * Rebuild a message with replaced text, preserving the original content shape.
 * - If original content was an array (e.g. [{type:'text', text:'...'}]), return a single-text-block array
 * - If original content was a string (or anything else), return a plain string
 */
function replaceMessageContent(
  original: MessageShape | undefined,
  newText: string,
  fallbackRole = 'user'
): MessageShape {
  const base: MessageShape = { ...(original ?? {}) };
  if (!base.role) base.role = fallbackRole;
  if (Array.isArray(original?.content)) {
    base.content = [{ type: 'text', text: newText }];
  } else {
    base.content = newText;
  }
  return base;
}

// ── Scanner factory ────────────────────────────────────────────────
// Accepts an optional `configOverride` so a per-instance
// `GuardrailMiddleware` can supply its own merged config (defaults < inline
// < disk + updateConfig() patches). When omitted, falls back to the static
// `ConfigStore.getCached()` — backward-compatible for direct programmatic
// consumers of `createWriteScannerHook()`.

function getScanner(
  configOverride?: GuardrailConfig
): { scanner: GuardrailScanner; config: GuardrailConfig } | null {
  try {
    const config = configOverride ?? ConfigStore.getCached();
    return { scanner: new GuardrailScanner(config), config };
  } catch (err) {
    logger.warn('[guardrail-write] Failed to load config — fail-open', { error: err });
    return null;
  }
}

// ── Content extraction ──────────────────────────────────────────

function extractContent(event: MessageWriteContext): string {
  // Direct string content
  if (typeof event.content === 'string') {
    return event.content;
  }

  // Message object — try to stringify
  if (event.message) {
    try {
      const msg = event.message as any;
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('\n');
      }
      return JSON.stringify(msg);
    } catch {
      return '';
    }
  }

  return '';
}

// ── Redaction ───────────────────────────────────────────────────

function redactContent(
  content: string,
  detections: { matchedContent?: string; category?: string }[]
): string {
  let text = content;
  for (const det of detections) {
    if (det.matchedContent) {
      const escaped = det.matchedContent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        text = text.replace(new RegExp(escaped, 'gi'), `[REDACTED:${det.category}]`);
      } catch {
        text = text.split(det.matchedContent).join(`[REDACTED:${det.category}]`);
      }
    }
  }
  return text;
}

// ── Main hook handler ───────────────────────────────────────────

/**
 * Create the before_message_write hook handler.
 *
 * Scans every message before it enters the conversation transcript.
 * This is the UNIVERSAL guardrail — covers all content regardless of source.
 * Signature matches OpenClaw's raw `(event, ctx)` dispatch; both args are
 * typed with shared `LifecycleContext`-derived shapes from `src/types.ts`.
 *
 * @param getConfig Optional config getter — `GuardrailMiddleware` passes
 *   `() => this.resolveConfig()` so the hook reads from per-instance config
 *   (which honors `initialize()` inline + `updateConfig()` patches). Free-
 *   function consumers omit this and fall back to `ConfigStore.getCached()`.
 */
export function createWriteScannerHook(
  getConfig?: () => GuardrailConfig
): (event: MessageWriteContext, ctx: LifecycleContext) => MessageWriteResult | undefined {
  let scanCount = 0;

  return (event, ctx): MessageWriteResult | undefined => {
    try {
      scanCount++;

      const fullContent = extractContent(event);
      if (!fullContent || fullContent.length === 0) return undefined;

      // For very large content (>512KB): scan head + tail instead of skipping.
      // Attackers pad the middle to push payloads past the size limit.
      // Head (512KB) catches front-loaded attacks; tail (128KB) catches appended payloads.
      const MAX_SCAN = 512_000;
      const TAIL_SCAN = 128_000;
      let content: string;

      if (fullContent.length > MAX_SCAN) {
        const head = fullContent.slice(0, MAX_SCAN);
        const tail = fullContent.slice(-TAIL_SCAN);
        content = head + '\n' + tail;
        logger.debug(
          `[guardrail-write] Chunked scan: ${fullContent.length} bytes → head(${MAX_SCAN}) + tail(${TAIL_SCAN})`
        );
      } else {
        content = fullContent;
      }

      // Load scanner — pass per-instance config via the optional getter.
      const loaded = getScanner(getConfig?.());
      if (!loaded) return undefined;

      const { scanner, config } = loaded;

      // ── L0: Moderation cache (result from async before_agent_start) ────
      // Only applied to user-role messages — the cache is populated from the
      // user's incoming prompt, so blocking makes sense only for that role.
      const msgRole =
        typeof event.role === 'string'
          ? event.role
          : typeof event.message?.role === 'string'
            ? event.message.role
            : undefined;

      if (msgRole === 'user' && ctx.sessionKey) {
        const cached = consumeModerationResult(ctx.sessionKey);
        if (cached && !config.dryRunMode) {
          // Severity-tiered rewrite: only rewrite prompts at or above the
          // configured threshold. Lower-severity flags are audited but left
          // intact — the LLM's own safety layer handles the refusal, and the
          // user's prompt bubble stays readable.
          const threshold = config.moderation?.rewriteThreshold ?? 'HIGH';
          const rank = { MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const;
          const shouldRewrite = rank[cached.severity] >= rank[threshold];

          if (shouldRewrite) {
            logger.info(
              `[guardrail-write] [source:moderation-cache] REWRITE | severity=${cached.severity} | threshold=${threshold} | ${cached.flagSummary}`,
              { sessionKey: ctx.sessionKey }
            );
            const blockedText = `[GUARDRAIL:openai-moderation-api] Content blocked — flagged categories: ${cached.flagSummary}`;
            return {
              message: replaceMessageContent(event.message, blockedText, msgRole),
            };
          }

          logger.info(
            `[guardrail-write] [source:moderation-cache] AUDIT-ONLY | severity=${cached.severity} < threshold=${threshold} | ${cached.flagSummary}`,
            { sessionKey: ctx.sessionKey }
          );
          // Fall through — continue with other guards; LLM handles refusal
        }
      }

      // ── L3 Guard: Canary / Leakback Detection ──────────────────
      // Check BEFORE all other guards — detect re-appearance of previously
      // redacted content. Re-redact immediately. This is always first because
      // it prevents the LLM from seeing content that was already blocked.
      const canaryMatches = detectCanaries(content);
      if (canaryMatches.length > 0 && !config.dryRunMode) {
        let redacted = fullContent;
        for (const cm of canaryMatches) {
          if (cm.matchedText) {
            const escaped = cm.matchedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            try {
              redacted = redacted.replace(
                new RegExp(escaped, 'gi'),
                `[REDACTED:canary:${cm.category}]`
              );
            } catch {
              redacted = redacted.split(cm.matchedText).join(`[REDACTED:canary:${cm.category}]`);
            }
          }
        }

        const canaryCategories = [...new Set(canaryMatches.map((c) => c.category))].join(', ');
        logger.info(
          `[guardrail-write] [source:canary-tracker] LEAKBACK #${scanCount} | ${canaryMatches.length} match(es) | categories=${canaryCategories}`,
          { sessionKey: ctx.sessionKey }
        );

        void DecisionLog.append({
          timestamp: new Date().toISOString(),
          module: 'before_message_write',
          method: 'canary',
          args: [{ contentLength: content.length, canaryCount: canaryMatches.length }],
          decision: 'BLOCKED',
          decisionTime: 0,
          reason: `guard:canary: ${canaryMatches.length} previously-redacted content(s) re-detected [${canaryCategories}]`,
          eventType: 'tool_blocked',
          tool: 'message_write',
          severity: 'HIGH',
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        });

        const warning = `[GUARDRAIL:canary-tracker] Canary leakback detected — ${canaryMatches.length} previously-redacted content(s) re-redacted`;
        return { message: replaceMessageContent(event.message, `${warning}\n\n${redacted}`) };
      }

      // ── L3 Guards: Run in PARALLEL ─────────────────────────────
      // Content moderation (ML-powered) and structural guards run concurrently.
      // Each covers a different threat surface:
      //   - content-moderation → violence, hate, sexual, self-harm, illicit
      //   - role-impersonation → ChatML injection, fake system markers
      //   - agent-interrogation → defense enumeration questions
      //   - rule-scanner → regex/prefix/heuristic pattern matching

      // before_message_write is synchronous in OpenClaw 2026.4.x+.
      // Pattern-based guards run synchronously. The moderation API (network I/O)
      // fires in the background for audit logging only — it cannot block here.
      const impersonation = detectRoleImpersonation(content);
      const interrogation = detectAgentInterrogation(content);
      const detections = scanner.scan(content);

      void checkContentModeration(content).then((moderationResult) => {
        if (!moderationResult.flagged) return;
        const flagSummary = moderationResult.flaggedCategories
          .map((c) => `${c.name}(${c.score.toFixed(3)})`)
          .join(', ');
        const severity = getOverallSeverity(moderationResult.flaggedCategories);
        logger.warn(
          `[guardrail-write] [source:openai-moderation-api] FLAGGED (post-write) #${scanCount} | severity=${severity} | ${flagSummary}`,
          { sessionKey: ctx.sessionKey }
        );
        void DecisionLog.append({
          timestamp: new Date().toISOString(),
          module: 'before_message_write',
          method: 'content-moderation',
          args: [{ contentLength: content.length, categories: flagSummary }],
          decision: 'ALLOWED',
          decisionTime: 0,
          reason: `guard:content-moderation(async): flagged [${flagSummary}] — hook is synchronous, result logged only`,
          eventType: 'tool_blocked',
          tool: 'message_write',
          severity: severity === 'CRITICAL' ? ('CATASTROPHIC' as any) : severity,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        });
        registerCanary(content.slice(0, 500), 'content-moderation');
      });

      // ── Handle: Role Impersonation (pattern-based) ─────────────
      if (impersonation.detected) {
        const hasCritical = impersonation.matches.some((m) => m.severity === 'CRITICAL');
        const hasHigh = impersonation.matches.some((m) => m.severity === 'HIGH');
        const matchNames = impersonation.matches.map((m) => m.name).join(', ');

        logger.info(
          `[guardrail-write] [source:role-impersonation] DETECTED #${scanCount} | ${impersonation.matches.length} match(es): ${matchNames}`,
          { sessionKey: ctx.sessionKey }
        );

        void DecisionLog.append({
          timestamp: new Date().toISOString(),
          module: 'before_message_write',
          method: 'role-impersonation',
          args: [{ contentLength: content.length, matches: matchNames }],
          decision: hasCritical && !config.dryRunMode ? 'BLOCKED' : 'ALLOWED',
          decisionTime: 0,
          reason: `guard:role-impersonation: ${matchNames}`,
          eventType: 'tool_blocked',
          tool: 'message_write',
          severity: hasCritical ? ('CATASTROPHIC' as any) : 'HIGH',
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        });

        if (!config.dryRunMode && (hasCritical || hasHigh)) {
          const neutralized = neutralizeImpersonation(fullContent, impersonation.matches);

          for (const m of impersonation.matches) {
            if (m.matchedText) {
              registerCanary(m.matchedText, 'role-impersonation');
            }
          }

          const warning = `[GUARDRAIL:role-impersonation] Neutralized ${impersonation.matches.length} pattern(s): ${matchNames}`;
          return { message: replaceMessageContent(event.message, `${warning}\n\n${neutralized}`) };
        }
      }

      // ── Handle: Agent Interrogation (pattern-based) ────────────
      if (interrogation.detected) {
        logger.info(
          `[guardrail-write] [source:agent-interrogation] DETECTED #${scanCount} | ${interrogation.questionCount} question(s) | severity=${interrogation.severity}`,
          { sessionKey: ctx.sessionKey }
        );

        void DecisionLog.append({
          timestamp: new Date().toISOString(),
          module: 'before_message_write',
          method: 'agent-interrogation',
          args: [{ contentLength: content.length, questionCount: interrogation.questionCount }],
          decision:
            !config.dryRunMode && interrogation.severity !== 'MEDIUM' ? 'BLOCKED' : 'ALLOWED',
          decisionTime: 0,
          reason: `guard:agent-interrogation: ${interrogation.questionCount} defense enumeration question(s) [${interrogation.severity}]`,
          eventType: 'tool_blocked',
          tool: 'message_write',
          severity: interrogation.severity === 'CRITICAL' ? ('CATASTROPHIC' as any) : 'HIGH',
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        });

        if (!config.dryRunMode) {
          const neutralized = neutralizeInterrogation(fullContent, interrogation.matchedQuestions);

          for (const q of interrogation.matchedQuestions) {
            registerCanary(q, 'defense-enumeration');
          }

          const warning = `[GUARDRAIL:agent-interrogation] Neutralized ${interrogation.questionCount} defense enumeration question(s)`;
          return { message: replaceMessageContent(event.message, `${warning}\n\n${neutralized}`) };
        }
      }

      // ── Handle: Main guardrail rule scan (regex/prefix/heuristic) ──
      //
      // Severity-driven posture (overrides per-rule `action` for the write
      // path so every HIGH leak gets sanitized and every CRITICAL leak blocks
      // the whole turn, regardless of how the rule was authored):
      //   CRITICAL → block the whole message (refusal placeholder)
      //   HIGH     → redact matched content inline, keep rest of the message
      //   MEDIUM/LOW → audit-only, pass through unchanged
      if (detections.length === 0) return undefined;

      const criticalDetections = detections.filter((d) => d.severity === 'CRITICAL');
      const highDetections = detections.filter((d) => d.severity === 'HIGH');
      const hasCritical = criticalDetections.length > 0;
      const hasHigh = highDetections.length > 0;

      const severities = [...new Set(detections.map((d) => d.severity))].join('/');
      const topRules = detections.slice(0, 5).map((d) => `${d.category}:${d.ruleName}`);

      if (!hasCritical && !hasHigh) {
        logger.info(
          `[guardrail-write] [source:rule-scanner] AUDIT #${scanCount} | severity=[${severities}] | detections=${detections.length}`,
          { detections: topRules, sessionKey: ctx.sessionKey }
        );
        return undefined;
      }

      const isDryRun = config.dryRunMode;
      const actionLabel = isDryRun ? 'DRY-RUN' : hasCritical ? 'BLOCK' : 'REDACT';

      logger.info(
        `[guardrail-write] [source:rule-scanner] ${actionLabel} #${scanCount} | severity=[${severities}] | detections=${detections.length}`,
        {
          detections: topRules,
          sessionKey: ctx.sessionKey,
        }
      );

      const reason = detections
        .slice(0, 3)
        .map((d) => `${d.category}:${d.ruleName} [${d.severity}]`)
        .join(', ');

      void DecisionLog.append({
        timestamp: new Date().toISOString(),
        module: 'before_message_write',
        method: 'write',
        args: [{ contentLength: content.length }],
        decision: hasCritical && !isDryRun ? 'BLOCKED' : 'ALLOWED',
        decisionTime: 0,
        reason: `guardrail-write: ${reason}`,
        eventType: hasCritical ? 'tool_blocked' : 'destructive_detected',
        tool: 'message_write',
        severity: detections[0]?.severity as 'LOW' | 'HIGH' | 'CATASTROPHIC' | undefined,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
      });

      if (isDryRun) return undefined;

      if (hasCritical) {
        for (const det of criticalDetections) {
          if (det.matchedContent) {
            registerCanary(det.matchedContent, det.category);
          }
        }
        const blockedRules = criticalDetections
          .slice(0, 3)
          .map((d) => `${d.category}:${d.ruleName}`)
          .join(', ');
        const blockedText = `[GUARDRAIL:rule-scanner] Content blocked — ${criticalDetections.length} CRITICAL detection(s): ${blockedRules}`;
        logger.info(`[guardrail-write] [source:rule-scanner] Returning blocked placeholder`);
        return { message: replaceMessageContent(event.message, blockedText) };
      }

      // hasHigh — redact inline, deliver sanitized body
      for (const det of highDetections) {
        if (det.matchedContent) {
          registerCanary(det.matchedContent, det.category);
        }
      }
      const redactedRules = highDetections
        .slice(0, 3)
        .map((d) => `${d.category}:${d.ruleName}`)
        .join(', ');
      const warning = `[GUARDRAIL:rule-scanner] Redacted ${highDetections.length} HIGH detection(s): ${redactedRules}`;
      const redacted = redactContent(fullContent, highDetections);
      logger.info(`[guardrail-write] [source:rule-scanner] Returning redacted content`);
      return { message: replaceMessageContent(event.message, `${warning}\n\n${redacted}`) };
    } catch (err) {
      logger.warn('[guardrail-write] Scan error — fail-open', { error: err });
      return undefined;
    }
  };
}
