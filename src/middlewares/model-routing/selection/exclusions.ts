/*
 * Copyright (c) 2026 BlockRun
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * This file is derived from the ClawRouter project
 * (https://github.com/BlockRunAI/ClawRouter) and has been modified for use
 * in the OpenClaw Middleware Suite.
 *
 * Used under the MIT License — see NOTICE for the full license text.
 */

/**
 * Model Exclusion — Filter models based on user-defined exclusion list.
 *
 * Ported from ClawRouter's exclude-models.ts:
 *  - Supports exact model IDs and glob-style prefixes (e.g. "gpt-4*")
 *  - Safety net: if ALL models in a chain are excluded, ignore the list
 *  - Persistent via ModelRoutingPolicyStore
 */

// ---------------------------------------------------------------------------
// Exclusion matching
// ---------------------------------------------------------------------------

/**
 * Check if a model ID matches an exclusion pattern.
 * Supports exact match and prefix glob (e.g. "gpt-4*").
 */
function matchesExclusion(modelId: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return modelId.startsWith(pattern.slice(0, -1));
  }
  return modelId === pattern;
}

/**
 * Check if a model is excluded by any pattern in the exclusion list.
 */
export function isExcluded(modelId: string, exclusions: string[]): boolean {
  return exclusions.some((pattern) => matchesExclusion(modelId, pattern));
}

// ---------------------------------------------------------------------------
// Chain filtering
// ---------------------------------------------------------------------------

/**
 * Filter a model chain by the exclusion list.
 * Safety net: if all models would be excluded, returns the original chain.
 */
export function filterByExcludeList(models: string[], exclusions: string[]): string[] {
  if (exclusions.length === 0) return models;

  const filtered = models.filter((m) => !isExcluded(m, exclusions));
  // Safety net: never return empty chain
  return filtered.length > 0 ? filtered : models;
}
