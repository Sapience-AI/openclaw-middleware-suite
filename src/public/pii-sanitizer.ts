/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `@sapience-ai-corporation/openclaw-middleware-suite/pii-sanitizer` — public PII Sanitizer surface
 */

export { PiiSanitizerMiddleware } from '../middlewares/pii-sanitizer/index.js';
export { PII_PATTERNS } from '../middlewares/pii-sanitizer/pii-patterns.js';

/**
 * Disk-backed DLP policy store. Exposed to support the write-through
 * configuration pattern for programmatic consumers:
 *
 *   await DlpStore.save(inlinePolicy);
 *   piiSanitizer.reloadPolicy();
 *
 * `PiiSanitizerMiddleware.initialize(config)` does not accept an inline policy,
 * so this is the supported programmatic route.
 */
export { DlpStore } from '../middlewares/pii-sanitizer/storage/DlpStore.js';

export type { DlpPolicy, DlpDetection, DlpRule } from '../middlewares/pii-sanitizer/types.js';
export type {
  PiiPatternKey,
  PiiPatternSpec,
  PiiSeverity,
} from '../middlewares/pii-sanitizer/pii-patterns.js';
