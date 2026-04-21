/**
 * Guardrail Middleware — Public API
 *
 * Re-exports the core components for external consumption.
 */

// Core engine
export { GuardrailScanner } from './GuardrailScanner.js';
export { applyConfidenceFilter } from './ConfidenceFilter.js';

// Normalizers & analyzers
export { normalizeUnicode } from './normalizers/UnicodeNormalizer.js';
export { calculateEntropy } from './analyzers/EntropyAnalyzer.js';
export { makeDetection } from './analyzers/DetectionFactory.js';

// Scanners
export { scanRegex } from './scanners/RegexScanner.js';
export { scanPrefix } from './scanners/PrefixScanner.js';
export { scanHeuristic } from './scanners/HeuristicScanner.js';

// Rules
export {
  DEFAULT_RULES,
  PROMPT_INJECTION_RULES,
  PII_RULES,
  SUSPICIOUS_RULES,
} from './rules/index.js';

// Storage
export {
  ConfigStore,
  DEFAULT_GUARDRAIL_CONFIG,
  DEFAULT_OUTPUT_SCRUBBER_CONFIG,
} from './storage/ConfigStore.js';

// Output scrubber
export { scrubMetadata, getPatternCount } from './scrubbers/MetadataScrubber.js';

// Guards
export { checkSensitivePath, DEFAULT_SENSITIVE_PATH_CONFIG } from './guards/sensitive-paths.js';
export { checkEgressControl, DEFAULT_EGRESS_CONFIG } from './guards/egress-control.js';
export {
  checkDestructiveCommand,
  DEFAULT_DESTRUCTIVE_CONFIG,
  getBuiltinPatterns,
} from './guards/destructive-commands.js';
export { detectRoleImpersonation, neutralizeImpersonation } from './guards/role-impersonation.js';
export {
  registerCanary,
  detectCanaries,
  getCanaryCount,
  clearCanaries,
} from './guards/canary-tracker.js';

// Types
export type {
  SeverityLevel,
  DetectionAction,
  RuleType,
  ConfidenceLevel,
  DetectionRule,
  GuardrailConfig,
  GuardrailDetection,
  SensitivePathConfig,
  EgressControlConfig,
  DestructiveCommandConfig,
  OutputScrubberConfig,
  ScrubResult,
} from './types.js';
