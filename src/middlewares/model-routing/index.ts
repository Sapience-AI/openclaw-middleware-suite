/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

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
import { ModelRoutingDiscovery } from './storage/ModelRoutingDiscovery.js';
import { ConfigStore } from '../../shared/storage/ConfigStore.js';
import { RoutingAuditLog } from './storage/RoutingAuditLog.js';
import { ModelRoutingConfig, DEFAULT_MODEL_ROUTING_CONFIG } from './config.js';
import {
  RoutingDecision,
  RoutingAuditEntry,
  Tier,
  ProviderConfig,
  ScoringResult,
} from './types.js';
import { CostTracker } from './storage/cost-tracker.js';
import { PluginRegistry } from './plugins/types.js';
import type { RouterPlugin } from './plugins/types.js';
import type { RoutingProfile } from './selection/profiles.js';
import { resolveProviderConfig } from './cli/provider-auth.js';
import { scoreRequest, ScoreRequestInput } from './scoring/scorer.js';
// fs.watchFile/unwatchFile replaced by centralized ConfigStore.onChange

const MIDDLEWARE_VERSION = '3.0.0';

export class ModelRoutingMiddleware implements Middleware {
  readonly name = 'model_routing';
  readonly version = MIDDLEWARE_VERSION;

  private enabled = false;
  private config: ModelRoutingConfig = DEFAULT_MODEL_ROUTING_CONFIG;
  private proxy: RoutingProxy | null = null;
  private store = new ModelRoutingDiscovery();
  private auditLog = new RoutingAuditLog();
  private watching = false;
  private sessionEvictInterval: ReturnType<typeof setInterval> | null = null;

  // ── Middleware interface ──────────────────────────────────────────────────

  /**
   * Build config from `rawConfig` + disk store, then auto-start the proxy
   * unless `rawConfig.enabled === false`. Programmatic consumers can skip
   * the auto-start by passing `enabled: false` and later call `start()`
   * explicitly when they want the proxy bound.
   */
  async initialize(rawConfig: Record<string, unknown>): Promise<void> {
    // ── Load store + build config (always) ─────────────────────────────────
    this.store.load();
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

    // Honor `enabled: false` as "build config but don't start the proxy".
    // Caller can later run `await mr.start()` to bring the proxy up using
    // the config that was built here.
    if (rawConfig.enabled === false) {
      this.enabled = false;
      logger.info('[model-routing] Initialized but proxy not started (enabled: false)');
      return;
    }

    await this.start();
  }

  /**
   * Bring up the routing proxy on the configured port. Idempotent — safe
   * to call when already running. Requires `initialize(config)` to have
   * been called first so `this.config` is populated.
   *
   * Programmatic users can call `start()` / `stop()` to toggle the proxy
   * at runtime without re-initializing (which would rebuild caches and
   * re-subscribe to file watchers from scratch).
   */
  async start(): Promise<void> {
    if (this.proxy) {
      logger.debug('[model-routing] start() called but proxy already running');
      return;
    }

    // ── Initialize Phase 4: Session intelligence ──────────────────────────
    initSessionIntelligence(this.config);

    // ── Initialize Phase 5: Response cache, cost tracker, plugins ─────────
    initResponseCache(this.config);
    initCostTracker(this.config);
    initPluginRegistry();

    // ── Build proxy ────────────────────────────────────────────────────────
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
      this.enabled = true;
      logger.info(
        `[model-routing] Started v${MIDDLEWARE_VERSION} — ` +
          `proxy on port ${this.config.port}, profile=${this.config.defaultProfile}`
      );
    } catch (err) {
      logger.error('[model-routing] Failed to start proxy', { error: err });
      this.proxy = null;
      this.enabled = false;
      throw err;
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
    // authored once by `sai init` and the gateway is a pure consumer.
    loadModelCatalog().catch((err) => {
      logger.debug('[model-routing] Background catalog load failed', { error: err });
    });
  }

  /**
   * Tear down the routing proxy and its runtime resources (session eviction
   * interval, plugin registry, file watcher). Idempotent — safe to call
   * when the proxy isn't running. The instance remains usable; call
   * `start()` again to re-bind. For permanent teardown use `shutdown()`.
   */
  async stop(): Promise<void> {
    if (this.sessionEvictInterval) {
      clearInterval(this.sessionEvictInterval);
      this.sessionEvictInterval = null;
    }

    const registry = getPluginRegistry();
    if (registry) {
      await registry.shutdown();
    }

    this.stopWatching();

    if (this.proxy) {
      await this.proxy.stop();
      this.proxy = null;
    }

    this.enabled = false;
    logger.info('[model-routing] Stopped');
  }

