/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Prefix Scanner — token prefix detection
 *
 * Detects known secret prefixes (e.g. AKIA, sk-, hf_) followed by
 * 16+ alphanumeric characters with word boundary enforcement.
 */

import { DetectionRule, GuardrailDetection } from '../types.js';
import { makeDetection } from '../analyzers/DetectionFactory.js';

export function scanPrefix(
  text: string,
  rule: DetectionRule,
  category: 'promptInjection' | 'pii' | 'suspicious'
): GuardrailDetection[] {
  const detections: GuardrailDetection[] = [];
  const regex = new RegExp(`\\b${rule.pattern}[A-Za-z0-9_\\-]{16,}\\b`, 'g');

  let match;
  while ((match = regex.exec(text)) !== null) {
    detections.push(makeDetection(rule, category, match[0], match.index));
  }

  return detections;
}
