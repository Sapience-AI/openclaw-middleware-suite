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
 * Request Deduplication — Prevents double-charging on timeouts and retries.
 *
 * Ported from ClawRouter's dedup.ts:
 *  - SHA-256 hash of canonicalized request body (timestamps stripped, keys sorted)
 *  - 30-second TTL for completed responses
 *  - Inflight dedup: concurrent identical requests await the same promise
 *  - Max body size: 1MB (skip dedup for larger payloads)
 */

import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  completedAt: number;
}

interface InflightEntry {
  promise: Promise<CachedResponse>;
  resolve: (value: CachedResponse) => void;
  reject: (reason: Error) => void;
}

// ---------------------------------------------------------------------------
// Canonicalization helpers
// ---------------------------------------------------------------------------

/** Recursively sort object keys for stable hashing. */
function canonicalize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  if (typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

/** Strip timestamp patterns injected by OpenClaw (e.g. [DAY YYYY-MM-DD HH:MM TZ]). */
function stripTimestamps(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(
      /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}\s\w+\]/g,
      ''
    );
  }
  if (Array.isArray(obj)) return obj.map(stripTimestamps);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = stripTimestamps(value);
    }
    return result;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// RequestDeduplicator
// ---------------------------------------------------------------------------

export class RequestDeduplicator {
  private inflight = new Map<string, InflightEntry>();
  private completed = new Map<string, CachedResponse>();
  private readonly ttlMs: number;
  private readonly maxBodySize: number;

  constructor(ttlMs = 30_000, maxBodySize = 1_048_576) {
    this.ttlMs = ttlMs;
    this.maxBodySize = maxBodySize;
  }

  /**
   * Generate a dedup key from a request body string.
   * Canonicalizes JSON (sorts keys, strips timestamps) before hashing.
   */
  static hash(body: string): string {
    let content = body;
    try {
      const parsed = JSON.parse(body);
      const stripped = stripTimestamps(parsed);
      const canonical = canonicalize(stripped);
      content = JSON.stringify(canonical);
    } catch {
      // Not valid JSON — hash raw content
    }
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Check if a completed response exists in cache.
   */
  getCached(key: string): CachedResponse | undefined {
    const cached = this.completed.get(key);
    if (!cached) return undefined;
    if (Date.now() - cached.completedAt > this.ttlMs) {
      this.completed.delete(key);
      return undefined;
    }
    return cached;
  }

  /**
   * Check if an identical request is already in-flight.
   * Returns the inflight promise if so, or undefined.
   */
  getInflight(key: string): Promise<CachedResponse> | undefined {
    return this.inflight.get(key)?.promise;
  }

  /**
   * Mark a request as in-flight. Subsequent identical requests will
   * await the same promise via getInflight().
   */
  markInflight(key: string): void {
    let resolve!: (value: CachedResponse) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<CachedResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Attach a no-op catch to prevent unhandled rejection when
    // removeInflight() rejects with no duplicate request waiting.
    // Actual waiters (from getInflight) attach their own .then/.catch.
    promise.catch(() => {});
    this.inflight.set(key, { promise, resolve, reject });
  }

  /**
   * Complete an in-flight request: cache the response and notify waiters.
   */
  complete(key: string, result: CachedResponse): void {
    const entry = this.inflight.get(key);
    if (entry) {
      entry.resolve(result);
      this.inflight.delete(key);
    }
    this.completed.set(key, { ...result, completedAt: Date.now() });
    this.prune();
  }

  /**
   * Remove an in-flight entry on error. Rejects waiting promises with 503.
   */
  removeInflight(key: string): void {
    const entry = this.inflight.get(key);
    if (entry) {
      entry.reject(new Error('Upstream request failed'));
      this.inflight.delete(key);
    }
  }

  /**
   * Whether dedup should be skipped for this body (too large).
   */
  shouldSkip(bodyLength: number): boolean {
    return bodyLength > this.maxBodySize;
  }

  /**
   * Prune expired completed entries.
   */
  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.completed) {
      if (now - entry.completedAt > this.ttlMs) {
        this.completed.delete(key);
      }
    }
  }
}
