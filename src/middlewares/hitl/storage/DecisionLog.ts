/*
 * Copyright (c) Kevin Wu and Pegasi contributors
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * This file is derived from the Reins project (https://github.com/pegasi-ai/reins)
 * and has been modified for use in the OpenClaw Middleware Suite.
 */

/**
 * Sapience Middleware DecisionLog
 * Audit trail in JSON Lines format (~/.openclaw/sapience-middleware/decisions.jsonl)
 */

import fs from 'fs-extra';
import os from 'os';
import { logger } from '../../../shared/Logger.js';
import { HITL_DECISIONS_FILE, HITL_DIR } from '../../../shared/storage/paths.js';

const DECISIONS_FILE = HITL_DECISIONS_FILE;

export interface DecisionRecord {
  timestamp: string;
  module: string;
  method: string;
  args: unknown[];
  decision: 'ALLOWED' | 'APPROVED' | 'REJECTED' | 'BLOCKED';
  userId?: string;
  agentId?: string;
  sessionKey?: string;
  decisionTime: number; // milliseconds
  reason?: string;
  eventType?:
    | 'destructive_detected'
    | 'approval_requested'
    | 'approval_decision'
    | 'tool_executed'
    | 'tool_blocked';
  tool?: string;
  severity?: 'HIGH' | 'CATASTROPHIC';
  reasons?: string[];
  bulkCount?: number;
  target?: string;
  argsHash?: string;
  summary?: string;
  requireToken?: string;
  approved?: boolean;
  decisionInput?: 'yes' | 'allow' | 'no' | 'confirm';
  confirmation?: string;
  // Comprehensive audit fields
  cwd?: string;
  hostname?: string;
  pid?: number;
  irreversibilityScore?: number;
  irreversibilityLevel?: string;
  memoryRiskScore?: number;
  memoryRiskDrift?: number;
  memoryRiskSalami?: number;
  memoryRiskCommitment?: number;
  cooldownLevel?: number;
}

export class DecisionLog {
  /**
   * Append a decision record to the log (Supports both JSON Lines and Pretty JSON blocks)
   */
  static async append(record: DecisionRecord): Promise<void> {
    try {
      await fs.ensureDir(HITL_DIR);

      // Enrich record with system context if not provided
      const finalRecord: DecisionRecord = {
        cwd: process.cwd(),
        hostname: os.hostname(),
        pid: process.pid,
        ...record,
      };

      // Append as Pretty JSON with a delimiter
      const line = JSON.stringify(finalRecord, null, 2) + '\n---\n';
      await fs.appendFile(DECISIONS_FILE, line, 'utf8');

      logger.debug('Decision logged', { decision: record.decision, module: record.module });
    } catch (error) {
      logger.error('Failed to log decision', { error });
      // Don't throw - logging failures shouldn't break execution
    }
  }

  /**
   * Read all decisions from the log
   */
  static async readAll(): Promise<DecisionRecord[]> {
    try {
      if (!(await fs.pathExists(DECISIONS_FILE))) {
        return [];
      }

      const content = await fs.readFile(DECISIONS_FILE, 'utf8');
      const records: DecisionRecord[] = [];

      // Split by the new delimiter '---'
      const blocks = content.split('\n---\n');

      for (const block of blocks) {
        const trimmedBlock = block.trim();
        if (!trimmedBlock) continue;

        try {
          // Try parsing the entire block (new pretty JSON format)
          records.push(JSON.parse(trimmedBlock));
        } catch {
          // Fallback: block might contain legacy JSON Lines (or mix of them)
          const lines = trimmedBlock.split('\n');
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('{') && trimmedLine.endsWith('}')) {
              try {
                records.push(JSON.parse(trimmedLine));
              } catch {
                // Ignore unparseable lines
              }
            }
          }
        }
      }

      return records;
    } catch (error) {
      logger.error('Failed to read decision log', { error });
      return [];
    }
  }

  /**
   * Read the last N decisions
   */
  static async readLast(n: number): Promise<DecisionRecord[]> {
    const all = await this.readAll();
    return all.slice(-n);
  }

  /**
   * Get the decision log file path
   */
  static getPath(): string {
    return DECISIONS_FILE;
  }
}
