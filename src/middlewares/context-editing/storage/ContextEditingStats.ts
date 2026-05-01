/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Context Editing Middleware — Persistent Stats Store
 *
 * Owns the middleware's runtime stats file (stats.json under the context-editing
 * dir) and a read-only translator that surfaces config overrides saved by
 * `ContextEditingPolicyStore` as the nested `Partial<ContextEditingConfig>`
 * shape the middleware needs at runtime. Config writes live on PolicyStore;
 * this class never writes to sapience-ai-suite.json.
 */

import { logger } from '../../../shared/Logger.js';
import {
  ContextEditingStatsData,
  SessionCompactionHistory,
  EntityLock,
  CompactionResult,
} from '../types.js';
import {
  CTX_EDIT_DIR,
  CTX_EDIT_STATS_FILE,
  STORE_KEY_CONTEXT_EDITING,
} from '../../../shared/storage/paths.js';
import { ConfigStore } from '../../../shared/storage/ConfigStore.js';
import { DEFAULT_CONTEXT_EDITING_CONFIG, ContextEditingConfig } from '../config.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

const VALID_TRIGGER_MODES: ReadonlyArray<ContextEditingConfig['triggerMode']> = [
  'token',
  'message',
  'both',
];

/** Default empty stats */
function defaultStats(): ContextEditingStatsData {
  return {
    totalCompactions: 0,
    totalEntitiesPreserved: 0,
    totalConflictsResolved: 0,
    sessionHistories: {},
  };
}

export class ContextEditingStats {
  private stats: ContextEditingStatsData = defaultStats();

  /**
   * Load state from disk synchronously.
   * Called during middleware initialization.
   */
  load(): void {
    try {
      if (existsSync(CTX_EDIT_STATS_FILE)) {
        const state = JSON.parse(readFileSync(CTX_EDIT_STATS_FILE, 'utf-8'));
        this.stats = { ...defaultStats(), ...state };
        logger.info('[ContextEditingStats] State loaded from stats file');
      } else {
        this.stats = defaultStats();
        logger.info('[ContextEditingStats] No existing state found, using defaults');
      }
    } catch (err) {
      logger.warn('[ContextEditingStats] Failed to load state, using defaults', { error: err });
      this.stats = defaultStats();
    }
  }

  /**
   * Save state to disk.
   * Writes to a dedicated stats.json file in the context-editing directory,
   * separate from sapience-ai-suite.json to avoid overwriting configOverrides.
   */
  save(): void {
    try {
      if (!existsSync(CTX_EDIT_DIR)) {
        mkdirSync(CTX_EDIT_DIR, { recursive: true });
      }
      writeFileSync(CTX_EDIT_STATS_FILE, JSON.stringify(this.stats, null, 2), 'utf-8');
      logger.debug('[ContextEditingStats] State saved to stats file');
    } catch (err) {
      logger.error('[ContextEditingStats] Failed to save state', { error: err });
    }
  }

  /**
   * Record a completed compaction cycle.
   */
  recordCompaction(sessionKey: string, result: CompactionResult): void {
    // Update aggregate stats
    this.stats.totalCompactions += 1;
    this.stats.totalEntitiesPreserved += result.extractedEntities.length;
    this.stats.totalConflictsResolved += result.resolvedConflicts.length;

    // Update per-session history
    const history = this.getOrCreateSessionHistory(sessionKey);
    history.compactionCount += 1;
    history.lastCompactionTimestamp = result.timestamp;
    history.lastInstructionHash = result.instructionHash;
    history.lastEntities = result.extractedEntities;

    // Auto-save after each compaction
    this.save();
  }

  /**
   * Replace the accumulated assistant usage for a session with `totalTokens`.
   *
   * On every turn, `beforeModelResolve` walks the session JSONL, sums each
   * persisted assistant message's `input + output` usage, and sets the
   * total here. `consumeAccumulatedUsage` then reads it at compaction time
   * for the UI-aligned `tokensSaved` metric.
   *
   * The pull-based JSONL-scan model replaces the previous `llm_output`
   * push that lived in this store. Each turn's read overwrites the prior
   * value with the full transcript total, so the counter is always
   * consistent with what's on disk.
   *
   * Functionally distinct from a delta-style accumulator: this method
   * recomputes the full sum each turn, so it overwrites rather than accrues.
   */
  setAccumulatedUsage(sessionKey: string, totalTokens: number): void {
    const history = this.getOrCreateSessionHistory(sessionKey);
    history.accumulatedAssistantUsage = totalTokens;
    this.save();
  }

  /**
   * Consume all accumulated assistant usage for a session, returning the
   * total. Resets the accumulator to 0. Returns null if no usage was
   * recorded (indicating fallback is needed).
   */
  consumeAccumulatedUsage(sessionKey: string): number | null {
    const history = this.getSessionHistory(sessionKey);
    if (!history || !history.accumulatedAssistantUsage) return null;

    const total = history.accumulatedAssistantUsage;
    history.accumulatedAssistantUsage = 0;
    this.save();
    return total;
  }

