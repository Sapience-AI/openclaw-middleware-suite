/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Context Editing Policy Store
 * Wraps the unified ConfigStore for context-editing config,
 * consistent with PolicyStore / DlpStore / LimitPolicyStore.
 *
 * load()   — returns persisted config merged with defaults (never auto-persists).
 * save()   — full-replace write at 'context_editing.configOverrides'. Callers
 *            pass the complete shape (dashboard PUT, dashboard reset).
 * update() — read-merge-save helper for partial writes (CLI commands that
 *            only know about a subset of fields).
 */

import { ConfigStore } from '../../../shared/storage/ConfigStore.js';
import {
  STORE_KEY_CONTEXT_EDITING,
  STORE_KEY_PLUGIN_CONFIG,
} from '../../../shared/storage/paths.js';
import { DEFAULT_CONTEXT_EDITING_CONFIG } from '../config.js';
import { logger } from '../../../shared/Logger.js';

export interface ContextEditingPolicyData {
  triggerMode: 'token' | 'message' | 'both';
  tokenThreshold: number;
  messageThreshold: number;
  pruningMode: string;
  ttl: string;
  model: string;
  customPromptEnabled: boolean;
  customInstructions: string;
  customSchema: string;
  messagesKeptBeforeCompaction: number;
}

const VALID_TRIGGER_MODES: ReadonlyArray<ContextEditingPolicyData['triggerMode']> = [
  'token',
  'message',
  'both',
];

export class ContextEditingPolicyStore {
  /**
   * Cached plugin-level enabled flag read from
   * `plugin_config.middlewares['context-editing']`. Refreshed by the
   * ConfigStore.onChange('context_editing', …) watcher in plugin/index.ts
   * (which fires on any store change) so dashboard toggles take effect on
   * the next lifecycle event without a process restart. The plugin's hook
   * wrappers gate on this — context-editing's class methods themselves are
   * dumb delegators (mirroring the HITL/guardrail/PII/TCL pattern).
   */
  private static cachedPluginEnabled: boolean | null = null;

  /**
   * Live plugin-level enabled check (zero I/O after first call).
   * Returns true only when `plugin_config.middlewares['context-editing'] === true`.
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
      return mw?.['context-editing'] === true;
    } catch (error) {
      logger.debug('Failed to read plugin_config.middlewares[context-editing]', { error });
      return false;
    }
  }

  /**
   * Refresh the cached plugin-enabled flag. Called by the plugin-level
   * ConfigStore.onChange watcher whenever sapience-ai-suite.json changes.
   */
  static refreshCache(): void {
    this.cachedPluginEnabled = this.loadPluginEnabled();
    logger.debug('Context-editing plugin-enabled cache refreshed');
  }

  /**
   * Load context-editing config, merging store overrides with defaults.
   */
  static async load(): Promise<ContextEditingPolicyData> {
    try {
      const store = await ConfigStore.read();
      const ceData = store[STORE_KEY_CONTEXT_EDITING];

      if (ceData && typeof ceData === 'object') {
        const overrides = (ceData as Record<string, unknown>).configOverrides || {};
        return this.mergeDefaults(overrides as Record<string, unknown>);
      }

      logger.debug('No existing context-editing config, returning defaults');
      return this.defaults();
    } catch (error) {
      logger.error('Failed to load context-editing config', { error });
      throw new Error(`Failed to load context-editing config: ${error}`);
    }
  }

  /**
   * Save context-editing config overrides to the unified store.
   * Full-replace: callers pass the complete ContextEditingPolicyData shape.
   */
  static async save(data: Partial<ContextEditingPolicyData>): Promise<void> {
    try {
      await ConfigStore.update(`${STORE_KEY_CONTEXT_EDITING}.configOverrides`, data);
      logger.debug('Context-editing config saved to unified store');
    } catch (error) {
      logger.error('Failed to save context-editing config', { error });
      throw new Error(`Failed to save context-editing config: ${error}`);
    }
  }

