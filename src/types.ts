/**
 * Sapience AI Suite — Type Definitions
 * Base Middleware interface + shared security vocabulary
 */

// ---------------------------------------------------------------------------
// Middleware Pipeline — Base contract for all middlewares
// ---------------------------------------------------------------------------

export interface MiddlewareContext {
  toolName: string;
  moduleName: string;
  methodName: string;
  params: Record<string, unknown>;
  sessionKey?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

export interface MiddlewareResult {
  block: boolean;
  reason?: string;
  modifiedParams?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface Middleware {
  readonly name: string;
  readonly version: string;
  initialize(config: Record<string, unknown>): Promise<void>;
  beforeToolCall?(context: MiddlewareContext): Promise<MiddlewareResult>;
  afterToolCall?(context: MiddlewareContext, result: unknown): Promise<void>;
  getStatus(): { enabled: boolean; stats?: Record<string, unknown> };
  shutdown?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Security Policy — Shared vocabulary
// ---------------------------------------------------------------------------

/**
 * Security decision types
 * - ALLOW: Execute immediately without prompting
 * - DENY: Block execution and throw error
 * - ASK: Pause and request human decision
 */
export type Decision = 'ALLOW' | 'DENY' | 'ASK';

/**
 * Rule definition for a specific method
 */
export interface SecurityRule {
  action: Decision;
  description?: string; // Optional reasoning for logs and UI
  /**
   * Glob patterns for allowed paths/URLs.
   * If set, the target path/URL MUST match at least one pattern or the call is DENIED.
   * Examples: ["/workspace/**", "/tmp/**"], ["https://api.example.com/**"]
   */
  allowPaths?: string[];
  /**
   * Glob patterns for denied paths/URLs.
   * If the target path/URL matches ANY of these, the call is DENIED regardless of allowPaths.
   * Examples: ["/etc/GLOB", "~/.ssh/GLOB", "GLOB/.env"]  (GLOB = **)
   */
  denyPaths?: string[];
}

/**
 * Granular thresholds and toggles that control the severity of interventions.
 */
export interface SystemThresholds {
  /** Score (0-100) at which an action is forced to ASK human regardless of ALLOW policy. */
  forceAskIrreversibilityThreshold: number;
  /** Score (0-100) at which an action escalates to explicit CONFIRM/2FA requirement. */
  explicitConfirmIrreversibilityThreshold: number;
  /** Score (0-100) at which session semantic drift/memory risk pauses the agent execution. */
  attackPauseThreshold: number;
  /** Score (0-100) at which memory drift escalates to explicit CONFIRM/2FA requirement. */
  explicitConfirmMemoryThreshold: number;
  /** Threshold for the destructive classifier (X deletes/modifications triggering a CATASTROPHIC rating). */
  destructiveBulkThreshold: number;
  /** Whether the destructive action interception scanning is enabled. */
  destructiveGatingEnabled: boolean;
  /** Number of minor suspicious actions allowed before Level 1 trust rate limit kicks in. */
  trustRateLimitLevel1: number;
  /** Number of moderate suspicious actions before Level 2 trust rate limit kicks in. */
  trustRateLimitLevel2: number;
}

/**
 * Complete security policy structure
 */
export interface SecurityPolicy {
  defaultAction: Decision; // Fallback if no rule exists (Paranoia mode)
  systemThresholds?: SystemThresholds; // Tune security enforcement dials
  modules: {
    [moduleName: string]: {
      [methodName: string]: SecurityRule;
    };
  };
}

export interface InterventionMetadata {
  /** Force human review regardless of normal ALLOW policy (DENY remains DENY). */
  forceAsk?: boolean;
  /** Override the displayed risk description in prompts/logs. */
  overrideDescription?: string;
  /** Extra reason text appended to channel-mode approval instructions. */
  interventionReason?: string;
  /** Escalate from YES/NO to explicit confirmation token flow. */
  requiresExplicitConfirmation?: boolean;
  /** Human-readable summary of the action that needs explicit confirmation. */
  actionSummary?: string;
  /**
   * If true, channel instructions tell the agent to capture a screenshot and
   * use vision reasoning before asking for approval.
   */
  recommendScreenshotReview?: boolean;
  /** Current cooldown escalation level (0=normal, 1=heightened, 2=restricted). */
  cooldownLevel?: number;
  /** Destructive-intercept severity for UI and audit context. */
  destructiveSeverity?: 'HIGH' | 'CATASTROPHIC';
  /** Reasons from destructive classifier. */
  destructiveReasons?: string[];
  /** Optional bulk count identified by destructive classifier. */
  destructiveBulkCount?: number;
  /** Optional user-facing target (mailbox/path/host). */
  destructiveTarget?: string;
  /** Require channel approvals to come via sapience_middleware_respond (fail-secure if unavailable). */
  requiresRespondToolApproval?: boolean;
  /** True if the OOB notification failed to send, implying in-chat approval is needed. */
  oobFailed?: boolean;
  /** Score (0-100) for irreversibility. */
  irreversibilityScore?: number;
  /** Level for irreversibility (LOW, MEDIUM, HIGH, CRITICAL). */
  irreversibilityLevel?: string;
  /** Score (0-100) for memory drift/risk. */
  memoryRiskScore?: number;
  /** Memory drift score. */
  memoryRiskDrift?: number;
  /** Memory salami score. */
  memoryRiskSalami?: number;
  /** Memory commitment score. */
  memoryRiskCommitment?: number;
}

/**
 * Execution context passed to the Arbitrator
 */
export interface ExecutionContext {
  moduleName: string;
  methodName: string;
  args: unknown[];
  rule: SecurityRule;
  /** Agent ID that initiated the tool call. */
  agentId?: string;
  /** OpenClaw session key (e.g. "agent:main:whatsapp:dm:+1555…"). Present in daemon/channel mode. */
  sessionKey?: string;
  intervention?: InterventionMetadata;
  /** Called once when a tool is blocked to fire the OOB approval notification.
   *  Returns true if a notification was actually dispatched (channel context found),
   *  false if no channel is available (e.g. TUI sessions). */
  onBlockCallback?: (
    sessionKey: string,
    moduleName: string,
    methodName: string
  ) => Promise<boolean>;
}
