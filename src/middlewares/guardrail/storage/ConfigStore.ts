/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Guardrail ConfigStore
 *
 * Manages persistence of guardrail configuration.
 * Default rules are imported from rules/ — not defined here.
 * Storage: unified sapience-ai-suite.json under key "guardrail"
 *
 * SECURITY: All loaded config is validated against the schema.
 * Invalid/missing fields fall back to hardcoded defaults — never fail-open empty.
 */

import {
  GuardrailConfig,
  DetectionRule,
  DetectionAction,
  SeverityLevel,
  OutputScrubberConfig,
} from '../types.js';
import { DEFAULT_RULES } from '../rules/index.js';
import { logger } from '../../../shared/Logger.js';
import { ConfigStore as UnifiedStore } from '../../../shared/storage/ConfigStore.js';
import { STORE_KEY_GUARDRAIL, STORE_KEY_PLUGIN_CONFIG } from '../../../shared/storage/paths.js';

export const DEFAULT_OUTPUT_SCRUBBER_CONFIG: OutputScrubberConfig = {
  enabled: true,
  dryRunMode: false,
  replacementText: '',
  customPatterns: [],
};

export const DEFAULT_GUARDRAIL_CONFIG: GuardrailConfig = {
  version: '2.0.0',
  dryRunMode: false,
  unicodeNormalization: true,
  entropyThreshold: 4.0,
  rules: DEFAULT_RULES,
  outputScrubber: { ...DEFAULT_OUTPUT_SCRUBBER_CONFIG },
  moderation: { rewriteThreshold: 'HIGH' },
};

// ── Schema validation ──────────────────────────────────────────

const VALID_ACTIONS: DetectionAction[] = ['LOG', 'WARN', 'BLOCK'];
const VALID_SEVERITIES: SeverityLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const VALID_RULE_TYPES = ['regex', 'prefix', 'heuristic'];
const VALID_CONFIDENCE = ['high', 'medium'];

/**
 * Validate a single detection rule. Returns true if valid, false if invalid.
 * Invalid rules are logged and excluded — never crash the system.
 */
function isValidRule(rule: unknown, index: number, category: string): rule is DetectionRule {
  if (!rule || typeof rule !== 'object') {
    logger.warn(`[config-validate] Invalid rule at ${category}[${index}]: not an object`);
    return false;
  }

  const r = rule as Record<string, unknown>;

  if (typeof r.name !== 'string' || r.name.length === 0) {
    logger.warn(`[config-validate] Invalid rule at ${category}[${index}]: missing name`);
    return false;
  }

  if (typeof r.type !== 'string' || !VALID_RULE_TYPES.includes(r.type)) {
    logger.warn(`[config-validate] Invalid rule "${r.name}": bad type "${r.type}"`);
    return false;
  }

  if (typeof r.pattern !== 'string') {
    logger.warn(`[config-validate] Invalid rule "${r.name}": missing pattern`);
    return false;
  }

  // Validate regex patterns can compile (catch ReDoS-prone patterns early)
  if (r.type === 'regex') {
    try {
      new RegExp(r.pattern as string, 'gi');
    } catch {
      logger.warn(
        `[config-validate] Invalid rule "${r.name}": regex won't compile: "${(r.pattern as string).slice(0, 50)}"`
      );
      return false;
    }
  }

  if (typeof r.severity !== 'string' || !VALID_SEVERITIES.includes(r.severity as SeverityLevel)) {
    logger.warn(`[config-validate] Invalid rule "${r.name}": bad severity "${r.severity}"`);
    return false;
  }

  if (typeof r.action !== 'string' || !VALID_ACTIONS.includes(r.action as DetectionAction)) {
    logger.warn(`[config-validate] Invalid rule "${r.name}": bad action "${r.action}"`);
    return false;
  }

  if (r.confidence !== undefined && !VALID_CONFIDENCE.includes(r.confidence as string)) {
    logger.warn(`[config-validate] Invalid rule "${r.name}": bad confidence "${r.confidence}"`);
    return false;
  }

  return true;
}

/**
 * Validate and sanitize a loaded config. Invalid fields fall back to defaults.
 * Returns a guaranteed-valid GuardrailConfig.
 */
