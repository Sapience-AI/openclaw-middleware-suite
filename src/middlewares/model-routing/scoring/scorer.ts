/**
 * Scorer — Main scoring entry point.
 *
 * Orchestrates text extraction, 23-dimension scoring, overrides, sigmoid
 * confidence, and tier classification. Runs in <2ms with zero external calls.
 */

import { ScoringResult, ScoringConfig, DimensionScore, KeywordDimensionDef } from '../types.js';
import { extractText, ExtractionInput } from './text-extractor.js';
import { scoreKeywordDimension } from './dimensions/keyword-dimensions.js';
import { scoreAllStructural } from './dimensions/structural-dimensions.js';
import { checkOverrides, applyToolFloor, applyStructuredOutputFloor } from './overrides.js';
import { scoreToTier, calcConfidence } from './sigmoid.js';
import { KeywordTrie } from './keyword-trie.js';

// ---------------------------------------------------------------------------
// Trie cache — rebuilt only when config reference changes (hot-reload safe)
// ---------------------------------------------------------------------------

const trieCache = new WeakMap<ScoringConfig, KeywordTrie>();

function getOrBuildTrie(config: ScoringConfig): KeywordTrie {
  if (!trieCache.has(config)) {
    const keywordDims = config.dimensions.filter(
      (d): d is KeywordDimensionDef => d.kind === 'keyword'
    );
    trieCache.set(
      config,
      new KeywordTrie(keywordDims.map((d) => ({ name: d.name, keywords: d.keywords })))
    );
  }
  return trieCache.get(config)!;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScoreRequestInput {
  /** The full request body (messages, tools, etc.) */
  body: ExtractionInput & {
    tools?: unknown[];
    tool_choice?: unknown;
    max_tokens?: number;
    response_format?: unknown;
  };
  /** Optional config override (for hot-reload) */
  config?: ScoringConfig;
}

/**
 * Score a chat completion request and return a tier classification.
 */
export function scoreRequest(
  input: ScoreRequestInput,
  defaultConfig: ScoringConfig
): ScoringResult {
  const config = input.config || defaultConfig;

  // ── Extract text ─────────────────────────────────────────────────────────
  const text = extractText(input.body, config.scoringMessageWindow, config.systemPromptScoring);

  // ── Trie scan (once per request) ─────────────────────────────────────────
  const trie = getOrBuildTrie(config);
  const trieMatches = trie.scan(text);

  // ── Check hard overrides first ───────────────────────────────────────────
  const override = checkOverrides(text, trieMatches, input.body, config);
  if (override) {
    // Session startup messages are system instructions, not real user prompts.
    // Skip tool/structured-output floors that would escalate the tier —
    // otherwise hasTools always pushes session_startup from SIMPLE to STANDARD.
    if (override.reason === 'session_startup') {
      return override;
    }
    let result = applyToolFloor(override, input.body.tools, input.body.tool_choice);
    result = applyStructuredOutputFloor(result, input.body as any, config);
    return result;
  }

  // ── Score keyword dimensions ─────────────────────────────────────────────
  const keywordDims = config.dimensions.filter(
    (d): d is KeywordDimensionDef => d.kind === 'keyword'
  );

  const keywordScores: DimensionScore[] = keywordDims.map((dim) => {
    const dimMatches = trieMatches.filter((m) => m.dimension === dim.name);
    return scoreKeywordDimension(dimMatches, dim);
  });

  // ── Score structural dimensions ──────────────────────────────────────────
  const structuralScores = scoreAllStructural({
    text,
    messages: input.body.messages,
    tools: input.body.tools,
    toolChoice: input.body.tool_choice,
    maxTokens: input.body.max_tokens,
    tokenCountThresholds: config.tokenCountThresholds,
  });

  // Attach weights from config to structural scores
  const structuralDims = config.dimensions.filter((d) => d.kind === 'structural');
  for (const ss of structuralScores) {
    const dimDef = structuralDims.find((d) => d.name === ss.name);
    if (dimDef) {
      ss.weight = dimDef.weight;
      if (dimDef.direction === 'down') {
        ss.score = -Math.abs(ss.score);
      }
      ss.weighted = ss.score * ss.weight;
    }
  }

  // ── Combine all dimensions ───────────────────────────────────────────────
  const allDimensions = [...keywordScores, ...structuralScores];

  let score = 0;
  for (const dim of allDimensions) {
    score += dim.weighted;
  }

  // ── Map to tier ──────────────────────────────────────────────────────────
  const tier = scoreToTier(score, config.boundaries);
  const confidence = calcConfidence(score, config.boundaries, config.confidenceSteepness);

  let result: ScoringResult = {
    tier,
    score,
    confidence,
    reason: 'scored',
    dimensions: allDimensions,
  };

  // ── Ambiguity check ──────────────────────────────────────────────────────
  if (confidence < config.confidenceThreshold) {
    result = {
      ...result,
      tier: 'STANDARD',
      reason: 'ambiguous',
    };
  }

  // ── Tool floor ───────────────────────────────────────────────────────────
  result = applyToolFloor(result, input.body.tools, input.body.tool_choice);

  // ── Structured output floor ─────────────────────────────────────────────
  result = applyStructuredOutputFloor(result, input.body as any, config);

  return result;
}
