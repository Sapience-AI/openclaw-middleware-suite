/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Context Editing Middleware — Adaptive Trigger Evaluator
 *
 * Maintains per-session SessionBuffer objects and evaluates thresholds
 * using real data from `session.getStats()` via the Gateway Runtime Context.
 *
 * Features:
 *  - Token threshold mode
 *  - Message threshold mode
 *  - Combined mode (either threshold triggers)
 *  - Cooldown: max 1 compaction per session per 60 seconds
 */

import { ContextEditingConfig } from './config.js';
import { CompactionTrigger, SessionBuffer } from './types.js';
import { logger } from '../../shared/Logger.js';

/** Cooldown period in milliseconds (60 seconds) */
const COMPACTION_COOLDOWN_MS = 60_000;

export class TriggerEvaluator {
  private buffers = new Map<string, SessionBuffer>();

  /**
   * Evaluate whether compaction should be triggered.
   * Uses real stats from the Gateway Runtime Context.
   *
   * @returns The trigger type if compaction should fire, or null if not.
   */
  shouldCompact(
    sessionKey: string,
    stats: { messageCount: number; tokenCount: number },
    config: ContextEditingConfig
  ): CompactionTrigger | null {
    const buffer = this.getOrCreateBuffer(sessionKey);

    // Update buffer with live stats
    buffer.messageCount = stats.messageCount;
    buffer.estimatedTokens = stats.tokenCount + buffer.toolOutputTokenBuffer;

    // Check cooldown
    if (buffer.lastCompactionTimestamp) {
      const elapsed = Date.now() - buffer.lastCompactionTimestamp;
      if (elapsed < COMPACTION_COOLDOWN_MS) {
        logger.debug('[TriggerEvaluator] Cooldown active', {
          sessionKey,
          elapsedMs: elapsed,
          cooldownMs: COMPACTION_COOLDOWN_MS,
        });
        return null;
      }
    }

    // Evaluate thresholds using delta since last compaction
    const messageDelta = buffer.messageCount - buffer.baselineMessageCount;
    const tokenDelta = buffer.estimatedTokens - buffer.baselineTokens;
    const tokenExceeded = tokenDelta >= config.tokenThreshold;
    const messageExceeded = messageDelta >= config.messageThreshold;

    switch (config.triggerMode) {
      case 'token':
        if (tokenExceeded) {
          logger.info('[TriggerEvaluator] Token threshold crossed', {
            sessionKey,
            tokenDelta,
            tokens: buffer.estimatedTokens,
            baseline: buffer.baselineTokens,
            threshold: config.tokenThreshold,
          });
          return 'token_threshold';
        }
        break;

      case 'message':
        if (messageExceeded) {
          logger.info('[TriggerEvaluator] Message threshold crossed', {
            sessionKey,
            messageDelta,
            messages: buffer.messageCount,
            baseline: buffer.baselineMessageCount,
            threshold: config.messageThreshold,
          });
          return 'message_threshold';
        }
        break;

      case 'both':
        if (tokenExceeded) {
          logger.info('[TriggerEvaluator] Token threshold crossed (both mode)', {
            sessionKey,
            tokenDelta,
            tokens: buffer.estimatedTokens,
            baseline: buffer.baselineTokens,
            threshold: config.tokenThreshold,
          });
          return 'token_threshold';
        }
        if (messageExceeded) {
          logger.info('[TriggerEvaluator] Message threshold crossed (both mode)', {
            sessionKey,
            messageDelta,
            messages: buffer.messageCount,
            baseline: buffer.baselineMessageCount,
            threshold: config.messageThreshold,
          });
          return 'message_threshold';
        }
        break;
    }

    return null;
  }

