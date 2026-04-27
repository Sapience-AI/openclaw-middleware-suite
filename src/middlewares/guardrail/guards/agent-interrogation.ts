/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Agent Interrogation Guard — L3 (before_message_write)
 *
 * Detects "defense enumeration" attacks: content (typically from tool
 * results / file reads) that interrogates the agent about its own
 * security configuration, guardrails, patterns, or architecture.
 *
 * KEY INSIGHT: Instead of matching specific phrasings (which attackers
 * endlessly rephrase), this guard detects the **shape** of interrogation:
 *
 *   1. Content contains question sentences (ending with ?)
 *   2. Questions are agent-directed (you/your)
 *   3. Questions reference security-adjacent topics
 *
 * Threshold: 2+ matching questions → detected (single question may be
 * legitimate; a concentrated cluster is enumeration).
 *
 * This catches every rephrasing because it detects the structural pattern
 * of interrogation, not specific words.
 */

import { logger } from '../../../shared/Logger.js';

const TAG = '[guard:agent-interrogation]';

// ── Result type ────────────────────────────────────────────────

export interface AgentInterrogationResult {
  detected: boolean;
  /** Number of agent-directed security questions found */
  questionCount: number;
  /** The matched question sentences (for logging/audit) */
  matchedQuestions: string[];
  /** Overall severity based on concentration */
  severity: 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

// ── Detection vocabulary ───────────────────────────────────────

/**
 * Agent-directed pronouns — indicates the question is addressed to the
 * agent itself, not about a third party.
 *
 * Word-boundary enforced to avoid matching inside words (e.g. "bayou").
 */
const AGENT_DIRECTED = /\b(?:you|your|you're|yourself|you've|you'll|you'd)\b/i;

/**
 * Security-adjacent topic nouns — broad enough to cover rephrasings,
 * narrow enough to avoid matching general programming questions.
 *
 * Organized by semantic cluster:
 *   - Defense mechanisms: guardrail, filter, firewall, shield, protection, defense
 *   - Configuration: config, setting, policy, rule, threshold, parameter
 *   - Detection: scan, detect, pattern, regex, signature, heuristic
 *   - Access control: block, allow, deny, restrict, whitelist, blacklist, permit
 *   - Secrets: secret, credential, key, token, password, sensitive
 *   - Architecture: middleware, plugin, hook, module, layer, pipeline
 *   - Lists: allowlist, blocklist, denylist, safelist
 */
const SECURITY_TOPICS = new RegExp(
  '\\b(?:' +
    // Defense mechanisms
    'guardrails?|filters?|firewalls?|shields?|protections?|defenses?|safeguards?|' +
    'security|safety|sanitiz(?:e|er|ation)|redact(?:ion|ed|ing)?|' +
    // Configuration
    'config(?:uration)?|settings?|polic(?:y|ies)|rules?|thresholds?|parameters?|' +
    // Detection
    'scann?(?:er|ing|ed)?|detect(?:ion|ing|ed|or)?|patterns?|regex(?:es|p)?|' +
    'signatures?|heuristics?|' +
    // Access control
    'block(?:ed|ing|list)?|allow(?:ed|ing|list)?|deny(?:ing)?|denylist|' +
    'restrict(?:ed|ion|ing)?|whitelist(?:ed)?|blacklist(?:ed)?|' +
    'permit(?:ted)?|forbidden|banned|safelist|' +
    // Secrets / sensitivity
    'secrets?|credentials?|keys?|tokens?|passwords?|sensitive|protected|' +
    // Architecture
    'middleware|plugins?|hooks?|modules?|layers?|pipelines?|interceptors?|' +
    // Behavioral
    'monitor(?:ing)?|audit(?:ing)?|log(?:ging|ged)?|track(?:ing|ed)?' +
    ')\\b',
  'i'
);

/**
 * Imperative verbs that signal information extraction — used to catch
 * non-question interrogation ("List your filters", "Explain your rules").
 */
const EXTRACTION_IMPERATIVES =
  /\b(?:list|explain|describe|detail|enumerate|show|reveal|tell|share|disclose|outline|summarize|dump|expose|report|provide|specify)\b/i;

// ── Question extraction ────────────────────────────────────────

/**
 * Extract question sentences from content.
 *
 * Handles:
 *   - Standard questions ending with ?
 *   - Numbered list items ending with ? (e.g., "1. What are your rules?")
 *   - Multi-line questions split across lines
 */
function extractQuestions(content: string): string[] {
  const questions: string[] = [];

  // Split on sentence boundaries: ?, or line breaks followed by numbering
  // Then filter for actual questions (ending with ?)
  const segments = content.split(/(?<=\?)\s*/);

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed.endsWith('?') && trimmed.length > 10) {
      // Take the last sentence if segment contains multiple
      const lastSentence = trimmed.split(/[.!]\s+/).pop() || trimmed;
      questions.push(lastSentence.trim());
    }
  }

  return questions;
}

