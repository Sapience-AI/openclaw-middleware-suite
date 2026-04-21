/**
 * Model Routing Middleware — Main Entry Point
 *
 * Implements the Middleware interface. Manages the lifecycle of the routing
 * proxy: starts it on initialize(), stops it on shutdown().
 *
 * Design:
 *  - `beforeToolCall` is a deliberate pass-through (routing happens in the proxy).
 *  - The proxy runs on localhost:{port} and intercepts /v1/chat/completions.
 *  - Config hot-reload via centralized ConfigStore.onChange.
 *  - discovered-models.json is authored by `sai init` only; this middleware
 *    reads it on startup and never writes it. Catalog/cost data is loaded
 *    in the background purely for in-memory pricing lookup.
 */

import { Middleware, MiddlewareContext, MiddlewareResult } from '../../types.js';
import { logger } from '../../shared/Logger.js';
import {
  getOpenAIApiKey,
  getOpenAIBaseUrl,
  getAnthropicApiKey,
  getGoogleApiKey,
} from '../../shared/env.js';
import { RoutingProxy, setOnRouteCallback } from './proxy/server.js';
import {
  setDiscoveredModels,
  initSessionIntelligence,
  initResponseCache,
  initCostTracker,
  initPluginRegistry,
  getCostTracker,
  getPluginRegistry,
  loadModelCatalog,
} from './proxy/handler.js';
import { ModelRoutingStore } from './storage/ModelRoutingStore.js';
import { ConfigStore } from '../../shared/storage/ConfigStore.js';
import { RoutingAuditLog } from './storage/RoutingAuditLog.js';
import { ModelRoutingConfig, DEFAULT_MODEL_ROUTING_CONFIG } from './config.js';
import { RoutingDecision, RoutingAuditEntry, Tier, ProviderConfig } from './types.js';
import { CostTracker } from './storage/cost-tracker.js';
import { PluginRegistry } from './plugins/types.js';
import type { RouterPlugin } from './plugins/types.js';
import type { RoutingProfile } from './selection/profiles.js';
import { resolveProviderConfig } from './cli/provider-auth.js';
// fs.watchFile/unwatchFile replaced by centralized ConfigStore.onChange

const MIDDLEWARE_VERSION = '3.0.0';

export class ModelRoutingMiddleware implements Middleware {
  readonly name = 'model_routing';
  readonly version = MIDDLEWARE_VERSION;

  private enabled = false;
  private config: ModelRoutingConfig = DEFAULT_MODEL_ROUTING_CONFIG;
  private proxy: RoutingProxy | null = null;
  private store = new ModelRoutingStore();
  private auditLog = new RoutingAuditLog();
  private watching = false;
  private sessionEvictInterval: ReturnType<typeof setInterval> | null = null;

  // ── Middleware interface ──────────────────────────────────────────────────

