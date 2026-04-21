/**
 * Fallback Chains — Execute requests with ordered model fallbacks.
 *
 * Ported from ClawRouter (selector.ts, proxy.ts) + Manifest (proxy-fallback.service.ts):
 *  - Get ordered chain [primary, ...fallbacks] for a tier
 *  - Filter by: exclusion list → context window → tool support → vision
 *  - Iterate through chain, try each model, advance on 4xx/5xx
 *  - Safety net: if all filters empty the chain, use original
 *  - Max 5 attempts total
 */

import {
  Tier,
  TierModelConfig,
  FallbackAttempt,
  ModelCapabilities,
  DiscoveredModel,
} from '../types.js';
import { filterByExcludeList } from './exclusions.js';

const MAX_FALLBACK_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Chain construction
// ---------------------------------------------------------------------------

/**
 * Get the ordered fallback chain for a tier: [primary, ...fallbacks].
 */
export function getFallbackChain(tier: Tier, tiers: Record<Tier, TierModelConfig>): string[] {
  const config = tiers[tier];
  if (!config) return [];
  return [config.primary, ...config.fallbacks];
}

// ---------------------------------------------------------------------------
// Capability filtering
// ---------------------------------------------------------------------------

/**
 * Look up capabilities for a model from the discovered models cache.
 */
function getCapabilities(modelId: string, discoveredModels: DiscoveredModel[]): ModelCapabilities {
  const found = discoveredModels.find((m) => m.id === modelId);
  return found?.capabilities ?? {};
}

/**
 * Filter chain by context window: remove models whose context window
 * is too small for the estimated token count (with 10% safety buffer).
 */
export function filterByContextWindow(
  models: string[],
  estimatedTokens: number,
  discoveredModels: DiscoveredModel[]
): string[] {
  if (estimatedTokens === 0) return models;

  const filtered = models.filter((m) => {
    const caps = getCapabilities(m, discoveredModels);
    if (caps.contextWindow === undefined) return true; // Unknown: include
    return caps.contextWindow >= estimatedTokens * 1.1;
  });
  return filtered.length > 0 ? filtered : models;
}

/**
 * Filter chain by tool-calling support: if the request uses tools,
 * prefer models that support tool calling.
 */
export function filterByToolCalling(
  models: string[],
  hasTools: boolean,
  discoveredModels: DiscoveredModel[]
): string[] {
  if (!hasTools) return models;

  const filtered = models.filter((m) => {
    const caps = getCapabilities(m, discoveredModels);
    return caps.toolCalling !== false; // Include if true or unknown
  });
  return filtered.length > 0 ? filtered : models;
}

/**
 * Filter chain by vision support: if the request contains image content,
 * prefer models that support vision.
 */
export function filterByVision(
  models: string[],
  hasVision: boolean,
  discoveredModels: DiscoveredModel[]
): string[] {
  if (!hasVision) return models;

  const filtered = models.filter((m) => {
    const caps = getCapabilities(m, discoveredModels);
    return caps.vision !== false;
  });
  return filtered.length > 0 ? filtered : models;
}

// ---------------------------------------------------------------------------
// Full chain filtering pipeline
// ---------------------------------------------------------------------------

export interface FilterContext {
  exclusions: string[];
  estimatedTokens: number;
  hasTools: boolean;
  hasVision: boolean;
  discoveredModels: DiscoveredModel[];
}

/**
 * Apply all filters to a fallback chain in order:
 * exclusions → context window → tool support → vision
 */
export function filterFallbackChain(chain: string[], ctx: FilterContext): string[] {
  let filtered = filterByExcludeList(chain, ctx.exclusions);
  filtered = filterByContextWindow(filtered, ctx.estimatedTokens, ctx.discoveredModels);
  filtered = filterByToolCalling(filtered, ctx.hasTools, ctx.discoveredModels);
  filtered = filterByVision(filtered, ctx.hasVision, ctx.discoveredModels);

  // Limit to max attempts
  return filtered.slice(0, MAX_FALLBACK_ATTEMPTS);
}

// ---------------------------------------------------------------------------
// Vision detection
// ---------------------------------------------------------------------------

/**
 * Check if the request body contains image content (image_url blocks).
 */
export function requestHasVision(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  for (const msg of messages) {
    if (Array.isArray(msg?.content)) {
      for (const block of msg.content) {
        if (block?.type === 'image_url' || block?.type === 'image') {
          return true;
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fallback status decision
// ---------------------------------------------------------------------------

/**
 * Determine if a response status should trigger a fallback attempt.
 * Triggers on:
 *  - 400: Provider-specific schema/format issues (e.g. Gemini thought_signature,
 *         additionalProperties). A different provider may accept the same request.
 *         Worst case for genuinely bad requests: ~200ms extra per wasted attempt.
 *  - 404: Model not found (wrong model ID, deprecated model)
 *  - 429: Rate limited
 *  - 5xx: Server errors
 * Does NOT retry on:
 *  - 401/403: Auth errors (all models for that provider would fail)
 */
export function shouldTriggerFallback(status: number): boolean {
  if (status === 400) return true; // Provider-specific schema issue — try next
  if (status === 404) return true; // Model not found — try next model
  if (status === 429) return true; // Rate limited — try next model
  if (status >= 500) return true; // Server error — try next model
  return false;
}

// ---------------------------------------------------------------------------
// Fallback result type
// ---------------------------------------------------------------------------

export interface FallbackResult {
  /** Whether any model succeeded */
  success: boolean;
  /** The model that succeeded (or the last attempted) */
  model: string;
  /** Provider that served the response */
  provider: string;
  /** If a fallback was used, the original primary model */
  fallbackFrom?: string;
  /** All failed attempts */
  attempts: FallbackAttempt[];
}
