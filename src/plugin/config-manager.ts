/**
 * Sapience Middleware Config Manager
 * Manages Sapience Middleware registration in OpenClaw's openclaw.json
 * and plugin-specific configuration in the unified ConfigStore (sapience-ai-suite.json).
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { logger } from '../shared/Logger.js';
import { ConfigStore } from '../shared/storage/ConfigStore.js';
import { STORE_KEY_PLUGIN_CONFIG } from '../shared/storage/paths.js';
import { cleanupMiddleware, type MiddlewareName } from '../shared/storage/cleanup.js';
import {
  getOpenclawHome,
  getOpenclawConfig,
  getOpenclawPluginId,
  getOpenclawPluginDir,
} from '../shared/env.js';
import type { OpenClawRuntime } from './index.js';

/** Middlewares whose cleanup needs to strip entries from openclaw.json. */
const MIDDLEWARES_WITH_OPENCLAW_CLEANUP: MiddlewareName[] = ['model-routing'];

// ---------------------------------------------------------------------------
// Runtime reference — set once during register(), used by load/save helpers.
// When available (gateway context), provides atomic config I/O with proper
// listener notification.  Falls back to raw file I/O (CLI context).
// ---------------------------------------------------------------------------

let _runtime: OpenClawRuntime | null = null;

/**
 * Capture the OpenClaw plugin runtime reference.
 * Called from register() — must happen before any config reads/writes.
 */
export function setOpenClawRuntime(runtime: OpenClawRuntime): void {
  _runtime = runtime;
  logger.info('[config-manager] OpenClaw runtime captured — using gateway config API');
}

/**
 * Returns the captured runtime, or null if running outside the gateway (CLI).
 */
export function getOpenClawRuntime(): OpenClawRuntime | null {
  return _runtime;
}

export interface OpenClawPaths {
  openclawHome: string;
  openclawConfig: string;
  pluginId: string;
  pluginDir: string;
}

export function getOpenClawPaths(): OpenClawPaths {
  const openclawHome = getOpenclawHome() || path.join(os.homedir(), '.openclaw');
  const openclawConfig = getOpenclawConfig() || path.join(openclawHome, 'openclaw.json');
  const pluginId = getOpenclawPluginId() || 'sapience-ai-suite';
  const pluginDir = getOpenclawPluginDir() || path.join(openclawHome, 'extensions', pluginId);

  return {
    openclawHome,
    openclawConfig,
    pluginId,
    pluginDir,
  };
}

