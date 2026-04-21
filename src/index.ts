#!/usr/bin/env node

/**
 * Sapience AI Suite — Public API Exports
 * Re-exports from shared/ and middlewares/hitl/ for backward compatibility
 */
import { Command } from 'commander';
import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';
import { registerHitlCommands } from './middlewares/hitl/cli/index.js';
import { registerContextEditingCommands } from './middlewares/context-editing/cli/index.js';
import { registerModelRoutingCommands } from './middlewares/model-routing/cli/index.js';
import { registerGuardrailCommands } from './middlewares/guardrail/cli/index.js';
// output-guardrail CLI consolidated into guardrail CLI (sai guardrail output ...)
import { registerPiiSanitizerCommands } from './middlewares/pii-sanitizer/cli/index.js';
import { registerToolCallLimitCommands } from './middlewares/tool-call-limit/cli/index.js';
import { registerGeneralCommands } from './shared/cli/index.js';

// Middleware Pipeline
export { MiddlewareRegistry } from './shared/config.js';

// Core HITL Components
export { Interceptor } from './middlewares/hitl/Interceptor.js';
export { Arbitrator } from './middlewares/hitl/approval/Arbitrator.js';
export { approvalQueue } from './middlewares/hitl/approval/ApprovalQueue.js';
export { logger, LOG_PATH, SAPIENCE_MW_DATA_DIR } from './shared/Logger.js';

// HITL Middleware Class
export { HitlMiddleware } from './middlewares/hitl/index.js';

// Storage
export { PolicyStore } from './middlewares/hitl/storage/PolicyStore.js';
export type { PersistedPolicy } from './middlewares/hitl/storage/PolicyStore.js';
export { DecisionLog } from './middlewares/hitl/storage/DecisionLog.js';
export type { DecisionRecord } from './middlewares/hitl/storage/DecisionLog.js';
export { StatsTracker } from './middlewares/hitl/storage/StatsTracker.js';
export type { Stats } from './middlewares/hitl/storage/StatsTracker.js';
export { BrowserSessionStore } from './middlewares/hitl/storage/BrowserSessionStore.js';
export type { SessionInjectionResult } from './middlewares/hitl/storage/BrowserSessionStore.js';

// Plugin
export { default as SapienceMiddlewarePlugin } from './plugin/index.js';
export type { SapienceMiddlewareConfig } from './plugin/index.js';
export { SapienceMiddlewareManifest } from './plugin/index.js';
export type { SapienceMiddlewarePluginManifest } from './plugin/index.js';
export {
  createToolCallHook,
  getToolMapping,
  getProtectedModules,
} from './middlewares/hitl/tool-interceptor.js';

export {
  isOpenClawInstalled,
  loadOpenClawConfig,
  saveOpenClawConfig,
  registerPlugin,
  unregisterPlugin,
  isPluginRegistered,
  getPluginMiddlewaresConfig,
  setPluginMiddlewaresConfig,
  getPluginMiddlewaresConfigSync,
} from './plugin/config-manager.js';

// Configuration
export { DEFAULT_POLICY } from './middlewares/hitl/config.js';

// Detection + Risk Scoring
export { detectBrowserChallenge } from './middlewares/hitl/scoring/BrowserChallengeDetector.js';
export type { BrowserChallengeSignal } from './middlewares/hitl/scoring/BrowserChallengeDetector.js';
export {
  classifyDestructiveAction,
  hashArgs,
} from './middlewares/hitl/scoring/DestructiveClassifier.js';
export type {
  DestructiveClassification,
  DestructiveSeverity,
} from './middlewares/hitl/scoring/DestructiveClassifier.js';
export { scoreIrreversibility } from './middlewares/hitl/scoring/IrreversibilityScorer.js';
export type { IrreversibilityAssessment } from './middlewares/hitl/scoring/IrreversibilityScorer.js';
export { MemoryRiskForecaster } from './middlewares/hitl/scoring/MemoryRiskForecaster.js';
export type {
  MemoryRiskAssessment,
  SimulatedPath,
} from './middlewares/hitl/scoring/MemoryRiskForecaster.js';
export {
  trustRateLimiter,
  TrustRateLimiter,
} from './middlewares/hitl/approval/TrustRateLimiter.js';
export type {
  EscalationLevel,
  TrustRateLimiterState,
} from './middlewares/hitl/approval/TrustRateLimiter.js';

// Context Editing Middleware
export { ContextEditingMiddleware } from './middlewares/context-editing/index.js';
export { DEFAULT_CONTEXT_EDITING_CONFIG } from './middlewares/context-editing/config.js';
export type { ContextEditingConfig } from './middlewares/context-editing/config.js';
export type {
  CompactionTrigger,
  CompactionResult,
  SessionBuffer,
  EntityLock,
  ConflictResolution,
} from './middlewares/context-editing/types.js';

