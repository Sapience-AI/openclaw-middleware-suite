/**
 * Model Routing Policy Store
 * Wraps the unified ConfigStore for model-routing config,
 * consistent with PolicyStore / DlpStore / LimitPolicyStore.
 *
 * load()  — returns persisted config or in-memory defaults (never auto-persists).
 * save()  — writes to sapience-ai-suite.json under 'model_routing'.
 */

import { ConfigStore } from '../../../shared/storage/ConfigStore.js';
import { STORE_KEY_MODEL_ROUTING } from '../../../shared/storage/paths.js';
import { logger } from '../../../shared/Logger.js';
import type { ModelRoutingStoreData } from './ModelRoutingStore.js';

export class ModelRoutingPolicyStore {
  /**
   * Load model-routing config from the unified store.
   */
  static async load(): Promise<ModelRoutingStoreData> {
    try {
      const store = await ConfigStore.read();
      const data = store[STORE_KEY_MODEL_ROUTING];

      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        logger.debug('Model-routing config loaded from unified store');
        return data as ModelRoutingStoreData;
      }

      logger.debug('No existing model-routing config, returning defaults');
      return this.defaults();
    } catch (error) {
      logger.error('Failed to load model-routing config', { error });
      throw new Error(`Failed to load model-routing config: ${error}`);
    }
  }

  /**
   * Save model-routing config to the unified store.
   */
  static async save(data: ModelRoutingStoreData): Promise<void> {
    try {
      await ConfigStore.update(STORE_KEY_MODEL_ROUTING, data);
      logger.debug('Model-routing config saved to unified store');
    } catch (error) {
      logger.error('Failed to save model-routing config', { error });
      throw new Error(`Failed to save model-routing config: ${error}`);
    }
  }

  /**
   * Return default config (in-memory, never auto-persisted).
   */
  static defaults(): ModelRoutingStoreData {
    return {};
  }

  static loadSync(): ModelRoutingStoreData {
    try {
      const store = ConfigStore.readSync();
      const data = store[STORE_KEY_MODEL_ROUTING];

      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        return data as ModelRoutingStoreData;
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
