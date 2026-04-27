/*
 * Copyright (c) 2026 MNFST, Inc.
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * This file is derived from the Manifest project
 * (https://github.com/mnfst/manifest) and has been modified for use in
 * the OpenClaw Middleware Suite.
 *
 * Used under the MIT License — see NOTICE for the full license text.
 */

/**
 * Provider Types — Interface for LLM provider adapters.
 *
 * Ported from Manifest's adapter pattern (anthropic-adapter.ts, google-adapter.ts):
 *  - Adapters are format converters, not HTTP clients
 *  - Each adapter converts OpenAI-format ↔ provider-specific format
 *  - The proxy handles the actual HTTP transport
 */

import { DiscoveredModel } from '../types.js';

// ---------------------------------------------------------------------------
// Provider adapter interface
// ---------------------------------------------------------------------------

export type ProviderFormat = 'openai' | 'anthropic' | 'google';

/** Options the proxy passes to adapter request transformers. */
export interface ProviderRequestOptions {
  /** When false, adapter must skip provider prompt-cache markers
   *  (Anthropic cache_control on system prompt + tool definitions). */
  promptCacheEnabled?: boolean;
}

/**
 * Stateful stream converter — processes provider SSE events one at a time,
 * accumulating state for multi-event constructs (e.g. Anthropic tool calls).
 */
export interface StreamConverter {
  /** Process a single SSE event data payload. Returns OpenAI SSE string(s) to emit, or null to skip. */
  processEvent(eventData: string): string | null;
  /** Flush any remaining state (called on stream end). Returns final SSE strings to emit. */
  flush(): string[];
}

export interface ProviderAdapter {
  /** Provider name (e.g. "openai", "anthropic", "google") */
  readonly name: string;

  /** API format this adapter handles */
  readonly format: ProviderFormat;

  /**
   * Convert an OpenAI-format request body to the provider's format.
   * Returns the body as-is if the provider uses OpenAI format.
   *
   * `options.promptCacheEnabled` is honored by adapters that support
   * provider-level prompt caching (Anthropic cache_control today).
   * Adapters without a caching layer ignore it.
   */
  toProviderRequest(
    body: Record<string, unknown>,
    model: string,
    options?: ProviderRequestOptions
  ): Record<string, unknown>;

  /**
   * Convert a provider response to OpenAI format.
   * Returns the response as-is if the provider uses OpenAI format.
   */
  fromProviderResponse(response: Record<string, unknown>, model: string): Record<string, unknown>;

  /**
   * Build the API URL for a chat completion request.
   * @param stream  If true, return the streaming endpoint URL (e.g. Gemini streamGenerateContent).
   */
  buildUrl(baseUrl: string, model: string, stream?: boolean): string;

  /**
   * Build headers for the request.
   */
  buildHeaders(apiKey: string): Record<string, string>;

  /**
   * Create a stateful stream converter for this provider.
   * Returns a converter that accumulates state across SSE events
   * (needed for tool calls which span multiple Anthropic events).
   */
  createStreamConverter?(model: string): StreamConverter;

  /**
   * Discover available models from the provider's API.
   */
  listModels?(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]>;
}

// ---------------------------------------------------------------------------
// Forward result (from provider request)
// ---------------------------------------------------------------------------

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  isStream: boolean;
}

// ---------------------------------------------------------------------------
// Model parameter compatibility
// ---------------------------------------------------------------------------

/** Parameters that may need stripping for certain models. */
export interface IncompatibleParams {
  /** Strip thinking/extended-thinking */
  stripThinking?: boolean;
  /** Downgrade tool_choice: "required" → "auto" */
  downgradeToolChoice?: boolean;
}

/**
 * Known model patterns that don't support extended thinking.
 * Matched by prefix.
 */
const NO_THINKING_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-3.5',
  'claude-haiku',
  'claude-4-5-haiku',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];

/**
 * Determine which parameters are incompatible with a model.
 */
export function getIncompatibleParams(modelId: string): IncompatibleParams {
  const lower = modelId.toLowerCase();
  const stripThinking = NO_THINKING_MODELS.some((prefix) => lower.startsWith(prefix.toLowerCase()));

  return { stripThinking };
}

/**
 * Strip incompatible parameters from a request body based on the target model.
 *
 * Removes incompatible params for models that don't support them:
 *  - Removes thinking/extended-thinking body params
 *  - Filters thinking/extended-thinking from anthropic-beta header
 */
export function stripIncompatibleParams(
  body: Record<string, unknown>,
  modelId: string,
  headers?: Record<string, string>
): void {
  const incompatible = getIncompatibleParams(modelId);

  if (incompatible.stripThinking) {
    delete body.thinking;
    delete body['extended-thinking'];

    // Also clean anthropic-beta header
    if (headers?.['anthropic-beta']) {
      const betas = headers['anthropic-beta']
        .split(',')
        .map((s) => s.trim())
        .filter((b) => !b.startsWith('thinking') && !b.startsWith('extended-thinking'));

      if (betas.length > 0) {
        headers['anthropic-beta'] = betas.join(',');
      } else {
        delete headers['anthropic-beta'];
      }
    }
  }
}
