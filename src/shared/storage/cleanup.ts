/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Centralized Middleware Cleanup Registry
 *
 * Defines exactly what to remove when each middleware is disabled.
 * Called from the init wizard (Step 0) and can be used by future
 * uninstall / per-middleware reset commands.
 *
 * Each middleware entry lists:
 *   files       — standalone files to delete
 *   dirs        — directories to remove recursively
 *   storeKeys   — keys to delete from the unified config store
 *
 * Middlewares with state that doesn't fit the file/dir/store-key shape
 * (openclaw.json edits, in-memory counters, per-agent auth profiles —
 * currently all only Model Routing) register a lazy-loaded handler in
 * `EXTRA_CLEANUP_LOADERS` below. The handler lives inside the owning
 * middleware's folder so `shared/` stays free of static dependencies on
 * middleware code and `cleanupMiddleware` doesn't need any
 * `if (name === '<x>')` branches.
 */

import { existsSync, unlinkSync, rmSync } from 'fs';
import { logger } from '../Logger.js';
import { ConfigStore } from './ConfigStore.js';
import {
  HITL_DIR,
  HITL_DECISIONS_FILE,
  HITL_BROWSER_SESSIONS,
  HITL_TOTP_FILE,
  CTX_EDIT_DIR,
  CTX_EDIT_AUDIT_FILE,
  CTX_EDIT_DIAGNOSTIC_FILE,
  MODEL_ROUTE_DIR,
  MODEL_ROUTE_AUDIT_FILE,
  MODEL_ROUTE_PROXY_LOG,
  MODEL_ROUTE_CATALOG_CACHE,
  GUARDRAIL_DIR,
  GUARDRAIL_CONFIG_FILE,
  GUARDRAIL_AUDIT_FILE,
  OUTPUT_GUARDRAIL_DIR,
  OUTPUT_GUARDRAIL_CONFIG_FILE,
  PII_SANITIZER_DIR,
  PII_SANITIZER_DLP_FILE,
  PII_SANITIZER_AUDIT_FILE,
  TOOL_CALL_LIMIT_DIR,
  TOOL_CALL_LIMIT_LIMITS_FILE,
  TOOL_CALL_LIMIT_SESSIONS_FILE,
  TOOL_CALL_LIMIT_REQUESTS_FILE,
  TOOL_CALL_LIMIT_LAST_REQ_FILE,
  STORE_KEY_HITL,
  STORE_KEY_CONTEXT_EDITING,
  STORE_KEY_MODEL_ROUTING,
  STORE_KEY_GUARDRAIL,
  STORE_KEY_OUTPUT_GUARDRAIL,
  STORE_KEY_PII_SANITIZER,
  STORE_KEY_TOOL_CALL_LIMIT,
} from './paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MiddlewareName =
  | 'hitl'
  | 'context-editing'
  | 'model-routing'
  | 'guardrail'
  | 'pii-sanitizer'
  | 'tool-call-limit';

interface CleanupSpec {
  /** Individual files to delete. */
  files: string[];
  /** Directories to remove recursively. */
  dirs: string[];
  /** Top-level keys to remove from sapience-ai-suite.json. */
  storeKeys: string[];
}

// ---------------------------------------------------------------------------
// Registry — single source of truth for what each middleware owns
// ---------------------------------------------------------------------------

