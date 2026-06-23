/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Guardrail Middleware — pipeline-compatible facade
 *
 * Implements every OpenClaw lifecycle surface guardrail cares about through
 * the unified `Middleware` interface:
 *
 *   beforeToolCall       → L2 guards + pre-read + param scan (executeGuardrailScan)
 *   beforeAgentStart     → prompt-guard policy injection + async OpenAI moderation
 *                          (cache populated here for beforeMessageWrite to consume)
 *   beforeMessageWrite   → transcript scanner (regex/prefix/heuristic + role
 *                          impersonation + agent interrogation + canary tracker
 *                          + moderation-cache enforcement)
 *
 * Notes:
 *  - The OpenClaw plugin runtime does NOT route through this class — it
 *    binds the free-function hook factories directly in plugin/index.ts.
 *    This class exists for external programmatic consumers (e.g.
 *    `MiddlewareRegistry`-style use) so they get every guard reachable
 *    through a single instance.
 *  - `escalate: true` from the scanner (WARN detections) is surfaced via
 *    the first-class `MiddlewareResult.escalate` / `escalateReason` fields,
 *    so orchestrators (plugin composedToolHook or external pipelines) can
 *    force HITL approval without reaching for the lower-level
 *    `executeGuardrailScan` free function.
 *  - The class is a dumb delegator: no internal enabled gate. To disable
 *    it in your own pipeline, stop calling its methods.
 */

import {
  Middleware,
  MiddlewareContext,
  MiddlewareResult,
  AgentStartContext,
  AgentStartResult,
  MessageWriteContext,
  MessageWriteResult,
} from '../../types.js';
import { logger } from '../../shared/Logger.js';
import { ConfigStore, DEFAULT_GUARDRAIL_CONFIG } from './storage/ConfigStore.js';
import { DecisionLog } from './storage/DecisionLog.js';
import { executeGuardrailScan } from './GuardrailInterceptorHook.js';
import { getPatternCount, scrubMetadata } from './scrubbers/MetadataScrubber.js';
import { createPromptGuardHook } from './PromptGuardHook.js';
import { createModerationGuardHook } from './ModerationGuardHook.js';
import { createWriteScannerHook } from './GuardrailWriteScannerHook.js';
import { GuardrailConfig } from './types.js';

/** Internal shape matching `MessageWriteContext.message` for content rewrites. */
type MessageShape = { role?: string; content?: unknown; [key: string]: unknown };

const GUARDRAIL_VERSION = '3.1.0';

export class GuardrailMiddleware implements Middleware {
  readonly name = 'guardrail';
  readonly version = GUARDRAIL_VERSION;

  private scanCount = 0;
  private blockCount = 0;
  private escalateCount = 0;
  private scrubCount = 0;

  /**
   * In-memory current config — source of truth for hot-path reads when
   * `initialize()` has run. `null` until then; `resolveConfig()` falls
   * back to `ConfigStore.getCached()` so direct programmatic consumers
   * who skip `initialize()` keep working.
   *
   * Populated by `initialize()`, mutated by `updateConfig()`, re-merged
   * with disk by `reloadConfig()`. Mirrors `ModelRoutingMiddleware`'s
   * config model exactly.
   */
  private config: GuardrailConfig | null = null;

  // Pre-built hook handlers — constructed once per middleware instance so
  // repeated event dispatches don't allocate new closures. Each hook reads
  // its config via `() => this.resolveConfig()` so per-instance updates
  // (initialize inline / updateConfig() patches) flow through to every guard.
  private readonly promptGuardHandler = createPromptGuardHook();
  private readonly moderationGuardHandler = createModerationGuardHook();
  private readonly writeScannerHandler = createWriteScannerHook(() => this.resolveConfig());