// Model Routing Middleware
export { ModelRoutingMiddleware } from './middlewares/model-routing/index.js';
export {
  DEFAULT_MODEL_ROUTING_CONFIG,
  DEFAULT_SCORING_CONFIG,
  DEFAULT_CLASSIFIER_CONFIG,
  DEFAULT_DEDUP_CONFIG,
} from './middlewares/model-routing/config.js';
export type { ModelRoutingConfig } from './middlewares/model-routing/config.js';
export { scoreRequest } from './middlewares/model-routing/scoring/scorer.js';
export { classifyWithLLM } from './middlewares/model-routing/scoring/llm-classifier.js';
export { RequestDeduplicator } from './middlewares/model-routing/cache/dedup.js';
export { ResponseCache } from './middlewares/model-routing/cache/response-cache.js';
export type { ResponseCacheConfig } from './middlewares/model-routing/cache/response-cache.js';
export { discoverAllModels } from './middlewares/model-routing/providers/discovery.js';
export { autoAssignTiers } from './middlewares/model-routing/selection/auto-assign.js';
export { resolveProvider } from './middlewares/model-routing/providers/registry.js';

// Phase 4: Session Intelligence
export { MomentumTracker } from './middlewares/model-routing/session/momentum.js';
export type { MomentumConfig } from './middlewares/model-routing/session/momentum.js';
export { SessionStore } from './middlewares/model-routing/session/session-store.js';
export type {
  SessionStoreConfig,
  SessionEntry,
  PinningDecision,
} from './middlewares/model-routing/session/session-store.js';
export {
  PROFILE_CONFIGS,
  VALID_PROFILES,
  isValidProfile,
} from './middlewares/model-routing/selection/profiles.js';
export type { RoutingProfile } from './middlewares/model-routing/selection/profiles.js';

// Phase 5: Production Hardening
export { CostTracker } from './middlewares/model-routing/storage/cost-tracker.js';
export type {
  CostAlertConfig,
  CostEvent,
  CostSummary,
} from './middlewares/model-routing/storage/cost-tracker.js';
export { PluginRegistry } from './middlewares/model-routing/plugins/types.js';
export type { RouterPlugin, AfterForwardEvent } from './middlewares/model-routing/plugins/types.js';

export type {
  Tier,
  ScoringResult,
  RoutingDecision,
  RoutingStats,
  DimensionScore,
  DiscoveredModel,
  ProviderConfig,
  ClassifierConfig,
  DedupConfig,
  ModelCapabilities,
  FallbackAttempt,
} from './middlewares/model-routing/types.js';

// Guardrail Middleware
export { GuardrailScanner } from './middlewares/guardrail/GuardrailScanner.js';
export { ConfigStore as GuardrailConfigStore } from './middlewares/guardrail/storage/ConfigStore.js';
export type {
  GuardrailConfig,
  GuardrailDetection,
  DetectionRule,
} from './middlewares/guardrail/types.js';

// Output Guardrail (consolidated into guardrail middleware)
export { scrubMetadata, getPatternCount } from './middlewares/guardrail/index.js';
export { ConfigStore as OutputGuardrailConfigStore } from './middlewares/guardrail/storage/ConfigStore.js';
export type {
  OutputScrubberConfig as OutputGuardrailConfig,
  ScrubResult,
} from './middlewares/guardrail/types.js';

// PII Sanitizer Middleware
export { PiiSanitizerMiddleware } from './middlewares/pii-sanitizer/index.js';
export type { DlpPolicy, DlpDetection, DlpRule } from './middlewares/pii-sanitizer/types.js';

// Tool Call Limit Middleware
export { ToolCallLimitMiddleware } from './middlewares/tool-call-limit/index.js';
export type {
  LimitPolicy,
  LimitRule,
  EnforcementStatus,
} from './middlewares/tool-call-limit/types.js';

// PII Patterns (owned by pii-sanitizer, shared with guardrail)
export { PII_PATTERNS } from './middlewares/pii-sanitizer/pii-patterns.js';
export type {
  PiiPatternKey,
  PiiPatternSpec,
  PiiSeverity,
} from './middlewares/pii-sanitizer/pii-patterns.js';

// Guardrail DecisionLog (audit trail for guardrail hooks)
export { DecisionLog as GuardrailDecisionLog } from './middlewares/guardrail/storage/DecisionLog.js';

// Types
export * from './types.js';

// ---------------------------------------------------------------------------
// CLI Execution Orchestrator
// ---------------------------------------------------------------------------
// Resolve realpath on both sides so `npm link` junctions on Windows don't break the entry check
const invokedPath = (() => {
  try {
    return realpathSync(process.argv[1] ?? '');
  } catch {
    return process.argv[1] ?? '';
  }
})();
if (invokedPath === fileURLToPath(import.meta.url)) {
  const program = new Command();

  program
    .name('sai')
    .description('Sapience AI Suite — the intervention layer for OpenClaw.')
    .version('1.0.0');

  registerHitlCommands(program);
  registerContextEditingCommands(program);
  registerModelRoutingCommands(program);
  registerGuardrailCommands(program);
  // output-guardrail CLI consolidated into guardrail CLI (sai guardrail output ...)
  registerPiiSanitizerCommands(program);
  registerToolCallLimitCommands(program);
  registerGeneralCommands(program);

  program.parse();
}
