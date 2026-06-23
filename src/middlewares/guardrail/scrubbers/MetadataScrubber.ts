/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Metadata Scrubber — Output scrubber for assistant-role messages
 *
 * Strips internal middleware artifacts from assistant-role messages
 * before they enter the conversation transcript. Four pattern groups:
 *
 *   1. Middleware tokens — [HITL:...], DENY_REASON:, [GUARDRAIL], etc.
 *   2. Reasoning artifacts — <thinking>, <scratchpad>, <internal>, etc.
 *   3. Architecture internals — config paths, hook names, module IDs
 *   4. Instruction reflection — agent explaining its own defenses
 *
 * All patterns are pre-compiled at module load time for performance.
 * Budget: <5ms per call on a 10KB message.
 */

import { OutputScrubberConfig, ScrubResult } from '../types.js';
import { logger } from '../../../shared/Logger.js';

const TAG = '[guardrail:output-scrubber]';

// ── Pattern groups ───────────────────────────────────────────────

interface PatternGroup {
  name: string;
  patterns: RegExp[];
}

/**
 * Group 1: Middleware tokens
 * Internal tokens that leak middleware state into user-facing responses.
 */
const MIDDLEWARE_TOKENS: RegExp[] = [
  /\[SapienceMiddleware:[^\]]*\]/g,
  /\[HITL:[^\]]*\]/g,
  /\[GUARDRAIL\][^\n]*/g,
  /\[OPERATOR[^\]]*\]/g,
  /\[NEUTRALIZED:[^\]]*\]/g,
  /\[REDACTED:[^\]]*\]/g,
  /\[ESCALATION REQUIRED\][^\n]*/g,
  /DENY_REASON:\s*\S+/g,
  /INTERNAL_ID:\s*\S+/g,
  /\[guard:[^\]]*\]/g,
];

/**
 * Group 2: Reasoning artifacts
 * Chain-of-thought XML tags that should never appear in output.
 * Uses non-greedy matching to handle nested content.
 */
const REASONING_ARTIFACTS: RegExp[] = [
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /<scratchpad>[\s\S]*?<\/scratchpad>/gi,
  /<internal>[\s\S]*?<\/internal>/gi,
  /<reflection>[\s\S]*?<\/reflection>/gi,
  /<chain_of_thought>[\s\S]*?<\/chain_of_thought>/gi,
  /<reasoning>[\s\S]*?<\/reasoning>/gi,
  /<inner_monologue>[\s\S]*?<\/inner_monologue>/gi,
];

/**
 * Group 3: Architecture internals
 * Config paths, hook names, and module identifiers that reveal
 * internal structure. Skip matches inside code blocks.
 */
