/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Centralized path definitions for all Sapience AI Suite storage.
 *
 * All middleware CONFIG is stored in the unified sapience-ai-suite.json.
 * Per-middleware directories contain only logs and runtime state.
 *
 * Directory layout:
 *
 *   ~/.openclaw/sapience-ai-suite/
 *   ├── sapience-ai-suite.json          (unified config store — all middleware config)
 *   ├── sapience-ai-suite.log           (main application log — shared)
 *   ├── hitl/
 *   │   ├── decisions.jsonl             (approval decision audit trail)
 *   │   ├── browser-sessions.json       (encrypted browser automation state)
 *   │   └── totp.json                   (TOTP authenticator secret)
 *   ├── context-editing/
 *   │   ├── audit.jsonl                 (compaction event audit trail)
 *   │   └── diagnostic.log             (verbose diagnostic output)
 *   ├── model-routing/
 *   │   ├── routing-audit.jsonl         (routing decision audit trail)
 *   │   ├── proxy-audit.log            (step-by-step request traces)
 *   │   └── litellm-model-catalog.json (cached model pricing catalog)
 *   ├── guardrail/
 *   │   └── audit.jsonl               (guardrail detection audit trail)
 *   ├── pii-sanitizer/
 *   │   └── audit.jsonl               (PII detection audit trail)
 *   └── tool-call-limit/
 *       ├── sessions.json              (session call trackers)
 *       ├── requests.json              (request call trackers)
 *       └── last_request.txt           (virtual request ID tracking)
 */

import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { getOpenclawHome } from '../env.js';

// ---------------------------------------------------------------------------
// Root directories
// ---------------------------------------------------------------------------

const OPENCLAW_HOME = getOpenclawHome() || path.join(os.homedir(), '.openclaw');

/** Root of all Sapience AI Suite data. */
export const SUITE_HOME = path.join(OPENCLAW_HOME, 'sapience-ai-suite');

// ---------------------------------------------------------------------------
// Shared (suite-level) paths
// ---------------------------------------------------------------------------

/** Unified JSON config store shared by all middlewares. */
export const STORE_FILE = path.join(SUITE_HOME, 'sapience-ai-suite.json');

/** Main application log (winston). */
export const LOG_FILE = path.join(SUITE_HOME, 'sapience-ai-suite.log');

// ---------------------------------------------------------------------------
// Per-middleware directories
// ---------------------------------------------------------------------------

export const HITL_DIR = path.join(SUITE_HOME, 'hitl');
export const CTX_EDIT_DIR = path.join(SUITE_HOME, 'context-editing');
export const MODEL_ROUTE_DIR = path.join(SUITE_HOME, 'model-routing');
export const GUARDRAIL_DIR = path.join(SUITE_HOME, 'guardrail');
export const OUTPUT_GUARDRAIL_DIR = path.join(SUITE_HOME, 'output-guardrail');
export const PII_SANITIZER_DIR = path.join(SUITE_HOME, 'pii-sanitizer');
export const TOOL_CALL_LIMIT_DIR = path.join(SUITE_HOME, 'tool-call-limit');

// ---------------------------------------------------------------------------
// HITL middleware files
// ---------------------------------------------------------------------------

export const HITL_STATS_FILE = path.join(HITL_DIR, 'stats.json');
export const HITL_DECISIONS_FILE = path.join(HITL_DIR, 'decisions.jsonl');
export const HITL_BROWSER_SESSIONS = path.join(HITL_DIR, 'browser-sessions.json');
export const HITL_TOTP_FILE = path.join(HITL_DIR, 'totp.json');

// ---------------------------------------------------------------------------
// Context Editing middleware files
// ---------------------------------------------------------------------------

export const CTX_EDIT_STATS_FILE = path.join(CTX_EDIT_DIR, 'stats.json');
export const CTX_EDIT_AUDIT_FILE = path.join(CTX_EDIT_DIR, 'audit.jsonl');
export const CTX_EDIT_DIAGNOSTIC_FILE = path.join(CTX_EDIT_DIR, 'diagnostic.log');

