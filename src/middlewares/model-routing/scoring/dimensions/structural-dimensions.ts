/**
 * Structural Dimensions — Scores based on text structure, not keywords.
 *
 * Ported from Manifest's 9 structural dimensions. These capture complexity
 * that keyword-only analysis misses (nested lists, conditional logic, code
 * blocks, constraint density, etc.).
 */

import { DimensionScore } from '../../types.js';

// ---------------------------------------------------------------------------
// Individual structural scorers
// ---------------------------------------------------------------------------

/**
 * Token count scoring.
 * < simple threshold → -0.5, > complex threshold → 0.5, linear between.
 */
export function scoreTokenCount(
  text: string,
  thresholds: { simple: number; complex: number }
): DimensionScore {
  const estimated = Math.ceil(text.length / 4);
  let score: number;
  let signal: string;

  if (estimated < thresholds.simple) {
    score = -0.5;
    signal = `short(${estimated}t)`;
  } else if (estimated > thresholds.complex) {
    score = 0.5;
    signal = `long(${estimated}t)`;
  } else {
    // Linear interpolation from -0.5 to 0.5
    const range = thresholds.complex - thresholds.simple;
    score = -0.5 + ((estimated - thresholds.simple) / range) * 1.0;
    signal = `${estimated}t`;
  }

  return { name: 'tokenCount', score, weight: 0, weighted: 0, signal };
}

/**
 * Nested list depth — counts distinct indentation levels in list items.
 * 0 → 0, 1 → 0.3, 2 → 0.6, 3+ → 0.9
 */
export function scoreNestedListDepth(text: string): DimensionScore {
  const pattern = /^(\s+)(?:[-*+]\s|\d+[.)]\s)/gm;
  const indents = new Set<number>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    indents.add(match[1].length);
  }

  const levels = indents.size;
  let score: number;
  if (levels === 0) score = 0;
  else if (levels === 1) score = 0.3;
  else if (levels === 2) score = 0.6;
  else score = 0.9;

  return {
    name: 'nestedListDepth',
    score,
    weight: 0,
    weighted: 0,
    signal: levels > 0 ? `${levels} levels` : null,
  };
}

/**
 * Conditional logic — counts conditional patterns like "if...then", "unless", etc.
 * 0 → 0, 1 → 0.3, 2 → 0.6, 3+ → 0.9
 */
export function scoreConditionalLogic(text: string): DimensionScore {
  const patterns = [
    /if\s.+\s*then/gi,
    /otherwise/gi,
    /unless/gi,
    /depending on/gi,
    /when\s.+\s*happens/gi,
    /in case/gi,
    /provided that/gi,
    /assuming/gi,
    /given that/gi,
    /on condition/gi,
  ];

  let count = 0;
  for (const pat of patterns) {
    const matches = text.match(pat);
    if (matches) count += matches.length;
  }

  let score: number;
  if (count === 0) score = 0;
  else if (count === 1) score = 0.3;
  else if (count === 2) score = 0.6;
  else score = 0.9;

  return {
    name: 'conditionalLogic',
    score,
    weight: 0,
    weighted: 0,
    signal: count > 0 ? `${count} conditionals` : null,
  };
}

/**
 * Code-to-prose ratio — measures fraction of text inside code blocks.
 * Score = min(0.9, codeRatio * 1.5)
 */