function validateConfig(raw: unknown): GuardrailConfig {
  const defaults = JSON.parse(JSON.stringify(DEFAULT_GUARDRAIL_CONFIG)) as GuardrailConfig;

  if (!raw || typeof raw !== 'object') {
    logger.warn('[config-validate] Config is not an object — using defaults');
    return defaults;
  }

  const data = raw as Record<string, unknown>;
  const config: GuardrailConfig = { ...defaults };

  // ── Core fields ─────────────────────────────────────────────
  if (typeof data.version === 'string') config.version = data.version;

  if (typeof data.dryRunMode === 'boolean') {
    config.dryRunMode = data.dryRunMode;
  } else if (data.dryRunMode !== undefined) {
    logger.warn(`[config-validate] Invalid "dryRunMode": ${data.dryRunMode} — using default`);
  }

  if (typeof data.unicodeNormalization === 'boolean') {
    config.unicodeNormalization = data.unicodeNormalization;
  } else if (data.unicodeNormalization !== undefined) {
    logger.warn(`[config-validate] Invalid "unicodeNormalization" — using default (true)`);
    config.unicodeNormalization = true; // SECURITY: force on if invalid
  }

  // ── Entropy threshold (bounded: 1.0 – 8.0) ─────────────────
  if (typeof data.entropyThreshold === 'number') {
    if (data.entropyThreshold >= 1.0 && data.entropyThreshold <= 8.0) {
      config.entropyThreshold = data.entropyThreshold;
    } else {
      logger.warn(
        `[config-validate] entropyThreshold ${data.entropyThreshold} out of range [1.0, 8.0] — using default (4.0)`
      );
      config.entropyThreshold = 4.0;
    }
  }

  // ── Rules (validate each rule individually) ─────────────────
  if (data.rules && typeof data.rules === 'object') {
    const rules = data.rules as Record<string, unknown>;

    for (const category of ['promptInjection', 'pii', 'suspicious'] as const) {
      const catRules = rules[category];
      if (Array.isArray(catRules)) {
        config.rules[category] = catRules.filter((r, i) =>
          isValidRule(r, i, category)
        ) as DetectionRule[];
        const dropped = catRules.length - config.rules[category].length;
        if (dropped > 0) {
          logger.warn(`[config-validate] Dropped ${dropped} invalid rule(s) from ${category}`);
        }
      }
      // If category is missing or not an array, keep defaults
    }
  }

  // ── Guard configs (optional — validate if present) ──────────
  if (data.sensitivePaths && typeof data.sensitivePaths === 'object') {
    const sp = data.sensitivePaths as Record<string, unknown>;
    config.sensitivePaths = {
      enabled: typeof sp.enabled === 'boolean' ? sp.enabled : true,
      action: VALID_ACTIONS.includes(sp.action as DetectionAction)
        ? (sp.action as DetectionAction)
        : 'BLOCK',
      blockedPaths: Array.isArray(sp.blockedPaths)
        ? sp.blockedPaths.filter((p): p is string => typeof p === 'string')
        : [],
      allowedPaths: Array.isArray(sp.allowedPaths)
        ? sp.allowedPaths.filter((p): p is string => typeof p === 'string')
        : [],
    };
  }

  if (data.egressControl && typeof data.egressControl === 'object') {
    const ec = data.egressControl as Record<string, unknown>;
    config.egressControl = {
      enabled: typeof ec.enabled === 'boolean' ? ec.enabled : true,
      defaultAction: VALID_ACTIONS.includes(ec.defaultAction as DetectionAction)
        ? (ec.defaultAction as DetectionAction)
        : 'BLOCK',
      allowedDomains: Array.isArray(ec.allowedDomains)
        ? ec.allowedDomains.filter((d): d is string => typeof d === 'string')
        : [],
      blockDataSending: typeof ec.blockDataSending === 'boolean' ? ec.blockDataSending : true,
      blockPrivateIPs: typeof ec.blockPrivateIPs === 'boolean' ? ec.blockPrivateIPs : true,
    };
  }

  if (data.destructiveCommands && typeof data.destructiveCommands === 'object') {
    const dc = data.destructiveCommands as Record<string, unknown>;
    const customPatterns: string[] = [];
    if (Array.isArray(dc.customPatterns)) {
      for (const p of dc.customPatterns) {
        if (typeof p !== 'string') continue;
        try {
          new RegExp(p, 'i'); // validate compiles
          customPatterns.push(p);
        } catch {
          logger.warn(
            `[config-validate] Dropped invalid destructive custom pattern: "${p.slice(0, 50)}"`
          );
        }
      }
    }
    config.destructiveCommands = {
      enabled: typeof dc.enabled === 'boolean' ? dc.enabled : true,
      action: VALID_ACTIONS.includes(dc.action as DetectionAction)
        ? (dc.action as DetectionAction)
        : 'BLOCK',
      customPatterns,
    };
  }

  // ── Output scrubber config (optional — validate if present) ──
  if (data.outputScrubber && typeof data.outputScrubber === 'object') {
    const os_ = data.outputScrubber as Record<string, unknown>;
    const scrubberPatterns: string[] = [];
    if (Array.isArray(os_.customPatterns)) {
      for (const p of os_.customPatterns) {
        if (typeof p !== 'string') continue;
        try {
          new RegExp(p, 'gi');
          scrubberPatterns.push(p);
        } catch {
          logger.warn(
            `[config-validate] Dropped invalid output scrubber custom pattern: "${p.slice(0, 50)}"`
          );
        }
      }
    }
    config.outputScrubber = {
      enabled: typeof os_.enabled === 'boolean' ? os_.enabled : true,
      dryRunMode: typeof os_.dryRunMode === 'boolean' ? os_.dryRunMode : false,
      replacementText: typeof os_.replacementText === 'string' ? os_.replacementText : '',
      customPatterns: scrubberPatterns,
    };
  } else {
    config.outputScrubber = { ...DEFAULT_OUTPUT_SCRUBBER_CONFIG };
  }

  // ── Moderation config (optional — validate if present) ──
  const VALID_THRESHOLDS = ['MEDIUM', 'HIGH', 'CRITICAL'] as const;
  if (data.moderation && typeof data.moderation === 'object') {
    const m = data.moderation as Record<string, unknown>;
    const threshold =
      typeof m.rewriteThreshold === 'string' &&
      (VALID_THRESHOLDS as readonly string[]).includes(m.rewriteThreshold)
        ? (m.rewriteThreshold as 'MEDIUM' | 'HIGH' | 'CRITICAL')
        : 'HIGH';
    if (m.rewriteThreshold && threshold !== m.rewriteThreshold) {
      logger.warn(
        `[config-validate] Invalid moderation.rewriteThreshold "${m.rewriteThreshold}" — using default (HIGH)`
      );
    }
    config.moderation = { rewriteThreshold: threshold };
  } else {
    config.moderation = { rewriteThreshold: 'HIGH' };
  }

  return config;
}