  async initialize(rawConfig: Record<string, unknown>): Promise<void> {
    this.enabled = rawConfig.enabled !== false;
    if (!this.enabled) {
      logger.info('[model-routing] Middleware is disabled');
      return;
    }

    // ── Load store ─────────────────────────────────────────────────────────
    this.store.load();

    // ── Merge config: defaults ← plugin config ← store overrides ──────────
    this.config = this.buildConfig(rawConfig);

    // ── Validate API key ───────────────────────────────────────────────────
    if (!this.config.targetApiKey && Object.keys(this.config.providers).length === 0) {
      logger.warn(
        '[model-routing] No target API key or providers configured. ' +
          'Set OPENAI_API_KEY env var or model-routing.targetApiKey in openclaw.json'
      );
    }

    // Log resolved providers for diagnostics
    const providerNames = Object.keys(this.config.providers);
    if (providerNames.length > 0) {
      logger.info(`[model-routing] Active providers: ${providerNames.join(', ')}`);
    }

    // ── Initialize Phase 4: Session intelligence ──────────────────────────
    initSessionIntelligence(this.config);

    // ── Initialize Phase 5: Response cache, cost tracker, plugins ─────────
    initResponseCache(this.config);
    initCostTracker(this.config);
    initPluginRegistry();

    // ── Start proxy ────────────────────────────────────────────────────────
    this.proxy = new RoutingProxy(this.config);

    // Wire up audit logging (with cost data)
    setOnRouteCallback((decision) => this.onRoute(decision));

    // Feed discovered models to handler
    const discoveredModels = this.store.getDiscoveredModels();
    if (discoveredModels.length > 0) {
      setDiscoveredModels(discoveredModels);
    }

    try {
      await this.proxy.start();
      logger.info(
        `[model-routing] Initialized v${MIDDLEWARE_VERSION} — ` +
          `proxy on port ${this.config.port}, profile=${this.config.defaultProfile}`
      );
    } catch (err) {
      logger.error('[model-routing] Failed to start proxy', { error: err });
      this.proxy = null;
      this.enabled = false;
      return;
    }

    // ── Hot-reload store file ──────────────────────────────────────────────
    this.startWatching();

    // ── Periodic session eviction ──────────────────────────────────────────
    this.sessionEvictInterval = setInterval(() => {
      const mt = getMomentumTracker();
      if (mt) mt.evictStale(this.config.session.ttlMs);
      const ss = getSessionStore();
      if (ss) ss.evictExpired();
      const rc = getResponseCache();
      if (rc) rc.evictExpired();
    }, 60_000); // Every minute

    // ── Background: load LiteLLM catalog ───────────────────────────────────
    // Catalog feeds pricing/capabilities into the cost tracker and handler
    // bootstrap cache. Discovery is NOT run here — discovered-models.json is
    // authored once by `sai init` and the gateway is a pure consumer. Users
    // pick up catalog refreshes, new providers, and rotated keys by re-running
    // `sai init`. Keeping the gateway out of the write path avoids the
    // overwrite-on-restart bug where a narrower runtime provider set would
    // drop providers from the file.
    loadModelCatalog().catch((err) => {
      logger.debug('[model-routing] Background catalog load failed', { error: err });
    });
  }

  async beforeToolCall(_context: MiddlewareContext): Promise<MiddlewareResult> {
    // Model routing happens in the proxy, not in the tool-call pipeline
    return { block: false };
  }

  getStatus(): { enabled: boolean; stats?: Record<string, unknown> } {
    return {
      enabled: this.enabled,
      stats: this.proxy ? (this.proxy.getStats() as unknown as Record<string, unknown>) : undefined,
    };
  }

  async shutdown(): Promise<void> {
    // Stop periodic eviction
    if (this.sessionEvictInterval) {
      clearInterval(this.sessionEvictInterval);
      this.sessionEvictInterval = null;
    }

    // Shutdown plugins
    const registry = getPluginRegistry();
    if (registry) {
      await registry.shutdown();
    }

    this.stopWatching();
    if (this.proxy) {
      await this.proxy.stop();
      this.proxy = null;
    }
    // Only persist state if middleware is still enabled.
    // When disabling via dashboard, cleanupMiddleware() deletes the store key
    // before openclaw.json cleanup triggers this shutdown — saving here would
    // re-create the key that cleanup just removed.
    const pluginData = ConfigStore.readSync();
    if (pluginData?.plugin_config?.middlewares?.['model-routing'] !== false) {
      this.store.saveSync();
    }

    logger.info('[model-routing] Shutdown complete');
  }

  // ── Public accessors (for CLI) ───────────────────────────────────────────

  getConfig(): ModelRoutingConfig {
    return this.config;
  }

  getStore(): ModelRoutingStore {
    return this.store;
  }

  getAuditLog(): RoutingAuditLog {
    return this.auditLog;
  }

  getProxy(): RoutingProxy | null {
    return this.proxy;
  }

  getCostTracker(): CostTracker | null {
    return getCostTracker();
  }

  getPluginRegistry(): PluginRegistry | null {
    return getPluginRegistry();
  }

  // ── Plugin management ───────────────────────────────────────────────────

  registerPlugin(plugin: RouterPlugin): void {
    const registry = getPluginRegistry();
    if (registry) {
      registry.register(plugin);
      logger.info(`[model-routing] Plugin registered: ${plugin.name}`);
    }
  }

  unregisterPlugin(name: string): void {
    const registry = getPluginRegistry();
    if (registry) {
      registry.unregister(name);
      logger.info(`[model-routing] Plugin unregistered: ${name}`);
    }
  }

