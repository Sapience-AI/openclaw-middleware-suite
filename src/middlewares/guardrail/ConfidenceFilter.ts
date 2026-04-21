/**
 * Confidence Filter — post-processing for detection results
 *
 * HIGH confidence rules: always fire on single match.
 * MEDIUM confidence rules: fire if EITHER:
 *   a) 2+ distinct categories have detections, OR
 *   b) 2+ distinct rules fired within the SAME category
 *
 * This reduces false positives from low-signal patterns like "base64" or "act as"
 * while ensuring two real same-category attacks don't cancel each other out (H3 fix).
 */

import { GuardrailDetection } from './types.js';

/**
 * Filter detections based on confidence level.
 * Returns only detections that meet their confidence threshold.
 */
export function applyConfidenceFilter(detections: GuardrailDetection[]): GuardrailDetection[] {
  // Count distinct categories that have ANY detection
  const categoriesWithAnyDetection = new Set<string>();
  for (const det of detections) {
    categoriesWithAnyDetection.add(det.category);
  }
  const totalDistinctCategories = categoriesWithAnyDetection.size;

  // Count distinct rule names per category (for same-category corroboration)
  const rulesPerCategory = new Map<string, Set<string>>();
  for (const det of detections) {
    if (!rulesPerCategory.has(det.category)) {
      rulesPerCategory.set(det.category, new Set());
    }
    rulesPerCategory.get(det.category)!.add(det.ruleName);
  }

  return detections.filter((det) => {
    if (det.confidence === 'high') {
      return true; // Always include
    }
    if (det.confidence === 'medium') {
      // Include if 2+ distinct categories triggered (cross-category signal)
      if (totalDistinctCategories >= 2) return true;

      // Include if 2+ distinct rules in the SAME category fired
      // (prevents two real attacks from cancelling each other out)
      const rulesInCategory = rulesPerCategory.get(det.category);
      if (rulesInCategory && rulesInCategory.size >= 2) return true;
    }
    return false; // Suppress: single MEDIUM rule, single category
  });
}
