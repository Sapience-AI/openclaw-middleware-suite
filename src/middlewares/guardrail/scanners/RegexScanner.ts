/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Regex Scanner — pattern-based rule matching
 *
 * Executes global regex against input text.
 * Handles zero-length match protection to prevent infinite loops.
 *
 * SECURITY: Each regex has a step-count deadline to prevent ReDoS.
 * If a regex exceeds the step limit, it is treated as a match (fail-closed)
 * to prevent attackers from using ReDoS as a bypass.
 */

import { DetectionRule, GuardrailDetection } from '../types.js';
import { makeDetection } from '../analyzers/DetectionFactory.js';
import { logger } from '../../../shared/Logger.js';

/** Maximum time (ms) a single regex may run before being killed. */
const REGEX_TIMEOUT_MS = 50;

/** Maximum number of matches per rule to prevent excessive processing. */
const MAX_MATCHES_PER_RULE = 100;

/**
 * Run a regex with a time deadline. Returns matches found, or null if
 * the regex timed out / exceeded limits.
 *
 * On timeout, the caller should treat it as a detection (fail-closed)
 * so that crafted ReDoS payloads cannot bypass scanning.
 */
function execWithTimeout(
  regex: RegExp,
  text: string,
  deadlineMs: number
): { matches: RegExpExecArray[]; timedOut: boolean } {
  const matches: RegExpExecArray[] = [];
  const deadline = Date.now() + deadlineMs;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match);

    // Prevent infinite loops on zero-length matches
    if (match[0].length === 0) regex.lastIndex++;

    // Cap total matches
    if (matches.length >= MAX_MATCHES_PER_RULE) break;

    // Check deadline
    if (Date.now() > deadline) {
      logger.warn(
        `[regex-scanner] Regex timed out after ${deadlineMs}ms | pattern="${regex.source.slice(0, 60)}…" | matches so far=${matches.length}`
      );
      return { matches, timedOut: true };
    }
  }

  return { matches, timedOut: false };
}

export function scanRegex(
  text: string,
  rule: DetectionRule,
  category: 'promptInjection' | 'pii' | 'suspicious'
): GuardrailDetection[] {
  const detections: GuardrailDetection[] = [];

  let regex: RegExp;
  try {
    regex = new RegExp(rule.pattern, 'gi');
  } catch {
    // Pattern won't compile — fail-closed: report as detection
    logger.warn(
      `[regex-scanner] Pattern won't compile — treating as detection | rule="${rule.name}"`
    );
    detections.push(makeDetection(rule, category, '[regex-compile-error]', 0));
    return detections;
  }

  const { matches, timedOut } = execWithTimeout(regex, text, REGEX_TIMEOUT_MS);

  for (const match of matches) {
    detections.push(makeDetection(rule, category, match[0], match.index));
  }

  // Fail-closed: if regex timed out and found no matches yet,
  // report a synthetic detection so the content isn't silently passed
  if (timedOut && detections.length === 0) {
    logger.warn(
      `[regex-scanner] Regex timeout with no matches — injecting synthetic detection | rule="${rule.name}"`
    );
    detections.push(makeDetection(rule, category, '[regex-timeout:possible-redos]', 0));
  }

  return detections;
}
