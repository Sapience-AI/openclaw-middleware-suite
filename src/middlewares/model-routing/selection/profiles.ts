/**
 * Routing Profiles — Pre-configured tier-to-model sets.
 *
 * Ported from ClawRouter's profile concept:
 *  - ECO:     Cheapest models per tier (cost-optimized)
 *  - AUTO:    Balanced (default — uses config tier assignments)
 *  - PREMIUM: Best quality per tier
 *  - AGENTIC: Tool-optimized per tier (best tool-calling models)
 *
 * Selected via:
 *  - Request header: X-Router-Profile: eco
 *  - Config default: model-routing.defaultProfile: "auto"
 *  - CLI: sai router config --set-profile premium
 */

import { Tier, TierModelConfig, DiscoveredModel } from '../types.js';
import type { CatalogModel } from '../storage/model-catalog.js';

// ---------------------------------------------------------------------------
// Profile type
// ---------------------------------------------------------------------------

export type RoutingProfile = 'eco' | 'auto' | 'premium' | 'agentic';

export const VALID_PROFILES: RoutingProfile[] = ['eco', 'auto', 'premium', 'agentic'];

// ---------------------------------------------------------------------------
// Static profile tier configs (used when no discovered models available)
// ---------------------------------------------------------------------------

export const PROFILE_CONFIGS: Record<RoutingProfile, Record<Tier, TierModelConfig>> = {
  eco: {
    SIMPLE: { primary: 'gpt-4o-mini', fallbacks: [] },
    STANDARD: { primary: 'gpt-4o-mini', fallbacks: ['gpt-4o'] },
    COMPLEX: { primary: 'gpt-4o', fallbacks: ['claude-sonnet-4-6'] },
    REASONING: { primary: 'gpt-4o', fallbacks: ['o3'] },
  },
  auto: {
    SIMPLE: { primary: 'gpt-4o-mini', fallbacks: [] },
    STANDARD: { primary: 'gpt-4o', fallbacks: [] },
    COMPLEX: { primary: 'claude-sonnet-4-6', fallbacks: ['gpt-4o'] },
    REASONING: { primary: 'o3', fallbacks: ['claude-opus-4-6'] },
  },
  premium: {
    SIMPLE: { primary: 'gpt-4o', fallbacks: ['gpt-4o-mini'] },
    STANDARD: { primary: 'claude-sonnet-4-6', fallbacks: ['gpt-4o'] },
    COMPLEX: { primary: 'claude-opus-4-6', fallbacks: ['claude-sonnet-4-6', 'gpt-4o'] },
    REASONING: { primary: 'o3', fallbacks: ['claude-opus-4-6'] },
  },
  agentic: {
    SIMPLE: { primary: 'gpt-4o-mini', fallbacks: [] },
    STANDARD: { primary: 'claude-sonnet-4-6', fallbacks: ['gpt-4o'] },
    COMPLEX: { primary: 'claude-sonnet-4-6', fallbacks: ['gpt-4o', 'claude-opus-4-6'] },
    REASONING: { primary: 'o3', fallbacks: ['claude-opus-4-6', 'claude-sonnet-4-6'] },
  },
};

// ---------------------------------------------------------------------------
// Profile descriptions (for CLI display)
// ---------------------------------------------------------------------------

export const PROFILE_DESCRIPTIONS: Record<RoutingProfile, string> = {
  eco: 'Cost-optimized — uses cheapest models per tier',
  auto: 'Balanced — default tier assignments',
  premium: 'Quality-optimized — uses best models per tier',
  agentic: 'Tool-optimized — prefers models with strong tool calling',
};

// ---------------------------------------------------------------------------
// Dynamic profile generation from discovered models
// ---------------------------------------------------------------------------

/**
 * Generate profile tier configs dynamically from discovered models.
 * Falls back to static configs if insufficient models are discovered.
 */
