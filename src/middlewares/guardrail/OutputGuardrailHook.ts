/**
 * Output Guardrail Hook — before_message_write handler (assistant only)
 *
 * Consolidated from the former standalone output-guardrail middleware.
 * Registered as a SECOND handler on before_message_write, after the
 * security guardrail. Only fires for assistant-role messages.
 *
 * Scrubs internal middleware tokens, reasoning artifacts, architecture
 * details, and instruction reflection patterns from the agent's responses.
 *
 * Return values:
 *   { content: string }  → replace message content (scrubbed)
 *   undefined            → pass through unchanged
 *
 * Fail-open: errors never block or corrupt messages.
 */

import { scrubMetadata } from './scrubbers/MetadataScrubber.js';
import { ConfigStore } from './storage/ConfigStore.js';
import { logger } from '../../shared/Logger.js';
import { DecisionLog } from './storage/DecisionLog.js';

// ── Types ───────────────────────────────────────────────────────

interface BeforeMessageWriteEvent {
  content?: string;
  message?: unknown;
  role?: string;
  filePath?: string;
  contentLength?: number;
  [key: string]: unknown;
}

interface BeforeMessageWriteContext {
  sessionKey?: string;
  agentId?: string;
  [key: string]: unknown;
}

interface WriteResult {
  content?: string;
  block?: boolean;
}

// ── Content extraction ──────────────────────────────────────────

function extractContent(event: BeforeMessageWriteEvent): string {
  if (typeof event.content === 'string') return event.content;

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

/**
 * Extract message role from event. Checks both top-level and nested message object.
 */
function extractRole(event: BeforeMessageWriteEvent): string | undefined {
  if (typeof event.role === 'string') return event.role;
  if (event.message && typeof (event.message as any).role === 'string') {
    return (event.message as any).role;
  }
  return undefined;
}

// ── Hook factory ────────────────────────────────────────────────

/**
 * Create the output guardrail before_message_write hook handler.
 *
 * Only processes assistant-role messages. All other roles pass through.
 * Now uses the consolidated guardrail ConfigStore (outputScrubber section).
 */
export function createOutputGuardrailHook(): (
  event: BeforeMessageWriteEvent,
  ctx: BeforeMessageWriteContext
) => WriteResult | undefined {
  let scrubCount = 0;

  return (event, ctx): WriteResult | undefined => {
    try {
      // CRITICAL: Only process assistant messages
      const role = extractRole(event);
      if (role !== 'assistant') return undefined;

      const content = extractContent(event);
      if (!content || content.length === 0) return undefined;

      const config = ConfigStore.getCached();
      const scrubberConfig = config.outputScrubber;
      if (!scrubberConfig || !scrubberConfig.enabled) return undefined;

      const result = scrubMetadata(content, scrubberConfig);

      if (!result.scrubbed) return undefined;

      scrubCount++;

      // Audit log
      void DecisionLog.append({
        timestamp: new Date().toISOString(),
        module: 'output-guardrail',
        method: 'metadata-scrubber',
        args: [{ contentLength: content.length, matchCount: result.matchCount }],
        decision: scrubberConfig.dryRunMode ? 'ALLOWED' : 'BLOCKED',
        decisionTime: 0,
        reason: `output-guardrail: scrubbed ${result.matchCount} match(es) [${result.matchedGroups.join(', ')}]`,
        eventType: 'tool_blocked' as const,
        tool: 'message_write',
        severity: 'LOW' as any,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
      });

      logger.info(
        `[output-guardrail] ${scrubberConfig.dryRunMode ? 'DRY-RUN' : 'SCRUB'} #${scrubCount} | ${result.matchCount} match(es) | groups=[${result.matchedGroups.join(', ')}]`,
        { sessionKey: ctx.sessionKey }
      );

      // Dry-run: log only, never modify
      if (scrubberConfig.dryRunMode) return undefined;

      return { content: result.content };
    } catch (err) {
      logger.warn('[output-guardrail] Hook error — fail-open', { error: err });
      return undefined;
    }
  };
}
