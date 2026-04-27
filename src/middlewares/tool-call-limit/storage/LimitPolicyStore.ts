/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Tool Call Limit — LimitPolicyStore
 * Manages persistence of tool call limits in the unified sapience-ai-suite.json
 * under key "tool_call_limit".
 */

import { statSync } from 'fs';
import { LimitPolicy, LimitRule, DEFAULT_LIMIT_POLICY } from '../types.js';
import { logger } from '../../../shared/Logger.js';
import { ConfigStore } from '../../../shared/storage/ConfigStore.js';
import {
  STORE_KEY_TOOL_CALL_LIMIT,
  STORE_KEY_PLUGIN_CONFIG,
} from '../../../shared/storage/paths.js';
import { SAPIENCE_MW_STORE_FILE } from '../../../shared/Logger.js';

const DEFAULT_LIMITS = DEFAULT_LIMIT_POLICY;

export type PersistedLimitPolicy = LimitPolicy;

export class LimitPolicyStore {
  /**
   * In-memory cached policy, kept fresh by ConfigStore.onChange('tool_call_limit', ...).
   * All hooks use getCached() instead of load()/loadSync() to avoid disk reads
   * on every tool call.
   */
  private static cachedPolicy: PersistedLimitPolicy | null = null;
  private static cachedMtimeMs: number = 0;

  /**
   * Cached plugin-level enabled flag read from
   * `plugin_config.middlewares['tool-call-limit']`. Refreshed by the
   * ConfigStore.onChange('tool_call_limit', …) watcher (which fires on any
   * store change) so dashboard toggles take effect on the next tool call
   * without a process restart. The composed tool-call hook gates on this.
   */
  private static cachedPluginEnabled: boolean | null = null;

  /**
   * Live plugin-level enabled check (zero I/O after first call).
   * Returns true only when `plugin_config.middlewares['tool-call-limit'] === true`.
   */
  static isPluginEnabled(): boolean {
    if (this.cachedPluginEnabled === null) {
      this.cachedPluginEnabled = this.loadPluginEnabled();
    }
    return this.cachedPluginEnabled === true;
  }

  private static loadPluginEnabled(): boolean {
    try {
      const store = ConfigStore.readSync();
      const mw = (store?.[STORE_KEY_PLUGIN_CONFIG] as Record<string, unknown>)?.middlewares as
        | Record<string, boolean>
        | undefined;
      return mw?.['tool-call-limit'] === true;
    } catch (error) {
      logger.debug('Failed to read plugin_config.middlewares[tool-call-limit]', { error });
      return false;
    }
  }

  /**
   * Return the cached policy. Re-reads from disk whenever the underlying
   * store file's mtime changes — defensive against cross-module-instance
   * cache drift (two module copies on Windows dynamic-import cache keys).
   * Cost: one `stat()` per tool call (microseconds).
   */
  static getCached(): PersistedLimitPolicy {
    let currentMtime = 0;
    try {
      currentMtime = statSync(SAPIENCE_MW_STORE_FILE).mtimeMs;
    } catch {
      // file missing — fall through to load which handles the empty case
    }
    if (!this.cachedPolicy || currentMtime !== this.cachedMtimeMs) {
      this.cachedPolicy = this.loadSync();
      this.cachedMtimeMs = currentMtime;
    }
    return this.cachedPolicy;
  }

  /**
   * Refresh the in-memory cache from disk. Called by ConfigStore.onChange
   * watcher registered in plugin/index.ts.
   */
  static refreshCache(): void {
    this.cachedPolicy = this.loadSync();
    this.cachedPluginEnabled = this.loadPluginEnabled();
    try {
      this.cachedMtimeMs = statSync(SAPIENCE_MW_STORE_FILE).mtimeMs;
    } catch {
      this.cachedMtimeMs = 0;
    }
    logger.debug('Limit policy cache refreshed');
  }

