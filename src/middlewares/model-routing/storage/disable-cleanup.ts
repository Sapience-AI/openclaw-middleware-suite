/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Model-Routing-specific disable cleanup.
 *
 * Owns every bit of state Model Routing leaves behind that the generic
 * `cleanupMiddleware` flow in `shared/storage/cleanup.ts` cannot express
 * declaratively (files / dirs / store-keys are uniform across middlewares,
 * but these aren't):
 *
 *   1. `openclaw.json` entries — the `sai-router/*` provider definition,
 *      allowlist entries under `agents.defaults.models`, and any references
 *      under `agents.defaults.model.{primary,fallbacks}`. No other
 *      middleware writes into openclaw.json.
 *
 *   2. Per-agent `auth-profiles.json` rows for `sai-router:default` /
 *      `sapience-router:default`. No other middleware touches these.
 *
 *   3. The module-level `stats` counter in `proxy/handler.ts`. The audit
 *      file is deleted by the generic cleanup loop, but the in-memory
 *      counter (which the dashboard's Routing Stats cards read via
 *      `getStats()`) keeps its pre-disable values across a same-process
 *      disable→re-enable cycle until something explicitly zeros it.
 *
 * Exported from the MR module so `cleanupMiddleware` can stay
 * branch-free — it just looks up the registered extras handler and calls
 * it. Keeps shared/cleanup.ts free of static deps on middleware code and
 * confines MR's quirks to MR's own folder.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../../../shared/Logger.js';
import {
  loadOpenClawConfig,
  saveOpenClawConfig,
  getOpenClawPaths,
} from '../../../plugin/config-manager.js';
import { resetStats } from '../proxy/handler.js';

/**
 * Provider keys MR may have written to `models.providers` in openclaw.json.
 * `sapience-router` is the legacy name kept for cleanup of installs that
 * predate the rename to `sai-router`.
 */
const ROUTER_PROVIDER_NAMES = ['sai-router', 'sapience-router'];

/** Match `<provider>/<model>` strings owned by MR. */
function isRouterRef(value: string): boolean {
  return ROUTER_PROVIDER_NAMES.some((name) => value.startsWith(`${name}/`));
}

/**
 * Run every MR-specific bit of disable cleanup. Safe to call when MR was
 * never enabled — each step short-circuits on missing state.
 */
export async function runDisableCleanup(): Promise<void> {
  await stripOpenClawConfig();
  try {
    resetStats();
    logger.debug('[cleanup] Reset in-memory routing stats counters');
  } catch (err) {
    logger.debug('[cleanup] Failed to reset routing stats counters', { error: err });
  }
}

// ---------------------------------------------------------------------------
// openclaw.json — strip provider, allowlist, and fallback entries
// ---------------------------------------------------------------------------

async function stripOpenClawConfig(): Promise<void> {
  const loaded = await loadOpenClawConfig();
  if (!loaded) return;

  // Deep clone — the gateway runtime may return a frozen/sealed config
  // object. Mutating it directly (delete, property assignment) would
  // silently fail or throw. Work on a mutable copy instead.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  stripAgentAuthProfiles(openclawHome);
}

// ---------------------------------------------------------------------------
// Per-agent auth-profiles.json — sai-router / sapience-router rows
// ---------------------------------------------------------------------------

function stripAgentAuthProfiles(openclawHome: string): void {
  const agentsDir = join(openclawHome, 'agents');
  if (!existsSync(agentsDir)) return;

  try {
    const agents = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const agentId of agents) {
      const authPath = join(agentsDir, agentId, 'agent', 'auth-profiles.json');

      // No existsSync precheck — just attempt the read and tolerate ENOENT.
      // Removing the precheck eliminates the TOCTOU window
      // (CodeQL js/file-system-race).
      try {
        let raw: string;
        try {
          raw = readFileSync(authPath, 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
        const store = JSON.parse(raw);
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