  /**
   * Score a chat-completion-shaped request and return the chosen tier
   * along with confidence and per-dimension breakdown. Pure in-process —
   * does NOT require the proxy to be running. Useful for embedding the
   * routing engine directly in your own request pipeline without binding
   * an HTTP server.
   *
   * Pair the returned tier with `mr.getConfig().tiersByProfile[profile][result.tier]`
   * (where `profile` is one of `eco` / `premium` / `agentic`) to resolve the
   * configured primary/fallback model names for that tier under the chosen
   * profile.
   */
  pickTier(input: ScoreRequestInput): ScoringResult {
    return scoreRequest(input, this.config.scoring);
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
    // Permanent teardown — delegates to stop() for the proxy + runtime
    // resource cleanup. The Middleware-interface contract is "this
    // instance is no longer in use", so nothing else needs to happen here.
    //
    // No store persist: the runtime only reads config; all mutations flow
    // through ModelRoutingPolicyStore from the CLI and dashboard, and
    // those writers persist inline. Re-saving in-memory state here would
    // just re-trigger the ConfigStore file write for no semantic change.
    await this.stop();
    logger.info('[model-routing] Shutdown complete');
  }

  // ── Public accessors (for CLI) ───────────────────────────────────────────

  getConfig(): ModelRoutingConfig {
    return this.config;
  }

