/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `@sapience-ai-corporation/openclaw-middleware-suite/context-editing` — public Context Editing surface
 *
 * Programmatic config: pair the PolicyStore with ce.reloadConfig():
 *
 *   await ContextEditingPolicyStore.save(inlineData);
 *   ce.reloadConfig();
 *
 * Lifecycle: a single hook drives the full compaction pipeline.
 *   `ce.beforeModelResolve(ctx)` — fires once per turn before OpenClaw's
 *   SessionManager opens the JSONL. Walks the JSONL itself, sums
 *   per-turn assistant token usage into the per-session counter,
 *   evaluates triggers, and runs ICC + appendCompaction inline when
 *   threshold is met. Same turn's LLM call sees compacted history.
 *
 * `ModelResolveContext` and `ModelResolveResult` are exported from the
 * package root (`@sapience-ai-corporation/openclaw-middleware-suite`)
 * via `export * from './types.js'`.
 *
 * No tool-call hooks: CE does not implement `beforeToolCall` /
 * `afterToolCall`, so `MiddlewareRegistry`'s tool-call pipeline skips
 * it. Trigger evaluation lives entirely in `beforeModelResolve`.
 */

export { ContextEditingMiddleware } from '../middlewares/context-editing/index.js';
export { DEFAULT_CONTEXT_EDITING_CONFIG } from '../middlewares/context-editing/config.js';
export type { ContextEditingConfig } from '../middlewares/context-editing/config.js';
export { ContextEditingPolicyStore } from '../middlewares/context-editing/storage/ContextEditingPolicyStore.js';
export type { ContextEditingPolicyData } from '../middlewares/context-editing/storage/ContextEditingPolicyStore.js';
export type {
  CompactionTrigger,
  CompactionResult,
  SessionBuffer,
  EntityLock,
  ConflictResolution,
} from '../middlewares/context-editing/types.js';
