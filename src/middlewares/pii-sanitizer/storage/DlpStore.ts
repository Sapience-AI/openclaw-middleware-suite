/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * PII Sanitizer DlpStore
 * Manages persistence of DLP policies in the unified sapience-ai-suite.json
 * under key "pii_sanitizer".
 */

import { DlpPolicy, DlpRule, ScannerAction, SeverityLevel } from '../types.js';
import { logger } from '../../../shared/Logger.js';
import { ConfigStore } from '../../../shared/storage/ConfigStore.js';
import { STORE_KEY_PII_SANITIZER, STORE_KEY_PLUGIN_CONFIG } from '../../../shared/storage/paths.js';
import { PII_PATTERNS, PiiPatternKey } from '../pii-patterns.js';

/**
 * Bind a catalog pattern to a DLP rule. Severity defaults to the
 * catalog's severity but can be overridden when the DLP risk model
 * differs from guardrail's content-scanning risk model.
 */
function bindCatalogRule(
  key: PiiPatternKey,
  name: string,
  action: ScannerAction,
  severityOverride?: SeverityLevel
): DlpRule {
  const spec = PII_PATTERNS[key];
  return {
    name,
    type: spec.type,
    pattern: spec.pattern,
    severity: severityOverride ?? spec.severity,
    action,
    enabled: true,
    description: spec.description,
  };
}

export const DEFAULT_DLP_POLICY: DlpPolicy = {
  version: '1.0.0',
  dryRunMode: false,
  globalRules: [
    bindCatalogRule('CREDIT_CARD', 'credit_card', 'REDACT', 'HIGH'),
    bindCatalogRule('EMAIL', 'email', 'ALLOW'),
    bindCatalogRule('SSN', 'ssn', 'REDACT', 'HIGH'),
    bindCatalogRule('AWS_ACCESS_KEY_ID', 'aws_key', 'ESCALATE'),
    bindCatalogRule('OPENAI_KEY', 'openai_key', 'ESCALATE'),
    bindCatalogRule('GITHUB_TOKEN', 'github_token', 'ESCALATE'),
    bindCatalogRule('SLACK_WEBHOOK', 'slack_webhook', 'REDACT'),
    bindCatalogRule('GCP_KEY', 'gcp_key', 'ESCALATE'),
    bindCatalogRule('PRIVATE_KEY_HEADER', 'private_ssh_key', 'BLOCK'),
    bindCatalogRule('DB_CONNECTION_STRING', 'db_connection_string', 'ESCALATE'),
    // pii-sanitizer-only: magnitude word redaction (DLP volume signal,
    // not a secret pattern — kept out of the shared catalog on purpose)
    {
      name: 'magnitude',
      type: 'regex',
      pattern:
        '\\b(thousands?|millions?|billions?|trillion|all|every|entire|full|bulk|massive|unlimited|infinity|everything)\\b|\\b10\\^[3-9]\\b|\\b[0-9.]+\\s*(GB|TB|PB|gigabytes|terabytes)\\b',
      severity: 'MEDIUM',
      action: 'REDACT',
      enabled: true,
    },
  ],
  toolPolicies: {
    Shell: {
      bash: { fields: { command: 'SCALABLE' } },
      exec: { fields: { command: 'SCALABLE' } },
    },
    Gmail: {
      send: { fields: { to: 'VALIDATE', subject: 'SCALABLE', body: 'SCALABLE' } },
    },
    Network: {
      fetch: { fields: { url: 'VALIDATE', body: 'SCALABLE', headers: 'SCALABLE' } },
    },
    GitHub: {
      createComment: { fields: { body: 'SCALABLE' } },
      updateFile: { fields: { content: 'SCALABLE' } },
    },
    Slack: {
      postMessage: { fields: { text: 'SCALABLE', attachments: 'SCALABLE' } },
    },
    Postgres: {
      query: { fields: { query: 'SCALABLE' } },
    },
    FileSystem: {
      read: { fields: { path: 'VALIDATE' } },
      write: { fields: { content: 'SCALABLE' } },
    },
  },
};