  // ── Config building ──────────────────────────────────────────────────────

  private buildConfig(rawConfig: Record<string, unknown>): ModelRoutingConfig {
    const base = { ...DEFAULT_MODEL_ROUTING_CONFIG };

    // Plugin-level config overrides
    if (typeof rawConfig.port === 'number') base.port = rawConfig.port;
    if (typeof rawConfig.targetBaseUrl === 'string') base.targetBaseUrl = rawConfig.targetBaseUrl;
    if (typeof rawConfig.targetApiKey === 'string') base.targetApiKey = rawConfig.targetApiKey;

    // Tier overrides from plugin config
    if (rawConfig.tiers && typeof rawConfig.tiers === 'object') {
      const tiers = rawConfig.tiers as Record<string, unknown>;
      for (const [tier, cfg] of Object.entries(tiers)) {
        if (tier in base.tiers && cfg && typeof cfg === 'object') {
          const tc = cfg as Record<string, unknown>;
          if (typeof tc.primary === 'string') {
            base.tiers[tier as Tier] = {
              primary: tc.primary,
              fallbacks: Array.isArray(tc.fallbacks) ? tc.fallbacks : [],
            };
          }
        }
      }
    }

    // Provider configs from plugin config (Phase 3)
    if (rawConfig.providers && typeof rawConfig.providers === 'object') {
      const providers = rawConfig.providers as Record<string, unknown>;
      for (const [name, cfg] of Object.entries(providers)) {
        if (cfg && typeof cfg === 'object') {
          const pc = cfg as Record<string, unknown>;
          if (typeof pc.baseUrl === 'string' && typeof pc.apiKey === 'string') {
            base.providers[name] = {
              name: (pc.name as string) || name,
              baseUrl: pc.baseUrl,
              apiKey: pc.apiKey,
              format: (pc.format as ProviderConfig['format']) || 'openai',
            };
          }
        }
      }
    }

    // Classifier config from plugin config (Phase 2)
    if (rawConfig.classifier && typeof rawConfig.classifier === 'object') {
      const cc = rawConfig.classifier as Record<string, unknown>;
      base.classifier = { ...base.classifier };
      if (typeof cc.enabled === 'boolean') base.classifier.enabled = cc.enabled;
      if (typeof cc.model === 'string') base.classifier.model = cc.model;
    }

    // Dedup config from plugin config (Phase 2)
    if (rawConfig.dedup && typeof rawConfig.dedup === 'object') {
      const dc = rawConfig.dedup as Record<string, unknown>;
      base.dedup = { ...base.dedup };
      if (typeof dc.enabled === 'boolean') base.dedup.enabled = dc.enabled;
      if (typeof dc.ttlMs === 'number') base.dedup.ttlMs = dc.ttlMs;
    }

    // Session config from plugin config (Phase 4)
    if (rawConfig.session && typeof rawConfig.session === 'object') {
      const sc = rawConfig.session as Record<string, unknown>;
      base.session = { ...base.session };
      if (typeof sc.ttlMs === 'number') base.session.ttlMs = sc.ttlMs;
      if (typeof sc.maxSessions === 'number') base.session.maxSessions = sc.maxSessions;
      if (typeof sc.strikeThreshold === 'number') base.session.strikeThreshold = sc.strikeThreshold;
    }

    // Momentum config from plugin config (Phase 4)
    if (rawConfig.momentum && typeof rawConfig.momentum === 'object') {
      const mc = rawConfig.momentum as Record<string, unknown>;
      base.momentum = { ...base.momentum };
      if (typeof mc.maxWeight === 'number') base.momentum.maxWeight = mc.maxWeight;
      if (typeof mc.historySize === 'number') base.momentum.historySize = mc.historySize;
    }

    // Default profile from plugin config (Phase 4)
    if (typeof rawConfig.defaultProfile === 'string') {
      base.defaultProfile = rawConfig.defaultProfile as RoutingProfile;
    }

    // Response cache config from plugin config (Phase 5)
    if (rawConfig.responseCache && typeof rawConfig.responseCache === 'object') {
      const rc = rawConfig.responseCache as Record<string, unknown>;
      base.responseCache = { ...base.responseCache };
      if (typeof rc.enabled === 'boolean') base.responseCache.enabled = rc.enabled;
      if (typeof rc.maxEntries === 'number') base.responseCache.maxEntries = rc.maxEntries;
      if (typeof rc.ttlMs === 'number') base.responseCache.ttlMs = rc.ttlMs;
    }

    // Cost alert config from plugin config (Phase 5)
    if (rawConfig.costAlerts && typeof rawConfig.costAlerts === 'object') {
      const ca = rawConfig.costAlerts as Record<string, unknown>;
      base.costAlerts = { ...base.costAlerts };
      if (typeof ca.enabled === 'boolean') base.costAlerts.enabled = ca.enabled;
      if (typeof ca.warnThresholdUsd === 'number')
        base.costAlerts.warnThresholdUsd = ca.warnThresholdUsd;
      if (typeof ca.criticalThresholdUsd === 'number')
        base.costAlerts.criticalThresholdUsd = ca.criticalThresholdUsd;
    }

    // Store overrides (user-tweaked weights, boundaries, tier mappings)
    const storeData = this.store.getData();

    if (storeData.weightOverrides) {
      for (const dim of base.scoring.dimensions) {
        if (dim.name in storeData.weightOverrides) {
          dim.weight = storeData.weightOverrides[dim.name];
        }
      }
    }

    if (storeData.boundaryOverrides) {
      Object.assign(base.scoring.boundaries, storeData.boundaryOverrides);
    }

    if (storeData.tierOverrides) {
      for (const [tier, cfg] of Object.entries(storeData.tierOverrides)) {
        if (cfg) {
          base.tiers[tier as Tier] = cfg;
        }
      }
    }

    // Merge store provider configs with plugin provider configs
    if (storeData.providerConfigs) {
      for (const [name, cfg] of Object.entries(storeData.providerConfigs)) {
        if (!base.providers[name]) {
          base.providers[name] = cfg;
        }
      }
    }

    // Store profile override
    if (storeData.defaultProfile) {
      base.defaultProfile = storeData.defaultProfile;
    }

    // Pinning + provider-cache overrides from store.
    // Cascade: if pinning is off, provider caching is forced off — a cached
    // prefix is useless when follow-up turns may land on a different model.
    if (storeData.sessionPinningEnabled !== undefined) {
      base.session.enabled = storeData.sessionPinningEnabled;
    }
    if (storeData.providerCacheEnabled !== undefined) {
      base.providerCache.enabled = storeData.providerCacheEnabled;
    }
    if (!base.session.enabled) {
      base.providerCache.enabled = false;
    }

    // Populate exclusions from store
    base.exclusions = storeData.exclusions || [];

    // Environment variable fallbacks
    const envOpenAIKey = getOpenAIApiKey();
    if (!base.targetApiKey && envOpenAIKey) {
      base.targetApiKey = envOpenAIKey;
    }
    const envOpenAIBaseUrl = getOpenAIBaseUrl();
    if (base.targetBaseUrl === DEFAULT_MODEL_ROUTING_CONFIG.targetBaseUrl && envOpenAIBaseUrl) {
      base.targetBaseUrl = envOpenAIBaseUrl;
    }

    // Provider-specific env var fallbacks
    const envAnthropicKey = getAnthropicApiKey();
    if (!base.providers.anthropic && envAnthropicKey) {
      base.providers.anthropic = {
        name: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: envAnthropicKey,
        format: 'anthropic',
      };
    }
    const envGoogleKey = getGoogleApiKey();
    if (!base.providers.google && envGoogleKey) {
      base.providers.google = {
        name: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: envGoogleKey,
        format: 'google',
      };
    }

    // Auto-populate openai provider from targetApiKey (mirrors anthropic/google above)
    if (!base.providers.openai && base.targetApiKey) {
      base.providers.openai = {
        name: 'openai',
        baseUrl: base.targetBaseUrl,
        apiKey: base.targetApiKey,
        format: 'openai',
      };
    }

    // Auto-resolve missing providers from tier models.
    // Scans all tier primaries + fallbacks, infers the provider from model name
    // prefixes, and resolves API keys from env vars or OpenClaw auth profiles.
    this.autoResolveProvidersFromTiers(base);

    return base;
  }