// ── ConfigStore class ──────────────────────────────────────────

export class ConfigStore {
  /**
   * In-memory cached config, kept fresh by ConfigStore.onChange('guardrail', ...).
   * All hooks use getCached() instead of loadSync() to avoid synchronous
   * disk reads on every tool call and message write.
   */
  private static cachedConfig: GuardrailConfig | null = null;

  /**
   * Cached plugin-level enabled flag read from `plugin_config.middlewares.guardrail`.
   * Refreshed by the same ConfigStore.onChange watcher that refreshes cachedConfig,
   * since the watcher fires on any change to sapience-ai-suite.json. Hooks must
   * consult this on every fire — OpenClaw doesn't deregister hooks when a
   * middleware is toggled off via the dashboard, so the hook itself has to bail.
   */
  private static cachedPluginEnabled: boolean | null = null;

  /**
   * Return the cached config (zero I/O). Falls back to loadSync() on
   * first call before the cache is populated.
   */
  static getCached(): GuardrailConfig {
    if (!this.cachedConfig) {
      this.cachedConfig = this.loadSync();
    }
    return this.cachedConfig;
  }

  /**
   * Live plugin-level enabled check (zero I/O after first call).
   * Returns true only when `plugin_config.middlewares.guardrail === true`.
   */
  static isPluginEnabled(): boolean {
    if (this.cachedPluginEnabled === null) {
      this.cachedPluginEnabled = this.loadPluginEnabled();
    }
    return this.cachedPluginEnabled === true;
  }

  private static loadPluginEnabled(): boolean {
    try {
      const store = UnifiedStore.readSync();
      const mw = (store?.[STORE_KEY_PLUGIN_CONFIG] as Record<string, unknown>)?.middlewares as
        | Record<string, boolean>
        | undefined;
      return mw?.guardrail === true;
    } catch (error) {
      logger.debug('Failed to read plugin_config.middlewares.guardrail', { error });
      return false;
    }
  }

