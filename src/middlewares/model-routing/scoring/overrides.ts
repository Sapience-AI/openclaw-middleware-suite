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
 * Post-scoring override: if the caller has explicitly requested structured
 * output via `response_format`, floor the tier to at least the configured
 * minimum (`structuredOutputMinTier`).
 *
 * Why only `response_format` and not "json/schema/structured" keywords in
 * the system prompt: the scoring pipeline deliberately excludes system /
 * developer / custom roles via `extractText` (text-extractor.ts:42-44) so
 * scaffolding doesn't pollute routing. This override previously walked
 * past that filter to inspect system messages with a regex, which on
 * OpenClaw fired on essentially every chat call — bootstrap files
 * (SOUL.md, USER.md, tool descriptions) routinely mention "json",
 * "schema", or "structured" in unrelated contexts. Net effect was that
 * simple chat consistently landed STANDARD via `structured_output`.
 *
 * `response_format` is the unambiguous API-level signal that the caller
 * needs JSON output — that stays as the floor trigger. Genuine structured-
 * output usage still fires the floor; OpenClaw chat (no response_format
 * ever set) does not.
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

  // Only fire on explicit response_format. The system-prompt keyword
  // heuristic was removed — see the file-top doc for the rationale.
  if (body.response_format == null) return result;

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
 * Post-scoring override: floor the tier to at least STANDARD when the
 * request shows evidence the agent has *actually* called tools in this
 * conversation — not merely that tools are listed as available.
 *
 * The distinction matters because OpenClaw sends its full tool inventory
 * on every chat turn. Treating "tools listed" as the floor trigger fires
 * on every turn regardless of whether the agent uses any, defeating
 * SIMPLE-tier routing for normal chat.
 *
 * Tool-usage evidence detected in `body.messages`:
 *   - OpenAI / openai-compatible:
 *       - any `role: 'tool'` message (a tool's response being fed back)
 *       - any `role: 'assistant'` message with non-empty `tool_calls[]`
 *   - Anthropic:
 *       - any content block with `type: 'tool_use'` (assistant called a tool)
 *       - any content block with `type: 'tool_result'` (tool output being
 *         fed back)
 *
 * The floor is bypassed entirely when `tool_choice === 'none'` (caller
 * has explicitly disabled tool use for this request).
 */
export function applyToolFloor(
  result: ScoringResult,
  body: { tools?: unknown[]; tool_choice?: unknown; messages?: unknown[] }
): ScoringResult {
  if (body.tool_choice === 'none') return result;

  // No tools listed → trivially no floor (the conversation can't have
  // tool-call evidence either, since there were no tools to call).
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (!hasTools) return result;

  // Tools listed but never used → don't floor. The scorer's tier wins.
  if (!Array.isArray(body.messages) || !hasToolCallEvidence(body.messages)) {
    return result;
  }

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

/**
 * Detect evidence in a chat-completion `messages[]` array that the agent
 * has invoked tools in this conversation. See `applyToolFloor` for the
 * full list of detected shapes.
 *
 * Returns on the first match — typical conversations either have many
 * matches or none, so this is cheap in both extremes.
 */
function hasToolCallEvidence(messages: unknown[]): boolean {
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as Record<string, unknown>;

    // OpenAI: a `role: 'tool'` message is a tool result being sent back
    // for synthesis — definitive evidence the agent already called a tool.
    if (m.role === 'tool') return true;

    // OpenAI: assistant message that emitted tool_calls. The next LLM
    // turn after this needs to synthesize their results.
    if (
      m.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      (m.tool_calls as unknown[]).length > 0
    ) {
      return true;
    }

    // Anthropic: tool_use / tool_result content blocks.
    if (Array.isArray(m.content)) {
      for (const block of m.content as unknown[]) {
        if (!block || typeof block !== 'object') continue;
        const t = (block as Record<string, unknown>).type;
        if (t === 'tool_use' || t === 'tool_result') return true;
      }
    }
  }
  return false;
}