  /**
   * Called from onBeforePromptBuild to sync internal buffer with real session stats
   * from the agent context. The before_prompt_build hook receives event.messages[]
   * which is the authoritative message list — use it to correct internal estimates.
   */
  syncSessionStats(sessionKey: string, messageCount: number, estimatedTokens: number): void {
    const buffer = this.getOrCreateBuffer(sessionKey);

    // First-time observation: anchor the baseline to the current live
    // counts. Without this, a session that already has messages when CE
    // first sees it (CE enabled mid-session, gateway restart, plugin
    // reload, disable→re-enable) computes a delta against `baseline=0`
    // and trips the threshold immediately on the very next turn —
    // counting all historical messages as "new". Anchoring the first
    // observation matches the post-compaction semantic in `resetSession`
    // where `baseline = messageCount`. Fresh sessions are unaffected:
    // at Turn 1's before_model_resolve the JSONL has 0 user messages
    // (the just-sent message hasn't been written yet), so the anchor
    // is trivially 0 and the delta-from-zero progression below is
    // unchanged.
    if (!buffer.hasBeenSynced) {
      buffer.baselineMessageCount = messageCount;
      buffer.baselineTokens = estimatedTokens;
      buffer.hasBeenSynced = true;
      logger.info('[TriggerEvaluator] First sync — anchoring baseline to current counts', {
        sessionKey,
        baselineMessageCount: messageCount,
        baselineTokens: estimatedTokens,
      });
    }

    // Detect session reset (/new, /reset) or post-compaction context
    // reduction: the live message count dropped below the baseline.
    // Reset baselines so delta-based thresholds start fresh — otherwise
    // the delta stays zero or negative and the trigger never fires again.
    // Also clear the cooldown timer so a brand-new session isn't blocked
    // by a compaction that happened in the previous session.
    if (messageCount < buffer.baselineMessageCount) {
      logger.info('[TriggerEvaluator] Message count dropped below baseline — resetting baselines', {
        sessionKey,
        liveMessageCount: messageCount,
        previousBaseline: buffer.baselineMessageCount,
      });
      buffer.baselineMessageCount = 0;
      buffer.baselineTokens = 0;
      buffer.toolOutputTokenBuffer = 0;
      buffer.lastCompactionTimestamp = null;
      buffer.compactionsSinceReset = 0;
    }

    buffer.messageCount = messageCount;
    buffer.estimatedTokens = estimatedTokens;

    logger.debug('[TriggerEvaluator] Synced session stats from agent context', {
      sessionKey,
      messageCount,
      estimatedTokens,
    });
  }

  /**
   * Called from afterToolCall to refine token estimates with tool output size.
   * The buffer accumulates tool output tokens until the next live stats refresh.
   */
  recordToolOutput(sessionKey: string, estimatedTokens: number): void {
    const buffer = this.getOrCreateBuffer(sessionKey);
    buffer.toolOutputTokenBuffer += estimatedTokens;

    logger.debug('[TriggerEvaluator] Recorded tool output tokens', {
      sessionKey,
      addedTokens: estimatedTokens,
      totalBuffer: buffer.toolOutputTokenBuffer,
    });
  }

  /**
   * Reset counters after successful compaction.
   */
  resetSession(sessionKey: string): void {
    const buffer = this.getOrCreateBuffer(sessionKey);
    buffer.lastCompactionTimestamp = Date.now();
    buffer.compactionsSinceReset += 1;
    buffer.toolOutputTokenBuffer = 0;
    // Snapshot current counts as the new baseline so future trigger
    // evaluation uses the delta (messages/tokens since this compaction).
    buffer.baselineMessageCount = buffer.messageCount;
    buffer.baselineTokens = buffer.estimatedTokens;

    logger.info('[TriggerEvaluator] Session reset after compaction', {
      sessionKey,
      compactionsSinceReset: buffer.compactionsSinceReset,
      baselineMessageCount: buffer.baselineMessageCount,
      baselineTokens: buffer.baselineTokens,
    });
  }

  /**
   * Get current buffer state for stats display.
   */
  getSessionBuffer(sessionKey: string): SessionBuffer {
    return this.getOrCreateBuffer(sessionKey);
  }

  /**
   * Clear all session buffers (used on full reset).
   */
  clearAll(): void {
    this.buffers.clear();
    logger.info('[TriggerEvaluator] All session buffers cleared');
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private getOrCreateBuffer(sessionKey: string): SessionBuffer {
    let buffer = this.buffers.get(sessionKey);
    if (!buffer) {
      buffer = {
        sessionKey,
        messageCount: 0,
        estimatedTokens: 0,
        toolOutputTokenBuffer: 0,
        lastCompactionTimestamp: null,
        compactionsSinceReset: 0,
        baselineMessageCount: 0,
        baselineTokens: 0,
        hasBeenSynced: false,
      };
      this.buffers.set(sessionKey, buffer);
    }
    return buffer;
  }
}
