#!/usr/bin/env node

/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Sapience AI Suite — Root public surface + CLI entry point
 *
 * The root package intentionally only exposes cross-cutting framework concerns:
 *   - Plugin lifecycle (registerPlugin / unregisterPlugin / isPluginRegistered)
 *   - The base pipeline contract (`Middleware`, `MiddlewareContext`, `MiddlewareResult`)
 *   - `MiddlewareRegistry`, the pipeline runner
 *   - Plugin default export + manifest (what OpenClaw loads)
 *   - Shared logger utilities
 *
 * Each middleware publishes its own public surface under a subpath:
 *
 *   import { HitlMiddleware, Interceptor } from '@sapience-ai-corporation/openclaw-middleware-suite/hitl';
 *   import { ContextEditingMiddleware } from '@sapience-ai-corporation/openclaw-middleware-suite/context-editing';
 *   import { ModelRoutingMiddleware } from '@sapience-ai-corporation/openclaw-middleware-suite/model-routing';
 *   import { GuardrailMiddleware } from '@sapience-ai-corporation/openclaw-middleware-suite/guardrail';
 *   import { PiiSanitizerMiddleware } from '@sapience-ai-corporation/openclaw-middleware-suite/pii-sanitizer';
 *   import { ToolCallLimitMiddleware } from '@sapience-ai-corporation/openclaw-middleware-suite/tool-call-limit';
 *
 * This file also hosts the `sai` CLI — the shebang above and the orchestrator
 * block at the bottom are what `bin.sai` in package.json resolves to.
 */

import { Command } from 'commander';
import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';
import { registerHitlCommands } from './middlewares/hitl/cli/index.js';
import { registerContextEditingCommands } from './middlewares/context-editing/cli/index.js';
import { registerModelRoutingCommands } from './middlewares/model-routing/cli/index.js';
import { registerGuardrailCommands } from './middlewares/guardrail/cli/index.js';
import { registerPiiSanitizerCommands } from './middlewares/pii-sanitizer/cli/index.js';
import { registerToolCallLimitCommands } from './middlewares/tool-call-limit/cli/index.js';
import { registerGeneralCommands } from './shared/cli/index.js';

// ---------------------------------------------------------------------------
// Root public surface
// ---------------------------------------------------------------------------

// Pipeline runner
export { MiddlewareRegistry } from './shared/config.js';

// Base pipeline contract (Middleware, MiddlewareContext, MiddlewareResult,
// plus the shared Decision / SecurityPolicy / SecurityRule / SystemThresholds
// vocabulary that HITL consumers also import from @sapience-ai-corporation/openclaw-middleware-suite/hitl).
export * from './types.js';

// Logger utilities — cross-cutting (used by all middlewares + consumer plugins)
export { logger, LOG_PATH, SAPIENCE_MW_DATA_DIR } from './shared/Logger.js';

// Plugin default export + manifest — the OpenClaw loader reads these when
// it imports the plugin bundle directly.
export { default as SapienceMiddlewarePlugin } from './plugin/index.js';
export type { SapienceMiddlewareConfig } from './plugin/index.js';
export { SapienceMiddlewareManifest } from './plugin/index.js';
export type { SapienceMiddlewarePluginManifest } from './plugin/index.js';

// Plugin lifecycle — used by programmatic installers and by `sai init`.
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
  registerPiiSanitizerCommands(program);
  registerToolCallLimitCommands(program);
  registerGeneralCommands(program);

  program.parse();
}