  getStore(): ModelRoutingDiscovery {
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
    // Deep-clone the per-profile tier table so subsequent mutations don't
    // leak into the module-level default. `{ ...DEFAULT }` is a shallow copy
    // and `tiersByProfile` is a nested object literal.
    base.tiersByProfile = JSON.parse(
      JSON.stringify(DEFAULT_MODEL_ROUTING_CONFIG.tiersByProfile)
    ) as typeof base.tiersByProfile;

    // Plugin-level config overrides
    if (typeof rawConfig.port === 'number') base.port = rawConfig.port;
    if (typeof rawConfig.targetBaseUrl === 'string') base.targetBaseUrl = rawConfig.targetBaseUrl;
    if (typeof rawConfig.targetApiKey === 'string') base.targetApiKey = rawConfig.targetApiKey;

    // Per-profile tier overrides from plugin config (preferred shape).
    // `tiersByProfile: { eco: {...}, premium: {...}, agentic: {...} }`
    if (rawConfig.tiersByProfile && typeof rawConfig.tiersByProfile === 'object') {
      const byProfile = rawConfig.tiersByProfile as Record<string, unknown>;
      for (const [profile, profileTiers] of Object.entries(byProfile)) {
        if (!(profile in base.tiersByProfile)) continue;
        if (!profileTiers || typeof profileTiers !== 'object') continue;
        for (const [tier, cfg] of Object.entries(profileTiers as Record<string, unknown>)) {
          if (!(tier in base.tiersByProfile[profile as RoutingProfile])) continue;
          if (!cfg || typeof cfg !== 'object') continue;
          const tc = cfg as Record<string, unknown>;
          if (typeof tc.primary === 'string') {
            base.tiersByProfile[profile as RoutingProfile][tier as Tier] = {
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

    // Per-profile tier overrides from disk store. Each profile slot is
    // applied independently — a write to `eco` doesn't touch `premium` or
    // `agentic`. Missing profile slots inherit the default (PROFILE_CONFIGS).
    if (storeData.tierOverridesByProfile) {
      for (const [profile, profileTiers] of Object.entries(storeData.tierOverridesByProfile)) {
        if (!(profile in base.tiersByProfile)) continue;
        if (!profileTiers) continue;
        for (const [tier, cfg] of Object.entries(profileTiers)) {
          if (!(tier in base.tiersByProfile[profile as RoutingProfile])) continue;
          if (cfg) {
            base.tiersByProfile[profile as RoutingProfile][tier as Tier] = cfg;
          }
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

    // Pinning + provider-cache overrides from store. The two toggles used to
    // cascade (pinning off forced cache off) but are now independent — caching
    // adds value on its own (provider-side prefix dedup across requests within
    // the same model) even when the per-session pin isn't set, so we no longer
    // coerce `providerCache.enabled` based on `session.enabled`.
    if (storeData.sessionPinningEnabled !== undefined) {
      base.session.enabled = storeData.sessionPinningEnabled;
    }
    if (storeData.providerCacheEnabled !== undefined) {
      base.providerCache.enabled = storeData.providerCacheEnabled;
    }

    // ── Bootstrap-from-store overlays ─────────────────────────────────
    // Previously these came only from `plugin_config['model-routing']` via
    // rawConfig (above). They now also flow from the disk overlay so the
    // plugin can call `initialize({})` and have a single source of truth.
    // Disk values overlay rawConfig — matching how every other field that
    // appears in both sources is resolved (storeData wins).

    if (typeof storeData.port === 'number') {
      base.port = storeData.port;
    }

    if (storeData.responseCache && typeof storeData.responseCache === 'object') {
      const rc = storeData.responseCache;
      base.responseCache = { ...base.responseCache };
      if (typeof rc.enabled === 'boolean') base.responseCache.enabled = rc.enabled;
      if (typeof rc.maxEntries === 'number') base.responseCache.maxEntries = rc.maxEntries;
      if (typeof rc.ttlMs === 'number') base.responseCache.ttlMs = rc.ttlMs;
    }

    if (storeData.costAlerts && typeof storeData.costAlerts === 'object') {
      const ca = storeData.costAlerts;
      base.costAlerts = { ...base.costAlerts };
      if (typeof ca.enabled === 'boolean') base.costAlerts.enabled = ca.enabled;
      if (typeof ca.warnThresholdUsd === 'number')
        base.costAlerts.warnThresholdUsd = ca.warnThresholdUsd;
      if (typeof ca.criticalThresholdUsd === 'number')
        base.costAlerts.criticalThresholdUsd = ca.criticalThresholdUsd;
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
   * Scan all tier models across every profile and auto-populate missing
   * provider configs. Uses env vars and OpenClaw auth profiles to resolve
   * API keys. Iterates every profile because users can pick any of them
   * per request — a key only present in one profile's tiers must still
   * resolve.
   */
  private autoResolveProvidersFromTiers(config: ModelRoutingConfig): void {
    const neededProviders = new Set<string>();

    for (const profileTiers of Object.values(config.tiersByProfile)) {
      for (const tierCfg of Object.values(profileTiers)) {
        const provider = this.inferProviderFromModel(tierCfg.primary);
        if (provider) neededProviders.add(provider);
        for (const fb of tierCfg.fallbacks) {
          const fbProvider = this.inferProviderFromModel(fb);
          if (fbProvider) neededProviders.add(fbProvider);
        }
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
      inputTokens: decision.inputTokens,
      outputTokens: decision.outputTokens,
      cacheReadTokens: decision.cacheReadTokens,
      cacheWriteTokens: decision.cacheWriteTokens,
      inputCostUsd: decision.inputCostUsd,
      outputCostUsd: decision.outputCostUsd,
    };

    this.auditLog.append(entry);
  }

  // ── In-process config updates ───────────────────────────────────────────

  /**
   * Shallow-merge `partial` into the current config without rebuilding from
   * defaults or touching the disk store. Use this for in-process programmatic
   * updates from external consumers who don't want a sapience-ai-suite.json
   * dependency. Sibling fields you don't pass are preserved.
   *
   * If the proxy is currently running, the change is propagated to it
   * immediately via `proxy.updateConfig()`. `pickTier()` reads `this.config`
   * on every call, so it picks up the change with no extra step.
   *
   * For nested patches, spread the current sub-object yourself:
   *
   *   mr.updateConfig({
   *     tiersByProfile: {
   *       ...mr.getConfig().tiersByProfile,
   *       eco: {
   *         ...mr.getConfig().tiersByProfile.eco,
   *         SIMPLE: { primary: 'gpt-5-mini', fallbacks: [] },
   *       },
   *     },
   *   });
   *
   * For disk-backed updates that survive process restarts (and hot-reload
   * to other plugin instances), use `ModelRoutingPolicyStore.update()` +
   * `reloadConfig()` instead.
   */
  updateConfig(partial: Partial<ModelRoutingConfig>): void {
    this.config = { ...this.config, ...partial };
    if (this.proxy) {
      this.proxy.updateConfig(this.config);
    }
  }

  // ── Hot-reload ────────────────────────────────────────────────────────────

  /**
   * Re-read config from the store and re-apply it to the running middleware.
   * Pair with `ModelRoutingPolicyStore.save(data)` for programmatic config
   * updates:
   *
   *   await ModelRoutingPolicyStore.save(newConfig);
   *   routing.reloadConfig();
   *
   * Also invoked automatically by the ConfigStore file watcher when the
   * dashboard or CLI writes changes.
   */
  reloadConfig(): void {
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
  }

  private onConfigStoreChange = (): void => {
    logger.info('[model-routing] Config store changed — reloading');
    this.reloadConfig();
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
