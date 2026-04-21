/**
 * Model Routing Store — Persists config overrides and state.
 *
 * Config (user-configurable settings) lives in the shared ConfigStore
 * (sapience-ai-suite.json) under the 'model_routing' key.
 *
 * Discovered models (runtime cache from provider APIs) live in a
 * separate file (model-routing/discovered-models.json) to avoid
 * save() calls overwriting dashboard config changes.
 */

import { SAPIENCE_MW_STORE_FILE, logger } from '../../../shared/Logger.js';
import { ConfigStore } from '../../../shared/storage/ConfigStore.js';
import { MODEL_ROUTE_DIR, MODEL_ROUTE_DISCOVERED_FILE } from '../../../shared/storage/paths.js';
import { Tier, TierModelConfig, DiscoveredModel, ProviderConfig } from '../types.js';
import { RoutingProfile } from '../selection/profiles.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

export interface ModelRoutingStoreData {
  /** User overrides for scoring weights (dimension name → weight) */
  weightOverrides?: Record<string, number>;
  /** User overrides for tier boundaries */
  boundaryOverrides?: {
    simpleStandard?: number;
    standardComplex?: number;
    complexReasoning?: number;
  };
  /** User overrides for tier-to-model mappings */
  tierOverrides?: Partial<Record<Tier, TierModelConfig>>;
  /** Model exclusion list */
  exclusions?: string[];
  /** Configured provider connections */
  providerConfigs?: Record<string, ProviderConfig>;
  /** Default routing profile override */
  defaultProfile?: RoutingProfile;
  /** When false, skip the pinning check — every turn re-scores. Default true. */
  sessionPinningEnabled?: boolean;
  /** When false, adapters skip provider prompt-cache markers. Default true.
   *  Coerced to false in buildConfig when sessionPinningEnabled is false. */
  providerCacheEnabled?: boolean;
}

export class ModelRoutingStore {
  private data: ModelRoutingStoreData = {};
  /** Discovered models — stored in separate file, not in ConfigStore */
  private discoveredModels: DiscoveredModel[] = [];

  /**
   * Load store from disk. Non-destructive: missing key = empty store.
   * Reads config from ConfigStore and discovered models from separate file.
   */
  load(): void {
    try {
      const storeData = ConfigStore.readSync();
      const state = storeData.model_routing;
      if (state && typeof state === 'object') {
        this.data = state as ModelRoutingStoreData;
        logger.info('[model-routing] Config loaded from unified store');
      } else {
        this.data = {};
        logger.info('[model-routing] No existing config found, using defaults');
      }
    } catch (err) {
      logger.warn('[model-routing] Failed to load store, using defaults', { error: err });
      this.data = {};
    }

    // Load discovered models from separate file
    this.loadDiscoveredModels();
  }

  /**
   * Persist config to disk. Only writes user-configurable settings
   * to ConfigStore — discovered models are stored separately.
   */
  async save(): Promise<void> {
    try {
      await ConfigStore.update('model_routing', this.data);
    } catch (err) {
      logger.error('[model-routing] Failed to save store', { error: err });
    }
  }

  /**
   * Synchronous save for shutdown paths.
   */
  saveSync(): void {
    try {
      ConfigStore.updateSync('model_routing', this.data);
    } catch (err) {
      logger.error('[model-routing] Failed to save store (sync)', { error: err });
    }
  }

  getData(): Readonly<ModelRoutingStoreData> {
    return this.data;
  }

  setWeightOverride(dimension: string, weight: number): void {
    if (!this.data.weightOverrides) this.data.weightOverrides = {};
    this.data.weightOverrides[dimension] = weight;
  }

  setBoundaryOverride(key: string, value: number): void {
    if (!this.data.boundaryOverrides) this.data.boundaryOverrides = {};
    (this.data.boundaryOverrides as Record<string, number>)[key] = value;
  }

  setTierOverride(tier: Tier, config: TierModelConfig): void {
    if (!this.data.tierOverrides) this.data.tierOverrides = {};
    this.data.tierOverrides[tier] = config;
  }

  addExclusion(model: string): void {
    if (!this.data.exclusions) this.data.exclusions = [];
    if (!this.data.exclusions.includes(model)) {
      this.data.exclusions.push(model);
    }
  }

  removeExclusion(model: string): void {
    if (!this.data.exclusions) return;
    this.data.exclusions = this.data.exclusions.filter((m) => m !== model);
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

  // ── Provider configs ────────────────────────────────────────────────────

  setProviderConfig(name: string, config: ProviderConfig): void {
    if (!this.data.providerConfigs) this.data.providerConfigs = {};
    this.data.providerConfigs[name] = config;
  }

  removeProviderConfig(name: string): void {
    if (this.data.providerConfigs) {
      delete this.data.providerConfigs[name];
    }
  }

  getProviderConfigs(): Record<string, ProviderConfig> {
    return this.data.providerConfigs || {};
  }

  // ── Default profile ──────────────────────────────────────────────────

  setDefaultProfile(profile: RoutingProfile): void {
    this.data.defaultProfile = profile;
  }

  getDefaultProfile(): RoutingProfile | undefined {
    return this.data.defaultProfile;
  }

  // ── Pinning + provider-cache toggles ─────────────────────────────────

  setSessionPinningEnabled(enabled: boolean): void {
    this.data.sessionPinningEnabled = enabled;
  }

  setProviderCacheEnabled(enabled: boolean): void {
    this.data.providerCacheEnabled = enabled;
  }

  getSessionPinningEnabled(): boolean | undefined {
    return this.data.sessionPinningEnabled;
  }

  getProviderCacheEnabled(): boolean | undefined {
    return this.data.providerCacheEnabled;
  }

  /**
   * Clear all overrides (reset to defaults).
   */
  reset(): void {
    this.data = {};
  }

  /**
   * Get the store file path (for CLI display and hot-reload watching).
   */
  static get filePath(): string {
    return SAPIENCE_MW_STORE_FILE;
  }

  /**
   * Alias for CLI display consistency with other middleware stores.
   */
  static getPath(): string {
    return SAPIENCE_MW_STORE_FILE;
  }
}
