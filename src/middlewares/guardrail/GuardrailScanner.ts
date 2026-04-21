/**
 * Guardrail Scanner — core detection engine orchestrator
 *
 * Coordinates normalization, scanning, and confidence filtering.
 * Delegates to specialized scanners per rule type.
 * Wraps each step in fail-open error handling.
 */

import { GuardrailConfig, DetectionRule, GuardrailDetection } from './types.js';
import { normalizeUnicode } from './normalizers/UnicodeNormalizer.js';
import { applyConfidenceFilter } from './ConfidenceFilter.js';
import { scanRegex } from './scanners/RegexScanner.js';
import { scanPrefix } from './scanners/PrefixScanner.js';
import { scanHeuristic } from './scanners/HeuristicScanner.js';
import { logger } from '../../shared/Logger.js';

type Category = 'promptInjection' | 'pii' | 'suspicious';

export class GuardrailScanner {
  private config: GuardrailConfig;

  constructor(config: GuardrailConfig) {
    this.config = config;
  }

  /**
   * Scan text for all violations.
   * 1. Unicode normalization (if enabled)
   * 2. Run all category scanners (fail-open per category)
   * 3. Apply confidence filtering
   */
  public scan(text: string): GuardrailDetection[] {
    // Step 1: Normalize
    const scanText = this.config.unicodeNormalization ? normalizeUnicode(text) : text;

    // Step 2: Collect detections (fail-open per category)
    const rawDetections: GuardrailDetection[] = [];

    rawDetections.push(
      ...this.scanCategory(scanText, this.config.rules.promptInjection, 'promptInjection')
    );
    rawDetections.push(...this.scanCategory(scanText, this.config.rules.pii, 'pii'));
    rawDetections.push(...this.scanCategory(scanText, this.config.rules.suspicious, 'suspicious'));

    // Step 3: Confidence filter
    return applyConfidenceFilter(rawDetections);
  }

  /**
   * Scan a single category of rules. Fail-open: category failure doesn't crash.
   */
  private scanCategory(
    text: string,
    rules: DetectionRule[],
    category: Category
  ): GuardrailDetection[] {
    const detections: GuardrailDetection[] = [];

    try {
      for (const rule of rules) {
        if (!rule.enabled) continue;

        try {
          detections.push(...this.dispatchRule(text, rule, category));
        } catch (error) {
          // Fail-open: individual rule failure doesn't crash the scanner
          logger.warn(`Fail-open: rule ${rule.name} failed, skipping`, { error });
        }
      }
    } catch (error) {
      logger.warn(`Fail-open: ${category} scan failed, skipping`, { error });
    }

    return detections;
  }

  /**
   * Dispatch a single rule to the appropriate scanner.
   */
  private dispatchRule(
    text: string,
    rule: DetectionRule,
    category: Category
  ): GuardrailDetection[] {
    switch (rule.type) {
      case 'regex':
        return scanRegex(text, rule, category);
      case 'prefix':
        return scanPrefix(text, rule, category);
      case 'heuristic':
        return scanHeuristic(text, rule, category, this.config.entropyThreshold);
      default:
        logger.warn(`Unknown rule type: ${rule.type} for rule ${rule.name}`);
        return [];
    }
  }
}
