/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `@sapience-ai-corporation/openclaw-middleware-suite/tool-call-limit` — public Tool Call Limit surface
 */

export { ToolCallLimitMiddleware } from '../middlewares/tool-call-limit/index.js';

/**
 * Disk-backed limit policy store. Exposed to support the write-through
 * configuration pattern for programmatic consumers:
 *
 *   await LimitPolicyStore.save(inlinePolicy);
 *   LimitPolicyStore.refreshCache();
 *
 * `ToolCallLimitMiddleware.initialize()` takes no arguments, so this is the
 * supported programmatic route. The middleware reads `getCached()` on every
 * tool call and the cache already auto-invalidates on store-file mtime change,
 * so `refreshCache()` is belt-and-braces but recommended for correctness.
 */
export { LimitPolicyStore } from '../middlewares/tool-call-limit/storage/LimitPolicyStore.js';

export type {
  LimitPolicy,
  LimitRule,
  EnforcementStatus,
} from '../middlewares/tool-call-limit/types.js';
