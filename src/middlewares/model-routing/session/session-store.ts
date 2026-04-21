/**
 * Session Store — In-memory session persistence with LRU eviction.
 *
 * Ported from ClawRouter's session concepts:
 *  - Once a model is chosen for a session, pin it unless complexity escalates
 *  - Three-strike escalation: if the same request hash repeats 3x, bump tier up
 *  - Max 1000 sessions with LRU eviction
 *  - Configurable TTL (default 30 minutes)
 */

import { Tier, TIER_ORDER } from '../types.js';

// ---------------------------------------------------------------------------
// Session store configuration
// ---------------------------------------------------------------------------

export interface SessionStoreConfig {
  /** Whether model pinning is active. When false, follow-up turns re-score
   *  and may land on different models; request hashes still flow through
   *  the store for three-strike tier escalation. */
  enabled: boolean;
  /** Session TTL in milliseconds (default: 30 minutes) */
  ttlMs: number;
  /** Maximum number of sessions to keep (LRU eviction) */
  maxSessions: number;
  /** Number of repeated request hashes before tier escalation */
  strikeThreshold: number;
}

export const DEFAULT_SESSION_STORE_CONFIG: SessionStoreConfig = {
  enabled: false,
  ttlMs: 30 * 60 * 1000, // 30 minutes
  maxSessions: 1000,
  strikeThreshold: 3,
};

// ---------------------------------------------------------------------------
// Session entry
// ---------------------------------------------------------------------------

export interface SessionEntry {
  /** Session ID */
  id: string;
  /** Pinned model for this session (once chosen) */
  pinnedModel: string | null;
  /** Pinned tier for this session */
  pinnedTier: Tier | null;
  /** Highest tier seen in this session */
  highWaterTier: Tier;
  /** Recent request hashes for three-strike detection */
  recentHashes: string[];
  /** Count of consecutive identical hashes */
  strikeCount: number;
  /** Last hash seen (for strike counting) */
  lastHash: string | null;
  /** Creation timestamp */
  createdAt: number;
  /** Last access timestamp (for TTL + LRU) */
  lastAccessedAt: number;
  /** Total requests in this session */
  requestCount: number;
}

// ---------------------------------------------------------------------------
// Pinning decision
// ---------------------------------------------------------------------------

export interface PinningDecision {
  /** Whether to use the pinned model */
  usePinned: boolean;
  /** The pinned model ID (if usePinned) */
  pinnedModel?: string;
  /** The pinned tier (if usePinned) */
  pinnedTier?: Tier;
  /** Whether a tier escalation was triggered */
  escalated: boolean;
  /** New tier after escalation (if escalated) */
  escalatedTier?: Tier;
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

export class SessionStore {
  private sessions = new Map<string, SessionEntry>();
  private config: SessionStoreConfig;

  constructor(config: SessionStoreConfig = DEFAULT_SESSION_STORE_CONFIG) {
    this.config = config;
  }

  /**
   * Get or create a session entry.
   */
  getOrCreate(sessionId: string): SessionEntry {
    let entry = this.sessions.get(sessionId);
    if (entry) {
      entry.lastAccessedAt = Date.now();
      // Move to end (most recently used) — delete + re-set
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, entry);
      return entry;
    }

    // Evict LRU if at capacity
    if (this.sessions.size >= this.config.maxSessions) {
      this.evictLRU();
    }

    entry = {
      id: sessionId,
      pinnedModel: null,
      pinnedTier: null,
      highWaterTier: 'SIMPLE',
      recentHashes: [],
      strikeCount: 0,
      lastHash: null,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      requestCount: 0,
    };
    this.sessions.set(sessionId, entry);
    return entry;
  }

  /**
   * Check pinning and three-strike escalation for a session.
   *
   * Call this AFTER scoring but BEFORE model selection.
   */
  checkPinning(sessionId: string, currentTier: Tier, requestHash: string): PinningDecision {
    const entry = this.getOrCreate(sessionId);
    entry.requestCount++;

    // ── Three-strike escalation ───────────────────────────────────────────
    let escalated = false;
    let escalatedTier: Tier | undefined;

    if (requestHash === entry.lastHash) {
      entry.strikeCount++;
    } else {
      entry.strikeCount = 1;
      entry.lastHash = requestHash;
    }

    // Track recent hashes (last 10)
    entry.recentHashes.push(requestHash);
    if (entry.recentHashes.length > 10) {
      entry.recentHashes.shift();
    }

    if (entry.strikeCount >= this.config.strikeThreshold) {
      // Bump tier up one level
      const currentIdx = TIER_ORDER.indexOf(currentTier);
      if (currentIdx < TIER_ORDER.length - 1) {
        escalatedTier = TIER_ORDER[currentIdx + 1];
        escalated = true;
        entry.strikeCount = 0; // Reset after escalation
      }
    }

    const effectiveTier = escalatedTier || currentTier;

    // ── Update high-water mark ────────────────────────────────────────────
    const currentHigh = TIER_ORDER.indexOf(entry.highWaterTier);
    const effectiveIdx = TIER_ORDER.indexOf(effectiveTier);
    if (effectiveIdx > currentHigh) {
      entry.highWaterTier = effectiveTier;
    }

    // ── Model pinning ─────────────────────────────────────────────────────
    // Pin to model once we've started, but allow escalation
    if (entry.pinnedModel && entry.pinnedTier) {
      const pinnedIdx = TIER_ORDER.indexOf(entry.pinnedTier);
      const newIdx = TIER_ORDER.indexOf(effectiveTier);

      if (newIdx > pinnedIdx) {
        // Complexity escalated — release pin
        entry.pinnedModel = null;
        entry.pinnedTier = null;
        return { usePinned: false, escalated, escalatedTier };
      }

      // Stay pinned
      return {
        usePinned: true,
        pinnedModel: entry.pinnedModel,
        pinnedTier: entry.pinnedTier,
        escalated: false,
      };
    }

    // No pin yet
    return { usePinned: false, escalated, escalatedTier };
  }

  /**
   * Pin a model to a session after successful routing.
   */
  pinModel(sessionId: string, model: string, tier: Tier): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.pinnedModel = model;
      entry.pinnedTier = tier;
    }
  }

  /**
   * Get session entry without creating one.
   */
  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get number of active sessions.
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Evict sessions that have exceeded TTL.
   */
  evictExpired(): number {
    const cutoff = Date.now() - this.config.ttlMs;
    let evicted = 0;
    for (const [id, entry] of this.sessions) {
      if (entry.lastAccessedAt < cutoff) {
        this.sessions.delete(id);
        evicted++;
      }
    }
    return evicted;
  }

  /**
   * Clear all sessions.
   */
  clear(): void {
    this.sessions.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private evictLRU(): void {
    // Map maintains insertion order; first entry is LRU
    const firstKey = this.sessions.keys().next().value;
    if (firstKey !== undefined) {
      this.sessions.delete(firstKey);
    }
  }
}
