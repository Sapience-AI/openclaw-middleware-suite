/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Content Moderation Guard — L3 (before_message_write)
 *
 * Calls the OpenAI Moderation API to detect harmful content:
 *   - Violence / graphic violence
 *   - Harassment / threatening
 *   - Hate speech / threatening
 *   - Sexual content / minors
 *   - Self-harm (intent, instructions)
 *   - Illicit / illicit-violent
 *
 * Runs in PARALLEL with other L3 guards (role-impersonation, agent-interrogation,
 * canary-tracker). Each guard covers a different threat surface:
 *   - This guard  → content safety (ML-powered, catches nuance)
 *   - Other guards → structural attacks (prompt injection, defense enumeration)
 *
 * Fail-open: API errors, timeouts, or missing API key never block messages.
 *
 * Used by: before_message_write hook (GuardrailWriteScannerHook.ts)
 */

import { logger } from '../../../shared/Logger.js';
import { getOpenAIApiKey } from '../../../shared/env.js';

const TAG = '[guard:content-moderation]';

// ── Configuration ─────────────────────────────────────────────

/** Timeout for the moderation API call (ms) */
const API_TIMEOUT_MS = 3_000;

/** Minimum content length to bother sending to the API */
const MIN_CONTENT_LENGTH = 10;

/** Maximum content length to send (API limit is ~32K tokens; truncate to be safe) */
const MAX_CONTENT_LENGTH = 50_000;

// ── Result types ──────────────────────────────────────────────

export interface ModerationCategory {
  name: string;
  flagged: boolean;
  score: number;
}

export interface ContentModerationResult {
  /** Whether any category was flagged */
  flagged: boolean;
  /** All categories with their scores */
  categories: ModerationCategory[];
  /** Only the flagged categories (convenience) */
  flaggedCategories: ModerationCategory[];
  /** Source label for logging */
  source: 'openai-moderation-api';
  /** Whether the check was skipped (no API key, too short, error) */
  skipped: boolean;
  /** Reason for skipping, if skipped */
  skipReason?: string;
}

// ── Severity mapping ──────────────────────────────────────────

/**
 * Map moderation categories to severity levels.
 * Categories involving minors or direct threats are CRITICAL.
 */
function categorySeverity(categoryName: string): 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  switch (categoryName) {
    case 'sexual/minors':
    case 'hate/threatening':
    case 'harassment/threatening':
    case 'illicit/violent':
      return 'CRITICAL';
    case 'violence':
    case 'violence/graphic':
    case 'hate':
    case 'sexual':
    case 'self-harm/intent':
    case 'self-harm/instructions':
      return 'HIGH';
    default:
      return 'MEDIUM';
  }
}

/**
 * Get the overall severity from flagged categories (highest wins).
 */
export function getOverallSeverity(
  flaggedCategories: ModerationCategory[]
): 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  let overall: 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'MEDIUM';
  for (const cat of flaggedCategories) {
    const sev = categorySeverity(cat.name);
    if (sev === 'CRITICAL') return 'CRITICAL';
    if (sev === 'HIGH') overall = 'HIGH';
  }
  return overall;
}

// ── Main detection ────────────────────────────────────────────

const PASS: ContentModerationResult = {
  flagged: false,
  categories: [],
  flaggedCategories: [],
  source: 'openai-moderation-api',
  skipped: false,
};

/**
 * Check content against the OpenAI Moderation API.
 *
 * Returns immediately (fail-open) if:
 *   - OPENAI_API_KEY is not set
 *   - Content is too short to be meaningful
 *   - API call fails or times out
 */
export async function checkContentModeration(content: string): Promise<ContentModerationResult> {
  // ── Pre-flight checks ───────────────────────────────────────
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    logger.debug(`${TAG} No OPENAI_API_KEY set — skipping moderation check`);
    return {
      ...PASS,
      skipped: true,
      skipReason: 'no-api-key',
    };
  }

  if (!content || content.length < MIN_CONTENT_LENGTH) {
    return {
      ...PASS,
      skipped: true,
      skipReason: 'content-too-short',
    };
  }

  // Truncate to stay within API limits
  const truncated =
    content.length > MAX_CONTENT_LENGTH ? content.slice(0, MAX_CONTENT_LENGTH) : content;

  // ── API call ────────────────────────────────────────────────
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    const res = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: truncated }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      logger.warn(`${TAG} API returned ${res.status} — fail-open`, {
        body: body.slice(0, 200),
      });
      return {
        ...PASS,
        skipped: true,
        skipReason: `api-error-${res.status}`,
      };
    }

    const data = (await res.json()) as {
      results: Array<{
        flagged: boolean;
        categories: Record<string, boolean>;
        category_scores: Record<string, number>;
      }>;
    };

    const result = data.results?.[0];
    if (!result) {
      logger.warn(`${TAG} Empty API response — fail-open`);
      return { ...PASS, skipped: true, skipReason: 'empty-response' };
    }

    // ── Parse results ───────────────────────────────────────────
    const categories: ModerationCategory[] = Object.entries(result.categories).map(
      ([name, flagged]) => ({
        name,
        flagged,
        score: result.category_scores[name] ?? 0,
      })
    );

    const flaggedCategories = categories.filter((c) => c.flagged);

    if (flaggedCategories.length > 0) {
      const flagSummary = flaggedCategories
        .map((c) => `${c.name}(${c.score.toFixed(3)})`)
        .join(', ');
      logger.info(
        `${TAG} FLAGGED | ${flaggedCategories.length} categor${flaggedCategories.length === 1 ? 'y' : 'ies'}: ${flagSummary}`
      );
    } else {
      logger.debug(`${TAG} CLEAN — no categories flagged`);
    }

    return {
      flagged: result.flagged,
      categories,
      flaggedCategories,
      source: 'openai-moderation-api',
      skipped: false,
    };
  } catch (err: unknown) {
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';
    const reason = isTimeout ? 'timeout' : 'fetch-error';
    logger.warn(`${TAG} ${isTimeout ? 'Timeout' : 'Fetch error'} — fail-open`, {
      error: err,
    });
    return { ...PASS, skipped: true, skipReason: reason };
  }
}
