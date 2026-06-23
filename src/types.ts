/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Portions of this file (Decision, SecurityRule, SecurityPolicy,
 * InterventionMetadata, ExecutionContext) are derived from the Reins project
 * (https://github.com/pegasi-ai/reins),
 * Copyright (c) Kevin Wu and Pegasi contributors, used under Apache-2.0.
 */

/**
 * Sapience AI Suite — Type Definitions
 * Base Middleware interface + shared security vocabulary
 */

// ---------------------------------------------------------------------------
// Middleware Pipeline — Base contract for all middlewares
//
// The interface covers every OpenClaw lifecycle surface any middleware in the
// suite binds to today:
//
//   beforeToolCall      — tool-call orchestration (HITL, guardrail, PII, limits)
//   afterToolCall       — post-tool tracking (extension point — no in-suite
//                         implementer; MiddlewareRegistry.executeAfterPipeline
//                         dispatches it for embedded consumers)
//   beforeAgentStart    — turn start (guardrail prompt-guard + moderation)
//   beforeModelResolve  — earliest per-turn hook, fires before SM_A opens the
//                         JSONL (context-editing compaction pipeline runs here)
//   beforeMessageWrite  — transcript write gate (guardrail write scanner +
//                         moderation enforcement, output-guardrail scrubber)
//
// `before_prompt_build`, `agent_end`, and `llm_output` slots were dropped
// in 1.0.3: no in-suite middleware implements them, no registry runner
// dispatches them, and on openclaw ≥ 2026.4.24 the latter two are
// conversation-access-gated so they no-op for non-bundled plugins anyway.
// Consumer plugins that need those phases can register their own
// `api.on(...)` handlers directly against the OpenClaw plugin SDK.
//
// All methods except `initialize` and `getStatus` are optional — implement
// only the surfaces your middleware cares about. Every lifecycle context
// extends `LifecycleContext`, so session-scoped fields (`sessionKey`,
// `agentId`, `runId`, etc.) are accessed uniformly across events.
// ---------------------------------------------------------------------------

/**
 * Fields common to every OpenClaw lifecycle event. Event-specific contexts
 * extend this so consumers always find `sessionKey`/`agentId`/`metadata` in
 * the same place regardless of which hook fired. The open index signature
 * (`[key: string]: unknown`) lets new OpenClaw fields flow through without
 * an interface-version bump.
 */
export interface LifecycleContext {
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  sessionId?: string;
  workspaceDir?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MiddlewareContext extends LifecycleContext {
  toolName: string;
  moduleName: string;
  methodName: string;
  params: Record<string, unknown>;
}

export interface MiddlewareResult {
  block: boolean;
  reason?: string;
  modifiedParams?: Record<string, unknown>;
  /**
   * First-class "force human approval" signal. A middleware sets this to
   * `true` when it wants the orchestrator to route the call through HITL
   * (force-ASK on policy-ALLOW) even though the middleware itself doesn't
   * hard-block. HITL never emits this — it's the escalation target.
   * Guardrail's WARN detections and PII's ESCALATE-severity redactions
   * both surface through this channel so orchestrators have one consistent
   * field to read regardless of which upstream middleware fired.
   */
  escalate?: boolean;
  /** Reason shown to the human on escalation. */
  escalateReason?: string;
  metadata?: Record<string, unknown>;
}

/** `before_agent_start` normalized context — fires at the start of each turn. */
export interface AgentStartContext extends LifecycleContext {
  prompt?: unknown;
  messages?: unknown[];
}

/**
 * `before_model_resolve` normalized context — fires very early in each
 * turn, **before** the gateway opens its SessionManager (SM_A) on the
 * session JSONL. This is the only ungated, non-deprecated hook on
 * openclaw 2026.4.27+ that fires before SM_A, so it's the safe window
 * for middleware compaction (which needs to open its own SM_B and
 * append-write to the JSONL without forking the DAG).
 *
 * The event itself only carries `prompt` and `attachments` for model-
 * routing decisions; CE doesn't use those. CE reads sessionKey /
 * sessionId / agentId from the ctx and pulls the actual transcript
 * directly off disk via `SessionManager.open(sessionFile).getEntries()`.
 */
export interface ModelResolveContext extends LifecycleContext {
  prompt?: unknown;
  attachments?: unknown[];
}
export interface ModelResolveResult {
  /** Override the model id for this turn (e.g. "anthropic/claude-haiku-4-5"). */
  modelOverride?: string;
  /** Override the provider id for this turn (e.g. "anthropic"). */
  providerOverride?: string;
}
export interface AgentStartResult {
  /** Prepend string(s) to the agent's system context (used by the prompt-guard). */
  prependContext?: string[];
  /** Append a block to the system prompt (used by context-editing's ICC). */
  appendSystemContext?: string;
  /** Hard-block the turn from starting. */
  block?: boolean;
  reason?: string;
}

/** `before_message_write` normalized context — fires before any message is persisted. */
export interface MessageWriteContext extends LifecycleContext {
  content?: string;
  message?: { role?: string; content?: unknown; [key: string]: unknown };
  role?: string;
  filePath?: string;
  path?: string;
  contentLength?: number;
}
export interface MessageWriteResult {
  /** Replace the persisted message (redact / rewrite). */
  message?: unknown;
  /** Drop the message entirely. */
  block?: boolean;
  reason?: string;
}

export interface Middleware {
  readonly name: string;
  readonly version: string;
  initialize(config: Record<string, unknown>): Promise<void>;

  // ── Tool-call pipeline ────────────────────────────────────────────────
  beforeToolCall?(context: MiddlewareContext): Promise<MiddlewareResult>;
  afterToolCall?(context: MiddlewareContext, result: unknown): Promise<void>;

  // ── OpenClaw lifecycle events ────────────────────────────────────────
  beforeAgentStart?(context: AgentStartContext): Promise<AgentStartResult | void>;
  beforeModelResolve?(context: ModelResolveContext): Promise<ModelResolveResult | void>;
  beforeMessageWrite?(
    context: MessageWriteContext
  ): MessageWriteResult | undefined | Promise<MessageWriteResult | undefined>;

  // ── Lifecycle / reporting ────────────────────────────────────────────
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
