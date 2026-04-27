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
 * Response Cache — In-memory LRU cache for LLM responses.
 *
 * Ported from ClawRouter's caching concept:
 *  - Max 200 entries (configurable)
 *  - Default TTL: 10 minutes
 *  - Max size per entry: 1MB
 *  - Cache key: SHA-256 of { model, messages, temperature, tools }
 *  - Only caches non-streaming, deterministic responses (temperature=0)
 *  - Respects Cache-Control: no-cache header
 */

import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ResponseCacheConfig {
  /** Whether response caching is enabled */
  enabled: boolean;
  /** Maximum number of cached responses */
  maxEntries: number;
  /** Cache TTL in milliseconds */
  ttlMs: number;
  /** Maximum size per entry in bytes */
  maxEntrySize: number;
}

export const DEFAULT_RESPONSE_CACHE_CONFIG: ResponseCacheConfig = {
  enabled: false,
  maxEntries: 200,
  ttlMs: 10 * 60 * 1000, // 10 minutes
  maxEntrySize: 1_048_576, // 1MB
};

// ---------------------------------------------------------------------------
// Cached response entry
// ---------------------------------------------------------------------------

export interface CachedResponseEntry {
  /** Response status code */
  status: number;
  /** Response headers */
  headers: Record<string, string>;
  /** Response body */
  body: Buffer;
  /** When this entry was cached */
  cachedAt: number;
  /** Cache key */
  key: string;
  /** Model that generated this response */
  model: string;
}

// ---------------------------------------------------------------------------
// Response cache
// ---------------------------------------------------------------------------

export class ResponseCache {
  private cache = new Map<string, CachedResponseEntry>();
  private config: ResponseCacheConfig;

  constructor(config: ResponseCacheConfig = DEFAULT_RESPONSE_CACHE_CONFIG) {
    this.config = config;
  }

  /**
   * Check if a request is cacheable.
   *
   * Only caches:
   *  - Non-streaming requests
   *  - Deterministic responses (temperature === 0)
   *  - No Cache-Control: no-cache header
   */
  isCacheable(body: Record<string, unknown>, headers?: Record<string, string>): boolean {
    if (!this.config.enabled) return false;

    // Must not be streaming
    if (body.stream === true) return false;

    // Must be deterministic (temperature = 0)
    if (body.temperature !== 0) return false;

    // Respect Cache-Control: no-cache
    if (headers) {
      const cc = headers['cache-control'] || headers['Cache-Control'] || '';
      if (cc.includes('no-cache') || cc.includes('no-store')) return false;
    }

    return true;
  }

  /**
   * Generate a cache key from a request body.
   */
  static generateKey(body: Record<string, unknown>): string {
    const canonical = {
      model: body.model,
      messages: body.messages,
      temperature: body.temperature,
      tools: body.tools || null,
      tool_choice: body.tool_choice || null,
    };

    const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 24);

    return `rc_${hash}`;
  }

  /**
   * Get a cached response if available and not expired.
   */
  get(key: string): CachedResponseEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.cachedAt > this.config.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry;
  }

  /**
   * Store a response in the cache.
   */
  set(
    key: string,
    status: number,
    headers: Record<string, string>,
    body: Buffer,
    model: string
  ): boolean {
    if (!this.config.enabled) return false;

    // Check entry size
    if (body.length > this.config.maxEntrySize) return false;

    // Evict LRU if at capacity
    while (this.cache.size >= this.config.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      } else {
        break;
      }
    }

    this.cache.set(key, {
      status,
      headers,
      body,
      cachedAt: Date.now(),
      key,
      model,
    });

    return true;
  }

  /**
   * Evict expired entries.
   */
  evictExpired(): number {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.cachedAt > this.config.ttlMs) {
        this.cache.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  /**
   * Get cache statistics.
   */
  getStats(): { size: number; maxEntries: number; hitRate?: number } {
    return {
      size: this.cache.size,
      maxEntries: this.config.maxEntries,
    };
  }

  /**
   * Clear all cached responses.
   */
  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
