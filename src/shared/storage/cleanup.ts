/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
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
 *   cleanOpenclaw — whether to strip router entries from openclaw.json
 *
 * Uses config-manager for openclaw.json and ConfigStore for the unified
 * store — no direct file reads/writes for config files.
 */

import { existsSync, unlinkSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../Logger.js';
import {
  loadOpenClawConfig,
  saveOpenClawConfig,
  getOpenClawPaths,
} from '../../plugin/config-manager.js';
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
  | 'output-guardrail'
  | 'pii-sanitizer'
  | 'tool-call-limit';

interface CleanupSpec {
  /** Individual files to delete. */
  files: string[];
  /** Directories to remove recursively. */
  dirs: string[];
  /** Top-level keys to remove from sapience-ai-suite.json. */
  storeKeys: string[];
  /** If true, also clean openclaw.json (provider, allowlist, fallbacks). */
  cleanOpenclaw: boolean;
}

// ---------------------------------------------------------------------------
// Registry — single source of truth for what each middleware owns
// ---------------------------------------------------------------------------

const CLEANUP_REGISTRY: Record<MiddlewareName, CleanupSpec> = {
  hitl: {
    files: [HITL_DECISIONS_FILE, HITL_BROWSER_SESSIONS, HITL_TOTP_FILE],
    dirs: [HITL_DIR],
    storeKeys: [STORE_KEY_HITL],
    cleanOpenclaw: false,
  },

  'context-editing': {
    files: [CTX_EDIT_AUDIT_FILE, CTX_EDIT_DIAGNOSTIC_FILE],
    dirs: [CTX_EDIT_DIR],
    storeKeys: [STORE_KEY_CONTEXT_EDITING],
    cleanOpenclaw: false,
  },

  'model-routing': {
    files: [MODEL_ROUTE_AUDIT_FILE, MODEL_ROUTE_PROXY_LOG, MODEL_ROUTE_CATALOG_CACHE],
    dirs: [MODEL_ROUTE_DIR],
    storeKeys: [STORE_KEY_MODEL_ROUTING],
    cleanOpenclaw: true,
  },

  guardrail: {
    files: [GUARDRAIL_CONFIG_FILE, GUARDRAIL_AUDIT_FILE],
    dirs: [GUARDRAIL_DIR],
    storeKeys: [STORE_KEY_GUARDRAIL],
    cleanOpenclaw: false,
  },

  'output-guardrail': {
    files: [OUTPUT_GUARDRAIL_CONFIG_FILE],
    dirs: [OUTPUT_GUARDRAIL_DIR],
    storeKeys: [STORE_KEY_OUTPUT_GUARDRAIL],
    cleanOpenclaw: false,
  },

  'pii-sanitizer': {
    files: [PII_SANITIZER_DLP_FILE, PII_SANITIZER_AUDIT_FILE],
    dirs: [PII_SANITIZER_DIR],
    storeKeys: [STORE_KEY_PII_SANITIZER],
    cleanOpenclaw: false,
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
    cleanOpenclaw: false,
  },
};

// ---------------------------------------------------------------------------
// Provider names used in openclaw.json (current + legacy)
// ---------------------------------------------------------------------------

const ROUTER_PROVIDER_NAMES = ['sai-router', 'sapience-router'];

function isRouterRef(value: string): boolean {
  return ROUTER_PROVIDER_NAMES.some((name) => value.startsWith(`${name}/`));
}

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

  // ── Remove directories ───────────────────────────────────────────────────
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

  // ── Clean openclaw.json (model-routing only) ─────────────────────────────
  if (spec.cleanOpenclaw) {
    await cleanOpenclawConfig();
  }
}

// ---------------------------------------------------------------------------
// openclaw.json cleanup — uses config-manager load/save
// ---------------------------------------------------------------------------

async function cleanOpenclawConfig(): Promise<void> {
  const loaded = await loadOpenClawConfig();
  if (!loaded) return;

  // Deep clone — the gateway runtime may return a frozen/sealed config
  // object. Mutating it directly (delete, property assignment) would
  // silently fail or throw. Work on a mutable copy instead.
  const config = JSON.parse(JSON.stringify(loaded)) as Record<string, any>;

  let changed = false;

  // ── Remove provider entries (models.providers) ───────────────────────────
  const providers = config?.models?.providers;
  if (providers) {
    for (const key of ROUTER_PROVIDER_NAMES) {
      if (providers[key]) {
        delete providers[key];
        changed = true;
        logger.info(`[cleanup] Removed ${key} from models.providers`);
      }
    }
  }

  // ── Remove model allowlist entries (agents.defaults.models) ──────────────
  const allowlist = config?.agents?.defaults?.models;
  if (allowlist && typeof allowlist === 'object' && !Array.isArray(allowlist)) {
    for (const key of Object.keys(allowlist)) {
      if (isRouterRef(key)) {
        delete allowlist[key];
        changed = true;
      }
    }
  }

  // ── Remove fallback references (agents.defaults.model.fallbacks) ─────────
  const modelDefaults = config?.agents?.defaults?.model;
  if (modelDefaults) {
    if (Array.isArray(modelDefaults.fallbacks)) {
      const before = modelDefaults.fallbacks.length;
      modelDefaults.fallbacks = modelDefaults.fallbacks.filter(
        (m: string) => typeof m !== 'string' || !isRouterRef(m)
      );
      if (modelDefaults.fallbacks.length !== before) {
        changed = true;
        logger.info('[cleanup] Removed router models from model.fallbacks');
      }
    }

    // Clear primary if it references the router
    if (typeof modelDefaults.primary === 'string' && isRouterRef(modelDefaults.primary)) {
      delete modelDefaults.primary;
      changed = true;
      logger.info('[cleanup] Removed router model from model.primary');
    }
  }

  if (changed) {
    await saveOpenClawConfig(config);
    logger.info('[cleanup] openclaw.json updated');
  } else {
    logger.info('[cleanup] openclaw.json — no router entries found to remove');
  }

  // ── Remove auth profiles from agent stores ───────────────────────────────
  const { openclawHome } = getOpenClawPaths();
  cleanAgentAuthProfiles(openclawHome);
}

// ---------------------------------------------------------------------------
// Agent auth profile cleanup
// (auth-profiles.json is per-agent, not managed by config-manager)
// ---------------------------------------------------------------------------

function cleanAgentAuthProfiles(openclawHome: string): void {
  const agentsDir = join(openclawHome, 'agents');
  if (!existsSync(agentsDir)) return;

  try {
    const agents = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const agentId of agents) {
      const authPath = join(agentsDir, agentId, 'agent', 'auth-profiles.json');
      if (!existsSync(authPath)) continue;

      try {
        const store = JSON.parse(readFileSync(authPath, 'utf8'));
        if (!store?.profiles) continue;

        let changed = false;
        for (const key of ['sai-router:default', 'sapience-router:default']) {
          if (store.profiles[key]) {
            delete store.profiles[key];
            changed = true;
          }
        }

        if (changed) {
          writeFileSync(authPath, JSON.stringify(store, null, 2));
          logger.info(`[cleanup] Removed router auth profile for agent: ${agentId}`);
        }
      } catch {
        // Skip unreadable auth stores
      }
    }
  } catch (err) {
    logger.debug('[cleanup] Agent auth cleanup failed', { error: err });
  }
}
