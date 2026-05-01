/*
 * Copyright (c) Knostic
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * This file is derived from the OpenClaw Shield project
 * (https://github.com/knostic/openclaw-shield) and has been modified for use
 * in the OpenClaw Middleware Suite.
 */

/**
 * Detection Factory — builds GuardrailDetection objects
 *
 * Centralizes detection construction with safe preview truncation.
 * PII matches are truncated to 12 chars to avoid leaking sensitive data in logs.
 */

import { DetectionRule, GuardrailDetection } from '../types.js';

/**
 * Build a detection object from a rule match.
 * Truncates PII previews to 12 characters for safe logging (from openclaw-shield pattern).
 */
export function makeDetection(
  rule: DetectionRule,
  category: 'promptInjection' | 'pii' | 'suspicious',
  matchedContent: string,
  matchIndex: number
): GuardrailDetection {
  const safePreview =
    category === 'pii' && matchedContent.length > 12
      ? `${matchedContent.slice(0, 12)}...`
      : matchedContent;

  return {
    ruleName: rule.name,
    ruleType: rule.type,
    severity: rule.severity,
    action: rule.action,
    confidence: rule.confidence || 'high',
    matchedContent: safePreview,
    matchIndex,
    category,
  };
}
