/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `@sapience-ai-corporation/openclaw-middleware-suite/hitl` — public HITL surface
 *
 * This is the only compat contract for external consumers. The files under
 * src/middlewares/hitl/ are internal and may reorganize freely as long as the
 * re-exports below keep resolving.
 */

// --- Middleware class (pipeline-compatible) ---
export { HitlMiddleware } from '../middlewares/hitl/index.js';

// --- Interceptor + approval engine ---
export { Interceptor } from '../middlewares/hitl/Interceptor.js';
export { Arbitrator } from '../middlewares/hitl/approval/Arbitrator.js';
export { approvalQueue } from '../middlewares/hitl/approval/ApprovalQueue.js';

// --- Tool-call hook factory + OpenClaw hook types ---
export {
  createToolCallHook,
  getToolMapping,
  getProtectedModules,
} from '../middlewares/hitl/tool-interceptor.js';
export type {
  BeforeToolCallEvent,
  ToolContext,
  BeforeToolCallResult,
} from '../middlewares/hitl/tool-interceptor.js';

// --- Storage ---
export { PolicyStore } from '../middlewares/hitl/storage/PolicyStore.js';
export type { PersistedPolicy } from '../middlewares/hitl/storage/PolicyStore.js';
export { DecisionLog } from '../middlewares/hitl/storage/DecisionLog.js';
export type { DecisionRecord } from '../middlewares/hitl/storage/DecisionLog.js';
export { StatsTracker } from '../middlewares/hitl/storage/StatsTracker.js';
export type { Stats } from '../middlewares/hitl/storage/StatsTracker.js';
export { BrowserSessionStore } from '../middlewares/hitl/storage/BrowserSessionStore.js';
export type { SessionInjectionResult } from '../middlewares/hitl/storage/BrowserSessionStore.js';

// --- Scoring + risk assessment ---
export {
  classifyDestructiveAction,
  hashArgs,
} from '../middlewares/hitl/scoring/DestructiveClassifier.js';
export type {
  DestructiveClassification,
  DestructiveSeverity,
} from '../middlewares/hitl/scoring/DestructiveClassifier.js';
export { scoreIrreversibility } from '../middlewares/hitl/scoring/IrreversibilityScorer.js';
export type { IrreversibilityAssessment } from '../middlewares/hitl/scoring/IrreversibilityScorer.js';
export { MemoryRiskForecaster } from '../middlewares/hitl/scoring/MemoryRiskForecaster.js';
export type {
  MemoryRiskAssessment,
  SimulatedPath,
} from '../middlewares/hitl/scoring/MemoryRiskForecaster.js';
export { detectBrowserChallenge } from '../middlewares/hitl/scoring/BrowserChallengeDetector.js';
export type { BrowserChallengeSignal } from '../middlewares/hitl/scoring/BrowserChallengeDetector.js';
export {
  trustRateLimiter,
  TrustRateLimiter,
} from '../middlewares/hitl/approval/TrustRateLimiter.js';
export type {
  EscalationLevel,
  TrustRateLimiterState,
} from '../middlewares/hitl/approval/TrustRateLimiter.js';

// --- Config defaults ---
export { DEFAULT_POLICY } from '../middlewares/hitl/config.js';

// --- HITL-specific types (security vocabulary) ---
export type {
  Decision,
  SecurityPolicy,
  SecurityRule,
  SystemThresholds,
  ExecutionContext,
  InterventionMetadata,
} from '../types.js';
