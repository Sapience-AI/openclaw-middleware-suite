/**
 * DecisionLog
 * Audit trail in pretty-JSON blocks delimited by '---'.
 *
 * Default output file: ~/.openclaw/sapience-ai-suite/guardrail/audit.jsonl
 * (a per-middleware audit location, kept backward-compatible via the static API)
 *
 * Pass a different path to the constructor to write to another middleware's
 * audit file.
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { logger } from '../../../shared/Logger.js';
import { GUARDRAIL_AUDIT_FILE } from '../../../shared/storage/paths.js';

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
  severity?: 'LOW' | 'HIGH' | 'CATASTROPHIC';
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
  private filePath: string;

  constructor(filePath: string = GUARDRAIL_AUDIT_FILE) {
    this.filePath = filePath;
  }

  /**
   * Append a decision record to the log (pretty-JSON blocks separated by '---')
   */
  async append(record: DecisionRecord): Promise<void> {
    try {
      await fs.ensureDir(path.dirname(this.filePath));

      const finalRecord: DecisionRecord = {
        cwd: process.cwd(),
        hostname: os.hostname(),
        pid: process.pid,
        ...record,
      };

      const line = JSON.stringify(finalRecord, null, 2) + '\n---\n';
      await fs.appendFile(this.filePath, line, 'utf8');

      logger.debug('Decision logged', { decision: record.decision, module: record.module });
    } catch (error) {
      logger.error('Failed to log decision', { error });
      // Don't throw - logging failures shouldn't break execution
    }
  }

  async readAll(): Promise<DecisionRecord[]> {
    try {
      if (!(await fs.pathExists(this.filePath))) {
        return [];
      }

      const content = await fs.readFile(this.filePath, 'utf8');
      const records: DecisionRecord[] = [];

      const blocks = content.split('\n---\n');

      for (const block of blocks) {
        const trimmedBlock = block.trim();
        if (!trimmedBlock) continue;

        try {
          records.push(JSON.parse(trimmedBlock));
        } catch {
          // Fallback: legacy JSON-Lines format
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

  async readLast(n: number): Promise<DecisionRecord[]> {
    const all = await this.readAll();
    return all.slice(-n);
  }

  getFilePath(): string {
    return this.filePath;
  }

  // ── Backward-compatible static API (uses default GUARDRAIL_AUDIT_FILE) ──

  static async append(record: DecisionRecord): Promise<void> {
    return new DecisionLog().append(record);
  }

  static async readAll(): Promise<DecisionRecord[]> {
    return new DecisionLog().readAll();
  }

  static async readLast(n: number): Promise<DecisionRecord[]> {
    return new DecisionLog().readLast(n);
  }

  static getPath(): string {
    return GUARDRAIL_AUDIT_FILE;
  }
}
