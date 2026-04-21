/**
 * Context Editing Middleware — Type Definitions
 * Domain-specific types for Intelligent Context Curation and Adaptive Triggers.
 */

// Re-export base types for convenience
export type { Middleware, MiddlewareContext, MiddlewareResult } from '../../types.js';

// ---------------------------------------------------------------------------
// Compaction Trigger Types
// ---------------------------------------------------------------------------

/** What caused a compaction to trigger */
export type CompactionTrigger = 'token_threshold' | 'message_threshold' | 'manual';

// ---------------------------------------------------------------------------
// Entity Types
// ---------------------------------------------------------------------------

/** Categories of entities that can be extracted and locked during compaction */
export type EntityType =
  | 'api_endpoint'
  | 'variable_name'
  | 'file_path'
  | 'constant'
  | 'model_name'
  | 'code_identifier';

/** A "locked" entity that must be preserved verbatim during compaction */
export interface EntityLock {
  name: string;
  type: EntityType;
  value: string;
}

// ---------------------------------------------------------------------------
// Conflict Resolution
// ---------------------------------------------------------------------------

/** Records when an instruction was overridden and how it was resolved */
export interface ConflictResolution {
  original: string;
  override: string;
  resolved: string;
  lineRef?: number;
}

// ---------------------------------------------------------------------------
// Session Buffer (per-session tracking)
// ---------------------------------------------------------------------------

/** Per-session state tracked by the TriggerEvaluator */
export interface SessionBuffer {
  sessionKey: string;
  messageCount: number;
  estimatedTokens: number;
  toolOutputTokenBuffer: number;
  lastCompactionTimestamp: number | null;
  compactionsSinceReset: number;
  /** Message count baseline at last compaction — delta = messageCount - baseline */
  baselineMessageCount: number;
  /** Token count baseline at last compaction — delta = estimatedTokens - baseline */
  baselineTokens: number;
}

// ---------------------------------------------------------------------------
// Compaction Result
// ---------------------------------------------------------------------------

/** Output of a single compaction cycle */
export interface CompactionResult {
  trigger: CompactionTrigger;
  iccInstruction: string;
  extractedEntities: EntityLock[];
  resolvedConflicts: ConflictResolution[];
  prioritySegments: string[];
  instructionHash: string;
  timestamp: string;
  /**
   * Populated only when icc.customPrompt.enabled is true. Each top-level
   * key in the user's schema becomes a section; arrays are rendered as
   * bullet lists in the compaction summary.
   */
  dynamicSections?: Record<string, unknown[]>;
}

// ---------------------------------------------------------------------------
// Store Types
// ---------------------------------------------------------------------------

/** Persisted per-session compaction history */
export interface SessionCompactionHistory {
  sessionKey: string;
  compactionCount: number;
  lastCompactionTimestamp: string | null;
  lastInstructionHash: string | null;
  lastEntities: EntityLock[];
  lastTokensSaved?: number;
  cumulativeTokensSaved?: number;
  lastTokensBeforeEstimate?: number;
  lastTokensAfterEstimate?: number;
  lastSavingsSource?: 'assistant-output-accumulated' | 'fallback-estimate';
  /** Running total of assistant input+output usage from llm_output, consumed at compaction */
  accumulatedAssistantUsage?: number;
}

import { ContextEditingConfig } from './config.js';

/** Aggregate statistics across all sessions */
export interface ContextEditingStats {
  totalCompactions: number;
  totalEntitiesPreserved: number;
  totalConflictsResolved: number;
  sessionHistories: Record<string, SessionCompactionHistory>;
  configOverrides?: Partial<ContextEditingConfig>;
}