export function generateProfileFromDiscovered(
  profile: RoutingProfile,
  discoveredModels: DiscoveredModel[],
  baseTiers: Record<Tier, TierModelConfig>
): Record<Tier, TierModelConfig> {
  // If AUTO, just use the base (configured) tiers
  if (profile === 'auto') return baseTiers;

  // If no discovered models, use static configs
  if (discoveredModels.length === 0) return PROFILE_CONFIGS[profile];

  const toolCapable = discoveredModels.filter((m) => m.capabilities.toolCalling);
  const reasoningCapable = discoveredModels.filter((m) => m.capabilities.reasoning);

  const byPrice = [...discoveredModels].sort(
    (a, b) => (a.inputPrice || 999) - (b.inputPrice || 999)
  );
  const byQuality = [...discoveredModels].sort(
    (a, b) => (b.qualityScore || 0) - (a.qualityScore || 0)
  );
  const toolByQuality = [...toolCapable].sort(
    (a, b) => (b.qualityScore || 0) - (a.qualityScore || 0)
  );

  switch (profile) {
    case 'eco':
      return buildEcoProfile(byPrice, baseTiers);
    case 'premium':
      return buildPremiumProfile(byQuality, reasoningCapable, baseTiers);
    case 'agentic':
      return buildAgenticProfile(toolByQuality, reasoningCapable, baseTiers);
    default:
      return baseTiers;
  }
}

function buildEcoProfile(
  byPrice: DiscoveredModel[],
  fallback: Record<Tier, TierModelConfig>
): Record<Tier, TierModelConfig> {
  const cheapest = byPrice[0];
  const secondCheapest = byPrice[1];
  const midRange = byPrice[Math.floor(byPrice.length / 2)];

  return {
    SIMPLE: cheapest
      ? { primary: cheapest.id, fallbacks: secondCheapest ? [secondCheapest.id] : [] }
      : fallback.SIMPLE,
    STANDARD: secondCheapest
      ? { primary: secondCheapest.id, fallbacks: cheapest ? [cheapest.id] : [] }
      : fallback.STANDARD,
    COMPLEX: midRange
      ? { primary: midRange.id, fallbacks: secondCheapest ? [secondCheapest.id] : [] }
      : fallback.COMPLEX,
    REASONING: midRange ? { primary: midRange.id, fallbacks: [] } : fallback.REASONING,
  };
}

function buildPremiumProfile(
  byQuality: DiscoveredModel[],
  reasoningCapable: DiscoveredModel[],
  fallback: Record<Tier, TierModelConfig>
): Record<Tier, TierModelConfig> {
  const best = byQuality[0];
  const second = byQuality[1];
  const third = byQuality[2];
  const bestReasoning = reasoningCapable.sort(
    (a, b) => (b.qualityScore || 0) - (a.qualityScore || 0)
  )[0];

  return {
    SIMPLE: second ? { primary: second.id, fallbacks: third ? [third.id] : [] } : fallback.SIMPLE,
    STANDARD: best ? { primary: best.id, fallbacks: second ? [second.id] : [] } : fallback.STANDARD,
    COMPLEX: best ? { primary: best.id, fallbacks: second ? [second.id] : [] } : fallback.COMPLEX,
    REASONING: bestReasoning
      ? {
          primary: bestReasoning.id,
          fallbacks: best && best.id !== bestReasoning.id ? [best.id] : [],
        }
      : fallback.REASONING,
  };
}

function buildAgenticProfile(
  toolByQuality: DiscoveredModel[],
  reasoningCapable: DiscoveredModel[],
  fallback: Record<Tier, TierModelConfig>
): Record<Tier, TierModelConfig> {
  const bestTool = toolByQuality[0];
  const secondTool = toolByQuality[1];
  const thirdTool = toolByQuality[2];
  const bestReasoning = reasoningCapable.sort(
    (a, b) => (b.qualityScore || 0) - (a.qualityScore || 0)
  )[0];

  return {
    SIMPLE: secondTool ? { primary: secondTool.id, fallbacks: [] } : fallback.SIMPLE,
    STANDARD: bestTool
      ? { primary: bestTool.id, fallbacks: secondTool ? [secondTool.id] : [] }
      : fallback.STANDARD,
    COMPLEX: bestTool
      ? {
          primary: bestTool.id,
          fallbacks: [secondTool, thirdTool].filter(Boolean).map((m) => m!.id),
        }
      : fallback.COMPLEX,
    REASONING: bestReasoning
      ? {
          primary: bestReasoning.id,
          fallbacks: bestTool && bestTool.id !== bestReasoning.id ? [bestTool.id] : [],
        }
      : fallback.REASONING,
  };
}