  /**
   * Get aggregate stats for CLI display.
   */
  getStats(): Record<string, unknown> {
    return {
      totalCompactions: this.stats.totalCompactions,
      totalEntitiesPreserved: this.stats.totalEntitiesPreserved,
      totalConflictsResolved: this.stats.totalConflictsResolved,
      sessionCount: Object.keys(this.stats.sessionHistories).length,
    };
  }

  /**
   * Get full stats object (for internal use).
   */
  getFullStats(): ContextEditingStatsData {
    return this.stats;
  }

  /**
   * Get entities from the last compaction for a specific session.
   */
  getSessionEntities(sessionKey: string): EntityLock[] {
    const history = this.stats.sessionHistories[sessionKey];
    return history?.lastEntities ?? [];
  }

  /**
   * Get session compaction history.
   */
  getSessionHistory(sessionKey: string): SessionCompactionHistory | null {
    return this.stats.sessionHistories[sessionKey] || null;
  }

  /**
   * Get all session keys with history.
   */
  getSessionKeys(): string[] {
    return Object.keys(this.stats.sessionHistories);
  }

  /**
   * Reset all stats.
   */
  reset(): void {
    this.stats = defaultStats();
    this.save();
    logger.info('[ContextEditingStats] State reset');
  }

  /**
   * Get the custom configuration overrides for thresholds and settings.
   * Reads from sapience-ai-suite.json (where the dashboard saves them),
   * NOT from the stats file.
   *
   * Transforms the flat policy fields saved by ContextEditingPolicyStore
   * (triggerMode, tokenThreshold, messageThreshold, pruningMode, ttl, model)
   * into the nested ContextEditingConfig shape so a shallow spread works.
   */
  getConfigOverrides(): Partial<ContextEditingConfig> {
    try {
      const store = ConfigStore.readSync();
      const ceData = store[STORE_KEY_CONTEXT_EDITING];
      const raw = (ceData?.configOverrides || {}) as Record<string, unknown>;
      if (Object.keys(raw).length === 0) return {};

      const overrides: Partial<ContextEditingConfig> = {};

      // Flat fields that map 1:1
      if (
        typeof raw.triggerMode === 'string' &&
        (VALID_TRIGGER_MODES as ReadonlyArray<string>).includes(raw.triggerMode)
      ) {
        overrides.triggerMode = raw.triggerMode as ContextEditingConfig['triggerMode'];
      }
      if (typeof raw.tokenThreshold === 'number') {
        overrides.tokenThreshold = raw.tokenThreshold;
      }
      if (typeof raw.messageThreshold === 'number') {
        overrides.messageThreshold = raw.messageThreshold;
      }

      // Flat pruningMode/ttl → nested pruning object
      if (raw.pruningMode !== undefined || raw.ttl !== undefined) {
        overrides.pruning = { ...DEFAULT_CONTEXT_EDITING_CONFIG.pruning };
        if (typeof raw.pruningMode === 'string') {
          overrides.pruning.enabled = raw.pruningMode === 'enabled';
          overrides.pruning.mode = raw.pruningMode === 'enabled' ? 'cache-ttl' : 'off';
        }
        if (typeof raw.ttl === 'string') {
          overrides.pruning.ttl = raw.ttl;
        }
      }

      // Flat model → nested compaction.model
      if (typeof raw.model === 'string' && raw.model) {
        overrides.compaction = { model: raw.model };
      }

      // Flat custom-prompt + messages-kept fields → nested icc subtree
      if (
        raw.customPromptEnabled !== undefined ||
        raw.customInstructions !== undefined ||
        raw.customSchema !== undefined ||
        raw.messagesKeptBeforeCompaction !== undefined
      ) {
        overrides.icc = { ...DEFAULT_CONTEXT_EDITING_CONFIG.icc };
        if (typeof raw.customPromptEnabled === 'boolean') {
          overrides.icc.customPrompt = {
            ...overrides.icc.customPrompt,
            enabled: raw.customPromptEnabled,
          };
        }
        if (typeof raw.customInstructions === 'string') {
          overrides.icc.customPrompt = {
            ...overrides.icc.customPrompt,
            instructions: raw.customInstructions,
          };
        }
        if (typeof raw.customSchema === 'string') {
          overrides.icc.customPrompt = {
            ...overrides.icc.customPrompt,
            schema: raw.customSchema,
          };
        }
        if (typeof raw.messagesKeptBeforeCompaction === 'number') {
          overrides.icc.messagesKeptBeforeCompaction = raw.messagesKeptBeforeCompaction;
        }
      }

      return overrides;
    } catch {
      return {};
    }
  }

  /**
   * Get the state file path (for CLI display).
   */
  static getPath(): string {
    return CTX_EDIT_STATS_FILE;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private getOrCreateSessionHistory(sessionKey: string): SessionCompactionHistory {
    if (!this.stats.sessionHistories[sessionKey]) {
      this.stats.sessionHistories[sessionKey] = {
        sessionKey,
        compactionCount: 0,
        lastCompactionTimestamp: null,
        lastInstructionHash: null,
        lastEntities: [],
        accumulatedAssistantUsage: 0,
      };
    }
    return this.stats.sessionHistories[sessionKey];
  }
}
