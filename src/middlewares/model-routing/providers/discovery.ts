/**
 * Model Discovery — Fetch available models from provider APIs.
 *
 * Ported from Manifest's provider-model-fetcher.service.ts + model-discovery.service.ts:
 *  - Calls each configured provider's model listing endpoint
 *  - Enriches with capability inference and pricing heuristics
 *  - Caches results in the ModelRoutingStore
 */

import { ProviderConfig, DiscoveredModel } from '../types.js';
import { getAdapter } from './registry.js';
import { logger } from '../../../shared/Logger.js';
import { getCachedCatalog, lookupModel, DATE_SUFFIX_RE } from '../storage/model-catalog.js';

// ---------------------------------------------------------------------------
// Quality scoring heuristic
// ---------------------------------------------------------------------------

/**
 * Assign a quality score (1-5) based on model characteristics.
 * Higher = better quality but more expensive.
 */
function computeQualityScore(model: DiscoveredModel): number {
  let score = 2; // Base

  // Price-based adjustment
  if (model.inputPrice !== undefined) {
    if (model.inputPrice >= 10) score = 5;
    else if (model.inputPrice >= 3) score = 4;
    else if (model.inputPrice >= 1) score = 3;
    else score = 2;
  }

  // Capability bonuses
  if (model.capabilities.reasoning) score = Math.min(5, score + 1);
  if (model.capabilities.toolCalling && model.capabilities.vision) {
    score = Math.min(5, score + 0.5);
  }

  // Name-based hints
  const lower = model.id.toLowerCase();
  if (lower.includes('opus') || lower.includes('pro')) score = Math.max(score, 4);
  if (lower.includes('mini') || lower.includes('flash') || lower.includes('haiku')) {
    score = Math.min(score, 2);
  }

  return Math.round(score);
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

/**
 * Enrich a discovered model with pricing, capabilities, and quality score
 * from the LiteLLM catalog. lookupModel is tolerant of dated and
 * gemini-prefixed ids, so the caller can pass the provider-API id as-is.
 * If the catalog hasn't loaded, pricing stays undefined — callers should
 * ensure the catalog is loaded before enriching.
 */
function enrichModel(model: DiscoveredModel): DiscoveredModel {
  const catalog = getCachedCatalog();
  const catEntry = catalog.length > 0 ? lookupModel(catalog, model.id) : undefined;

  if (catEntry) {
    if (model.inputPrice === undefined) model.inputPrice = catEntry.pricing.input;
    if (model.outputPrice === undefined) model.outputPrice = catEntry.pricing.output;
    if (model.cacheReadPrice === undefined) model.cacheReadPrice = catEntry.pricing.cacheRead;
    if (model.cacheWritePrice === undefined) model.cacheWritePrice = catEntry.pricing.cacheWrite;
    model.capabilities.maxOutput = catEntry.maxOutputTokens;
    model.capabilities.contextWindow = catEntry.maxInputTokens;
    model.capabilities.toolChoice = catEntry.capabilities.toolChoice;
    model.capabilities.parallelToolCalls = catEntry.capabilities.parallelToolCalls;
    model.capabilities.functionCalling = catEntry.capabilities.functionCalling;
    if (model.capabilities.reasoning === undefined) {
      model.capabilities.reasoning = catEntry.capabilities.reasoning;
    }
    if (model.capabilities.vision === undefined) {
      model.capabilities.vision = catEntry.capabilities.vision;
    }
  } else {
    logger.debug(`[model-routing] No catalog entry for "${model.id}" — pricing unavailable`);
  }

  model.qualityScore = computeQualityScore(model);
  return model;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover models from a single provider.
 */
export async function discoverFromProvider(config: ProviderConfig): Promise<DiscoveredModel[]> {
  const adapter = getAdapter(config.format);

  if (!adapter.listModels) {
    logger.warn(`[model-routing] No model discovery for format: ${config.format}`);
    return [];
  }

  try {
    const models = await adapter.listModels(config.baseUrl, config.apiKey);

    // Filter to chat models and enrich
    const enriched = models
      .filter((m) => {
        // Filter out models confirmed to lack tool support
        if (m.capabilities.toolCalling === false) return false;
        return true;
      })
      .map(enrichModel);

    logger.info(`[model-routing] Discovered ${enriched.length} models from ${config.name}`);
    return enriched;
  } catch (err) {
    logger.error(`[model-routing] Failed to discover models from ${config.name}`, { error: err });
    return [];
  }
}

/**
 * Normalize a list of DiscoveredModels: strips date suffixes from ids/names,
 * dedupes on the stripped id, and prefers the undated source when both exist.
 * Between two dated variants, the lexically-latest id wins (which is the
 * most recent date for ISO-like suffixes).
 *
 * This is the single source of dedup/normalization logic. Use it after live
 * provider discovery and after any catalog projection before persisting or
 * handing the list to a consumer.
 */
export function normalizeDiscoveredModels(models: DiscoveredModel[]): DiscoveredModel[] {
  const byId = new Map<string, DiscoveredModel>();
  for (const model of models) {
    const originalId = model.id;
    const strippedId = originalId.replace(DATE_SUFFIX_RE, '');
    model.id = strippedId;
    if (typeof model.name === 'string') {
      model.name = model.name.replace(DATE_SUFFIX_RE, '');
    }

    const existing = byId.get(strippedId);
    if (!existing) {
      byId.set(strippedId, model);
      continue;
    }
    const existingHadDate = existing.id !== strippedId;
    const candidateHadDate = originalId !== strippedId;
    if (existingHadDate && !candidateHadDate) {
      byId.set(strippedId, model);
    } else if (existingHadDate && candidateHadDate && originalId > existing.id) {
      byId.set(strippedId, model);
    }
  }
  return Array.from(byId.values());
}

/**
 * Discover models from all configured providers, enriched and normalized.
 */
export async function discoverAllModels(
  providers: Record<string, ProviderConfig>
): Promise<DiscoveredModel[]> {
  const all: DiscoveredModel[] = [];

  const results = await Promise.allSettled(
    Object.values(providers).map((config) => discoverFromProvider(config))
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      all.push(...result.value);
    }
  }

  const deduped = normalizeDiscoveredModels(all);
  logger.info(`[model-routing] Total discovered models: ${deduped.length}`);
  return deduped;
}