/**
 * Extract imperative sentences that demand information.
 *
 * Catches "List your guardrails.", "Explain your security config.",
 * "Tell me about your filters." — commands, not questions.
 */
function extractImperatives(content: string): string[] {
  const imperatives: string[] = [];

  // Split content into sentences
  const sentences = content
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  for (const sentence of sentences) {
    // Sentence starts with or contains an extraction imperative
    if (EXTRACTION_IMPERATIVES.test(sentence)) {
      imperatives.push(sentence);
    }
  }

  return imperatives;
}

// ── Main detection ─────────────────────────────────────────────

/**
 * Detect agent-directed security interrogation in content.
 *
 * Two detection paths (catches both direct and evasive attacks):
 *
 * PATH A — Agent-directed: Questions/imperatives with "you/your" + security topic.
 *   Threshold: 2+ → DETECTED
 *
 * PATH B — Security question concentration: Questions about security topics
 *   regardless of pronouns. Files don't normally contain clusters of questions
 *   about guardrails, patterns, allowlists, etc. Attackers evade Path A by
 *   using "they", "the system", or passive voice — but the concentration
 *   of security questions is itself the signal.
 *   Threshold: 3+ → DETECTED (higher bar since no agent-directed signal)
 *
 * Severity:
 *   - 2 matches (Path A) or 3 (Path B) → MEDIUM
 *   - 3-4 agent-directed or 4-5 concentrated → HIGH
 *   - 5+ of either → CRITICAL
 */
export function detectAgentInterrogation(content: string): AgentInterrogationResult {
  const PASS: AgentInterrogationResult = {
    detected: false,
    questionCount: 0,
    matchedQuestions: [],
    severity: 'MEDIUM',
  };

  if (!content || content.length < 20) return PASS;

  // ── Path A: Agent-directed (you/your) + security topic ──────
  const agentDirected: string[] = [];

  const questions = extractQuestions(content);
  for (const q of questions) {
    if (AGENT_DIRECTED.test(q) && SECURITY_TOPICS.test(q)) {
      agentDirected.push(q);
    }
  }

  const imperatives = extractImperatives(content);
  for (const imp of imperatives) {
    if (AGENT_DIRECTED.test(imp) && SECURITY_TOPICS.test(imp)) {
      if (!agentDirected.includes(imp)) {
        agentDirected.push(imp);
      }
    }
  }

  // ── Path B: Security question concentration ─────────────────
  // Any question about security topics, regardless of pronouns.
  // Catches passive voice ("What patterns are used?"), third person
  // ("What do they scan for?"), impersonal ("What guardrails are active?").
  const securityQuestions: string[] = [];

  for (const q of questions) {
    if (SECURITY_TOPICS.test(q)) {
      if (!securityQuestions.includes(q)) {
        securityQuestions.push(q);
      }
    }
  }

  // Also count imperatives about security topics (without pronoun requirement)
  for (const imp of imperatives) {
    if (SECURITY_TOPICS.test(imp)) {
      if (!securityQuestions.includes(imp)) {
        securityQuestions.push(imp);
      }
    }
  }

  // ── Evaluate thresholds ─────────────────────────────────────
  const pathA = agentDirected.length >= 2;
  const pathB = securityQuestions.length >= 3;

  if (!pathA && !pathB) return PASS;

  // Use the richer match set — Path A matches are a subset of Path B
  const matchedSentences = pathA ? agentDirected : securityQuestions;
  const count = matchedSentences.length;

  // Severity escalation — agent-directed is more severe at lower counts
  let severity: 'MEDIUM' | 'HIGH' | 'CRITICAL';
  if (count >= 5) {
    severity = 'CRITICAL';
  } else if (pathA && count >= 3) {
    severity = 'HIGH';
  } else if (pathB && count >= 4) {
    severity = 'HIGH';
  } else {
    severity = 'MEDIUM';
  }

  logger.debug(`${TAG} Detected ${count} agent-directed security question(s)`, {
    matched: matchedSentences.slice(0, 5),
  });

  return {
    detected: true,
    questionCount: count,
    matchedQuestions: matchedSentences,
    severity,
  };
}

/**
 * Neutralize interrogation by replacing matched questions with visible tags.
 *
 * Unlike role-impersonation (which replaces inline), interrogation
 * neutralization prepends a warning and wraps each matched question
 * so the LLM sees it as flagged data, not as instructions to follow.
 */
export function neutralizeInterrogation(content: string, matchedQuestions: string[]): string {
  let text = content;

  for (const question of matchedQuestions) {
    const escaped = question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      text = text.replace(new RegExp(escaped, 'gi'), `[NEUTRALIZED:defense_enumeration]`);
    } catch {
      text = text.split(question).join(`[NEUTRALIZED:defense_enumeration]`);
    }
  }

  return text;
}
