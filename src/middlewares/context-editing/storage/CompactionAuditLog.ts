/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Context Editing Compaction Audit Log
 * JSONL append-only audit trail for compaction events.
 */

import fs from 'fs-extra';
import { logger } from '../../../shared/Logger.js';
import { CTX_EDIT_AUDIT_FILE, CTX_EDIT_DIR } from '../../../shared/storage/paths.js';
import { CompactionTrigger, EntityLock, ConflictResolution } from '../types.js';

const AUDIT_FILE = CTX_EDIT_AUDIT_FILE;

export interface CompactionAuditRecord {
  timestamp: string;
  sessionKey: string;
  trigger: CompactionTrigger;
  instructionHash: string;

  // Full ICC instruction that was injected into the compaction system prompt
  iccInstruction: string;

  // The actual text transcript of messages passed to the ICC for summarization
  iccInputTranscript?: string;

  // Three pillars — stored in full for inspection
  extractedEntities: EntityLock[];
  resolvedConflicts: ConflictResolution[];
  prioritySegments: string[];

  // Session stats at time of compaction
  tokenCount?: number;
  messageCount?: number;

  // Post-compaction verification
  entitiesPreserved?: number;
  entitiesMissing?: string[];

  // Post-compaction stats recorded by the middleware
  compactedCount?: number;
  postCompactionMessages?: number;
  postCompactionTokens?: number;

  // Exact UI-aligned savings tracking
  tokensSaved?: number;
  tokensSavedSource?: 'assistant-output-accumulated' | 'fallback-estimate';
  tokensBeforeEstimate?: number;
  tokensAfterEstimate?: number;
  firstKeptEntryId?: string;
}

export class CompactionAuditLog {
  /**
   * Append a new compaction record to the audit log.
   */
  static async append(record: CompactionAuditRecord): Promise<void> {
    try {
      await fs.ensureDir(CTX_EDIT_DIR);

      const logStr = JSON.stringify(record, null, 2) + '\n---\n';
      await fs.appendFile(AUDIT_FILE, logStr, 'utf-8');
    } catch (error) {
      logger.error('Failed to append to compaction audit log', { error });
    }
  }

  /**
   * Read the most recent N compaction records.
   * Note: This reads from the end of the file. For very large files,
   * a proper backward-streaming approach would be better, but this suffices for now.
   */
  static async readRecent(count: number, sessionKey?: string): Promise<CompactionAuditRecord[]> {
    try {
      if (!(await fs.pathExists(AUDIT_FILE))) {
        return [];
      }

      const content = await fs.readFile(AUDIT_FILE, 'utf-8');
      const blocks = content.split('\n---\n').filter((b) => b.trim().length > 0);

      const records: CompactionAuditRecord[] = [];
      for (const block of blocks) {
        try {
          records.push(JSON.parse(block));
        } catch {
          // ignore malformed blocks
        }
      }

      const filtered = sessionKey ? records.filter((r) => r.sessionKey === sessionKey) : records;

      // Return the most recent N (from end of array)
      return filtered.slice(-count).reverse();
    } catch (error) {
      logger.error('Failed to read from compaction audit log', { error });
      return [];
    }
  }

  /**
   * Read all compaction records (optionally filtered by session).
   */
  static async readAll(sessionKey?: string): Promise<CompactionAuditRecord[]> {
    try {
      if (!(await fs.pathExists(AUDIT_FILE))) {
        return [];
      }

      const content = await fs.readFile(AUDIT_FILE, 'utf-8');
      const blocks = content.split('\n---\n').filter((b) => b.trim().length > 0);

      const records: CompactionAuditRecord[] = [];
      for (const block of blocks) {
        try {
          records.push(JSON.parse(block));
        } catch {
          // ignore malformed blocks
        }
      }

      const filtered = sessionKey ? records.filter((r) => r.sessionKey === sessionKey) : records;
      return filtered.reverse();
    } catch (error) {
      logger.error('Failed to read from compaction audit log', { error });
      return [];
    }
  }

  /**
   * Get the path to the audit log file.
   */
  static getPath(): string {
    return AUDIT_FILE;
  }
}
