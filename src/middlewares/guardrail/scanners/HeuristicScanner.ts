/*
 * Copyright (c) Knostic
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * This file is derived from the OpenClaw Shield project
 * (https://github.com/knostic/openclaw-shield) and has been modified for use
 * in the OpenClaw Middleware Suite.
 */

/**
 * Heuristic Scanner — entropy-based secret detection
 *
 * Finds long alphanumeric tokens (20+ chars) and calculates Shannon entropy.
 * High-entropy strings (>= threshold) are flagged as likely secrets.
 * Uses partial redaction for safe logging: "sk-****abc1".
 */

import { DetectionRule, GuardrailDetection } from '../types.js';
import { calculateEntropy } from '../analyzers/EntropyAnalyzer.js';
import { makeDetection } from '../analyzers/DetectionFactory.js';

export function scanHeuristic(
  text: string,
  rule: DetectionRule,
  category: 'promptInjection' | 'pii' | 'suspicious',
  entropyThreshold: number = 4.0
): GuardrailDetection[] {
  const detections: GuardrailDetection[] = [];
  const regex = /\b[A-Za-z0-9_\-+/]{20,}\b/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const word = match[0];
    const entropy = calculateEntropy(word);

    if (entropy >= entropyThreshold) {
      // Partial redaction for safe logging (from openclaw-shield)
      const preview = word.length > 8 ? `${word.slice(0, 3)}****${word.slice(-4)}` : '[REDACTED]';
      detections.push(makeDetection(rule, category, preview, match.index));
    }
  }

  return detections;
}
