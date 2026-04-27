/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Canary / Leakback Detection — L3 Guard
 *
 * Tracks content that was previously redacted and detects if it reappears
 * in later messages (the LLM regurgitating from its context window, or
 * a second tool fetch returning the same data).
 *
 * How it works:
 *   1. When content is redacted, hash the original matched text and store it
 *   2. On every subsequent message, check if any stored canary hashes appear
 *   3. If a canary is found, re-redact the content
 *
 * Storage: in-memory ring buffer (not persisted — cleared on restart).
 * Uses simple hash for fast comparison, not crypto-grade.
 *
 * Used by: before_message_write hook (guardrail-write-scanner.ts)
 */

import { logger } from '../../../shared/Logger.js';
import * as crypto from 'crypto';

const TAG = '[guard:canary]';

// ── Configuration ──────────────────────────────────────────────

/** Maximum number of canary entries to track */
const MAX_CANARIES = 500;

/** Minimum content length to track (ignore very short matches) */
const MIN_CONTENT_LENGTH = 8;

// ── Canary storage ─────────────────────────────────────────────

interface CanaryEntry {
  hash: string;
  category: string;
  originalLength: number;
  timestamp: number;
  /** First N chars for debug logging (not the full content) */
  preview: string;
}

/**
 * In-memory ring buffer of redacted content hashes.
 * Shared across all sessions (single process).
 */
const canaries: CanaryEntry[] = [];

// ── Hash function ──────────────────────────────────────────────

/**
 * Create a fast hash of content for canary tracking.
 * Uses SHA-256 truncated to 16 chars — sufficient for collision avoidance
 * in a buffer of 500 entries.
 */
function hashContent(content: string): string {
  // Normalize: lowercase, trim, collapse whitespace (prevents trivial evasion
  // by inserting extra spaces/tabs/newlines between characters)
  const normalized = content.toLowerCase().trim().replace(/\s+/g, ' ');

  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Register content that was redacted — add to canary tracking.
 * Call this AFTER redacting content so we can detect re-appearance.
 *
 * @param originalContent - The original (pre-redaction) content
 * @param category - The detection category (e.g., "pii", "promptInjection")
 */
export function registerCanary(originalContent: string, category: string): void {
  if (!originalContent || originalContent.length < MIN_CONTENT_LENGTH) return;

  const hash = hashContent(originalContent);

  // Don't add duplicates
  if (canaries.some((c) => c.hash === hash)) return;

  // Ring buffer eviction
  if (canaries.length >= MAX_CANARIES) {
    canaries.shift(); // Remove oldest
  }

  canaries.push({
    hash,
    category,
    originalLength: originalContent.length,
    timestamp: Date.now(),
    preview: originalContent.slice(0, 20).replace(/[\n\r]/g, ' '),
  });

  logger.debug(
    `${TAG} Registered canary | category=${category} | len=${originalContent.length} | total=${canaries.length}`
  );
}

/**
 * Scan content for previously redacted canary strings.
 * Returns all matches found.
 */
export interface CanaryMatch {
  hash: string;
  category: string;
  matchedText: string;
  originalLength: number;
}

/**
 * Check if content contains any previously-redacted canary strings.
 *
 * Strategy: We can't efficiently reverse a hash to check substrings,
 * so we use a sliding window approach. For each canary, we slide a window
 * of the original content length across the new content and hash each window.
 *
 * Optimization: Only check canaries whose original length <= content length.
 * Group canaries by length to minimize redundant hashing.
 */
export function detectCanaries(content: string): CanaryMatch[] {
  if (!content || content.length < MIN_CONTENT_LENGTH || canaries.length === 0) {
    return [];
  }

  const matches: CanaryMatch[] = [];
  const normalizedContent = content.toLowerCase().trim().replace(/\s+/g, ' ');

  // Group canaries by original length for efficient windowing
  const byLength = new Map<number, CanaryEntry[]>();
  for (const canary of canaries) {
    if (canary.originalLength > normalizedContent.length) continue;
    const len = canary.originalLength;
    if (!byLength.has(len)) byLength.set(len, []);
    byLength.get(len)!.push(canary);
  }

  for (const [windowSize, windowCanaries] of byLength) {
    // Build a set of hashes for this window size for O(1) lookup
    const hashSet = new Map<string, CanaryEntry>();
    for (const c of windowCanaries) {
      hashSet.set(c.hash, c);
    }

    // Slide window across content
    for (let i = 0; i <= normalizedContent.length - windowSize; i++) {
      const window = normalizedContent.slice(i, i + windowSize);
      const windowHash = hashContent(window);

      const canary = hashSet.get(windowHash);
      if (canary) {
        const matchedText = content.slice(i, i + windowSize);
        matches.push({
          hash: canary.hash,
          category: canary.category,
          matchedText,
          originalLength: canary.originalLength,
        });

        logger.info(
          `${TAG} CANARY DETECTED | category=${canary.category} | preview="${canary.preview}..." | len=${windowSize}`
        );

        // Skip past this match to avoid overlapping detections
        i += windowSize - 1;

        // Remove from set so we don't match the same canary twice
        hashSet.delete(windowHash);
      }
    }
  }

  return matches;
}

/**
 * Get the number of active canaries (for status/debug).
 */
export function getCanaryCount(): number {
  return canaries.length;
}

/**
 * Clear all canaries (for testing/reset).
 */
export function clearCanaries(): void {
  canaries.length = 0;
  logger.debug(`${TAG} All canaries cleared`);
}
