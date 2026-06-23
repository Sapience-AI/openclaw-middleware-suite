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
 * HITL StatsTracker
 * Tracks statistics about decisions in a dedicated stats file.
 *
 * Stats are runtime state, NOT user-configurable settings. They live in
 * hitl/stats.json (separate from sapience-ai-suite.json) to avoid
 * triggering ConfigStore file-watcher callbacks on every decision.
 */

import { logger } from '../../../shared/Logger.js';
import { HITL_DIR, HITL_STATS_FILE } from '../../../shared/storage/paths.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

export interface Stats {
  totalCalls: number;
  approved: number;
  rejected: number;
  blocked: number;
  allowed: number;
  avgDecisionTime: number;
  lastReset: string;
}

export class StatsTracker {
  /**
   * Load stats from disk
   */
  static async load(): Promise<Stats> {
    return this.loadSync();
  }

  /**
   * Synchronous load for dashboard and internal use.
   */
  static loadSync(): Stats {
    try {
      if (existsSync(HITL_STATS_FILE)) {
        return JSON.parse(readFileSync(HITL_STATS_FILE, 'utf-8')) as Stats;
      }
      return this.defaults();
    } catch (error) {
      logger.error('Failed to load stats', { error });
      return this.defaults();
    }
  }

  /**
   * Save stats to disk
   */
  static async save(stats: Stats): Promise<void> {
    try {
      if (!existsSync(HITL_DIR)) {
        mkdirSync(HITL_DIR, { recursive: true });
      }
      writeFileSync(HITL_STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
    } catch (error) {
      logger.error('Failed to save stats', { error });
    }
  }

  /**
   * Increment a stat counter and update average decision time
   */
  static async increment(
    decision: 'ALLOWED' | 'APPROVED' | 'REJECTED' | 'BLOCKED',
    decisionTime: number
  ): Promise<void> {
    const stats = await this.load();

    stats.totalCalls++;

    switch (decision) {
      case 'ALLOWED':
        stats.allowed++;
        break;
      case 'APPROVED':
        stats.approved++;
        break;
      case 'REJECTED':
        stats.rejected++;
        break;
      case 'BLOCKED':
        stats.blocked++;
        break;
    }

    // Update rolling average decision time
    const totalDecisionTime = stats.avgDecisionTime * (stats.totalCalls - 1) + decisionTime;
    stats.avgDecisionTime = Math.round(totalDecisionTime / stats.totalCalls);

    await this.save(stats);
  }

  /**
   * Return default stats (in-memory, never auto-persisted).
   */
  static defaults(): Stats {
    return {
      totalCalls: 0,
      approved: 0,
      rejected: 0,
      blocked: 0,
      allowed: 0,
      avgDecisionTime: 0,
      lastReset: new Date().toISOString(),
    };
  }

  /**
   * Reset all stats to zero
   */
  static async reset(): Promise<void> {
    await this.save(this.defaults());
    logger.info('Stats reset');
  }

  /**
   * Get the stats file path
   */
  static getPath(): string {
    return HITL_STATS_FILE;
  }
}