const ARCHITECTURE_INTERNALS: RegExp[] = [
  /~\/\.openclaw\/[^\s"'\])+]*/g,
  /sapience-ai-suite/gi,
  /sapience-guardrail/gi,
  /sapience-output-guardrail/gi,
];

/**
 * Group 4: Instruction reflection
 * The agent explaining its own guardrails / system prompt / defenses.
 * This teaches attackers what's blocked so they can craft bypasses.
 */
const INSTRUCTION_REFLECTION: RegExp[] = [
  /(?:my|the)\s+(?:system\s+)?(?:prompt|instructions?)\s+(?:says?|tells?|instructs?|requires?|prevents?|blocks?)\s+(?:me\s+)?(?:to|that|from)\s+[^.!?\n]{5,}[.!?]?/gi,
  /(?:I(?:'m| am)\s+)?(?:configured|programmed|instructed|designed|built|set up)\s+to\s+(?:not|never|always|block|prevent|deny|reject|refuse)\s+[^.!?\n]{5,}[.!?]?/gi,
  /(?:my|the)\s+(?:security|guardrail|safety|middleware|filter)\s+(?:policy|system|layer|module|config(?:uration)?)\s+(?:says?|prevents?|blocks?|doesn't allow|won't allow|restricts?)\s+[^.!?\n]{5,}[.!?]?/gi,
  /I\s+(?:was|have been)\s+(?:told|instructed|configured|programmed)\s+(?:to\s+)?(?:not|never)\s+[^.!?\n]{5,}[.!?]?/gi,
  /(?:my|the)\s+(?:defense|detection|blocking)\s+(?:mechanism|strategy|approach|system)\s+[^.!?\n]{5,}[.!?]?/gi,
];

// ── Pre-compiled pattern groups ──────────────────────────────────

const PATTERN_GROUPS: PatternGroup[] = [
  { name: 'middleware-tokens', patterns: MIDDLEWARE_TOKENS },
  { name: 'reasoning-artifacts', patterns: REASONING_ARTIFACTS },
  { name: 'architecture-internals', patterns: ARCHITECTURE_INTERNALS },
  { name: 'instruction-reflection', patterns: INSTRUCTION_REFLECTION },
];

// ── Code block detection ─────────────────────────────────────────

/**
 * Find all code block ranges (``` fenced) so we can skip scrubbing inside them.
 * Returns array of [start, end] index pairs.
 */
function findCodeBlockRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const fence = /```/g;
  let match: RegExpExecArray | null;
  let openIndex: number | null = null;

  while ((match = fence.exec(text)) !== null) {
    if (openIndex === null) {
      openIndex = match.index;
    } else {
      ranges.push([openIndex, match.index + 3]);
      openIndex = null;
    }
  }

  return ranges;
}

/**
 * Check if a position falls inside any code block.
 */
function isInsideCodeBlock(pos: number, ranges: [number, number][]): boolean {
  for (const [start, end] of ranges) {
    if (pos >= start && pos < end) return true;
  }
  return false;
}

// ── Main scrub function ──────────────────────────────────────────

/**
 * Scrub internal metadata from assistant message content.
 *
 * Skips matches inside code blocks (``` fenced) to avoid
 * breaking legitimate code discussion.
 *
 * @param content - The assistant message content
 * @param config - Output scrubber configuration
 * @returns ScrubResult with modified content and match details
 */
export function scrubMetadata(content: string, config: OutputScrubberConfig): ScrubResult {
  if (!content || content.length === 0) {
    return { scrubbed: false, content, matchCount: 0, matchedGroups: [] };
  }

  const codeBlockRanges = findCodeBlockRanges(content);
  const replacement = config.replacementText;
  const matchedGroups = new Set<string>();
  let totalMatches = 0;
  let text = content;

  for (const group of PATTERN_GROUPS) {
    for (const pattern of group.patterns) {
      // Reset regex state (global flag)
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      const replacements: { start: number; end: number; original: string }[] = [];

      while ((match = regex.exec(text)) !== null) {
        if (!isInsideCodeBlock(match.index, codeBlockRanges)) {
          replacements.push({
            start: match.index,
            end: match.index + match[0].length,
            original: match[0],
          });
        }
        // Prevent infinite loops on zero-length matches
        if (match[0].length === 0) regex.lastIndex++;
      }

      if (replacements.length > 0) {
        // Apply replacements in reverse order to preserve indices
        for (let i = replacements.length - 1; i >= 0; i--) {
          const r = replacements[i];
          text = text.slice(0, r.start) + replacement + text.slice(r.end);
        }
        totalMatches += replacements.length;
        matchedGroups.add(group.name);
      }
    }

    // Recalculate code block ranges after modifications
    // (positions may have shifted due to replacements)
    if (totalMatches > 0 && group !== PATTERN_GROUPS[PATTERN_GROUPS.length - 1]) {
      codeBlockRanges.length = 0;
      codeBlockRanges.push(...findCodeBlockRanges(text));
    }
  }

  // Clean up artifacts: collapse multiple blank lines left by removals
  if (totalMatches > 0) {
    text = text.replace(/\n{3,}/g, '\n\n').trim();
  }

  const scrubbed = totalMatches > 0;

  if (scrubbed) {
    logger.debug(
      `${TAG} Scrubbed ${totalMatches} match(es) | groups: ${[...matchedGroups].join(', ')}`
    );
  }

  // Also process custom patterns from config
  if (config.customPatterns.length > 0) {
    for (const patternStr of config.customPatterns) {
      try {
        const customRegex = new RegExp(patternStr, 'gi');
        let customMatch: RegExpExecArray | null;
        let customCount = 0;

        while ((customMatch = customRegex.exec(text)) !== null) {
          if (!isInsideCodeBlock(customMatch.index, findCodeBlockRanges(text))) {
            customCount++;
          }
          if (customMatch[0].length === 0) customRegex.lastIndex++;
        }

        if (customCount > 0) {
          // Re-run replacement outside code blocks
          const customRegex2 = new RegExp(patternStr, 'gi');
          const customReplacements: { start: number; end: number }[] = [];
          let cm: RegExpExecArray | null;
          const currentRanges = findCodeBlockRanges(text);

          while ((cm = customRegex2.exec(text)) !== null) {
            if (!isInsideCodeBlock(cm.index, currentRanges)) {
              customReplacements.push({ start: cm.index, end: cm.index + cm[0].length });
            }
            if (cm[0].length === 0) customRegex2.lastIndex++;
          }

          for (let i = customReplacements.length - 1; i >= 0; i--) {
            const r = customReplacements[i];
            text = text.slice(0, r.start) + replacement + text.slice(r.end);
          }
          totalMatches += customCount;
          matchedGroups.add('custom');
        }
      } catch {
        // Invalid pattern — skip silently (already validated at config load)
      }
    }
  }

  return {
    scrubbed: totalMatches > 0,
    content: text,
    matchCount: totalMatches,
    matchedGroups: [...matchedGroups],
  };
}

/**
 * Get the total number of built-in patterns (for status display).
 */
export function getPatternCount(): { builtin: number; groups: string[] } {
  let total = 0;
  const groups: string[] = [];
  for (const group of PATTERN_GROUPS) {
    total += group.patterns.length;
    groups.push(`${group.name} (${group.patterns.length})`);
  }
  return { builtin: total, groups };
}