const CLEANUP_REGISTRY: Record<MiddlewareName, CleanupSpec> = {
  hitl: {
    files: [HITL_DECISIONS_FILE, HITL_BROWSER_SESSIONS, HITL_TOTP_FILE],
    dirs: [HITL_DIR],
    storeKeys: [STORE_KEY_HITL],
  },

  'context-editing': {
    files: [CTX_EDIT_AUDIT_FILE, CTX_EDIT_DIAGNOSTIC_FILE],
    dirs: [CTX_EDIT_DIR],
    storeKeys: [STORE_KEY_CONTEXT_EDITING],
  },

  'model-routing': {
    files: [MODEL_ROUTE_AUDIT_FILE, MODEL_ROUTE_PROXY_LOG, MODEL_ROUTE_CATALOG_CACHE],
    dirs: [MODEL_ROUTE_DIR],
    storeKeys: [STORE_KEY_MODEL_ROUTING],
  },

  guardrail: {
    // Output Guardrail is a sub-feature of Guardrail (its config lives in
    // `guardrail.outputScrubber` and its hook is gated on Guardrail's
    // master toggle). The `OUTPUT_GUARDRAIL_*` paths/keys are vestigial
    // from the standalone-middleware era and are folded here so a
    // disable-cleanup sweeps any legacy residue from older installs.
    files: [GUARDRAIL_CONFIG_FILE, GUARDRAIL_AUDIT_FILE, OUTPUT_GUARDRAIL_CONFIG_FILE],
    dirs: [GUARDRAIL_DIR, OUTPUT_GUARDRAIL_DIR],
    storeKeys: [STORE_KEY_GUARDRAIL, STORE_KEY_OUTPUT_GUARDRAIL],
  },

  'pii-sanitizer': {
    files: [PII_SANITIZER_DLP_FILE, PII_SANITIZER_AUDIT_FILE],
    dirs: [PII_SANITIZER_DIR],
    storeKeys: [STORE_KEY_PII_SANITIZER],
  },

  'tool-call-limit': {
    files: [
      TOOL_CALL_LIMIT_LIMITS_FILE,
      TOOL_CALL_LIMIT_SESSIONS_FILE,
      TOOL_CALL_LIMIT_REQUESTS_FILE,
      TOOL_CALL_LIMIT_LAST_REQ_FILE,
    ],
    dirs: [TOOL_CALL_LIMIT_DIR],
    storeKeys: [STORE_KEY_TOOL_CALL_LIMIT],
  },
};

// ---------------------------------------------------------------------------
// Per-middleware extras — lazy-loaded handlers for cleanup that doesn't fit
// the file/dir/store-key shape (e.g. editing openclaw.json, resetting
// in-memory counters). The handler lives in the middleware's own folder
// and is dynamically imported so this file stays free of static
// middleware-code dependencies.
// ---------------------------------------------------------------------------

type ExtrasHandler = () => Promise<void>;
type ExtrasLoader = () => Promise<ExtrasHandler>;

const EXTRA_CLEANUP_LOADERS: Partial<Record<MiddlewareName, ExtrasLoader>> = {
  'model-routing': async () =>
    (await import('../../middlewares/model-routing/storage/disable-cleanup.js')).runDisableCleanup,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Clean up all data owned by a middleware.
 * Safe to call even if files don't exist yet.
 */
export async function cleanupMiddleware(name: MiddlewareName): Promise<void> {
  const spec = CLEANUP_REGISTRY[name];
  if (!spec) {
    logger.debug(`[cleanup] Unknown middleware: ${name}`);
    return;
  }

  // ── Delete individual files ──────────────────────────────────────────────
  for (const file of spec.files) {
    try {
      if (existsSync(file)) {
        unlinkSync(file);
        logger.info(`[cleanup] Removed ${file}`);
      }
    } catch (err) {
      logger.debug(`[cleanup] Failed to remove ${file}`, { error: err });
    }
  }

  // ── Remove directories recursively ───────────────────────────────────────
  for (const dir of spec.dirs) {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        logger.info(`[cleanup] Removed directory ${dir}`);
      }
    } catch (err) {
      logger.debug(`[cleanup] Failed to remove directory ${dir}`, { error: err });
    }
  }

  // ── Remove keys from unified config store (via ConfigStore) ──────────────
  if (spec.storeKeys.length > 0) {
    try {
      await ConfigStore.deleteKeys(spec.storeKeys);
      logger.info(`[cleanup] Removed store keys: ${spec.storeKeys.join(', ')}`);
    } catch (err) {
      logger.debug('[cleanup] Failed to update config store', { error: err });
    }
  }

  // ── Run the middleware's own extras handler (if registered) ──────────────
  // No `if (name === '<x>')` branches — the lookup itself is the dispatch.
  const loader = EXTRA_CLEANUP_LOADERS[name];
  if (loader) {
    try {
      const handler = await loader();
      await handler();
    } catch (err) {
      logger.debug(`[cleanup] Extras handler for ${name} failed (non-fatal)`, { error: err });
    }
  }
}