// ---------------------------------------------------------------------------
// Catalog-based profile generation (uses live LiteLLM data)
// ---------------------------------------------------------------------------

/**
 * Build profile tier configs from CatalogModel[] (live pricing data).
 *
 * Strategy per profile:
 *  - ECO:     cheapest model per tier (sorted by input price)
 *  - AUTO:    balanced — mid-price for simple/standard, pricier for complex/reasoning
 *  - PREMIUM: most expensive (highest quality) per tier
 *  - AGENTIC: best tool-calling models (function calling + tool choice), priciest first
 *
 * Each tier picks a primary and up to one fallback from a different provider.
 */
export function buildProfileFromCatalog(
  profile: RoutingProfile,
  models: CatalogModel[]
): Record<Tier, TierModelConfig> {
  if (models.length === 0) return PROFILE_CONFIGS[profile];

  const byPrice = [...models].sort((a, b) => a.pricing.input - b.pricing.input);
  const byPriceDesc = [...byPrice].reverse();
  const reasoning = models.filter((m) => m.capabilities.reasoning);
  const reasoningByPriceDesc = [...reasoning].sort((a, b) => b.pricing.input - a.pricing.input);

  switch (profile) {
    case 'eco':
      return buildCatalogEco(byPrice);
    case 'premium':
      return buildCatalogPremium(byPriceDesc, reasoningByPriceDesc);
    case 'agentic':
      return buildCatalogAgentic(byPriceDesc, reasoningByPriceDesc);
    case 'auto':
    default:
      return buildCatalogAuto(byPrice, byPriceDesc, reasoningByPriceDesc);
  }
}

/** Pick a fallback from a different provider than the primary. */
function pickFallback(primary: CatalogModel, candidates: CatalogModel[]): string[] {
  const alt = candidates.find(
    (m) => m.provider !== primary.provider && m.displayName !== primary.displayName
  );
  return alt ? [alt.displayName] : [];
}

function buildCatalogEco(byPrice: CatalogModel[]): Record<Tier, TierModelConfig> {
  const cheapest = byPrice[0];
  const second = byPrice[1] || cheapest;
  const mid = byPrice[Math.floor(byPrice.length / 3)] || second;

  return {
    SIMPLE: { primary: cheapest.displayName, fallbacks: [] },
    STANDARD: { primary: second.displayName, fallbacks: pickFallback(second, byPrice) },
    COMPLEX: { primary: mid.displayName, fallbacks: pickFallback(mid, byPrice) },
    REASONING: { primary: mid.displayName, fallbacks: pickFallback(mid, byPrice) },
  };
}

function buildCatalogAuto(
  byPrice: CatalogModel[],
  byPriceDesc: CatalogModel[],
  reasoningDesc: CatalogModel[]
): Record<Tier, TierModelConfig> {
  const cheap = byPrice[0];
  const mid = byPrice[Math.floor(byPrice.length / 2)] || cheap;
  const pricey = byPriceDesc[0];
  const bestReasoning = reasoningDesc[0] || pricey;

  return {
    SIMPLE: { primary: cheap.displayName, fallbacks: [] },
    STANDARD: { primary: mid.displayName, fallbacks: pickFallback(mid, byPrice) },
    COMPLEX: { primary: pricey.displayName, fallbacks: pickFallback(pricey, byPriceDesc) },
    REASONING: {
      primary: bestReasoning.displayName,
      fallbacks: pickFallback(bestReasoning, byPriceDesc),
    },
  };
}

