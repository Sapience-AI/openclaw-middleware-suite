/*
 * Copyright (c) Kevin Wu and Pegasi contributors
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * This file is derived from the Reins project (https://github.com/pegasi-ai/reins)
 * and has been modified for use in the OpenClaw Middleware Suite.
 */

/**
 * HITL PolicyStore
 * Manages persistence of security policies in the unified config store
 */

import { SecurityPolicy } from '../../../types.js';
import { DEFAULT_POLICY } from '../config.js';
import { SAPIENCE_MW_STORE_FILE, logger } from '../../../shared/Logger.js';
import { ConfigStore } from '../../../shared/storage/ConfigStore.js';

export interface PersistedPolicy extends SecurityPolicy {
  version: string;
  createdAt: string;
  updatedAt: string;
}

export class PolicyStore {
  /**
   * Load the policy from disk, or create default if doesn't exist
   */
  static async load(): Promise<PersistedPolicy> {
    try {
      const store = await ConfigStore.read();
      const data = store.hitl?.policy;

      if (data) {
        return data as PersistedPolicy;
      }

      // Return in-memory defaults — only persist on explicit save/init.
      logger.info('No existing policy found, returning defaults');
      return this.defaults();
    } catch (error) {
      logger.error('Failed to load policy', { error });
      throw new Error(`Failed to load policy: ${error}`);
    }
  }

  /**
   * Save the policy to disk
   */
  static async save(policy: PersistedPolicy): Promise<void> {
    try {
      policy.updatedAt = new Date().toISOString();
      await ConfigStore.update('hitl.policy', policy);
      logger.info('Policy saved to unified store');
    } catch (error) {
      logger.error('Failed to save policy', { error });
      throw new Error(`Failed to save policy: ${error}`);
    }
  }

  /**
   * Shallow merge-update at the top level: read current, `{ ...current, ...partial }`,
   * save the full shape back. Preferred for in-process patches of **top-level**
   * fields — `defaultAction`, `systemThresholds` (whole-object replace),
   * `version`, etc. Top-level sibling keys are preserved.
   *
   * IMPORTANT: this is a shallow merge. If you pass `{ modules: { FileSystem: {...} } }`,
   * the entire `modules` map is replaced — `Shell`, `Network`, and any other
   * modules you didn't list are wiped. For nested patches, spread the current
   * sub-map yourself:
   *
   *   const current = await PolicyStore.load();
   *   await PolicyStore.update({
   *     modules: {
   *       ...current.modules,
   *       FileSystem: {
   *         ...current.modules.FileSystem,
   *         write: { action: 'DENY' },
   *       },
   *     },
   *   });
   *
   * `save()` refreshes `updatedAt` as a side effect.
   */
  static async update(partial: Partial<PersistedPolicy>): Promise<void> {
    const current = await this.load();
    const merged = { ...current, ...partial };
    await this.save(merged);
  }

  /**
   * Reset policy to defaults
   */
  static async reset(): Promise<void> {
    await this.save(this.defaults());
    logger.info('Policy reset to defaults');
  }

  /**
   * Return default policy (in-memory, never auto-persisted).
   */
  static defaults(): PersistedPolicy {
    return {
      ...DEFAULT_POLICY,
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Load the policy synchronously (for plugin register which must be sync)
   */
  static loadSync(): PersistedPolicy {
    try {
      const store = ConfigStore.readSync();
      const data = store.hitl?.policy;

      if (data) {
        return data as PersistedPolicy;
      }

      logger.info('No existing policy found, returning defaults (sync)');
      return this.defaults();
    } catch (error) {
      logger.error('Failed to load policy (sync)', { error });
      throw new Error(`Failed to load policy: ${error}`);
    }
  }

  /**
   * Get the policy file path
   */
  static getPath(): string {
    return SAPIENCE_MW_STORE_FILE;
  }
}