  // ── Provider auto-resolution from tier models ────────────────────────────

  /** Map model name prefixes to provider names (same logic as registry.ts PREFIX_MAP). */
  private static readonly MODEL_PREFIX_TO_PROVIDER: Array<{ prefix: string; provider: string }> = [
    { prefix: 'anthropic/', provider: 'anthropic' },
    { prefix: 'claude-', provider: 'anthropic' },
    { prefix: 'google/', provider: 'google' },
    { prefix: 'gemini/', provider: 'google' },
    { prefix: 'gemini-', provider: 'google' },
    { prefix: 'openai/', provider: 'openai' },
    { prefix: 'gpt-', provider: 'openai' },
    { prefix: 'o1-', provider: 'openai' },
    { prefix: 'o3-', provider: 'openai' },
    { prefix: 'o3', provider: 'openai' },
    { prefix: 'o4-', provider: 'openai' },
  ];

  /**
   * Infer which provider a model belongs to from its name prefix.
   */
  private inferProviderFromModel(modelId: string): string | undefined {
    for (const { prefix, provider } of ModelRoutingMiddleware.MODEL_PREFIX_TO_PROVIDER) {
      if (modelId.startsWith(prefix)) return provider;
    }
    return undefined;
  }

  /**
   * Scan all tier models and auto-populate missing provider configs.
   * Uses env vars and OpenClaw auth profiles to resolve API keys.
   */
  private autoResolveProvidersFromTiers(config: ModelRoutingConfig): void {
    const neededProviders = new Set<string>();

    for (const tierCfg of Object.values(config.tiers)) {
      const provider = this.inferProviderFromModel(tierCfg.primary);
      if (provider) neededProviders.add(provider);
      for (const fb of tierCfg.fallbacks) {
        const fbProvider = this.inferProviderFromModel(fb);
        if (fbProvider) neededProviders.add(fbProvider);
      }
    }

    for (const provider of neededProviders) {
      if (config.providers[provider]) continue; // Already configured

      const resolved = resolveProviderConfig(provider);
      if (resolved) {
        config.providers[provider] = resolved;
        logger.info(`[model-routing] Auto-resolved provider: ${provider}`);
      } else {
        logger.warn(
          `[model-routing] Tier models require "${provider}" but no API key found ` +
            `in OpenClaw auth profiles or environment. Configure the provider in OpenClaw settings.`
        );
      }
    }
  }