  /**
   * Build the merged config from defaults + base + inline + disk overlay.
   * Precedence: `DEFAULT_GUARDRAIL_CONFIG < base < inline < disk-overlay`.
   *
   * The "disk overlay" is the raw `guardrail` sub-tree from
   * `sapience-ai-suite.json` (via `ConfigStore.loadOverlay()`) — empty `{}`
   * when the file is absent or the key is unset, so a hermetic embedded
   * consumer's inline config applies fully. A consumer running alongside
   * the plugin gets `defaults < inline < disk` (disk shadows inline —
   * escape hatch: `updateConfig()`).
   */
  private buildConfig(
    inline: Partial<GuardrailConfig>,
    base: Partial<GuardrailConfig> = DEFAULT_GUARDRAIL_CONFIG
  ): GuardrailConfig {
    const disk = ConfigStore.loadOverlay();
    return {
      ...DEFAULT_GUARDRAIL_CONFIG,
      ...base,
      ...inline,
      ...disk,
    } as GuardrailConfig;
  }

  /**
   * Resolve the active config for hot-path reads. Falls back to the static
   * cache when `initialize()` hasn't run yet — keeps the legacy zero-init
   * path working for direct consumers of the class.
   */
  private resolveConfig(): GuardrailConfig {
    return this.config ?? ConfigStore.getCached();
  }

  /**
   * Initialize the middleware. Accepts an optional inline `GuardrailConfig`
   * partial — fields you set here apply on top of `DEFAULT_GUARDRAIL_CONFIG`
   * but below the disk overlay (`sapience-ai-suite.json[guardrail]`). Pass
   * `{}` (or omit) to fall back to defaults + disk — the path the OpenClaw
   * plugin runtime uses.
   */
  async initialize(config: Record<string, unknown> = {}): Promise<void> {
    this.config = this.buildConfig(config as Partial<GuardrailConfig>);
    // Warm the static cache too — direct consumers of the free-function
    // hook factories (who don't pass a config getter) still rely on it.
    ConfigStore.getCached();
    logger.info('[GuardrailMiddleware] Initialized');
  }

  /**
   * In-process patch — bypasses disk. Shallow-merges `partial` into the
   * current in-memory config. Sibling fields are preserved.
   *
   *   gr.updateConfig({ dryRunMode: true });
   *
   * For disk-backed updates that survive process restarts, use
   * `GuardrailConfigStore.update()` + `reloadConfig()` instead.
   *
   * Throws if called before `initialize()`.
   */
  updateConfig(partial: Partial<GuardrailConfig>): void {
    if (!this.config) {
      throw new Error('GuardrailMiddleware.updateConfig: call initialize() first');
    }
    this.config = { ...this.config, ...partial } as GuardrailConfig;
    logger.debug('[GuardrailMiddleware] In-process config updated', {
      keys: Object.keys(partial),
    });
  }

  /**
   * Re-read config from disk and re-merge over the current in-memory config.
   * `updateConfig()` patches survive for fields the disk doesn't set; disk-
   * set fields shadow them (matches `ModelRoutingMiddleware.reloadConfig()`
   * semantics). Called by the plugin's `ConfigStore.onChange('guardrail',
   * …)` watcher and by programmatic consumers after
   * `GuardrailConfigStore.save()` / `update()`.
   */
  reloadConfig(): void {
    const base = this.config ?? DEFAULT_GUARDRAIL_CONFIG;
    this.config = this.buildConfig({}, base);
    logger.debug('[GuardrailMiddleware] Config hot-reloaded');
  }

  async beforeToolCall(context: MiddlewareContext): Promise<MiddlewareResult> {
    try {
      const result = executeGuardrailScan(
        context.toolName,
        context.moduleName,
        context.methodName,
        context.params,
        context.sessionKey,
        context.agentId,
        this.resolveConfig()
      );

      this.scanCount++;
      if (result.block) {
        this.blockCount++;
        return { block: true, reason: result.reason };
      }
      if (result.escalate) {
        this.escalateCount++;
        // Surface WARN detections via the first-class escalate channel on
        // MiddlewareResult so orchestrators (plugin composed hook or external
        // pipelines) can force HITL approval without dropping down to the
        // lower-level executeGuardrailScan free function.
        return {
          block: false,
          escalate: true,
          escalateReason: result.reason,
        };
      }
      return { block: false };
    } catch (err) {
      logger.warn('[GuardrailMiddleware] scan error — fail-open', { error: err });
      return { block: false };
    }
  }

