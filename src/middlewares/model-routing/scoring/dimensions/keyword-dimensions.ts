/*
 * Copyright (c) 2026 MNFST, Inc.
 * Copyright (c) 2026 BlockRun
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * Portions of this file are derived from the Manifest project
 * (https://github.com/mnfst/manifest) and the ClawRouter project
 * (https://github.com/BlockRunAI/ClawRouter), both used under the MIT
 * License — see NOTICE for the full license text. This file has been
 * modified for use in the OpenClaw Middleware Suite.
 */

/**
 * Keyword Dimensions — Scores text by counting trie-matched keywords.
 *
 * Ported from Manifest's keyword scoring with ClawRouter's multilingual
 * programming-syntax tokens. Uses the KeywordTrie for word-boundary-aware
 * matching — "proof" will not fire inside "waterproof", "function" will not
 * fire inside "functional", etc.
 *
 * Callers must pre-scan text with a KeywordTrie and pass the per-dimension
 * match arrays here. The scorer builds the trie once per config object and
 * scans once per request.
 */

import { DimensionScore, KeywordDimensionDef } from '../../types.js';
import { TrieMatch, applyDensityClustering } from '../keyword-trie.js';

/**
 * Score a single keyword dimension from pre-scanned trie matches.
 *
 * Scoring logic:
 *  - Count unique keyword matches for this dimension (after density clustering)
 *  - 1 match → 0.3, 2 matches → 0.6, 3+ matches → 0.9
 *  - Direction 'down' negates the score
 */
export function scoreKeywordDimension(
  matches: TrieMatch[],
  dim: KeywordDimensionDef
): DimensionScore {
  const positions = matches.map((m) => m.position);
  const effectiveCount = applyDensityClustering(positions);

  let rawScore: number;
  if (effectiveCount === 0) {
    rawScore = 0;
  } else if (effectiveCount === 1) {
    rawScore = 0.3;
  } else if (effectiveCount === 2) {
    rawScore = 0.6;
  } else {
    rawScore = 0.9;
  }

  const score = dim.direction === 'down' ? -rawScore : rawScore;
  const signal =
    matches.length > 0
      ? matches
          .slice(0, 3)
          .map((m) => m.keyword)
          .join(', ')
      : null;

  return {
    name: dim.name,
    score,
    weight: dim.weight,
    weighted: score * dim.weight,
    signal,
  };
}

/**
 * Count how many trie matches belong to a specific set of keywords.
 * Used by overrides (e.g., reasoning keyword count >= 2 → force REASONING).
 */
export function countKeywordMatches(matches: TrieMatch[], dimensionName: string): number {
  return matches.filter((m) => m.dimension === dimensionName).length;
}