function buildCatalogPremium(
  byPriceDesc: CatalogModel[],
  reasoningDesc: CatalogModel[]
): Record<Tier, TierModelConfig> {
  const best = byPriceDesc[0];
  const second = byPriceDesc[1] || best;
  const third = byPriceDesc[2] || second;
  const bestReasoning = reasoningDesc[0] || best;

  return {
    SIMPLE: { primary: second.displayName, fallbacks: pickFallback(second, byPriceDesc) },
    STANDARD: { primary: best.displayName, fallbacks: pickFallback(best, byPriceDesc) },
    COMPLEX: {
      primary: best.displayName,
      fallbacks: [third.displayName].filter((f) => f !== best.displayName),
    },
    REASONING: {
      primary: bestReasoning.displayName,
      fallbacks: pickFallback(bestReasoning, byPriceDesc),
    },
  };
}

function buildCatalogAgentic(
  byPriceDesc: CatalogModel[],
  reasoningDesc: CatalogModel[]
): Record<Tier, TierModelConfig> {
  // All wizard models already have functionCalling, so sort by tool-richness then price
  const toolRich = [...byPriceDesc].sort((a, b) => {
    const scoreA = (a.capabilities.toolChoice ? 2 : 0) + (a.capabilities.parallelToolCalls ? 1 : 0);
    const scoreB = (b.capabilities.toolChoice ? 2 : 0) + (b.capabilities.parallelToolCalls ? 1 : 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return b.pricing.input - a.pricing.input;
  });

  const best = toolRich[0];
  const second = toolRich[1] || best;
  const bestReasoning = reasoningDesc[0] || best;

  return {
    SIMPLE: { primary: second.displayName, fallbacks: [] },
    STANDARD: { primary: best.displayName, fallbacks: pickFallback(best, toolRich) },
    COMPLEX: { primary: best.displayName, fallbacks: pickFallback(best, toolRich) },
    REASONING: {
      primary: bestReasoning.displayName,
      fallbacks: pickFallback(bestReasoning, toolRich),
    },
  };
}

// ---------------------------------------------------------------------------
// Discovered-model-based profile generation (preferred over catalog-based)
// ---------------------------------------------------------------------------

/**
 * Build profile tier configs from discovered models (provider-API authoritative).
 * Mirrors buildProfileFromCatalog's selection strategy but operates on
 * DiscoveredModel[] (which has already been date-stripped + deduplicated).
 *
 * Discovered models should be enriched (via providers/discovery.ts:enrichModel)
 * with catalog-derived toolChoice/parallelToolCalls capabilities for the
 * agentic profile to score tool-richness correctly.
 */
export function buildProfileFromDiscovered(
  profile: RoutingProfile,
  models: DiscoveredModel[]
): Record<Tier, TierModelConfig> {
  if (models.length === 0) return PROFILE_CONFIGS[profile];

  const priced = models.filter((m) => (m.inputPrice ?? 0) > 0);
  const pool = priced.length > 0 ? priced : models;

  const byPrice = [...pool].sort((a, b) => (a.inputPrice ?? 0) - (b.inputPrice ?? 0));
  const byPriceDesc = [...byPrice].reverse();
  const reasoning = pool.filter((m) => m.capabilities.reasoning);
  const reasoningByPriceDesc = [...reasoning].sort(
    (a, b) => (b.inputPrice ?? 0) - (a.inputPrice ?? 0)
  );

  switch (profile) {
    case 'eco':
      return discoveredEco(byPrice);
    case 'premium':
      return discoveredPremium(byPriceDesc, reasoningByPriceDesc);
    case 'agentic':
      return discoveredAgentic(byPriceDesc, reasoningByPriceDesc);
    case 'auto':
    default:
      return discoveredAuto(byPrice, byPriceDesc, reasoningByPriceDesc);
  }
}

/** Pick a fallback from a different provider than the primary. */
function pickDiscoveredFallback(primary: DiscoveredModel, candidates: DiscoveredModel[]): string[] {
  const alt = candidates.find((m) => m.provider !== primary.provider && m.id !== primary.id);
  return alt ? [alt.id] : [];
}

function discoveredEco(byPrice: DiscoveredModel[]): Record<Tier, TierModelConfig> {
  const cheapest = byPrice[0];
  const second = byPrice[1] || cheapest;
  const mid = byPrice[Math.floor(byPrice.length / 3)] || second;

  return {
    SIMPLE: { primary: cheapest.id, fallbacks: [] },
    STANDARD: { primary: second.id, fallbacks: pickDiscoveredFallback(second, byPrice) },
    COMPLEX: { primary: mid.id, fallbacks: pickDiscoveredFallback(mid, byPrice) },
    REASONING: { primary: mid.id, fallbacks: pickDiscoveredFallback(mid, byPrice) },
  };
}

function discoveredAuto(
  byPrice: DiscoveredModel[],
  byPriceDesc: DiscoveredModel[],
  reasoningDesc: DiscoveredModel[]
): Record<Tier, TierModelConfig> {
  const cheap = byPrice[0];
  const mid = byPrice[Math.floor(byPrice.length / 2)] || cheap;
  const pricey = byPriceDesc[0];
  const bestReasoning = reasoningDesc[0] || pricey;

  return {
    SIMPLE: { primary: cheap.id, fallbacks: [] },
    STANDARD: { primary: mid.id, fallbacks: pickDiscoveredFallback(mid, byPrice) },
    COMPLEX: { primary: pricey.id, fallbacks: pickDiscoveredFallback(pricey, byPriceDesc) },
    REASONING: {
      primary: bestReasoning.id,
      fallbacks: pickDiscoveredFallback(bestReasoning, byPriceDesc),
    },
  };
}

function discoveredPremium(
  byPriceDesc: DiscoveredModel[],
  reasoningDesc: DiscoveredModel[]
): Record<Tier, TierModelConfig> {
  const best = byPriceDesc[0];
  const second = byPriceDesc[1] || best;
  const third = byPriceDesc[2] || second;
  const bestReasoning = reasoningDesc[0] || best;

  return {
    SIMPLE: { primary: second.id, fallbacks: pickDiscoveredFallback(second, byPriceDesc) },
    STANDARD: { primary: best.id, fallbacks: pickDiscoveredFallback(best, byPriceDesc) },
    COMPLEX: {
      primary: best.id,
      fallbacks: [third.id].filter((f) => f !== best.id),
    },
    REASONING: {
      primary: bestReasoning.id,
      fallbacks: pickDiscoveredFallback(bestReasoning, byPriceDesc),
    },
  };
}

function discoveredAgentic(
  byPriceDesc: DiscoveredModel[],
  reasoningDesc: DiscoveredModel[]
): Record<Tier, TierModelConfig> {
  // Sort by tool-richness (toolChoice + parallelToolCalls), tiebreaker price desc
  const toolRich = [...byPriceDesc].sort((a, b) => {
    const scoreA =
      (a.capabilities.toolChoice ? 2 : 0) + (a.capabilities.parallelToolCalls ? 1 : 0);
    const scoreB =
      (b.capabilities.toolChoice ? 2 : 0) + (b.capabilities.parallelToolCalls ? 1 : 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (b.inputPrice ?? 0) - (a.inputPrice ?? 0);
  });

  const best = toolRich[0];
  const second = toolRich[1] || best;
  const bestReasoning = reasoningDesc[0] || best;

  return {
    SIMPLE: { primary: second.id, fallbacks: [] },
    STANDARD: { primary: best.id, fallbacks: pickDiscoveredFallback(best, toolRich) },
    COMPLEX: { primary: best.id, fallbacks: pickDiscoveredFallback(best, toolRich) },
    REASONING: {
      primary: bestReasoning.id,
      fallbacks: pickDiscoveredFallback(bestReasoning, toolRich),
    },
  };
}

/**
 * Validate a profile string.
 */
export function isValidProfile(value: string): value is RoutingProfile {
  return VALID_PROFILES.includes(value as RoutingProfile);
}