  /**
   * Merge-update: read current config, shallow-merge the partial, save the
   * full shape back. The sibling CLI commands use this to avoid wiping fields
   * they don't know about.
   */
  static async update(partial: Partial<ContextEditingPolicyData>): Promise<void> {
    const current = await this.load();
    const merged = { ...current, ...partial };
    await this.save(merged);
  }

  /**
   * Return default config (in-memory, never auto-persisted).
   */
  static defaults(): ContextEditingPolicyData {
    return {
      triggerMode: DEFAULT_CONTEXT_EDITING_CONFIG.triggerMode,
      tokenThreshold: DEFAULT_CONTEXT_EDITING_CONFIG.tokenThreshold,
      messageThreshold: DEFAULT_CONTEXT_EDITING_CONFIG.messageThreshold,
      pruningMode: DEFAULT_CONTEXT_EDITING_CONFIG.pruning.mode === 'off' ? 'disabled' : 'enabled',
      ttl: DEFAULT_CONTEXT_EDITING_CONFIG.pruning.ttl,
      model: '',
      customPromptEnabled: DEFAULT_CONTEXT_EDITING_CONFIG.icc.customPrompt.enabled,
      customInstructions: DEFAULT_CONTEXT_EDITING_CONFIG.icc.customPrompt.instructions,
      customSchema: DEFAULT_CONTEXT_EDITING_CONFIG.icc.customPrompt.schema,
      messagesKeptBeforeCompaction: DEFAULT_CONTEXT_EDITING_CONFIG.icc.messagesKeptBeforeCompaction,
    };
  }

  static loadSync(): ContextEditingPolicyData {
    try {
      const store = ConfigStore.readSync();
      const ceData = store[STORE_KEY_CONTEXT_EDITING];

      if (ceData && typeof ceData === 'object') {
        const overrides = (ceData as Record<string, unknown>).configOverrides || {};
        return this.mergeDefaults(overrides as Record<string, unknown>);
      }

      return this.defaults();
    } catch (error) {
      logger.error('Failed to load context-editing config (sync)', { error });
      return this.defaults();
    }
  }

  static getPath(): string {
    return 'sapience-ai-suite.json [context_editing]';
  }

  private static mergeDefaults(overrides: Record<string, unknown>): ContextEditingPolicyData {
    const d = this.defaults();
    return {
      triggerMode:
        typeof overrides.triggerMode === 'string' &&
        (VALID_TRIGGER_MODES as ReadonlyArray<string>).includes(overrides.triggerMode)
          ? (overrides.triggerMode as ContextEditingPolicyData['triggerMode'])
          : d.triggerMode,
      tokenThreshold:
        typeof overrides.tokenThreshold === 'number' ? overrides.tokenThreshold : d.tokenThreshold,
      messageThreshold:
        typeof overrides.messageThreshold === 'number'
          ? overrides.messageThreshold
          : d.messageThreshold,
      pruningMode:
        typeof overrides.pruningMode === 'string' ? overrides.pruningMode : d.pruningMode,
      ttl: typeof overrides.ttl === 'string' ? overrides.ttl : d.ttl,
      model: typeof overrides.model === 'string' ? overrides.model : d.model,
      customPromptEnabled:
        typeof overrides.customPromptEnabled === 'boolean'
          ? overrides.customPromptEnabled
          : d.customPromptEnabled,
      customInstructions:
        typeof overrides.customInstructions === 'string'
          ? overrides.customInstructions
          : d.customInstructions,
      customSchema:
        typeof overrides.customSchema === 'string' ? overrides.customSchema : d.customSchema,
      messagesKeptBeforeCompaction:
        typeof overrides.messagesKeptBeforeCompaction === 'number'
          ? overrides.messagesKeptBeforeCompaction
          : d.messagesKeptBeforeCompaction,
    };
  }
}