// ---------------------------------------------------------------------------
// Model Routing middleware files
// ---------------------------------------------------------------------------

export const MODEL_ROUTE_DISCOVERED_FILE = path.join(MODEL_ROUTE_DIR, 'discovered-models.json');
export const MODEL_ROUTE_AUDIT_FILE = path.join(MODEL_ROUTE_DIR, 'routing-audit.jsonl');
export const MODEL_ROUTE_PROXY_LOG = path.join(MODEL_ROUTE_DIR, 'proxy-audit.log');
export const MODEL_ROUTE_CATALOG_CACHE = path.join(MODEL_ROUTE_DIR, 'litellm-model-catalog.json');
export const MODEL_ROUTE_COST_FILE = path.join(MODEL_ROUTE_DIR, 'cost-tracker.json');

// ---------------------------------------------------------------------------
// Guardrail middleware files
// ---------------------------------------------------------------------------

/** @deprecated Legacy path — config now in unified store. Kept for one-time migration. */
export const GUARDRAIL_CONFIG_FILE = path.join(GUARDRAIL_DIR, 'config.json');
export const GUARDRAIL_AUDIT_FILE = path.join(GUARDRAIL_DIR, 'audit.jsonl');

// ---------------------------------------------------------------------------
// Output Guardrail middleware files
// ---------------------------------------------------------------------------

/** @deprecated Legacy path — config merged into guardrail's outputScrubber field. */
export const OUTPUT_GUARDRAIL_CONFIG_FILE = path.join(OUTPUT_GUARDRAIL_DIR, 'config.json');

// ---------------------------------------------------------------------------
// PII Sanitizer middleware files
// ---------------------------------------------------------------------------

/** @deprecated Legacy path — config now in unified store. Kept for one-time migration. */
export const PII_SANITIZER_DLP_FILE = path.join(PII_SANITIZER_DIR, 'dlp.json');
export const PII_SANITIZER_AUDIT_FILE = path.join(PII_SANITIZER_DIR, 'audit.jsonl');

// ---------------------------------------------------------------------------
// Tool Call Limit middleware files
// ---------------------------------------------------------------------------

/** @deprecated Legacy path — config now in unified store. Kept for one-time migration. */
export const TOOL_CALL_LIMIT_LIMITS_FILE = path.join(TOOL_CALL_LIMIT_DIR, 'limits.json');
export const TOOL_CALL_LIMIT_SESSIONS_FILE = path.join(TOOL_CALL_LIMIT_DIR, 'sessions.json');
export const TOOL_CALL_LIMIT_REQUESTS_FILE = path.join(TOOL_CALL_LIMIT_DIR, 'requests.json');
export const TOOL_CALL_LIMIT_LAST_REQ_FILE = path.join(TOOL_CALL_LIMIT_DIR, 'last_request.txt');

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** Directory containing the built dashboard static assets (dist/dashboard/). */
export const DASHBOARD_DIST_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dashboard'
);

// ---------------------------------------------------------------------------
// Config store keys (sections inside sapience-ai-suite.json)
// ---------------------------------------------------------------------------

export const STORE_KEY_HITL = 'hitl';
export const STORE_KEY_HITL_POLICY = 'hitl.policy';
export const STORE_KEY_HITL_STATS = 'hitl.stats';
export const STORE_KEY_CONTEXT_EDITING = 'context_editing';
export const STORE_KEY_MODEL_ROUTING = 'model_routing';
export const STORE_KEY_PLUGIN_CONFIG = 'plugin_config';
export const STORE_KEY_GUARDRAIL = 'guardrail';
export const STORE_KEY_OUTPUT_GUARDRAIL = 'output_guardrail';
export const STORE_KEY_PII_SANITIZER = 'pii_sanitizer';
export const STORE_KEY_TOOL_CALL_LIMIT = 'tool_call_limit';

/** Staged writes waiting to be flushed to openclaw.json. */
export const STORE_KEY_OPENCLAW_PENDING = '_openclaw_pending';
