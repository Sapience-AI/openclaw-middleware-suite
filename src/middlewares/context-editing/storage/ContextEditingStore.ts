/**
 * Context Editing Middleware — Persistent State Store
 *
 * Persists middleware state in the unified config store.
 */

import { logger } from '../../../shared/Logger.js';
import {
  ContextEditingStats,
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

/** Default empty stats */
function defaultStats(): ContextEditingStats {
  return {
    totalCompactions: 0,
    totalEntitiesPreserved: 0,
    totalConflictsResolved: 0,
    sessionHistories: {},
  };
}

export class ContextEditingStore {
  private stats: ContextEditingStats = defaultStats();

  /**
   * Load state from disk synchronously.
   * Called during middleware initialization.
   */
  load(): void {
    try {
      if (existsSync(CTX_EDIT_STATS_FILE)) {
        const state = JSON.parse(readFileSync(CTX_EDIT_STATS_FILE, 'utf-8'));
        this.stats = { ...defaultStats(), ...state };
        logger.info('[ContextEditingStore] State loaded from stats file');
      } else {
        this.stats = defaultStats();
        logger.info('[ContextEditingStore] No existing state found, using defaults');
      }
    } catch (err) {
      logger.warn('[ContextEditingStore] Failed to load state, using defaults', { error: err });
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
      logger.debug('[ContextEditingStore] State saved to stats file');
    } catch (err) {
      logger.error('[ContextEditingStore] Failed to save state', { error: err });
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
   * Accumulate exact usage for an assistant turn (from llm_output hook).
   * Since llm_output doesn't provide a message ID, we simply accumulate
   * assistant input+output usage per session after the middleware gate.
   * At compaction time, all accumulated usage represents the assistant
   * turns being compacted away.
   */
  accumulateAssistantUsage(sessionKey: string, totalTokens: number): void {
    const history = this.getOrCreateSessionHistory(sessionKey);
    history.accumulatedAssistantUsage = (history.accumulatedAssistantUsage ?? 0) + totalTokens;
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
  getFullStats(): ContextEditingStats {
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
   * Reset all stats and custom configuration overrides.
   */
  reset(): void {
    this.stats = defaultStats();
    this.save();
    logger.info('[ContextEditingStore] State reset');
  }

  /**
   * Get the custom configuration overrides for thresholds and settings.
   * Reads from sapience-ai-suite.json (where the dashboard saves them),
   * NOT from the stats file.
   *
   * Transforms the flat policy fields saved by ContextEditingPolicyStore
   * (tokenThreshold, messageThreshold, pruningMode, ttl, model) into
   * the nested ContextEditingConfig shape so a shallow spread works.
   */
  getConfigOverrides(): Partial<ContextEditingConfig> {
    try {
      const store = ConfigStore.readSync();
      const ceData = store[STORE_KEY_CONTEXT_EDITING];
      const raw = (ceData?.configOverrides || {}) as Record<string, unknown>;
      if (Object.keys(raw).length === 0) return {};

      const overrides: Partial<ContextEditingConfig> = {};

      // Flat fields that map 1:1
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
   * Update the custom configuration overrides.
   * Writes to sapience-ai-suite.json under context_editing.configOverrides.
   */
  updateConfigOverrides(overrides: Partial<ContextEditingConfig>): void {
    const current = this.getConfigOverrides();
    const merged = { ...current, ...overrides };
    ConfigStore.updateSync(`${STORE_KEY_CONTEXT_EDITING}.configOverrides`, merged);
    logger.info('[ContextEditingStore] Config overrides updated', { overrides });
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
