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
 * Session Momentum — Blends recent session tier history with current scoring.
 *
 * Ported from Manifest's session momentum concept:
 *  - Tracks last 5 tiers per session (keyed by session ID)
 *  - Assigns numeric scores: SIMPLE=-0.2, STANDARD=0.0, COMPLEX=0.2, REASONING=0.4
 *  - For short messages (<30 chars), blends 30% history weight
 *  - Weight degrades linearly to 0% for messages >100 chars
 *  - Prevents erratic tier-switching mid-conversation
 */

import { Tier, TierBoundaries, ScoringResult } from '../types.js';
import { scoreToTier } from '../scoring/sigmoid.js';

// ---------------------------------------------------------------------------
// Tier numeric values for momentum calculation
// ---------------------------------------------------------------------------

const TIER_VALUES: Record<Tier, number> = {
  SIMPLE: -0.2,
  STANDARD: 0.0,
  COMPLEX: 0.2,
  REASONING: 0.4,
};

// ---------------------------------------------------------------------------
// Momentum configuration
// ---------------------------------------------------------------------------

export interface MomentumConfig {
  /** Number of recent tiers to track per session */
  historySize: number;
  /** Max blending weight for short messages (0-1) */
  maxWeight: number;
  /** Messages shorter than this get full momentum weight */
  shortChars: number;
  /** Messages longer than this get zero momentum weight */
  longChars: number;
}

export const DEFAULT_MOMENTUM_CONFIG: MomentumConfig = {
  historySize: 5,
  maxWeight: 0.3,
  shortChars: 30,
  longChars: 100,
};

// ---------------------------------------------------------------------------
// Session momentum state
// ---------------------------------------------------------------------------

interface SessionMomentum {
  tiers: Tier[];
  lastAccessedAt: number;
}

// ---------------------------------------------------------------------------
// Momentum tracker
// ---------------------------------------------------------------------------

export class MomentumTracker {
  private sessions = new Map<string, SessionMomentum>();
  private config: MomentumConfig;

  constructor(config: MomentumConfig = DEFAULT_MOMENTUM_CONFIG) {
    this.config = config;
  }

  /**
   * Record a tier decision for a session.
   */
  record(sessionId: string, tier: Tier): void {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { tiers: [], lastAccessedAt: Date.now() };
      this.sessions.set(sessionId, session);
    }

    session.tiers.push(tier);
    if (session.tiers.length > this.config.historySize) {
      session.tiers.shift();
    }
    session.lastAccessedAt = Date.now();
  }

  /**
   * Apply momentum blending to a scoring result.
   *
   * Returns the original result if no session history exists or
   * if the message is long enough that momentum has zero weight.
   */
  applyMomentum(
    sessionId: string | null,
    scoringResult: ScoringResult,
    messageLength: number,
    boundaries: TierBoundaries
  ): ScoringResult {
    if (!sessionId) return scoringResult;

    const session = this.sessions.get(sessionId);
    if (!session || session.tiers.length === 0) return scoringResult;

    // Calculate blending weight based on message length
    const weight = this.calcWeight(messageLength);
    if (weight <= 0) return scoringResult;

    // Calculate momentum score (average of recent tier values)
    const momentumScore =
      session.tiers.reduce((sum, t) => sum + TIER_VALUES[t], 0) / session.tiers.length;

    // Blend: (1 - weight) * currentScore + weight * momentumScore
    const blendedScore = (1 - weight) * scoringResult.score + weight * momentumScore;

    // Re-classify tier from blended score using configured boundaries
    const newTier = scoreToTier(blendedScore, boundaries);

    // Only apply if tier actually changed
    if (newTier === scoringResult.tier) return scoringResult;

    return {
      ...scoringResult,
      score: blendedScore,
      tier: newTier,
      reason: 'momentum',
    };
  }

  /**
   * Get the momentum history for a session.
   */
  getHistory(sessionId: string): Tier[] {
    return this.sessions.get(sessionId)?.tiers || [];
  }

  /**
   * Get number of active sessions.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Evict sessions older than the given TTL (milliseconds).
   */
  evictStale(ttlMs: number): number {
    const cutoff = Date.now() - ttlMs;
    let evicted = 0;
    for (const [id, session] of this.sessions) {
      if (session.lastAccessedAt < cutoff) {
        this.sessions.delete(id);
        evicted++;
      }
    }
    return evicted;
  }

  /**
   * Clear all session momentum data.
   */
  clear(): void {
    this.sessions.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private calcWeight(messageLength: number): number {
    if (messageLength >= this.config.longChars) return 0;
    if (messageLength >= this.config.shortChars) {
      const range = this.config.longChars - this.config.shortChars;
      const progress = (messageLength - this.config.shortChars) / range;
      return this.config.maxWeight * (1 - progress);
    }
    // Very short messages get a boost: weight ramps from maxWeight up to
    // 2×maxWeight as length → 0, matching manifest's stickier behavior on
    // one-word follow-ups like "yes" / "continue".
    return (
      this.config.maxWeight + this.config.maxWeight * (1 - messageLength / this.config.shortChars)
    );
  }
}