export function scoreCodeToProse(text: string): DimensionScore {
  let codeChars = 0;

  // Fenced code blocks (triple backtick)
  const fenced = text.match(/```[\s\S]*?```/g);
  if (fenced) {
    for (const block of fenced) codeChars += block.length;
  }

  // Inline code (single backtick) at 50% weight
  const inline = text.match(/`[^`]+`/g);
  if (inline) {
    for (const span of inline) codeChars += span.length * 0.5;
  }

  if (text.length === 0) {
    return { name: 'codeToProse', score: 0, weight: 0, weighted: 0, signal: null };
  }

  const ratio = codeChars / text.length;
  const score = Math.min(0.9, ratio * 1.5);

  return {
    name: 'codeToProse',
    score,
    weight: 0,
    weighted: 0,
    signal: ratio > 0 ? `${(ratio * 100).toFixed(0)}% code` : null,
  };
}

/**
 * Constraint density — counts constraint patterns relative to word count.
 * Density < 0.5% → 0, else linear up to 0.9 at 3% density.
 */
export function scoreConstraintDensity(text: string): DimensionScore {
  const patterns = [
    /at most/gi,
    /at least/gi,
    /exactly \d+/gi,
    /no more than/gi,
    /must not/gi,
    /must be/gi,
    /should not/gi,
    /cannot exceed/gi,
    /within \d+/gi,
    /between \w+ and \w+/gi,
    /O\([^)]+\)/g,
  ];

  let constraintCount = 0;
  for (const pat of patterns) {
    const matches = text.match(pat);
    if (matches) constraintCount += matches.length;
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) {
    return { name: 'constraintDensity', score: 0, weight: 0, weighted: 0, signal: null };
  }

  const density = (constraintCount / wordCount) * 100;
  let score: number;
  if (density < 0.5) {
    score = 0;
  } else {
    // Linear interpolation from 0.5% → 0 to 3% → 0.9
    score = Math.min(0.9, ((density - 0.5) / 2.5) * 0.9);
  }

  return {
    name: 'constraintDensity',
    score,
    weight: 0,
    weighted: 0,
    signal: constraintCount > 0 ? `${constraintCount} constraints` : null,
  };
}

/**
 * Expected output length — signal words like "comprehensive", "detailed", etc.
 * 1 signal → 0.3, 2+ → 0.6, plus bonus for high max_tokens.
 */
export function scoreExpectedOutputLength(text: string, maxTokens?: number): DimensionScore {
  const signals = [
    'comprehensive',
    'detailed',
    'thorough',
    'exhaustive',
    'in-depth',
    'full report',
    'complete guide',
    'write a full',
    'cover all',
  ];

  const lower = text.toLowerCase();
  let count = 0;
  for (const s of signals) {
    if (lower.includes(s)) count++;
  }

  let score = 0;
  if (count === 1) score = 0.3;
  else if (count >= 2) score = 0.6;

  // Bonus for high max_tokens
  if (maxTokens && maxTokens > 8000) score += 0.3;
  else if (maxTokens && maxTokens > 4000) score += 0.2;

  score = Math.min(0.9, score);

  return {
    name: 'expectedOutputLength',
    score,
    weight: 0,
    weighted: 0,
    signal: count > 0 ? `${count} length signals` : null,
  };
}

/**
 * Repetition requests — detects "N variations/options/examples".
 * ≤1 → 0, 2-3 → 0.3, 4-9 → 0.6, 10+ → 0.9
 */
export function scoreRepetitionRequests(text: string): DimensionScore {
  const match = text.match(
    /(\d{1,6})\s{0,10}(variations?|options?|alternatives?|versions?|examples?|ways?\s{1,10}to|times)/i
  );

  if (!match) {
    return { name: 'repetitionRequests', score: 0, weight: 0, weighted: 0, signal: null };
  }

  const n = parseInt(match[1], 10);
  let score: number;
  if (n <= 1) score = 0;
  else if (n <= 3) score = 0.3;
  else if (n <= 9) score = 0.6;
  else score = 0.9;

  return {
    name: 'repetitionRequests',
    score,
    weight: 0,
    weighted: 0,
    signal: `${n} ${match[2]}`,
  };
}

/**
 * Tool count — how many tools are provided in the request.
 * 0 → 0, 1-2 → 0.1, 3-5 → 0.3, 6-10 → 0.6, 11+ → 0.9
 */
export function scoreToolCount(tools?: unknown[], toolChoice?: unknown): DimensionScore {
  const count = Array.isArray(tools) ? tools.length : 0;

  // If tool_choice is explicitly 'none', treat as no tools
  if (toolChoice === 'none') {
    return { name: 'toolCount', score: 0, weight: 0, weighted: 0, signal: null };
  }

  let score: number;
  if (count === 0) score = 0;
  else if (count <= 2) score = 0.1;
  else if (count <= 5) score = 0.3;
  else if (count <= 10) score = 0.6;
  else score = 0.9;

  // Bonus for specific tool_choice
  if (
    (toolChoice && typeof toolChoice === 'object') ||
    toolChoice === 'any' ||
    toolChoice === 'required'
  ) {
    score = Math.min(0.9, score + 0.2);
  }

  return {
    name: 'toolCount',
    score,
    weight: 0,
    weighted: 0,
    signal: count > 0 ? `${count} tools` : null,
  };
}

/**
 * Conversation depth — number of non-system messages.
 * ≤2 → 0, 3-5 → 0.1, 6-10 → 0.3, 11-20 → 0.5, >20 → 0.7
 */
export function scoreConversationDepth(messages?: Array<{ role?: string }>): DimensionScore {
  if (!messages) {
    return { name: 'conversationDepth', score: 0, weight: 0, weighted: 0, signal: null };
  }

  const count = messages.filter((m) => m.role !== 'system' && m.role !== 'developer').length;

  let score: number;
  if (count <= 2) score = 0;
  else if (count <= 5) score = 0.1;
  else if (count <= 10) score = 0.3;
  else if (count <= 20) score = 0.5;
  else score = 0.7;

  return {
    name: 'conversationDepth',
    score,
    weight: 0,
    weighted: 0,
    signal: count > 2 ? `${count} msgs` : null,
  };
}

// ---------------------------------------------------------------------------
// Aggregate all structural dimensions
// ---------------------------------------------------------------------------

export interface StructuralInput {
  text: string;
  messages?: Array<{ role?: string }>;
  tools?: unknown[];
  toolChoice?: unknown;
  maxTokens?: number;
  tokenCountThresholds: { simple: number; complex: number };
}

export function scoreAllStructural(input: StructuralInput): DimensionScore[] {
  return [
    scoreTokenCount(input.text, input.tokenCountThresholds),
    scoreNestedListDepth(input.text),
    scoreConditionalLogic(input.text),
    scoreCodeToProse(input.text),
    scoreConstraintDensity(input.text),
    scoreExpectedOutputLength(input.text, input.maxTokens),
    scoreRepetitionRequests(input.text),
    scoreToolCount(input.tools, input.toolChoice),
    scoreConversationDepth(input.messages),
  ];
}