export class DlpStore {
  /**
   * Cached plugin-level enabled flag read from
   * `plugin_config.middlewares['pii-sanitizer']`. Refreshed by the
   * ConfigStore.onChange('pii_sanitizer', …) watcher (which fires on any
   * store change) so dashboard toggles take effect on the next tool call
   * without a process restart. The composed tool-call hook gates on this.
   */
  private static cachedPluginEnabled: boolean | null = null;

  /**
   * Live plugin-level enabled check (zero I/O after first call).
   * Returns true only when `plugin_config.middlewares['pii-sanitizer'] === true`.
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
      return mw?.['pii-sanitizer'] === true;
    } catch (error) {
      logger.debug('Failed to read plugin_config.middlewares[pii-sanitizer]', { error });
      return false;
    }
  }

  /**
   * Refresh the cached plugin-enabled flag. Called by the plugin-level
   * ConfigStore.onChange watcher whenever sapience-ai-suite.json changes.
   */
  static refreshCache(): void {
    this.cachedPluginEnabled = this.loadPluginEnabled();
    logger.debug('DLP plugin-enabled cache refreshed');
  }

  /**
   * Load the DLP policy from the unified store, or create default if doesn't exist
   */
  static async load(): Promise<DlpPolicy> {
    try {
      const store = await ConfigStore.read();
      const data = store[STORE_KEY_PII_SANITIZER];

      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        logger.debug('DLP Policy loaded from unified store');
        return data as DlpPolicy;
      }

      logger.debug('No existing DLP policy found, returning defaults');
      return this.defaults();
    } catch (error) {
      logger.error('Failed to load DLP policy', { error });
      throw new Error(`Failed to load DLP policy: ${error}`);
    }
  }

  /**
   * Save the DLP policy to the unified store
   */
  static async save(policy: DlpPolicy): Promise<void> {
    try {
      await ConfigStore.update(STORE_KEY_PII_SANITIZER, policy);
      logger.debug('DLP Policy saved to unified store');
    } catch (error) {
      logger.error('Failed to save DLP policy', { error });
      throw new Error(`Failed to save DLP policy: ${error}`);
    }
  }

  /**
   * Shallow merge-update at the top level: read current, `{ ...current, ...partial }`,
   * save the full shape back. Preferred for in-process patches of **top-level**
   * fields — `dryRunMode`, `version`. Top-level sibling keys
   * (`globalRules`, `toolPolicies`) are preserved as-is.
   *
   * IMPORTANT: this is a shallow merge. Passing `{ toolPolicies: { Shell: {...} } }`
   * replaces the entire `toolPolicies` map — you'd lose `Gmail`, `FileSystem`,
   * and every other module. Passing `{ globalRules: [newRule] }` replaces the
   * whole array. For nested patches, spread the current sub-object yourself
   * before calling `.update()`.
   *
   * Caller still owns `pii.reloadPolicy()` — `.update()` writes disk only,
   * matching `.save()`.
   */
  static async update(partial: Partial<DlpPolicy>): Promise<void> {
    const current = await this.load();
    const merged = { ...current, ...partial };
    await this.save(merged);
  }

  /**
   * Return default DLP policy (in-memory, never auto-persisted).
   */
  static defaults(): DlpPolicy {
    return JSON.parse(JSON.stringify(DEFAULT_DLP_POLICY));
  }

  /**
   * Load the DLP policy synchronously (e.g. for plugin register)
   */
  static loadSync(): DlpPolicy {
    try {
      const store = ConfigStore.readSync();
      const data = store[STORE_KEY_PII_SANITIZER];

      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        logger.debug('DLP Policy loaded from unified store (sync)');
        return data as DlpPolicy;
      }

      logger.debug('No existing DLP policy, returning defaults (sync)');
      return this.defaults();
    } catch (error) {
      logger.error('Failed to load DLP policy (sync)', { error });
      throw new Error(`Failed to load DLP policy: ${error}`);
    }
  }

  static getPath(): string {
    return 'sapience-ai-suite.json [pii_sanitizer]';
  }
}
