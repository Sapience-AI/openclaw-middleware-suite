/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Model Routing Middleware — Type Definitions
 */

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

export type Tier = 'SIMPLE' | 'STANDARD' | 'COMPLEX' | 'REASONING';

export const TIER_ORDER: readonly Tier[] = ['SIMPLE', 'STANDARD', 'COMPLEX', 'REASONING'] as const;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type ScoringReason =
  | 'scored'
  | 'reasoning_override'
  | 'large_context'
  | 'tool_floor'
  | 'short_message'
  | 'ambiguous'
  | 'momentum'
  | 'llm_classified'
  | 'profile_override'
  | 'session_pinned'
  | 'three_strike'
  | 'structured_output'
  | 'session_startup'
  | 'icc_extraction';

export interface DimensionScore {
  name: string;
  score: number; // normalised to [-1, 1]
  weight: number;
  weighted: number; // score * weight
  signal: string | null;
}

export interface ScoringResult {
  tier: Tier;
  score: number;
  confidence: number;
  reason: ScoringReason;
  dimensions: DimensionScore[];
}

// ---------------------------------------------------------------------------
// Scoring config (keyword + structural dimensions)
// ---------------------------------------------------------------------------

export type DimensionDirection = 'up' | 'down';

export interface KeywordDimensionDef {
  kind: 'keyword';
  name: string;
  weight: number;
  direction: DimensionDirection;
  keywords: string[];
}

export interface StructuralDimensionDef {
  kind: 'structural';
  name: string;
  weight: number;
  direction: DimensionDirection;
}

export type DimensionDef = KeywordDimensionDef | StructuralDimensionDef;

export interface TierBoundaries {
  simpleStandard: number;
  standardComplex: number;
  complexReasoning: number;
}

export interface OverrideConfig {
  reasoningKeywordMin: number;
  largeContextTokens: number;
  shortMessageChars: number;
  /** Minimum tier for requests with structured output (response_format or JSON/schema in system prompt) */
  structuredOutputMinTier: Tier;
}

export interface ScoringConfig {
  dimensions: DimensionDef[];
  boundaries: TierBoundaries;
  overrides: OverrideConfig;
  confidenceSteepness: number;
  confidenceThreshold: number;
  systemPromptScoring: boolean;
  scoringMessageWindow: number;
  tokenCountThresholds: { simple: number; complex: number };
}

// ---------------------------------------------------------------------------
// Tier ↔ model mapping
// ---------------------------------------------------------------------------

export interface TierModelConfig {
  primary: string;
  fallbacks: string[];
}

// ---------------------------------------------------------------------------
// Routing decision (per-request output)
// ---------------------------------------------------------------------------

export interface RoutingDecision {
  tier: Tier;
  model: string;
  confidence: number;
  score: number;
  reason: ScoringReason;
  dimensions: DimensionScore[];
  latencyMs: number;
  fallbackFrom?: string;
  fallbackAttempts?: FallbackAttempt[];
  /** Total cost in USD for this request (input + output + cache costs combined). */
  costEstimateUsd?: number;
  /**
   * Per-request token usage and cost split, captured at response completion
   * from upstream usage data. All optional because non-streaming responses
   * with missing usage blocks (or upstream errors) leave these undefined.
   */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputCostUsd?: number;
  outputCostUsd?: number;
}

// ---------------------------------------------------------------------------
// Fallback tracking
// ---------------------------------------------------------------------------

export interface FallbackAttempt {
  model: string;
  provider: string;
  status: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Model capabilities (for fallback filtering)
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  toolCalling?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  contextWindow?: number;
  maxOutput?: number;
  toolChoice?: boolean;
  parallelToolCalls?: boolean;
  functionCalling?: boolean;
}

// ---------------------------------------------------------------------------
// Discovered model (from provider APIs)
// ---------------------------------------------------------------------------

export interface DiscoveredModel {
  id: string;
  name: string;
  provider: string;
  inputPrice?: number; // USD per million input tokens
  outputPrice?: number; // USD per million output tokens
  cacheReadPrice?: number; // USD per million cache-read tokens
  cacheWritePrice?: number; // USD per million cache-write tokens
  capabilities: ModelCapabilities;
  qualityScore?: number; // 1-5, heuristic
}

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  format: 'openai' | 'anthropic' | 'google';
}

// ---------------------------------------------------------------------------
// LLM classifier configuration
// ---------------------------------------------------------------------------

export interface ClassifierConfig {
  enabled: boolean;
  model: string;
  maxTokens: number;
  temperature: number;
  truncationChars: number;
  cacheTtlMs: number;
}

// ---------------------------------------------------------------------------
// Dedup configuration
// ---------------------------------------------------------------------------

export interface DedupConfig {
  enabled: boolean;
  ttlMs: number;
  maxBodySize: number;
}

// ---------------------------------------------------------------------------
// Stats (aggregate counters)
// ---------------------------------------------------------------------------

export interface RoutingStats {
  total: number;
  byTier: Record<Tier, number>;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Audit log entry
// ---------------------------------------------------------------------------

export interface RoutingAuditEntry {
  ts: string;
  tier: Tier;
  model: string;
  score: number;
  confidence: number;
  reason: ScoringReason;
  latencyMs: number;
  promptPreview: string;
  fallbackFrom?: string;
  provider?: string;
  profile?: string;
  sessionId?: string;
  costEstimateUsd?: number;
  cached?: boolean;
  /** Per-request token usage + cost split. Populated from upstream usage. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputCostUsd?: number;
  outputCostUsd?: number;
}
