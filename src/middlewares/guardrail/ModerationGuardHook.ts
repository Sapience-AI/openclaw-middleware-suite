/**
 * Moderation Guard Hook — before_agent_start (async, blocking)
 *
 * Runs the OpenAI Moderation API on the incoming user prompt at the start
 * of each agent turn. Stores the result in a per-session cache so the
 * synchronous before_message_write hook can block flagged user messages.
 *
 * Flow:
 *   1. before_agent_start fires (async, awaited by OpenClaw)
 *   2. checkContentModeration called on event.prompt
 *   3. If flagged: result cached under sessionKey
 *   4. before_message_write fires (sync) for the user message
 *   5. consumeModerationResult() → block if flagged
 *   6. Cache entry consumed (one-shot per turn)
 *
 * Fail-open: API errors, timeouts, missing API key → allow through.
 */

import { logger } from '../../shared/Logger.js';
import { checkContentModeration, getOverallSeverity } from './guards/content-moderation.js';
import { DecisionLog } from './storage/DecisionLog.js';

const TAG = '[moderation-guard]';

/** How long a cached result survives if not consumed (ms) */
const CACHE_TTL_MS = 30_000;

// ── Cache types ────────────────────────────────────────────────

export interface ModerationCacheEntry {
  flagged: boolean;
  flagSummary: string;
  severity: 'MEDIUM' | 'HIGH' | 'CRITICAL';
  timestamp: number;
}

const cache = new Map<string, ModerationCacheEntry>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > CACHE_TTL_MS) cache.delete(key);
  }
}

/**
 * Consume (read + delete) a cached moderation result for a session.
 * Returns undefined if no entry exists or if the entry is not flagged.
 * One-shot: the entry is removed after the first call.
 */
export function consumeModerationResult(sessionKey: string): ModerationCacheEntry | undefined {
  const entry = cache.get(sessionKey);
  if (entry) cache.delete(sessionKey);
  return entry?.flagged ? entry : undefined;
}

// ── Hook types ─────────────────────────────────────────────────

interface BeforeAgentStartEvent {
  prompt?: unknown;
  [key: string]: unknown;
}

interface BeforeAgentStartContext {
  sessionKey?: string;
  agentId?: string;
  [key: string]: unknown;
}

// ── Hook factory ───────────────────────────────────────────────

/**
 * Create the before_agent_start moderation hook.
 *
 * before_agent_start is awaited by OpenClaw, so the API result is ready
 * before any before_message_write handler runs for this turn.
 */
export function createModerationGuardHook(): (
  event: BeforeAgentStartEvent,
  ctx: BeforeAgentStartContext
) => Promise<Record<string, never>> {
  return async (event, ctx): Promise<Record<string, never>> => {
    try {
      pruneExpired();

      const sessionKey = ctx?.sessionKey;
      if (!sessionKey) return {};

      const prompt = typeof event?.prompt === 'string' ? event.prompt : undefined;
      if (!prompt) return {};

      const result = await checkContentModeration(prompt);

      if (result.skipped) {
        logger.info(`${TAG} skipped | reason=${result.skipReason} | sessionKey=${sessionKey}`);
        return {};
      }

      if (!result.flagged) {
        logger.info(`${TAG} CLEAN | sessionKey=${sessionKey}`);
        return {};
      }

      const flagSummary = result.flaggedCategories
        .map((c) => `${c.name}(${c.score.toFixed(3)})`)
        .join(', ');
      const severity = getOverallSeverity(result.flaggedCategories);

      logger.info(`${TAG} FLAGGED | severity=${severity} | categories: ${flagSummary}`, {
        sessionKey,
      });

      cache.set(sessionKey, { flagged: true, flagSummary, severity, timestamp: Date.now() });

      void DecisionLog.append({
        timestamp: new Date().toISOString(),
        module: 'before_agent_start',
        method: 'content-moderation',
        args: [{ promptLength: prompt.length, categories: flagSummary }],
        decision: 'BLOCKED',
        decisionTime: 0,
        reason: `guard:content-moderation: flagged [${flagSummary}]`,
        eventType: 'tool_blocked',
        tool: 'message_write',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        severity: severity === 'CRITICAL' ? ('CATASTROPHIC' as any) : severity,
        agentId: ctx.agentId,
        sessionKey,
      });
    } catch (err) {
      logger.warn(`${TAG} Hook error — fail-open`, { error: err });
    }

    return {};
  };
}
