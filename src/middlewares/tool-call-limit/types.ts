/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Tool Call Limit Internal Types
 */

export type SeverityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type EnforcementStatus = 'OK' | 'SOFT_LIMIT' | 'HARD_LIMIT';

export interface CallLimit {
  max: number;
  soft?: number;
}

export interface LimitRule {
  /** Optional call limits for this specific tool (Session). */
  sessionCallLimit?: { max: number; windowMs?: number };
  /** Optional request-level call limits (e.g. per prompt). */
  requestCallLimit?: { max: number };
}

/**
 * Complete tool call limit policy structure (Budgets only)
 * This should be consistent with the global LimitPolicy type in src/types.ts
 */
export interface LimitPolicy {
  version: string;
  globalSessionCallLimit?: number;
  globalRequestCallLimit?: number;
  /**
   * ISO timestamp bumped by `sai limits reset`. The middleware watches this
   * field and clears in-memory trackers when it changes.
   */
  resetAt?: string;
  /** Which scope the most recent reset targeted. */
  resetScope?: 'all' | 'session' | 'request';
  modules: {
    [moduleName: string]: {
      [methodName: string]: LimitRule;
    };
  };
}

export const DEFAULT_LIMIT_POLICY: LimitPolicy = {
  version: '1.0.0',
  globalSessionCallLimit: 100,
  globalRequestCallLimit: 20,
  modules: {
    FileSystem: {
      read: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 20 } },
      list: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 20 } },
      write: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 20 } },
      delete: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 20 } },
    },
    Shell: {
      bash: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 30 } },
      exec: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 30 } },
      spawn: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 10 } },
    },
    Browser: {
      navigate: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 20 } },
      click: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 20 } },
      type: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 20 } },
      evaluate: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 20 } },
      screenshot: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 10 } },
    },
    Gateway: {
      sendMessage: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 30 } },
      listSessions: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 30 } },
      listNodes: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 30 } },
    },
    Network: {
      fetch: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 20 } },
      request: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 20 } },
    },
    Gmail: {
      list: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 20 } },
      read: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 20 } },
      download: { sessionCallLimit: { max: 50 }, requestCallLimit: { max: 20 } },
      draft: { sessionCallLimit: { max: 50 }, requestCallLimit: { max: 20 } },
      send: { sessionCallLimit: { max: 50 }, requestCallLimit: { max: 20 } },
      write: { sessionCallLimit: { max: 50 }, requestCallLimit: { max: 20 } },
      delete: { sessionCallLimit: { max: 50 }, requestCallLimit: { max: 20 } },
    },
    GoogleDrive: {
      list: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 30 } },
      read: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 30 } },
      download: { sessionCallLimit: { max: 50 }, requestCallLimit: { max: 10 } },
      upload: { sessionCallLimit: { max: 50 }, requestCallLimit: { max: 10 } },
      write: { sessionCallLimit: { max: 50 }, requestCallLimit: { max: 10 } },
      delete: { sessionCallLimit: { max: 50 }, requestCallLimit: { max: 10 } },
      share: { sessionCallLimit: { max: 50 }, requestCallLimit: { max: 10 } },
      move: { sessionCallLimit: { max: 50 }, requestCallLimit: { max: 10 } },
    },
    Memory: {
      search: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 20 } },
      add: { sessionCallLimit: { max: 30 }, requestCallLimit: { max: 10 } },
      delete: { sessionCallLimit: { max: 30 }, requestCallLimit: { max: 10 } },
    },
    Process: {
      list: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 30 } },
      poll: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 30 } },
      log: { sessionCallLimit: { max: 100 }, requestCallLimit: { max: 30 } },
      write: { sessionCallLimit: { max: 50 }, requestCallLimit: { max: 20 } },
      kill: { sessionCallLimit: { max: 50 }, requestCallLimit: { max: 10 } },
      clear: { sessionCallLimit: { max: 50 }, requestCallLimit: { max: 10 } },
      remove: { sessionCallLimit: { max: 50 }, requestCallLimit: { max: 10 } },
    },
  },
};

// Core Middleware-interface types are imported from the suite's canonical
// `src/types.ts` so the shape stays in one place and the local module is
// no longer self-contained-but-incomplete.
export type { Middleware, MiddlewareContext, MiddlewareResult } from '../../types.js';

export interface LimitState {
  count: number;
  warnedSoftLimit: boolean;
  expiresAt?: number;
}