  /**
   * Refresh the in-memory cache from disk. Called by ConfigStore.onChange
   * watcher registered in plugin/index.ts.
   */
  static refreshCache(): void {
    this.cachedConfig = this.loadSync();
    this.cachedPluginEnabled = this.loadPluginEnabled();
    logger.debug('Guardrail config cache refreshed');
  }

  /**
   * Return the **raw** guardrail sub-tree as a `Partial<GuardrailConfig>` —
   * just the fields actually persisted to disk, without merging in defaults
   * or running validation. Used by `GuardrailMiddleware.buildConfig()` to
   * compute `defaults < inline < disk` precedence (the same shape MR / HITL /
   * PII use). Returns `{}` when the file is absent or the key is unset.
   *
   * Distinct from `getCached()` / `loadSync()` which always return a fully
   * validated `GuardrailConfig` (defaults filled in for missing fields) —
   * those would shadow inline config because every field is "set".
   */
  static loadOverlay(): Partial<GuardrailConfig> {
    try {
      const store = UnifiedStore.readSync();
      const raw = store[STORE_KEY_GUARDRAIL];
      if (raw && typeof raw === 'object' && Object.keys(raw).length > 0) {
        return raw as Partial<GuardrailConfig>;
      }
      return {};
    } catch (error) {
      logger.debug('Failed to read guardrail overlay', { error });
      return {};
    }
  }

  static async load(): Promise<GuardrailConfig> {
    try {
      const store = await UnifiedStore.read();
      const data = store[STORE_KEY_GUARDRAIL];

      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        logger.debug('Guardrail config loaded from unified store');
        return validateConfig(data);
      }

      logger.debug('No existing guardrail config found, returning defaults');
      return this.defaults();
    } catch (error) {
      // SECURITY: On load failure, return hardcoded defaults — never fail-open empty
      logger.error('Failed to load guardrail config — falling back to hardcoded defaults', {
        error,
      });
      return this.defaults();
    }
  }

  static async save(config: GuardrailConfig): Promise<void> {
    try {
      await UnifiedStore.update(STORE_KEY_GUARDRAIL, config);
      logger.debug('Guardrail config saved to unified store');
    } catch (error) {
      logger.error('Failed to save guardrail config', { error });
      throw new Error(`Failed to save guardrail config: ${error}`);
    }
  }

  /**
   * Shallow merge-update at the top level: read current, `{ ...current, ...partial }`,
   * save the full shape back. Preferred for in-process patches of **top-level**
   * fields — `dryRunMode`, `entropyThreshold`, `unicodeNormalization`, etc.
   * Top-level sibling keys are preserved.
   *
   * IMPORTANT: this is a shallow merge. Passing `{ rules: { pii: [...] } }`
   * replaces the entire `rules` object — you'd lose `promptInjection` and
   * `suspicious`. Same applies to `sensitivePaths`, `egressControl`,
   * `destructiveCommands`, `outputScrubber`, `moderation`. For nested patches,
   * spread the current sub-object yourself before calling `.update()`.
   *
   * Caller still owns `refreshCache()` — `.update()` writes disk only,
   * matching `.save()`.
   */
  static async update(partial: Partial<GuardrailConfig>): Promise<void> {
    const current = await this.load();
    const merged = { ...current, ...partial };
    await this.save(merged);
  }

  /**
   * Return default guardrail config (in-memory, never auto-persisted).
   */
  static defaults(): GuardrailConfig {
    return JSON.parse(JSON.stringify(DEFAULT_GUARDRAIL_CONFIG));
  }

  static loadSync(): GuardrailConfig {
    try {
      const store = UnifiedStore.readSync();
      const data = store[STORE_KEY_GUARDRAIL];

      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        logger.debug('Guardrail config loaded from unified store (sync)');
        return validateConfig(data);
      }

      logger.debug('No existing guardrail config, returning defaults (sync)');
      return this.defaults();
    } catch (error) {
      // SECURITY: On load failure, return hardcoded defaults — never fail-open empty
      logger.error('Failed to load config (sync) — falling back to hardcoded defaults', { error });
      return this.defaults();
    }
  }

  static getPath(): string {
    return 'sapience-ai-suite.json [guardrail]';
  }
}
