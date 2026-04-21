/**
 * Auto-Assign — Automatically assign the best model to each tier.
 *
 * Ported from Manifest's tier-auto-assign.service.ts:
 *  - SIMPLE:    Cheapest model
 *  - STANDARD:  Cheapest with quality >= 2, prefer tool-capable
 *  - COMPLEX:   Highest quality, cost tiebreaker, prefer tool-capable
 *  - REASONING: Highest quality among reasoning-capable; fallback to COMPLEX pick
 *
 * Only assigns if the user hasn't set a manual override for that tier.
 */

import { Tier, TierModelConfig, DiscoveredModel, TIER_ORDER } from '../types.js';

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function totalPrice(model: DiscoveredModel): number {
  return (model.inputPrice ?? 999) + (model.outputPrice ?? 999);
}

function quality(model: DiscoveredModel): number {
  return model.qualityScore ?? 2;
}

// ---------------------------------------------------------------------------
// Per-tier selection strategies
// ---------------------------------------------------------------------------

type PickStrategy = (models: DiscoveredModel[]) => DiscoveredModel | null;

const TIER_STRATEGIES: Record<Tier, PickStrategy> = {
  SIMPLE: (models) => {
    // Cheapest model
    const sorted = [...models].sort((a, b) => totalPrice(a) - totalPrice(b));
    return sorted[0] ?? null;
  },

  STANDARD: (models) => {
    // Cheapest among quality >= 2, prefer tool-capable
    const qualified = models.filter((m) => quality(m) >= 2);
    const pool = qualified.length > 0 ? qualified : models;

    const sorted = [...pool].sort((a, b) => {
      // Prefer tool-capable
      const aTool = a.capabilities.toolCalling ? 0 : 1;
      const bTool = b.capabilities.toolCalling ? 0 : 1;
      if (aTool !== bTool) return aTool - bTool;
      // Then cheapest
      return totalPrice(a) - totalPrice(b);
    });

    return sorted[0] ?? null;
  },

  COMPLEX: (models) => {
    // Highest quality, cost tiebreaker, prefer tool-capable
    const sorted = [...models].sort((a, b) => {
      // Highest quality first
      if (quality(b) !== quality(a)) return quality(b) - quality(a);
      // Prefer tool-capable
      const aTool = a.capabilities.toolCalling ? 0 : 1;
      const bTool = b.capabilities.toolCalling ? 0 : 1;
      if (aTool !== bTool) return aTool - bTool;
      // Then cheapest
      return totalPrice(a) - totalPrice(b);
    });

    return sorted[0] ?? null;
  },

  REASONING: (models) => {
    // Highest quality among reasoning-capable
    const reasoning = models.filter((m) => m.capabilities.reasoning);
    if (reasoning.length > 0) {
      const sorted = [...reasoning].sort((a, b) => {
        if (quality(b) !== quality(a)) return quality(b) - quality(a);
        const aTool = a.capabilities.toolCalling ? 0 : 1;
        const bTool = b.capabilities.toolCalling ? 0 : 1;
        if (aTool !== bTool) return aTool - bTool;
        return totalPrice(a) - totalPrice(b);
      });
      return sorted[0] ?? null;
    }
    // Fallback: use COMPLEX strategy
    return TIER_STRATEGIES.COMPLEX(models);
  },
};

// ---------------------------------------------------------------------------
// Auto-assignment
// ---------------------------------------------------------------------------

/**
 * Automatically assign models to tiers based on discovered models.
 *
 * @param discoveredModels All discovered models (enriched with pricing/quality)
 * @param existingOverrides Tiers that already have manual overrides (skip these)
 * @returns A partial tier-to-model map with auto-assigned models
 */
export function autoAssignTiers(
  discoveredModels: DiscoveredModel[],
  existingOverrides: Partial<Record<Tier, TierModelConfig>>
): Partial<Record<Tier, TierModelConfig>> {
  if (discoveredModels.length === 0) return {};

  const result: Partial<Record<Tier, TierModelConfig>> = {};

  for (const tier of TIER_ORDER) {
    // Skip tiers with manual overrides
    if (existingOverrides[tier]) continue;

    const strategy = TIER_STRATEGIES[tier];
    const best = strategy(discoveredModels);

    if (best) {
      result[tier] = {
        primary: best.id,
        fallbacks: buildFallbacks(tier, best, discoveredModels),
      };
    }
  }

  return result;
}

/**
 * Build a fallback chain for a tier: pick 2 alternatives that differ
 * from the primary and are suitable for the tier.
 */
function buildFallbacks(
  tier: Tier,
  primary: DiscoveredModel,
  allModels: DiscoveredModel[]
): string[] {
  const minQuality = tier === 'SIMPLE' ? 1 : tier === 'STANDARD' ? 2 : 3;
  const candidates = allModels
    .filter((m) => m.id !== primary.id && quality(m) >= minQuality)
    .sort((a, b) => {
      // Sort by quality descending, then price ascending
      if (quality(b) !== quality(a)) return quality(b) - quality(a);
      return totalPrice(a) - totalPrice(b);
    });

  return candidates.slice(0, 2).map((m) => m.id);
}
