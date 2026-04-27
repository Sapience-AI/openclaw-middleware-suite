/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `@sapience-ai-corporation/openclaw-middleware-suite/context-editing` — public Context Editing surface
 *
 * Programmatic config: pair the PolicyStore with ce.reloadConfig():
 *
 *   await ContextEditingPolicyStore.save(inlineData);
 *   ce.reloadConfig();
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
