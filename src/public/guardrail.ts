/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `@sapience-ai-corporation/openclaw-middleware-suite/guardrail` — public Guardrail surface
 *
 * `GuardrailMiddleware` is the pipeline-compatible facade (symmetric with the
 * other five middlewares). The scanner + hook factories remain exported for
 * consumers who want to register hooks directly without going through the
 * MiddlewareRegistry.
 */

// --- Middleware class (pipeline-compatible facade) ---
export { GuardrailMiddleware } from '../middlewares/guardrail/GuardrailMiddleware.js';

// --- Scanner engine ---
export { GuardrailScanner } from '../middlewares/guardrail/GuardrailScanner.js';
export { executeGuardrailScan } from '../middlewares/guardrail/GuardrailInterceptorHook.js';

// --- Hook factories (framework-level hooks outside before_tool_call) ---
export { createWriteScannerHook } from '../middlewares/guardrail/GuardrailWriteScannerHook.js';
export { createPromptGuardHook } from '../middlewares/guardrail/PromptGuardHook.js';
export {
  createModerationGuardHook,
  consumeModerationResult,
} from '../middlewares/guardrail/ModerationGuardHook.js';
export type { ModerationCacheEntry } from '../middlewares/guardrail/ModerationGuardHook.js';

// --- Output scrubbing ---
export {
  scrubMetadata,
  getPatternCount,
} from '../middlewares/guardrail/scrubbers/MetadataScrubber.js';

// --- Storage ---
export { ConfigStore as GuardrailConfigStore } from '../middlewares/guardrail/storage/ConfigStore.js';
export { DecisionLog as GuardrailDecisionLog } from '../middlewares/guardrail/storage/DecisionLog.js';

// --- Types ---
export type {
  GuardrailConfig,
  GuardrailDetection,
  DetectionRule,
  OutputScrubberConfig,
  ScrubResult,
} from '../middlewares/guardrail/types.js';

/**
 * Back-compat alias for the output scrubber config.
 * Prefer `OutputScrubberConfig` for new code.
 */
export type { OutputScrubberConfig as OutputGuardrailConfig } from '../middlewares/guardrail/types.js';
