/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Context Editing Middleware — Session Adapter
 *
 * Wraps the Gateway Runtime Context (`ctx`) for clean separation of concerns.
 * Provides session access and conversation history retrieval.
 */

import { logger } from '../../shared/Logger.js';

// ---------------------------------------------------------------------------
// Session interface (subset of what ctx.sessions provides)
// ---------------------------------------------------------------------------

export interface SessionHandle {
  getStats(): { messageCount: number; tokenCount: number };
  compact(opts: { customInstructions: string; force: boolean }): Promise<void>;
}

// ---------------------------------------------------------------------------
// History cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  transcript: string;
  cachedAt: number;
}

/** Cache TTL in milliseconds (30 seconds) */
const HISTORY_CACHE_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Session Adapter
// ---------------------------------------------------------------------------

export class SessionAdapter {
  private historyCache = new Map<string, CacheEntry>();

  constructor(_pluginApi: unknown) {
    // pluginApi not stored — session operations use ctx passed per-call
  }

  /**
   * Get session object with stats and compact methods.
   * Calls `ctx.sessions.get(sessionKey)`.
   */
  async getSession(sessionKey: string, ctx: unknown): Promise<SessionHandle> {
    try {
      const ctxObj = ctx as { sessions?: { get?(key: string): Promise<unknown> } };

      if (!ctxObj?.sessions?.get) {
        throw new Error('ctx.sessions.get is not available');
      }

      const session = await ctxObj.sessions.get(sessionKey);

      if (!session || typeof session !== 'object') {
        throw new Error(`Session not found: ${sessionKey}`);
      }

      // Validate the session object has the expected shape
      const sess = session as Record<string, unknown>;

      return {
        getStats: () => {
          if (typeof sess.getStats === 'function') {
            return (sess.getStats as () => { messageCount: number; tokenCount: number })();
          }
          // Fallback: return zeros if the method isn't available
          logger.warn('[SessionAdapter] session.getStats() not available, returning defaults');
          return { messageCount: 0, tokenCount: 0 };
        },
        compact: async (opts: { customInstructions: string; force: boolean }) => {
          if (typeof sess.compact === 'function') {
            await (
              sess.compact as (opts: {
                customInstructions: string;
                force: boolean;
              }) => Promise<void>
            )(opts);
          } else {
            logger.warn('[SessionAdapter] session.compact() not available');
          }
        },
      };
    } catch (err) {
      logger.error('[SessionAdapter] Failed to get session', { sessionKey, error: err });
      throw err;
    }
  }

  /**
   * Get conversation transcript for ICC processing.
   * Calls `ctx.sessions.getHistory(sessionKey)`.
   * Uses an internal cache with 30-second TTL to avoid redundant calls
   * within the same compaction cycle.
   */
  async getHistory(sessionKey: string, ctx: unknown): Promise<string> {
    // Check cache first
    const cached = this.historyCache.get(sessionKey);
    if (cached && Date.now() - cached.cachedAt < HISTORY_CACHE_TTL_MS) {
      logger.debug('[SessionAdapter] Returning cached history', { sessionKey });
      return cached.transcript;
    }

    try {
      const ctxObj = ctx as { sessions?: { getHistory?(key: string): Promise<unknown> } };

      if (!ctxObj?.sessions?.getHistory) {
        throw new Error('ctx.sessions.getHistory is not available');
      }

      const history = await ctxObj.sessions.getHistory(sessionKey);
      const transcript = typeof history === 'string' ? history : JSON.stringify(history ?? '');

      // Cache the result
      this.historyCache.set(sessionKey, { transcript, cachedAt: Date.now() });

      logger.debug('[SessionAdapter] Fetched and cached history', {
        sessionKey,
        transcriptLength: transcript.length,
      });

      return transcript;
    } catch (err) {
      logger.error('[SessionAdapter] Failed to get history', { sessionKey, error: err });
      throw err;
    }
  }
}
