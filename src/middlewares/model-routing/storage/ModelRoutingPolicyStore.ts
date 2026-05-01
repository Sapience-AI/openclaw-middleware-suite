/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Model Routing Policy Store
 * Canonical config API for model-routing, consistent with PolicyStore /
 * DlpStore / LimitPolicyStore / ContextEditingPolicyStore.
 *
 * load()   — returns persisted config or in-memory defaults (never auto-persists).
 * save()   — full-replace write at 'model_routing' key.
 * update() — read-merge-save helper for partial writes (CLI commands that
 *            only know about a subset of fields).
 *
 * Writes target sapience-ai-suite.json only; model-routing's gateway-restart
 * behavior is scoped to enable/disable (which touches openclaw.json via
 * init) and is unaffected by config writes here.
 */

import { ConfigStore } from '../../../shared/storage/ConfigStore.js';
import { STORE_KEY_MODEL_ROUTING } from '../../../shared/storage/paths.js';
import { logger } from '../../../shared/Logger.js';
import { Tier, TierModelConfig, ProviderConfig } from '../types.js';
import { RoutingProfile } from '../selection/profiles.js';
import { ResponseCacheConfig } from '../cache/response-cache.js';
import { CostAlertConfig } from './cost-tracker.js';

export interface ModelRoutingPolicyData {
  /** User overrides for scoring weights (dimension name → weight) */
  weightOverrides?: Record<string, number>;
  /** User overrides for tier boundaries */
  boundaryOverrides?: {
    simpleStandard?: number;
    standardComplex?: number;
    complexReasoning?: number;
  };
  /** Per-profile tier-to-model mappings.
   *  Keyed by RoutingProfile; each value is a partial Tier→TierModelConfig map.
   *  Profiles absent from this object inherit the runtime default (built via
   *  `buildProfileFromDiscovered` from the live model catalog). The dashboard
   *  edits one profile's slot at a time without touching the others. */
  tierOverridesByProfile?: Partial<Record<RoutingProfile, Partial<Record<Tier, TierModelConfig>>>>;
  /** Model exclusion list */
  exclusions?: string[];
  /** Configured provider connections */
  providerConfigs?: Record<string, ProviderConfig>;
  /** Default routing profile override */
  defaultProfile?: RoutingProfile;
  /** When false, skip the pinning check — every turn re-scores. Default true. */
  sessionPinningEnabled?: boolean;
  /** When false, adapters skip provider prompt-cache markers. Default true.
   *  Independent of `sessionPinningEnabled` — caching pays off on its own
   *  (provider-side prefix dedup across same-model requests) even without
   *  the per-session pin. */
  providerCacheEnabled?: boolean;

  // ── Bootstrap settings (migrated from plugin_config['model-routing']) ──
  // Previously these came from openclaw.json's per-plugin config block and
  // were spread into MR.initialize() by the plugin runtime. Moving them to
  // the disk overlay lets the plugin call `_modelRouting.initialize({})`
  // and keeps a single source of truth (sapience-ai-suite.json) for both
  // operational config and bootstrap settings.

  /** Local proxy port for the OpenClaw → MR routing path. Default: 9000. */
  port?: number;
  /** Response-cache config (semantic cache for repeated requests). */
  responseCache?: Partial<ResponseCacheConfig>;
  /** Cost-alert thresholds for spend monitoring. */
  costAlerts?: Partial<CostAlertConfig>;
}

export class ModelRoutingPolicyStore {
  /**
   * Load model-routing config from the unified store.
   */
  static async load(): Promise<ModelRoutingPolicyData> {
    try {
      const store = await ConfigStore.read();
      const data = store[STORE_KEY_MODEL_ROUTING];

      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        logger.debug('Model-routing config loaded from unified store');
        return data as ModelRoutingPolicyData;
      }

      logger.debug('No existing model-routing config, returning defaults');
      return this.defaults();
    } catch (error) {
      logger.error('Failed to load model-routing config', { error });
      throw new Error(`Failed to load model-routing config: ${error}`);
    }
  }

  /**
   * Save model-routing config to the unified store. Full-replace at the
   * `model_routing` key — callers pass the complete `ModelRoutingPolicyData`
   * shape (dashboard PUT builds it via update() or reset via defaults()).
   */
  static async save(data: ModelRoutingPolicyData): Promise<void> {
    try {
      await ConfigStore.update(STORE_KEY_MODEL_ROUTING, data);
      logger.debug('Model-routing config saved to unified store');
    } catch (error) {
      logger.error('Failed to save model-routing config', { error });
      throw new Error(`Failed to save model-routing config: ${error}`);
    }
  }

  /**
   * Merge-update: read current config, shallow-merge the partial, save the
   * full shape back. Used by every CLI command that only knows about a
   * subset of fields so sibling fields are preserved.
   */
  static async update(partial: Partial<ModelRoutingPolicyData>): Promise<void> {
    const current = await this.load();
    const merged = { ...current, ...partial };
    await this.save(merged);
  }

  /**
   * Return default config (in-memory, never auto-persisted).
   */
  static defaults(): ModelRoutingPolicyData {
    return {};
  }

  static loadSync(): ModelRoutingPolicyData {
    try {
      const store = ConfigStore.readSync();
      const data = store[STORE_KEY_MODEL_ROUTING];

      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        return data as ModelRoutingPolicyData;
      }

      return this.defaults();
    } catch (error) {
      logger.error('Failed to load model-routing config (sync)', { error });
      return this.defaults();
    }
  }

  static getPath(): string {
    return 'sapience-ai-suite.json [model_routing]';
  }
}
