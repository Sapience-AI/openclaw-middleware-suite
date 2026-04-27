/*
 * Copyright (c) 2026 MNFST, Inc.
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * This file is derived from the Manifest project
 * (https://github.com/mnfst/manifest) and has been modified for use in
 * the OpenClaw Middleware Suite.
 *
 * Used under the MIT License — see NOTICE for the full license text.
 */

/**
 * Sigmoid — Score-to-tier mapping and confidence calculation.
 *
 * Ported from Manifest (k=8, boundaries at -0.1 / 0.08 / 0.35)
 * with configurable parameters.
 */

import { Tier, TierBoundaries } from '../types.js';

/**
 * Map a raw weighted score to a tier based on configurable boundaries.
 */
export function scoreToTier(score: number, b: TierBoundaries): Tier {
  if (score < b.simpleStandard) return 'SIMPLE';
  if (score < b.standardComplex) return 'STANDARD';
  if (score < b.complexReasoning) return 'COMPLEX';
  return 'REASONING';
}

/**
 * Calculate confidence as a sigmoid of the distance from the nearest boundary.
 *
 * At a boundary (distance=0), confidence = 0.5 (maximally uncertain).
 * As distance increases, confidence → 1.0.
 *
 * @param score       Raw weighted score
 * @param b           Tier boundaries
 * @param steepness   Sigmoid steepness (default 8)
 * @returns           Confidence in [0.5, 1.0]
 */
export function calcConfidence(score: number, b: TierBoundaries, steepness = 8): number {
  const boundaries = [b.simpleStandard, b.standardComplex, b.complexReasoning];

  // Distance to nearest boundary
  let minDist = Infinity;
  for (const boundary of boundaries) {
    const dist = Math.abs(score - boundary);
    if (dist < minDist) minDist = dist;
  }

  return 1 / (1 + Math.exp(-steepness * minDist));
}