  /**
   * `before_agent_start` surface. Runs both the prompt-guard (injects the
   * security policy into the system prompt) and the async OpenAI moderation
   * check (caches the result for `beforeMessageWrite` to consume). The
   * return value carries the prompt-guard's `prependContext`; the
   * moderation call's side effect is the cache population.
   */
  async beforeAgentStart(context: AgentStartContext): Promise<AgentStartResult | void> {
    try {
      // Both underlying handlers accept the raw (event, ctx) shape with
      // index signatures — the normalized LifecycleContext satisfies both.
      const [, promptResult] = await Promise.all([
        this.moderationGuardHandler(context, context).catch((err) => {
          logger.warn('[GuardrailMiddleware] moderation error — fail-open', { error: err });
          return {} as Record<string, never>;
        }),
        Promise.resolve(this.promptGuardHandler(context)),
      ]);
      return promptResult ?? {};
    } catch (err) {
      logger.warn('[GuardrailMiddleware] beforeAgentStart error — fail-open', { error: err });
      return {};
    }
  }

  /**
   * `before_message_write` surface. Runs two stages in sequence on the same
   * hook event:
   *
   *   1. **Security write scanner** — regex/prefix/heuristic rules, role
   *      impersonation detection, agent interrogation detection, canary
   *      tracker, and moderation-cache enforcement (cache populated by
   *      `beforeAgentStart`). Fires for **all** roles (user, assistant,
   *      tool result, system). May block, rewrite, or pass through.
   *   2. **Output scrubber** — strips middleware tokens, reasoning
   *      artifacts, architecture leaks, and instruction-reflection
   *      patterns from the agent's text. Fires only on **assistant**
   *      messages, only when `outputScrubber.enabled === true`. Operates
   *      on the security stage's rewrite when one occurred, else on the
   *      original content (matches the prior plugin-runtime behavior
   *      where two separate `before_message_write` registrations chained
   *      sequentially).
   *
   * If the security stage blocks, the scrubber is skipped (a blocked
   * message has no body to scrub). Returns `{ message }` to rewrite,
   * `{ block: true }` to drop, or `undefined` to pass through.
   */
  beforeMessageWrite(context: MessageWriteContext): MessageWriteResult | undefined {
    try {
      const secResult = this.writeScannerHandler(context, context);
      if (secResult?.block) return secResult;

      const scrubResult = this.runOutputScrubber(context, secResult);
      return scrubResult ?? secResult ?? undefined;
    } catch (err) {
      logger.warn('[GuardrailMiddleware] beforeMessageWrite error — fail-open', { error: err });
      return undefined;
    }
  }

