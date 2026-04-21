/**
 * Tool Call Limit — LimitPolicyStore
 * Manages persistence of tool call limits in the unified sapience-ai-suite.json
 * under key "tool_call_limit".
 */

import { LimitPolicy, LimitRule, DEFAULT_LIMIT_POLICY } from '../types.js';
import { logger } from '../../../shared/Logger.js';
import { ConfigStore } from '../../../shared/storage/ConfigStore.js';
import { STORE_KEY_TOOL_CALL_LIMIT } from '../../../shared/storage/paths.js';

const DEFAULT_LIMITS = DEFAULT_LIMIT_POLICY;

export type PersistedLimitPolicy = LimitPolicy;

export class LimitPolicyStore {
  /**
   * In-memory cached policy, kept fresh by ConfigStore.onChange('tool_call_limit', ...).
   * All hooks use getCached() instead of load()/loadSync() to avoid disk reads
   * on every tool call.
   */
  private static cachedPolicy: PersistedLimitPolicy | null = null;

  /**
   * Return the cached policy (zero I/O). Falls back to loadSync() on
   * first call before the cache is populated.
   */
  static getCached(): PersistedLimitPolicy {
    if (!this.cachedPolicy) {
      this.cachedPolicy = this.loadSync();
    }
    return this.cachedPolicy;
  }

  /**
   * Refresh the in-memory cache from disk. Called by ConfigStore.onChange
   * watcher registered in plugin/index.ts.
   */
  static refreshCache(): void {
    this.cachedPolicy = this.loadSync();
    logger.debug('Limit policy cache refreshed');
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
   * Look up a rule for a specific tool (uses cached policy — zero I/O).
   */
  static lookupRule(moduleName: string, methodName: string): LimitRule | undefined {
    const policy = this.getCached();
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
