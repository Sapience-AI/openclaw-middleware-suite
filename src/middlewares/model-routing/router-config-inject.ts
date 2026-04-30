/*
 * Copyright (c) 2026 BlockRun
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * This file is derived from the ClawRouter project
 * (https://github.com/BlockRunAI/ClawRouter) and has been modified for use
 * in the OpenClaw Middleware Suite.
 *
 * Used under the MIT License — see NOTICE for the full license text.
 */

/**
 * Router Config Injection — Stages sai-router provider config and model
 * allowlist for later flush to openclaw.json, and injects auth profiles.
 *
 * This is required because `api.registerProvider()` alone does not make models
 * appear in OpenClaw's /model picker. OpenClaw uses `agents.defaults.models`
 * in openclaw.json as a whitelist — only listed models appear in the dropdown.
 *
 * Same pattern as CLawRouter's injectModelsConfig() + injectAuthProfile()
 * (ClawRouter/src/index.ts:185-436, 438-527).
 *
 * Called from `sai init model-routing` (async CLI context).
 * Uses openclaw-sync for staged writes to openclaw.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../../shared/Logger.js';
import { loadOpenClawConfig, getOpenClawPaths } from '../../plugin/config-manager.js';
import { stageOpenClawWrites } from '../../shared/server/openclaw-sync.js';
import type { ModelDefinitionConfig } from './router-provider.js';

// ---------------------------------------------------------------------------
// Models allowlist entries (model IDs without provider prefix)
// ---------------------------------------------------------------------------

const ALLOWLIST_MODELS = ['auto', 'eco', 'premium', 'agentic'];

// ---------------------------------------------------------------------------
// injectModelsConfig — stage provider + allowlist writes
// ---------------------------------------------------------------------------

/**
 * Stage sai-router provider config and model allowlist for openclaw.json.
 * The actual write to openclaw.json happens when `flushToOpenClaw()` is called
 * (at the end of CLI init or from the dashboard).
 */
export async function injectModelsConfig(
  port: number,
  modelList: ModelDefinitionConfig[]
): Promise<void> {
  // Read current openclaw.json to merge with existing config
  const config: Record<string, any> = (await loadOpenClawConfig()) || {};

  // ── Build provider config ────────────────────────────────────────────────
  const expectedBaseUrl = `http://127.0.0.1:${port}/v1`;
  const existingProviders = (config.models?.providers || {}) as Record<string, any>;

  // Start from existing sai-router config or build fresh
  let providerConfig: Record<string, any>;
  if (existingProviders['sai-router']) {
    providerConfig = { ...existingProviders['sai-router'] };

    // Validate and fix existing config
    if (!providerConfig.baseUrl || providerConfig.baseUrl !== expectedBaseUrl) {
      providerConfig.baseUrl = expectedBaseUrl;
    }
    if (!providerConfig.api) {
      providerConfig.api = 'openai-completions';
    }
    if (!providerConfig.apiKey) {
      providerConfig.apiKey = 'sapience-proxy-handles-routing';
    }
    // Always refresh models list
    providerConfig.models = modelList;
  } else {
    providerConfig = {
      baseUrl: expectedBaseUrl,
      api: 'openai-completions',
      apiKey: 'sapience-proxy-handles-routing',
      models: modelList,
    };
  }

  // ── Build allowlist ──────────────────────────────────────────────────────
  const existingAllowlist = (config.agents?.defaults?.models || {}) as Record<string, unknown>;
  const allowlist: Record<string, unknown> = { ...existingAllowlist };

  // Migrate old sapience-router allowlist entries
  for (const id of ALLOWLIST_MODELS) {
    const oldKey = `sapience-router/${id}`;
    if (allowlist[oldKey] !== undefined) {
      delete allowlist[oldKey];
    }
  }

  // Add sai-router models
  for (const id of ALLOWLIST_MODELS) {
    const key = `sai-router/${id}`;
    if (!allowlist[key]) {
      allowlist[key] = {};
    }
  }

  // ── Build full providers object (merge with existing) ────────────────────
  const providers: Record<string, any> = { ...existingProviders };
  // Remove legacy name
  delete providers['sapience-router'];
  providers['sai-router'] = providerConfig;

  // ── Stage both writes ────────────────────────────────────────────────────
  await stageOpenClawWrites([
    { dotPath: 'models.providers', value: providers },
    { dotPath: 'agents.defaults.models', value: allowlist },
  ]);

  logger.info('[router-inject] Staged provider config and model allowlist');
}

// ---------------------------------------------------------------------------
// injectAuthProfile — write dummy auth to agent auth stores
// ---------------------------------------------------------------------------

/**
 * Inject placeholder auth profile for sai-router into all agent auth stores.
 * OpenClaw's agent system looks for auth even when provider has auth: [].
 * Same pattern as CLawRouter's injectAuthProfile().
 *
 * Note: auth-profiles.json is per-agent and not managed by config-manager,
 * so direct file I/O is used here. These are NOT openclaw.json writes.
 */
export function injectAuthProfile(): void {
  const { openclawHome } = getOpenClawPaths();
  const agentsDir = join(openclawHome, 'agents');

  if (!existsSync(agentsDir)) {
    try {
      mkdirSync(agentsDir, { recursive: true });
    } catch {
      return;
    }
  }

  try {
    let agents = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    // Always ensure "main" agent has auth
    if (!agents.includes('main')) {
      agents = ['main', ...agents];
    }

    for (const agentId of agents) {
      const authDir = join(agentsDir, agentId, 'agent');
      const authPath = join(authDir, 'auth-profiles.json');

      if (!existsSync(authDir)) {
        try {
          mkdirSync(authDir, { recursive: true });
        } catch {
          continue;
        }
      }

      // Load or create auth-profiles.json
      let store: { version: number; profiles: Record<string, unknown> } = {
        version: 1,
        profiles: {},
      };
      // No existsSync precheck — attempt the read and tolerate ENOENT.
      // Removing the precheck eliminates the TOCTOU window
      // (CodeQL js/file-system-race).
      try {
        const existing = JSON.parse(readFileSync(authPath, 'utf8'));
        if (existing.version && existing.profiles) {
          store = existing;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Invalid JSON or other error — use fresh store
        }
      }

      // Migrate old sapience-router profile
      if (store.profiles['sapience-router:default']) {
        delete store.profiles['sapience-router:default'];
      }

      const profileKey = 'sai-router:default';
      if (store.profiles[profileKey]) {
        continue; // Already configured
      }

      store.profiles[profileKey] = {
        type: 'api_key',
        provider: 'sai-router',
        key: 'sapience-proxy-handles-routing',
      };

      try {
        writeFileSync(authPath, JSON.stringify(store, null, 2));
        logger.info(`[router-inject] Injected auth profile for agent: ${agentId}`);
      } catch {
        // Skip if we can't write
      }
    }
  } catch (err) {
    logger.debug('[router-inject] Auth injection failed', { error: err });
  }
}