  // ── Audit logging ────────────────────────────────────────────────────────

  private onRoute(decision: RoutingDecision): void {
    const entry: RoutingAuditEntry = {
      ts: new Date().toISOString(),
      tier: decision.tier,
      model: decision.model,
      score: decision.score,
      confidence: decision.confidence,
      reason: decision.reason,
      latencyMs: decision.latencyMs,
      promptPreview: '', // kept minimal for privacy
      fallbackFrom: decision.fallbackFrom,
      costEstimateUsd: decision.costEstimateUsd,
    };

    this.auditLog.append(entry);
  }

  // ── Hot-reload (via centralized ConfigStore watcher) ──────────────────────

  private onConfigStoreChange = (): void => {
    logger.info('[model-routing] Config store changed — reloading');
    this.store.load();
    this.config = this.buildConfig(this.config as unknown as Record<string, unknown>);

    // Update discovered models in handler
    const models = this.store.getDiscoveredModels();
    if (models.length > 0) {
      setDiscoveredModels(models);
    }

    if (this.proxy) {
      this.proxy.updateConfig(this.config);
    }
  };

  private startWatching(): void {
    if (this.watching) return;
    ConfigStore.onChange('model_routing', this.onConfigStoreChange);
    this.watching = true;
  }

  private stopWatching(): void {
    if (!this.watching) return;
    ConfigStore.offChange('model_routing', this.onConfigStoreChange);
    this.watching = false;
  }
}

// ── Helper imports for session eviction (from handler) ──────────────────────

import { getMomentumTracker, getSessionStore, getResponseCache } from './proxy/handler.js';
