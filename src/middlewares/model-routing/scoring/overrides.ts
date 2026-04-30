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
 * Overrides — Hard classification rules that bypass scoring.
 *
 * These run BEFORE the weighted scoring and short-circuit when triggered.
 * Combined from Manifest (tool floor, large context, short message) and
 * ClawRouter (reasoning keyword override).
 */

import { ScoringResult, ScoringConfig, TIER_ORDER } from '../types.js';
import { TrieMatch } from './keyword-trie.js';
import { estimateTotalTokens, ExtractionInput } from './text-extractor.js';
import { isSessionStartupMessage } from '../../../shared/session-detection.js';
import { isIccExtractionCall } from '../../../shared/icc-detection.js';

/**
 * Attempt to classify via hard overrides before running the full scorer.
 * Returns a ScoringResult if an override triggers, or null to continue
 * with normal weighted scoring.
 *
 * @param text         Extracted scoring text
 * @param trieMatches  All keyword matches from the trie scan
 * @param body         Full request body (for token estimation and tools)
 * @param config       Active scoring config
 */
export function checkOverrides(
  text: string,
  trieMatches: TrieMatch[],
  body: ExtractionInput & { tools?: unknown[]; tool_choice?: unknown },
  config: ScoringConfig
): ScoringResult | null {
  const { overrides } = config;

  // ── 0a. Context Editing ICC extraction call ─────────────────────────────
  // CE prepends ICC_EXTRACTION_MARKER to its compaction-extraction prompts
  // (see src/shared/icc-detection.ts). Without this branch, MR would score
  // the transcript content the user is compacting and routinely route the
  // call to the user's most expensive tier — wrong on every axis (the job
  // is fixed-shape JSON extraction, not user-facing chat). Force SIMPLE
  // and short-circuit before scoring runs at all.
  if (isIccExtractionCall(text)) {
    return {
      tier: 'SIMPLE',
      score: -0.5,
      confidence: 1.0,
      reason: 'icc_extraction',
      dimensions: [],
    };
  }

  // ── 0b. Session startup message ─────────────────────────────────────────
  // OpenClaw injects a generic message when user types /new or /reset.
  // This is a system instruction, not a real user prompt — always SIMPLE.
  if (isSessionStartupMessage(text)) {
    return {
      tier: 'SIMPLE',
      score: -0.4,
      confidence: 1.0,
      reason: 'session_startup',
      dimensions: [],
    };
  }

  // ── 1. Short message fast path ───────────────────────────────────────────
  // Messages under shortMessageChars with no complex keywords → SIMPLE
  if (text.length > 0 && text.length < overrides.shortMessageChars) {
    const hasComplexKeywords = trieMatches.some(
      (m) => m.dimension !== 'simpleIndicators' && m.dimension !== 'relay'
    );

    if (!hasComplexKeywords) {
      return {
        tier: 'SIMPLE',
        score: -0.3,
        confidence: 0.9,
        reason: 'short_message',
        dimensions: [],
      };
    }
  }

  // ── 2. Reasoning keyword override ────────────────────────────────────────
  // 2+ formal logic keywords → force REASONING
  const formalLogicCount = trieMatches.filter((m) => m.dimension === 'formalLogic').length;

  if (formalLogicCount >= overrides.reasoningKeywordMin) {
    return {
      tier: 'REASONING',
      score: 0.5,
      confidence: 0.95,
      reason: 'reasoning_override',
      dimensions: [],
    };
  }

  // ── 3. Large context override ────────────────────────────────────────────
  // Total message tokens > threshold → floor to COMPLEX
  const totalTokens = estimateTotalTokens(body);
  if (totalTokens > overrides.largeContextTokens) {
    return {
      tier: 'COMPLEX',
      score: 0.2,
      confidence: 0.95,
      reason: 'large_context',
      dimensions: [],
    };
  }

  return null; // No override triggered — proceed with scoring
}

/**
 * Post-scoring override: if the request requires structured output
 * (response_format set, or JSON/schema keywords in the system prompt),
 * floor the tier to at least the configured minimum.
 *
 * Ported from ClawRouter's structuredOutputMinTier override.
 */
export function applyStructuredOutputFloor(
  result: ScoringResult,
  body: { messages?: unknown[]; response_format?: unknown },
  config: ScoringConfig
): ScoringResult {
  const minTier = config.overrides.structuredOutputMinTier;
  if (!minTier) return result;

  // Detect structured output: explicit response_format or JSON/schema in system prompt
  const hasResponseFormat = body.response_format != null && body.response_format !== undefined;

  let hasStructuredSystemPrompt = false;
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages as Array<{ role?: string; content?: string }>) {
      if ((msg.role === 'system' || msg.role === 'developer') && typeof msg.content === 'string') {
        if (/json|structured|schema/i.test(msg.content)) {
          hasStructuredSystemPrompt = true;
          break;
        }
      }
    }
  }

  if (!hasResponseFormat && !hasStructuredSystemPrompt) return result;

  const currentIdx = TIER_ORDER.indexOf(result.tier);
  const minIdx = TIER_ORDER.indexOf(minTier);

  if (currentIdx < minIdx) {
    return {
      ...result,
      tier: minTier,
      reason: 'structured_output',
    };
  }

  return result;
}

/**
 * Post-scoring override: if tools are present and tool_choice != 'none',
 * floor the tier to at least STANDARD.
 */
export function applyToolFloor(
  result: ScoringResult,
  tools?: unknown[],
  toolChoice?: unknown
): ScoringResult {
  if (toolChoice === 'none') return result;

  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (!hasTools) return result;

  const currentIdx = TIER_ORDER.indexOf(result.tier);
  const standardIdx = TIER_ORDER.indexOf('STANDARD');

  if (currentIdx < standardIdx) {
    return {
      ...result,
      tier: 'STANDARD',
      reason: 'tool_floor',
    };
  }
  return result;
}
