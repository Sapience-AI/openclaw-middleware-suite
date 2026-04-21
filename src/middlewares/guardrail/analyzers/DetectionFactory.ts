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
