/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Model Routing Discovery Store — runtime read-only config view +
 * discovered-models owner.
 *
 * Config (user-configurable settings) lives in sapience-ai-suite.json under
 * the 'model_routing' key. All **writes** go through `ModelRoutingPolicyStore`
 * (canonical config API for CLI + dashboard). This class only reads that
 * config and exposes accessors for the middleware runtime and CLI display.
 *
 * Discovered models (runtime cache from provider APIs) live in a separate
 * file (model-routing/discovered-models.json) and ARE written by this class.
 * This class is named after that responsibility.
 */

import { logger } from '../../../shared/Logger.js';
import { MODEL_ROUTE_DIR, MODEL_ROUTE_DISCOVERED_FILE } from '../../../shared/storage/paths.js';
import { DiscoveredModel, ProviderConfig } from '../types.js';
import { RoutingProfile } from '../selection/profiles.js';
import { ModelRoutingPolicyStore, ModelRoutingPolicyData } from './ModelRoutingPolicyStore.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

export class ModelRoutingDiscovery {
  private data: ModelRoutingPolicyData = {};
  /** Discovered models — stored in separate file, not in ConfigStore */
  private discoveredModels: DiscoveredModel[] = [];

  /**
   * Load state from disk. Config is delegated to PolicyStore.loadSync() so
   * the parse logic lives in one place; failures there are caught here and
   * default to an empty config so the runtime never crashes on a corrupt
   * file. Discovered models come from their own file.
   */
  load(): void {
    try {
      this.data = ModelRoutingPolicyStore.loadSync();
    } catch (err) {
      logger.warn('[model-routing] Failed to load config, using defaults', { error: err });
      this.data = {};
    }
    this.loadDiscoveredModels();
  }

  getData(): Readonly<ModelRoutingPolicyData> {
    return this.data;
  }

  getExclusions(): string[] {
    return this.data.exclusions || [];
  }

  // ── Discovered models (separate file) ───────────────────────────────────

  /**
   * Set discovered models and persist to separate file.
   */
  setDiscoveredModels(models: DiscoveredModel[]): void {
    this.discoveredModels = models;
    this.saveDiscoveredModels();
  }

  getDiscoveredModels(): DiscoveredModel[] {
    return this.discoveredModels;
  }

  private loadDiscoveredModels(): void {
    try {
      if (existsSync(MODEL_ROUTE_DISCOVERED_FILE)) {
        this.discoveredModels = JSON.parse(readFileSync(MODEL_ROUTE_DISCOVERED_FILE, 'utf-8'));
        logger.debug('[model-routing] Discovered models loaded from file', {
          count: this.discoveredModels.length,
        });
      }
    } catch (err) {
      logger.warn('[model-routing] Failed to load discovered models', { error: err });
      this.discoveredModels = [];
    }
  }

  private saveDiscoveredModels(): void {
    try {
      if (!existsSync(MODEL_ROUTE_DIR)) {
        mkdirSync(MODEL_ROUTE_DIR, { recursive: true });
      }
      writeFileSync(
        MODEL_ROUTE_DISCOVERED_FILE,
        JSON.stringify(this.discoveredModels, null, 2),
        'utf-8'
      );
      logger.debug('[model-routing] Discovered models saved to file', {
        count: this.discoveredModels.length,
      });
    } catch (err) {
      logger.error('[model-routing] Failed to save discovered models', { error: err });
    }
  }

  // ── Config accessors (read-only views over this.data) ──────────────────

  getProviderConfigs(): Record<string, ProviderConfig> {
    return this.data.providerConfigs || {};
  }

  getDefaultProfile(): RoutingProfile | undefined {
    return this.data.defaultProfile;
  }

  getSessionPinningEnabled(): boolean | undefined {
    return this.data.sessionPinningEnabled;
  }

  getProviderCacheEnabled(): boolean | undefined {
    return this.data.providerCacheEnabled;
  }

  /**
   * Returns the path of the file this class owns (discovered-models.json).
   * For the config file path, use `ModelRoutingPolicyStore.getPath()`.
   */
  static getPath(): string {
    return MODEL_ROUTE_DISCOVERED_FILE;
  }
}