  /**
   * Output scrubber stage of `beforeMessageWrite`. See the method's docstring
   * for stage ordering. Returns a `MessageWriteResult` only when the scrubber
   * actually modified content (and dry-run is off); otherwise returns
   * `undefined` so the caller can fall through to the security stage's
   * result.
   */
  private runOutputScrubber(
    context: MessageWriteContext,
    secResult: MessageWriteResult | undefined
  ): MessageWriteResult | undefined {
    // Determine the message shape to operate on. If security rewrote, scrub
    // the rewritten content (matches prior plugin-runtime behavior where the
    // standalone scrubber received the security stage's rewrite as its event).
    const effectiveMessage = (secResult?.message ?? context.message) as MessageShape | undefined;
    const role = GuardrailMiddleware.extractRole(context, effectiveMessage);
    if (role !== 'assistant') return undefined;

    const scrubberConfig = this.resolveConfig().outputScrubber;
    if (!scrubberConfig || !scrubberConfig.enabled) return undefined;

    const sourceContent = effectiveMessage
      ? GuardrailMiddleware.extractContentFromMessage(effectiveMessage)
      : GuardrailMiddleware.extractContentFromContext(context);
    if (!sourceContent || sourceContent.length === 0) return undefined;

    const result = scrubMetadata(sourceContent, scrubberConfig);
    if (!result.scrubbed) return undefined;

    this.scrubCount += 1;

    void DecisionLog.append({
      timestamp: new Date().toISOString(),
      module: 'guardrail:output-scrubber',
      method: 'metadata-scrubber',
      args: [{ contentLength: sourceContent.length, matchCount: result.matchCount }],
      decision: scrubberConfig.dryRunMode ? 'ALLOWED' : 'BLOCKED',
      decisionTime: 0,
      reason: `output-scrubber: scrubbed ${result.matchCount} match(es) [${result.matchedGroups.join(', ')}]`,
      eventType: 'tool_blocked' as const,
      tool: 'message_write',
      severity: 'LOW',
      agentId: context.agentId,
      sessionKey: context.sessionKey,
    });

    logger.info(
      `[guardrail:output-scrubber] ${scrubberConfig.dryRunMode ? 'DRY-RUN' : 'SCRUB'} #${this.scrubCount} | ${result.matchCount} match(es) | groups=[${result.matchedGroups.join(', ')}]`,
      { sessionKey: context.sessionKey }
    );

    if (scrubberConfig.dryRunMode) return undefined;

    const newMessage = GuardrailMiddleware.replaceMessageContent(
      effectiveMessage,
      result.content,
      role
    );
    return { message: newMessage };
  }

  /** Pull role from the context's top level or its nested message object. */
  private static extractRole(
    context: MessageWriteContext,
    fallbackMessage?: MessageShape
  ): string | undefined {
    if (typeof context.role === 'string') return context.role;
    const msg = (context.message ?? fallbackMessage) as MessageShape | undefined;
    if (msg && typeof msg.role === 'string') return msg.role;
    return undefined;
  }

  /** Extract scrubbable text from a `MessageWriteContext` top-level shape. */
  private static extractContentFromContext(context: MessageWriteContext): string {
    if (typeof context.content === 'string') return context.content;
    if (context.message) return GuardrailMiddleware.extractContentFromMessage(context.message);
    return '';
  }

  /** Extract scrubbable text from a nested message shape (string or array). */
  private static extractContentFromMessage(message: MessageShape): string {
    const c = message.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c
        .filter(
          (b): b is { type: string; text: string } =>
            !!b &&
            typeof b === 'object' &&
            (b as { type?: unknown }).type === 'text' &&
            typeof (b as { text?: unknown }).text === 'string'
        )
        .map((b) => b.text)
        .join('\n');
    }
    return '';
  }

  /**
   * Rebuild a message with replaced text, preserving the original content
   * shape (string vs array of text blocks). When `original` is missing, a
   * minimal `{ role, content: <newText> }` object is returned so the caller
   * still has a valid message to forward.
   */
  private static replaceMessageContent(
    original: MessageShape | undefined,
    newText: string,
    fallbackRole: string
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

  getStatus(): { enabled: boolean; stats?: Record<string, unknown> } {
    // The plugin-level on/off switch lives upstream (dashboard / `sai init`
    // → `plugin_config.middlewares.guardrail`, gated in plugin/index.ts
    // hook wrappers). Once this middleware is constructed, it is always
    // active by the Middleware-interface contract — disable by not
    // calling its methods.
    return {
      enabled: true,
      stats: {
        scanCount: this.scanCount,
        blockCount: this.blockCount,
        escalateCount: this.escalateCount,
        scrubCount: this.scrubCount,
        metadataPatternCount: getPatternCount(),
      },
    };
  }
}
