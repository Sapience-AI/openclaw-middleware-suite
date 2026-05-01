/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `@sapience-ai-corporation/openclaw-middleware-suite/model-routing` — public Model Routing surface
 *
 * Programmatic config: pair the PolicyStore with mr.reloadConfig():
 *
 *   await ModelRoutingPolicyStore.save(inlineData);
 *   // or for partial updates that preserve sibling fields:
 *   await ModelRoutingPolicyStore.update({ defaultProfile: 'premium' });
 *   mr.reloadConfig();
 */

// --- Middleware class ---
export { ModelRoutingMiddleware } from '../middlewares/model-routing/index.js';

// --- Config defaults ---
export {
  DEFAULT_MODEL_ROUTING_CONFIG,
  DEFAULT_SCORING_CONFIG,
  DEFAULT_CLASSIFIER_CONFIG,
  DEFAULT_DEDUP_CONFIG,
} from '../middlewares/model-routing/config.js';
export type { ModelRoutingConfig } from '../middlewares/model-routing/config.js';

// --- Disk-backed config store ---
export { ModelRoutingPolicyStore } from '../middlewares/model-routing/storage/ModelRoutingPolicyStore.js';
export type { ModelRoutingPolicyData } from '../middlewares/model-routing/storage/ModelRoutingPolicyStore.js';

// --- Scoring + classification ---
export { scoreRequest } from '../middlewares/model-routing/scoring/scorer.js';
export { classifyWithLLM } from '../middlewares/model-routing/scoring/llm-classifier.js';

// --- Cache ---
export { RequestDeduplicator } from '../middlewares/model-routing/cache/dedup.js';
export { ResponseCache } from '../middlewares/model-routing/cache/response-cache.js';
export type { ResponseCacheConfig } from '../middlewares/model-routing/cache/response-cache.js';

// --- Provider registry + discovery ---
export { discoverAllModels } from '../middlewares/model-routing/providers/discovery.js';
export { resolveProvider } from '../middlewares/model-routing/providers/registry.js';
export { autoAssignTiers } from '../middlewares/model-routing/selection/auto-assign.js';

// --- Session intelligence ---
export { MomentumTracker } from '../middlewares/model-routing/session/momentum.js';
export type { MomentumConfig } from '../middlewares/model-routing/session/momentum.js';
export { SessionStore } from '../middlewares/model-routing/session/session-store.js';
export type {
  SessionStoreConfig,
  SessionEntry,
  PinningDecision,
} from '../middlewares/model-routing/session/session-store.js';

// --- Routing profiles ---
export {
  PROFILE_CONFIGS,
  VALID_PROFILES,
  isValidProfile,
} from '../middlewares/model-routing/selection/profiles.js';
export type { RoutingProfile } from '../middlewares/model-routing/selection/profiles.js';

// --- Cost tracking ---
export { CostTracker } from '../middlewares/model-routing/storage/cost-tracker.js';
export type {
  CostAlertConfig,
  CostEvent,
  CostSummary,
} from '../middlewares/model-routing/storage/cost-tracker.js';

// --- Router plugin system ---
export { PluginRegistry } from '../middlewares/model-routing/plugins/types.js';
export type {
  RouterPlugin,
  AfterForwardEvent,
} from '../middlewares/model-routing/plugins/types.js';

// --- Core types ---
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
} from '../middlewares/model-routing/types.js';
