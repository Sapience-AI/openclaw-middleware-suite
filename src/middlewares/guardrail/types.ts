/**
 * Input Guardrail Hook — Type Definitions
 * Configuration schema for prompt injection, PII detection, and content security rules
 */

export type SeverityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type DetectionAction = 'LOG' | 'WARN' | 'BLOCK';
export type RuleType = 'regex' | 'prefix' | 'heuristic';

/**
 * Confidence level determines how a rule triggers:
 * - 'high': Single match triggers detection (default for most rules)
 * - 'medium': Requires 2+ distinct category matches in same message to trigger
 */
export type ConfidenceLevel = 'high' | 'medium';

export interface DetectionRule {
  name: string;
  type: RuleType;
  pattern: string;
  severity: SeverityLevel;
  action: DetectionAction;
  enabled: boolean;
  confidence?: ConfidenceLevel; // Default: 'high' (single match triggers)
  description?: string;
}

// ── Sensitive Path Blocklist Config ─────────────────────────────

export interface SensitivePathConfig {
  enabled: boolean;
  action: DetectionAction; // BLOCK or WARN
  /** Glob-like patterns for paths that should never be read/written */
  blockedPaths: string[];
  /** Paths that are exempt from blocking (overrides blockedPaths) */
  allowedPaths: string[];
}

// ── Network Egress Control Config ──────────────────────────────

export interface EgressControlConfig {
  enabled: boolean;
  /** Default action for unlisted domains: BLOCK or WARN */
  defaultAction: DetectionAction;
  /** Domains that are allowed (supports wildcard: *.github.com) */
  allowedDomains: string[];
  /** Always block commands that send data outbound (curl -d, wget --post, etc.) */
  blockDataSending: boolean;
  /** Block connections to private/internal IPs (127.x, 10.x, 169.254.169.254, etc.) */
  blockPrivateIPs: boolean;
}

// ── Destructive Command Blocker Config ─────────────────────────

export interface DestructiveCommandConfig {
  enabled: boolean;
  action: DetectionAction; // BLOCK or WARN
  /** Additional command patterns to block (regex strings) */
  customPatterns: string[];
}

// ── Output Scrubber Config ─────────────────────────────────────

export interface OutputScrubberConfig {
  enabled: boolean;
  dryRunMode: boolean;
  /** Text that replaces scrubbed tokens (default: empty string — seamless removal) */
  replacementText: string;
  /** User-added custom regex patterns */
  customPatterns: string[];
}

export interface ScrubResult {
  /** Whether any content was modified */
  scrubbed: boolean;
  /** The (potentially modified) content */
  content: string;
  /** Total number of pattern matches replaced */
  matchCount: number;
  /** Names of pattern groups that matched */
  matchedGroups: string[];
}

// ── Content Moderation Config ──────────────────────────────────

export interface ModerationConfig {
  /**
   * Minimum severity at which a flagged user prompt is rewritten in the
   * transcript. Lower-severity flags are still audited, but the original
   * prompt is preserved (the LLM's own safety handles the refusal).
   * Default: 'CRITICAL' — only rewrite for the most severe categories.
   */
  rewriteThreshold: 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

// ── Main Guardrail Config ──────────────────────────────────────

export interface GuardrailConfig {
  version: string;
  enabled: boolean;
  dryRunMode: boolean; // If true, log violations but do not block
  unicodeNormalization: boolean; // NFKC normalize input before scanning
  entropyThreshold: number; // Shannon entropy threshold for heuristic detection (default: 4.0)
  rules: {
    promptInjection: DetectionRule[];
    pii: DetectionRule[];
    suspicious: DetectionRule[];
  };
  /** L2: Block access to sensitive file paths before the tool even opens them */
  sensitivePaths?: SensitivePathConfig;
  /** L2: Control network egress — allowlist domains, block data exfiltration */
  egressControl?: EgressControlConfig;
  /** L2: Block destructive shell commands (rm -rf, format, DROP TABLE, etc.) */
  destructiveCommands?: DestructiveCommandConfig;
  /** Output scrubber: strip internal tokens from assistant responses */
  outputScrubber?: OutputScrubberConfig;
  /** Content moderation: severity-tiered rewrite policy for flagged prompts */
  moderation?: ModerationConfig;
}

export interface GuardrailDetection {
  ruleName: string;
  ruleType: RuleType;
  severity: SeverityLevel;
  action: DetectionAction;
  confidence: ConfidenceLevel;
  matchedContent: string; // Content that matched (redacted for PII)
  matchIndex: number;
  category: 'promptInjection' | 'pii' | 'suspicious';
}
