/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Provider Registry — Maps model IDs to provider adapters.
 *
 * Resolution order:
 *  1. Explicit prefix: "anthropic/claude-..." → Anthropic adapter
 *  2. Model ID patterns: "claude-..." → Anthropic, "gemini-..." → Google
 *  3. Configured providers: look up model in discovered models
 *  4. Default: OpenAI-compatible adapter
 */

import { ProviderAdapter, ProviderFormat } from './types.js';
import { ProviderConfig, DiscoveredModel } from '../types.js';
import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { GoogleAdapter } from './google.js';

// ---------------------------------------------------------------------------
// Singleton adapters
// ---------------------------------------------------------------------------

const openaiAdapter = new OpenAIAdapter();
const anthropicAdapter = new AnthropicAdapter();
const googleAdapter = new GoogleAdapter();

const FORMAT_TO_ADAPTER: Record<ProviderFormat, ProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  google: googleAdapter,
};

// ---------------------------------------------------------------------------
// Prefix-based detection
// ---------------------------------------------------------------------------

const PREFIX_MAP: Array<{ prefix: string; format: ProviderFormat }> = [
  { prefix: 'anthropic/', format: 'anthropic' },
  { prefix: 'claude-', format: 'anthropic' },
  { prefix: 'google/', format: 'google' },
  { prefix: 'gemini/', format: 'google' },
  { prefix: 'gemini-', format: 'google' },
  { prefix: 'openai/', format: 'openai' },
  { prefix: 'gpt-', format: 'openai' },
  { prefix: 'o1-', format: 'openai' },
  { prefix: 'o3-', format: 'openai' },
  { prefix: 'o4-', format: 'openai' },
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ResolvedProvider {
  adapter: ProviderAdapter;
  providerName: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * Resolve which provider adapter and credentials to use for a given model.
 *
 * @param modelId          The model ID (e.g. "anthropic/claude-sonnet-4-6" or "gpt-4o")
 * @param providers        Configured provider connections
 * @param discoveredModels Cached discovered models (for lookup)
 * @param defaultBaseUrl   Fallback base URL (Phase 1 targetBaseUrl)
 * @param defaultApiKey    Fallback API key (Phase 1 targetApiKey)
 */
export function resolveProvider(
  modelId: string,
  providers: Record<string, ProviderConfig>,
  discoveredModels: DiscoveredModel[],
  defaultBaseUrl: string,
  defaultApiKey: string
): ResolvedProvider {
  // 1. Check explicit prefix
  for (const { prefix, format } of PREFIX_MAP) {
    if (modelId.startsWith(prefix)) {
      const providerName = format === 'openai' ? 'openai' : format;
      const providerConfig = providers[providerName];

      if (providerConfig) {
        return {
          adapter: FORMAT_TO_ADAPTER[providerConfig.format] || openaiAdapter,
          providerName,
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
        };
      }

      // No explicit provider config — use default with the right adapter
      return {
        adapter: FORMAT_TO_ADAPTER[format],
        providerName,
        baseUrl: defaultBaseUrl,
        apiKey: defaultApiKey,
      };
    }
  }

  // 2. Check discovered models
  const discovered = discoveredModels.find((m) => m.id === modelId);
  if (discovered) {
    const providerConfig = providers[discovered.provider];
    if (providerConfig) {
      return {
        adapter: FORMAT_TO_ADAPTER[providerConfig.format] || openaiAdapter,
        providerName: discovered.provider,
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
      };
    }
  }

  // 3. Check if any provider config matches by name
  for (const [name, config] of Object.entries(providers)) {
    // Model ID might loosely match a provider name
    if (modelId.toLowerCase().includes(name.toLowerCase())) {
      return {
        adapter: FORMAT_TO_ADAPTER[config.format] || openaiAdapter,
        providerName: name,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      };
    }
  }

  // 4. Default: OpenAI-compatible with fallback credentials
  return {
    adapter: openaiAdapter,
    providerName: 'openai',
    baseUrl: defaultBaseUrl,
    apiKey: defaultApiKey,
  };
}

/**
 * Get an adapter by format name.
 */
export function getAdapter(format: ProviderFormat): ProviderAdapter {
  return FORMAT_TO_ADAPTER[format] || openaiAdapter;
}

/**
 * Get all registered adapters.
 */
export function getAllAdapters(): ProviderAdapter[] {
  return [openaiAdapter, anthropicAdapter, googleAdapter];
}

/**
 * Strip provider prefix from a model ID (e.g. "anthropic/claude-3" → "claude-3").
 */
export function stripModelPrefix(modelId: string): string {
  const slashIdx = modelId.indexOf('/');
  if (slashIdx > 0 && slashIdx < 20) {
    return modelId.slice(slashIdx + 1);
  }
  return modelId;
}
