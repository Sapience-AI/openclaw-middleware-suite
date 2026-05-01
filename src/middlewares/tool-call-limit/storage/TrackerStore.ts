/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

import fs from 'fs-extra';
import { logger } from '../../../shared/Logger.js';
import {
  TOOL_CALL_LIMIT_DIR,
  TOOL_CALL_LIMIT_SESSIONS_FILE,
  TOOL_CALL_LIMIT_REQUESTS_FILE,
  TOOL_CALL_LIMIT_LAST_REQ_FILE,
} from '../../../shared/storage/paths.js';
import { LimitState } from '../types.js';

/**
 * Persistence layer for Tool Call Limit middleware
 */

export class TrackerStore {
  private static getSessionsFile() {
    return TOOL_CALL_LIMIT_SESSIONS_FILE;
  }
  private static getRequestsFile() {
    return TOOL_CALL_LIMIT_REQUESTS_FILE;
  }
  private static getLastRequestFile() {
    return TOOL_CALL_LIMIT_LAST_REQ_FILE;
  }

  /**
   * Load state from disk
   */
  static async load(): Promise<{
    sessions: Record<string, Record<string, LimitState>>;
    requests: Record<string, Record<string, LimitState>>;
  }> {
    const state = { sessions: {}, requests: {} };
    try {
      if (await fs.pathExists(this.getSessionsFile())) {
        state.sessions = await fs.readJson(this.getSessionsFile());
      }
      if (await fs.pathExists(this.getRequestsFile())) {
        state.requests = await fs.readJson(this.getRequestsFile());
      }
    } catch (error) {
      logger.error('Failed to load tracker state', { error });
    }
    return state;
  }

  /**
   * Save state to disk
   */
  static async save(
    sessions: Map<string, Map<string, LimitState>>,
    requests: Map<string, Map<string, LimitState>>
  ): Promise<void> {
    try {
      const serializableSessions: Record<string, Record<string, LimitState>> = {};
      for (const [sessionKey, sessionMap] of sessions.entries()) {
        const cleanedSession: Record<string, LimitState> = {};
        for (const [trackerKey, state] of sessionMap.entries()) {
          cleanedSession[trackerKey] = state;
        }
        serializableSessions[sessionKey] = cleanedSession;
      }

      const serializableRequests: Record<string, Record<string, LimitState>> = {};
      for (const [requestId, reqMap] of requests.entries()) {
        const cleanedReq: Record<string, LimitState> = {};
        for (const [trackerKey, state] of reqMap.entries()) {
          cleanedReq[trackerKey] = state;
        }
        serializableRequests[requestId] = cleanedReq;
      }

      await fs.ensureDir(TOOL_CALL_LIMIT_DIR);
      await fs.writeJson(this.getSessionsFile(), serializableSessions, { spaces: 2 });
      await fs.writeJson(this.getRequestsFile(), serializableRequests, { spaces: 2 });
    } catch (error) {
      logger.error('Failed to save tracker state', { error });
    }
  }

  static async saveLastRequestId(requestId: string): Promise<void> {
    try {
      await fs.ensureDir(TOOL_CALL_LIMIT_DIR);
      await fs.writeFile(this.getLastRequestFile(), requestId, 'utf8');
    } catch (error) {
      logger.error('Failed to save last request ID', { error });
    }
  }

  static async loadLastRequestId(): Promise<string | null> {
    try {
      if (await fs.pathExists(this.getLastRequestFile())) {
        return await fs.readFile(this.getLastRequestFile(), 'utf8');
      }
    } catch (error) {
      logger.error('Failed to load last request ID', { error });
    }
    return null;
  }
}
