/**
 * Context Editing Policy Store
 * Wraps the unified ConfigStore for context-editing config,
 * consistent with PolicyStore / DlpStore / LimitPolicyStore.
 *
 * load()  — returns persisted config or in-memory defaults (never auto-persists).
 * save()  — writes to sapience-ai-suite.json under 'context_editing.configOverrides'.
 */

import { ConfigStore } from '../../../shared/storage/ConfigStore.js';
import { STORE_KEY_CONTEXT_EDITING } from '../../../shared/storage/paths.js';
import { DEFAULT_CONTEXT_EDITING_CONFIG } from '../config.js';
import { logger } from '../../../shared/Logger.js';

export interface ContextEditingPolicyData {
  tokenThreshold: number;
  messageThreshold: number;
  pruningMode: string;
  ttl: string;
  model: string;
  customPromptEnabled: boolean;
  customInstructions: string;
  customSchema: string;
  messagesKeptBeforeCompaction: number;
}

export class ContextEditingPolicyStore {
  /**
   * Load context-editing config, merging store overrides with defaults.
   */
  static async load(): Promise<ContextEditingPolicyData> {
    try {
      const store = await ConfigStore.read();
      const ceData = store[STORE_KEY_CONTEXT_EDITING];

      if (ceData && typeof ceData === 'object') {
        const overrides = (ceData as Record<string, unknown>).configOverrides || {};
        return this.mergeDefaults(overrides as Record<string, unknown>);
      }

      logger.debug('No existing context-editing config, returning defaults');
      return this.defaults();
    } catch (error) {
      logger.error('Failed to load context-editing config', { error });
      throw new Error(`Failed to load context-editing config: ${error}`);
    }
  }

  /**
   * Save context-editing config overrides to the unified store.
   */
  static async save(data: Partial<ContextEditingPolicyData>): Promise<void> {
    try {
      await ConfigStore.update(`${STORE_KEY_CONTEXT_EDITING}.configOverrides`, data);
      logger.debug('Context-editing config saved to unified store');
    } catch (error) {
      logger.error('Failed to save context-editing config', { error });
      throw new Error(`Failed to save context-editing config: ${error}`);
    }
  }

  /**
   * Return default config (in-memory, never auto-persisted).
   */
  static defaults(): ContextEditingPolicyData {
    return {
      tokenThreshold: DEFAULT_CONTEXT_EDITING_CONFIG.tokenThreshold,
      messageThreshold: DEFAULT_CONTEXT_EDITING_CONFIG.messageThreshold,
      pruningMode: DEFAULT_CONTEXT_EDITING_CONFIG.pruning.mode === 'off' ? 'disabled' : 'enabled',
      ttl: DEFAULT_CONTEXT_EDITING_CONFIG.pruning.ttl,
      model: '',
      customPromptEnabled: DEFAULT_CONTEXT_EDITING_CONFIG.icc.customPrompt.enabled,
      customInstructions: DEFAULT_CONTEXT_EDITING_CONFIG.icc.customPrompt.instructions,
      customSchema: DEFAULT_CONTEXT_EDITING_CONFIG.icc.customPrompt.schema,
      messagesKeptBeforeCompaction: DEFAULT_CONTEXT_EDITING_CONFIG.icc.messagesKeptBeforeCompaction,
    };
  }

  static loadSync(): ContextEditingPolicyData {
    try {
      const store = ConfigStore.readSync();
      const ceData = store[STORE_KEY_CONTEXT_EDITING];

      if (ceData && typeof ceData === 'object') {
        const overrides = (ceData as Record<string, unknown>).configOverrides || {};
        return this.mergeDefaults(overrides as Record<string, unknown>);
      }

      return this.defaults();
    } catch (error) {
      logger.error('Failed to load context-editing config (sync)', { error });
      return this.defaults();
    }
  }

  static getPath(): string {
    return 'sapience-ai-suite.json [context_editing]';
  }

  private static mergeDefaults(overrides: Record<string, unknown>): ContextEditingPolicyData {
    const d = this.defaults();
    return {
      tokenThreshold:
        typeof overrides.tokenThreshold === 'number' ? overrides.tokenThreshold : d.tokenThreshold,
      messageThreshold:
        typeof overrides.messageThreshold === 'number'
          ? overrides.messageThreshold
          : d.messageThreshold,
      pruningMode:
        typeof overrides.pruningMode === 'string' ? overrides.pruningMode : d.pruningMode,
      ttl: typeof overrides.ttl === 'string' ? overrides.ttl : d.ttl,
      model: typeof overrides.model === 'string' ? overrides.model : d.model,
      customPromptEnabled:
        typeof overrides.customPromptEnabled === 'boolean'
          ? overrides.customPromptEnabled
          : d.customPromptEnabled,
      customInstructions:
        typeof overrides.customInstructions === 'string'
          ? overrides.customInstructions
          : d.customInstructions,
      customSchema:
        typeof overrides.customSchema === 'string' ? overrides.customSchema : d.customSchema,
      messagesKeptBeforeCompaction:
        typeof overrides.messagesKeptBeforeCompaction === 'number'
          ? overrides.messagesKeptBeforeCompaction
          : d.messagesKeptBeforeCompaction,
    };
  }
}