export interface OpenClawConfig {
  plugins?: {
    entries?: Record<
      string,
      {
        enabled: boolean;
        config?: Record<string, unknown>;
      }
    >;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Check if OpenClaw is installed
 */
export async function isOpenClawInstalled(): Promise<boolean> {
  const { openclawHome } = getOpenClawPaths();
  return await fs.pathExists(openclawHome);
}

/**
 * Load OpenClaw's main configuration.
 * Uses the gateway runtime API when running in-process (atomic, cached),
 * falls back to file I/O when running from the CLI.
 */
export async function loadOpenClawConfig(): Promise<OpenClawConfig | null> {
  // Gateway context — use the runtime's cached config snapshot.
  // Deep-clone the result: the gateway may return a frozen/sealed object
  // and callers (flushToOpenClaw, cleanOpenclawConfig) need to mutate it.
  if (_runtime) {
    try {
      const snapshot = _runtime.config.loadConfig();
      return JSON.parse(JSON.stringify(snapshot)) as OpenClawConfig;
    } catch (err) {
      logger.warn('[config-manager] runtime.config.loadConfig() failed, falling back to file I/O', {
        error: err,
      });
    }
  }

  // CLI context — read from disk
  const { openclawConfig } = getOpenClawPaths();
  try {
    if (!(await fs.pathExists(openclawConfig))) {
      return null;
    }
    return await fs.readJson(openclawConfig);
  } catch (error) {
    logger.error('Failed to load OpenClaw config', { error, path: openclawConfig });
    return null;
  }
}

/**
 * Save OpenClaw's main configuration.
 * Uses the gateway runtime API when running in-process (atomic writes,
 * backup rotation, schema validation, listener notification), falls back
 * to file I/O when running from the CLI.
 */
export async function saveOpenClawConfig(config: OpenClawConfig): Promise<void> {
  // Gateway context — use atomic writeConfigFile
  if (_runtime) {
    try {
      await _runtime.config.writeConfigFile(config as Record<string, unknown>);
      logger.info('OpenClaw config saved via runtime API');
      return;
    } catch (err) {
      logger.warn(
        '[config-manager] runtime.config.writeConfigFile() failed, falling back to file I/O',
        {
          error: err,
        }
      );
    }
  }

  // CLI context — write to disk directly
  const { openclawConfig } = getOpenClawPaths();
  try {
    await fs.ensureDir(path.dirname(openclawConfig));
    await fs.writeJson(openclawConfig, config, { spaces: 2 });
    logger.info('OpenClaw config saved', { path: openclawConfig });
  } catch (error) {
    logger.error('Failed to save OpenClaw config', { error, path: openclawConfig });
    throw error;
  }
}

/**
 * Register Sapience Middleware plugin in OpenClaw's config (plugins.entries.<pluginId>).
 * Only sets `enabled: true` — all plugin-specific configuration lives in
 * the unified ConfigStore (sapience-ai-suite.json), not openclaw.json.
 */
export async function registerPlugin(): Promise<void> {
  const { pluginId } = getOpenClawPaths();
  const config = (await loadOpenClawConfig()) || {};

  if (!config.plugins || typeof config.plugins !== 'object') {
    config.plugins = {};
  }

  if (!config.plugins.entries || typeof config.plugins.entries !== 'object') {
    config.plugins.entries = {};
  }

  // Migrate any legacy plugin-specific config out of openclaw.json
  const existingEntry = (config.plugins.entries as any)[pluginId] || {};
  if (existingEntry.config) {
    await migrateLegacyPluginConfig(existingEntry.config);
  }

  // Only store enabled state — no config payload
  config.plugins.entries[pluginId] = { enabled: true };

  await saveOpenClawConfig(config);
  logger.info('Registered plugin in OpenClaw config', {
    pluginId,
    path: getOpenClawPaths().openclawConfig,
  });
}

/**
 * Unregister Sapience Middleware plugin from OpenClaw's config.
 * Runs cleanup for all middlewares that inject into openclaw.json
 * so uninstalling the plugin does not leave stale entries behind.
 */
export async function unregisterPlugin(): Promise<void> {
  const { pluginId } = getOpenClawPaths();

  // Clean openclaw.json-injecting middlewares before removing the plugin entry.
  for (const mw of MIDDLEWARES_WITH_OPENCLAW_CLEANUP) {
    try {
      await cleanupMiddleware(mw);
    } catch (err) {
      logger.debug(`[unregister] ${mw} cleanup failed (non-fatal)`, { error: err });
    }
  }

  const config = await loadOpenClawConfig();

  if (!config?.plugins?.entries) {
    return;
  }

  delete config.plugins.entries[pluginId];
  await saveOpenClawConfig(config);
  logger.info('Unregistered plugin from OpenClaw config', {
    pluginId,
    path: getOpenClawPaths().openclawConfig,
  });
}

/**
 * Check if Sapience Middleware is registered in OpenClaw
 */
export async function isPluginRegistered(): Promise<boolean> {
  const { pluginId } = getOpenClawPaths();
  const config = await loadOpenClawConfig();
  return !!config?.plugins?.entries?.[pluginId];
}

/**
 * Gets the current middlewares configuration state from the unified ConfigStore.
 * Falls back to openclaw.json for legacy installations and migrates automatically.
 */
export async function getPluginMiddlewaresConfig(): Promise<Record<string, boolean>> {
  const store = await ConfigStore.read();
  const storeMiddlewares = store?.[STORE_KEY_PLUGIN_CONFIG]?.middlewares as
    | Record<string, boolean>
    | undefined;
  if (storeMiddlewares) {
    return storeMiddlewares;
  }

  // Legacy fallback: check openclaw.json for existing config and migrate it
  const { pluginId } = getOpenClawPaths();
  const config = await loadOpenClawConfig();
  const pluginConfig = config?.plugins?.entries?.[pluginId]?.config as
    | Record<string, unknown>
    | undefined;
  const legacyMiddlewares = pluginConfig?.middlewares as Record<string, boolean> | undefined;
  if (legacyMiddlewares) {
    // Migrate to ConfigStore
    await ConfigStore.update(`${STORE_KEY_PLUGIN_CONFIG}.middlewares`, legacyMiddlewares);
    // Clean up openclaw.json
    await removeLegacyPluginConfig();
    logger.info('Migrated middlewares config from openclaw.json to ConfigStore');
    return legacyMiddlewares;
  }

  return {
    hitl: false,
    'context-editing': false,
    'model-routing': false,
    guardrail: false,
    'output-guardrail': false,
    'pii-sanitizer': false,
    'tool-call-limit': false,
  };
}

/**
 * Sets the middlewares configuration state in the unified ConfigStore.
 */
export async function setPluginMiddlewaresConfig(
  middlewares: Record<string, boolean>
): Promise<void> {
  await ConfigStore.update(`${STORE_KEY_PLUGIN_CONFIG}.middlewares`, middlewares);
}

/**
 * Gets the middlewares config synchronously (for plugin loading).
 * Falls back to openclaw.json for legacy installations.
 */
export function getPluginMiddlewaresConfigSync(): Record<string, boolean> {
  const store = ConfigStore.readSync();
  const storeMiddlewares = store?.[STORE_KEY_PLUGIN_CONFIG]?.middlewares as
    | Record<string, boolean>
    | undefined;
  if (storeMiddlewares) {
    return storeMiddlewares;
  }

  // Legacy fallback: check openclaw.json (prefer runtime API if available)
  try {
    let config: Record<string, unknown> | null = null;

    if (_runtime) {
      try {
        config = _runtime.config.loadConfig();
      } catch {
        // fall through to file I/O
      }
    }

    if (!config) {
      const { openclawConfig } = getOpenClawPaths();
      if (fs.pathExistsSync(openclawConfig)) {
        config = fs.readJsonSync(openclawConfig);
      }
    }

    if (config) {
      const { pluginId } = getOpenClawPaths();
      const legacyMiddlewares = (config as any)?.plugins?.entries?.[pluginId]?.config
        ?.middlewares as Record<string, boolean> | undefined;
      if (legacyMiddlewares) {
        return legacyMiddlewares;
      }
    }
  } catch {
    // ignore read errors
  }

  return {
    hitl: false,
    'context-editing': false,
    'model-routing': false,
    guardrail: false,
    'output-guardrail': false,
    'pii-sanitizer': false,
    'tool-call-limit': false,
  };
}

/**
 * Migrates legacy plugin config (middlewares, defaultAction) from openclaw.json
 * to the unified ConfigStore if it hasn't been migrated yet.
 */
async function migrateLegacyPluginConfig(legacyConfig: Record<string, unknown>): Promise<void> {
  const store = await ConfigStore.read();
  const alreadyMigrated = store?.[STORE_KEY_PLUGIN_CONFIG]?.middlewares;

  if (!alreadyMigrated && legacyConfig.middlewares) {
    await ConfigStore.update(`${STORE_KEY_PLUGIN_CONFIG}.middlewares`, legacyConfig.middlewares);
    logger.info('Migrated middlewares config from openclaw.json to ConfigStore');
  }
}

/**
 * Removes the legacy `config` field from the plugin entry in openclaw.json,
 * leaving only `{ enabled: true/false }`.
 */
async function removeLegacyPluginConfig(): Promise<void> {
  try {
    const { pluginId } = getOpenClawPaths();
    const config = await loadOpenClawConfig();
    if (config?.plugins?.entries?.[pluginId]?.config) {
      const entry = config.plugins.entries[pluginId];
      config.plugins.entries[pluginId] = { enabled: entry.enabled };
      await saveOpenClawConfig(config);
      logger.info('Removed legacy plugin config from openclaw.json');
    }
  } catch (error) {
    logger.debug('Failed to clean legacy plugin config from openclaw.json', { error });
  }
}
