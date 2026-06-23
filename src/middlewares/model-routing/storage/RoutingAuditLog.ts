/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Routing Audit Log — Append-only JSONL log of routing decisions.
 *
 * Follows the same pattern as DecisionLog and CompactionAuditLog:
 * one JSON object per line, appended atomically.
 */

import fs from 'fs-extra';
import { appendFileSync } from 'fs';
import { logger } from '../../../shared/Logger.js';
import { MODEL_ROUTE_AUDIT_FILE, MODEL_ROUTE_DIR } from '../../../shared/storage/paths.js';
import { RoutingAuditEntry, Tier } from '../types.js';

const AUDIT_FILE = MODEL_ROUTE_AUDIT_FILE;

export class RoutingAuditLog {
  private ensured = false;

  /**
   * Append a routing decision to the audit log.
   */
  append(entry: RoutingAuditEntry): void {
    try {
      if (!this.ensured) {
        fs.ensureDirSync(MODEL_ROUTE_DIR);
        this.ensured = true;
      }
      appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
    } catch (err) {
      logger.error('[model-routing] Failed to write audit log', { error: err });
    }
  }

  /**
   * Read the last N entries from the audit log.
   */
  readLast(n = 20): RoutingAuditEntry[] {
    try {
      if (!fs.existsSync(AUDIT_FILE)) return [];
      const content = fs.readFileSync(AUDIT_FILE, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const recent = lines.slice(-n);
      return recent.map((line) => JSON.parse(line) as RoutingAuditEntry);
    } catch (err) {
      logger.error('[model-routing] Failed to read audit log', { error: err });
      return [];
    }
  }

  /**
   * Walk the entire audit log and sum tier counters. Used by the proxy
   * handler at startup to hydrate its in-memory `RoutingStats` object so
   * cumulative counters (Requests Routed / Simple / Standard / Complex+
   * Reasoning) survive gateway restarts. The audit log is the source of
   * truth — every routed request appends one entry, and `proxy/handler.ts`
   * mirrors that into `stats.total` / `stats.byTier` for fast `/api/routing/stats`
   * reads. Without hydration, those counters reset to zero on every restart.
   *
   * Malformed lines are skipped silently — partial corruption of the audit
   * file (e.g., from a crash mid-write) shouldn't prevent startup.
   */
  computeTierCounters(): { total: number; byTier: Record<Tier, number> } {
    const counters = {
      total: 0,
      byTier: { SIMPLE: 0, STANDARD: 0, COMPLEX: 0, REASONING: 0 } as Record<Tier, number>,
    };
    try {
      if (!fs.existsSync(AUDIT_FILE)) return counters;
      const content = fs.readFileSync(AUDIT_FILE, 'utf-8');
      const lines = content.trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as RoutingAuditEntry;
          if (!entry || typeof entry !== 'object') continue;
          const tier = entry.tier;
          if (
            tier !== 'SIMPLE' &&
            tier !== 'STANDARD' &&
            tier !== 'COMPLEX' &&
            tier !== 'REASONING'
          ) {
            continue;
          }
          counters.total++;
          counters.byTier[tier]++;
        } catch {
          // Malformed line — skip and continue.
        }
      }
    } catch (err) {
      logger.error('[model-routing] Failed to compute tier counters from audit log', {
        error: err,
      });
    }
    return counters;
  }

  /**
   * Clear the audit log.
   */
  clear(): void {
    // No existsSync precheck — attempt the truncate and tolerate ENOENT.
    // Removing the precheck eliminates the TOCTOU window
    // (CodeQL js/file-system-race).
    try {
      fs.writeFileSync(AUDIT_FILE, '');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      logger.error('[model-routing] Failed to clear audit log', { error: err });
    }
  }

  static get filePath(): string {
    return AUDIT_FILE;
  }
}