  /**
   * Return the **raw** tool_call_limit sub-tree as a `Partial<LimitPolicy>` —
   * just the fields actually persisted, without filling in defaults. Used by
   * `ToolCallLimitMiddleware.buildPolicy()` to compute `defaults < inline <
   * disk` precedence. Returns `{}` when the file is absent or the key is
   * unset, so a hermetic embedded consumer's inline policy applies fully.
   *
   * Distinct from `getCached()` / `loadSync()` which always return a complete
   * `LimitPolicy` (defaults filled in for missing fields) — those would
   * shadow inline config because every field is "set".
   */
  static loadOverlay(): Partial<PersistedLimitPolicy> {
    try {
      const store = ConfigStore.readSync();
      const raw = store[STORE_KEY_TOOL_CALL_LIMIT];
      if (raw && typeof raw === 'object' && Object.keys(raw).length > 0) {
        return raw as Partial<PersistedLimitPolicy>;
      }
      return {};
    } catch (error) {
      logger.debug('Failed to read tool_call_limit overlay', { error });
      return {};
    }
  }

  /**
   * Load the limit policy from the unified store, or create default if doesn't exist
   */
  static async load(): Promise<PersistedLimitPolicy> {
    try {
      const store = await ConfigStore.read();
      const data = store[STORE_KEY_TOOL_CALL_LIMIT];

      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        logger.debug('Limit policy loaded from unified store');
        return data;
      }

      logger.debug('No existing limit policy found, returning defaults');
      return this.defaults();
    } catch (error) {
      logger.error('Failed to load limit policy', { error });
      throw new Error(`Failed to load limit policy: ${error}`);
    }
  }

  /**
   * Save the limit policy to the unified store
   */
  static async save(policy: PersistedLimitPolicy): Promise<void> {
    try {
      await ConfigStore.update(STORE_KEY_TOOL_CALL_LIMIT, policy);
      logger.debug('Limit policy saved to unified store');
    } catch (error) {
      logger.error('Failed to save limit policy', { error });
      throw new Error(`Failed to save limit policy: ${error}`);
    }
  }

  /**
   * Shallow merge-update at the top level: read current, `{ ...current, ...partial }`,
   * save the full shape back. Preferred for in-process patches of **top-level**
   * fields — `globalSessionCallLimit`, `globalRequestCallLimit`, `version`,
   * `resetAt`, `resetScope`. Top-level sibling keys are preserved.
   *
   * IMPORTANT: this is a shallow merge. Passing `{ modules: { FileSystem: {...} } }`
   * replaces the entire `modules` map — you'd lose `Gmail`, `Shell`, and
   * every other module's limit rules. For nested patches, spread the current
   * sub-object yourself before calling `.update()`.
   *
   * Caller still owns `refreshCache()` — `.update()` writes disk only,
   * matching `.save()`.
   */
  static async update(partial: Partial<PersistedLimitPolicy>): Promise<void> {
    const current = await this.load();
    const merged = { ...current, ...partial };
    await this.save(merged);
  }

  /**
   * Return default limit policy (in-memory, never auto-persisted).
   */
  static defaults(): PersistedLimitPolicy {
    return { ...DEFAULT_LIMITS };
  }

  /**
   * Reset limit policy to defaults
   */
  static async reset(): Promise<void> {
    await this.save(this.defaults());
    logger.info('Limit policy reset to defaults');
  }

  /**
   * Look up a rule for a specific tool. By default reads from the cached
   * policy (zero I/O). When `policyOverride` is provided, looks up the rule
   * in that policy instead — used by `ToolCallLimitMiddleware` to read from
   * its per-instance config (which may include `updateConfig()` patches).
   */
  static lookupRule(
    moduleName: string,
    methodName: string,
    policyOverride?: PersistedLimitPolicy
  ): LimitRule | undefined {
    const policy = policyOverride ?? this.getCached();
    const moduleRules = policy.modules[moduleName];
    if (moduleRules) {
      if (moduleRules[methodName]) return moduleRules[methodName];
      if (moduleRules['*']) return moduleRules['*'];
    }
    return undefined;
  }

  /**
   * Load the policy synchronously
   */
  static loadSync(): PersistedLimitPolicy {
    try {
      const store = ConfigStore.readSync();
      const data = store[STORE_KEY_TOOL_CALL_LIMIT];

      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        return data;
      }

      logger.debug('No existing limit policy, returning defaults (sync)');
      return this.defaults();
    } catch (error) {
      logger.error('Failed to load limit policy (sync)', { error });
      throw new Error(`Failed to load limit policy: ${error}`);
    }
  }

  static getPath(): string {
    return 'sapience-ai-suite.json [tool_call_limit]';
  }
}
