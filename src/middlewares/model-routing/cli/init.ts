/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Model Routing Init Wizard
 * Interactive setup for SAI-Model-Routing-Middleware within OpenClaw.
 *
 * Steps:
 *  1. (Optional) Customize tier-to-model mappings for any of the three
 *     profiles (eco / premium / agentic). Profiles the user doesn't
 *     customize get discovery-based defaults from buildProfileFromDiscovered.
 *  2. (Optional) Set a universal fallback model applied across every tier
 *     of every profile.
 *
 * All three profiles are always exposed to OpenClaw — there is no "default
 * profile" concept at the user-facing level. Each profile carries its own
 * tier→model map under `tierOverridesByProfile[profile]` so editing one
 * doesn't disturb the others.
 *
 * Model list sources:
 *  - Live provider API discovery (Anthropic, Google, OpenAI) for the
 *    authoritative set of models available to the user.
 *  - LiteLLM catalog for pricing and capability enrichment, and as a
 *    fallback when a provider's discovery call returns nothing.
 *
 * Writes:
 *  - sapience-ai-suite.json → model_routing: per-profile tier overrides
 *    and provider configs for every configured provider.
 *  - model-routing/discovered-models.json: authoritative list for the
 *    dashboard dropdown. Written once per sai init; the gateway is a
 *    pure consumer.
 *  - openclaw.json: sai-router provider entry + allowlist (via stage
 *    + flush).
 *
 * On re-run, existing per-profile configurations are preserved and shown as
 * the starting point for any customization the user opts into.
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { ModelRoutingDiscovery } from '../storage/ModelRoutingDiscovery.js';
import { ModelRoutingPolicyStore } from '../storage/ModelRoutingPolicyStore.js';
import { VALID_PROFILES, PROFILE_DESCRIPTIONS, RoutingProfile } from '../selection/profiles.js';
import { buildProfileFromDiscovered } from '../selection/profiles.js';
import { Tier, TierModelConfig, DiscoveredModel, ProviderConfig } from '../types.js';
import { SAPIENCE_MW_STORE_FILE } from '../../../shared/Logger.js';
import { resolveProviderConfig } from './provider-auth.js';
import { discoverAllModels, normalizeDiscoveredModels } from '../providers/discovery.js';
import {
  fetchModelCatalog,
  getWizardModels,
  lookupModel,
  toDiscoveredModels,
} from '../storage/model-catalog.js';
import { buildRouterModelList } from '../router-provider.js';
import { injectModelsConfig, injectAuthProfile } from '../router-config-inject.js';
import { flushToOpenClaw } from '../../../shared/server/openclaw-sync.js';
import { loadOpenClawConfig } from '../../../plugin/config-manager.js';

const TIERS: Tier[] = ['SIMPLE', 'STANDARD', 'COMPLEX', 'REASONING'];

const TIER_DESCRIPTIONS: Record<Tier, string> = {
  SIMPLE: 'Quick factual answers, greetings, simple lookups',
  STANDARD: 'Code generation, multi-step instructions, tool calls',
  COMPLEX: 'Architecture design, large-context analysis, code review',
  REASONING: 'Formal proofs, theorem proving, deep analytical reasoning',
};

function formatTierTable(tiers: Record<Tier, TierModelConfig>, label?: string): void {
  console.log('');
  if (label) console.log(chalk.dim(`   ${label}`));
  console.log(chalk.dim('   Tier         Primary Model          Fallbacks'));
  console.log(chalk.dim('   ' + '-'.repeat(60)));
  for (const tier of TIERS) {
    const cfg = tiers[tier];
    const fallbacks = cfg.fallbacks.length > 0 ? cfg.fallbacks.join(', ') : chalk.dim('none');
    console.log(`   ${chalk.bold(tier.padEnd(12))} ${cfg.primary.padEnd(23)} ${fallbacks}`);
  }
  console.log('');
}

/**
 * Format a discovered model choice for inquirer, showing price and badges.
 * Uses the (date-stripped) discovered model id so terminal users see the
 * same names the dashboard dropdown does.
 */
function formatModelChoice(m: DiscoveredModel): { name: string; value: string } {
  const price = `$${(m.inputPrice ?? 0).toFixed(2)}/$${(m.outputPrice ?? 0).toFixed(2)}`;
  const badges: string[] = [];
  if (m.capabilities.reasoning) badges.push('reasoning');
  if (m.capabilities.vision) badges.push('vision');
  if (m.capabilities.functionCalling || m.capabilities.toolCalling) badges.push('tools');
  const badgeStr = badges.length > 0 ? chalk.dim(` [${badges.join(', ')}]`) : '';

  return {
    name: `${m.id.padEnd(32)} ${chalk.dim(price + '/M tok')}${badgeStr}`,
    value: m.id,
  };
}

/**
 * Read configured providers from openclaw.json auth.profiles section
 * using the config-manager API (not direct file reads).
 */
async function detectConfiguredProviders(): Promise<Set<string>> {
  const config = await loadOpenClawConfig();
  if (!config) return new Set<string>();

  const auth = config.auth as { profiles?: Record<string, { provider?: string }> } | undefined;
  if (!auth?.profiles) return new Set<string>();

  const providers = new Set<string>();
  for (const profile of Object.values(auth.profiles)) {
    if (profile.provider) {
      // Normalize: google auth might list as "google" or "gemini"
      const normalized = profile.provider === 'gemini' ? 'google' : profile.provider;
      if (['openai', 'anthropic', 'google'].includes(normalized)) {
        providers.add(normalized);
      }
    }
  }
  return providers;
}

/**
 * Merge profile defaults with existing user overrides to build the
 * effective tier configuration (what's actually running).
 */
function buildEffectiveTiers(
  profileTiers: Record<Tier, TierModelConfig>,
  tierOverrides?: Partial<Record<Tier, TierModelConfig>>
): Record<Tier, TierModelConfig> {
  const merged: Record<Tier, TierModelConfig> = { ...profileTiers };
  if (tierOverrides) {
    for (const [tier, cfg] of Object.entries(tierOverrides)) {
      if (cfg) merged[tier as Tier] = cfg;
    }
  }
  return merged;
}

export async function initModelRoutingMiddleware(
  _options: any,
  jsonMode: boolean,
  nonInteractive: boolean,
  paths: any,
  warnings: string[]
): Promise<any> {
  const store = new ModelRoutingDiscovery();
  store.load();
  const existingData = store.getData();

  // ── Detect configured providers ────────────────────────────────────────
  // Read from openclaw.json auth.profiles via config-manager API
  const configuredProviders = await detectConfiguredProviders();

  if (!jsonMode) {
    console.log(chalk.green('\n  Setting up Model Routing middleware.'));
    console.log(
      chalk.dim('  Routes each request to the optimal model based on complexity scoring.')
    );
    const providerNames = [...configuredProviders].join(', ');
    console.log(chalk.dim(`  Detected providers: ${providerNames}`));
    console.log(chalk.dim('  Fetching model catalog...'));
  }

  // ── Fetch live model catalog ───────────────────────────────────────────
  const catalog = await fetchModelCatalog();
  const wizardModels = getWizardModels(catalog, configuredProviders);

  if (!jsonMode) {
    console.log(
      chalk.dim(
        `  Found ${wizardModels.length} models from ${[...configuredProviders].join(', ')}\n`
      )
    );
  }

  // ── Discover models from each configured provider's API ───────────────
  // Discovery date-strips and dedupes ids; enrichment copies pricing +
  // tool capabilities from the catalog. We use these as the authoritative
  // model list for profile selection so tier overrides match the names
  // the dashboard dropdown will show.
  const providerConfigs: Record<string, ProviderConfig> = {};
  for (const provider of configuredProviders) {
    const cfg = resolveProviderConfig(provider);
    if (cfg) providerConfigs[provider] = cfg;
  }

  let discoveredModels: DiscoveredModel[] = [];
  if (Object.keys(providerConfigs).length > 0) {
    if (!jsonMode) console.log(chalk.dim('  Discovering models from provider APIs...'));
    try {
      discoveredModels = await discoverAllModels(providerConfigs);
    } catch (err) {
      if (!jsonMode) {
        console.log(
          chalk.yellow(`  Discovery failed, falling back to catalog: ${(err as Error).message}`)
        );
      }
    }
  }

  // If live provider discovery yielded nothing, project the catalog (already
  // filtered to configured providers via getWizardModels above) through the
  // same normalize step so the wizard and dashboard still have a usable list.
  if (discoveredModels.length === 0) {
    const projected = toDiscoveredModels(wizardModels) as DiscoveredModel[];
    discoveredModels = normalizeDiscoveredModels(projected);
    if (!jsonMode && discoveredModels.length > 0) {
      console.log(
        chalk.dim(`  Using catalog fallback — ${discoveredModels.length} models available.`)
      );
    }
  }

  // Persist discovered models immediately so the dashboard dropdown sees
  // them without waiting for the first request to trigger middleware init.
  if (discoveredModels.length > 0) {
    store.setDiscoveredModels(discoveredModels);
  }

  // Wizard list — require function-calling; unpriced models are allowed so
  // new models that haven't hit the catalog yet still appear.
  const effectiveWizard: DiscoveredModel[] = discoveredModels.filter(
    (m) => m.capabilities.functionCalling !== false
  );

  if (!jsonMode && effectiveWizard.length > 0) {
    console.log(chalk.dim(`  ${effectiveWizard.length} usable models available.\n`));
  }

  // ── Build per-profile default tiers from discovery ────────────────────────
  // All three profiles always exist in the OpenClaw model picker. Each one
  // gets a starting tier configuration computed from the discovered models
  // (or the static fallback if discovery returned nothing). The user can
  // then optionally customize any of them; the rest keep these defaults.
  const profileDefaults: Record<RoutingProfile, Record<Tier, TierModelConfig>> = {
    eco: buildProfileFromDiscovered('eco', effectiveWizard),
    premium: buildProfileFromDiscovered('premium', effectiveWizard),
    agentic: buildProfileFromDiscovered('agentic', effectiveWizard),
  };

  // Per-profile tier overrides we'll persist. Seeded from existing per-profile
  // overrides on re-runs so the user's saved customizations survive.
  const tierOverridesByProfile: Partial<
    Record<RoutingProfile, Partial<Record<Tier, TierModelConfig>>>
  > = {};
  for (const p of VALID_PROFILES) {
    const existing = existingData.tierOverridesByProfile?.[p];
    if (existing && Object.keys(existing).length > 0) {
      tierOverridesByProfile[p] = { ...existing };
    }
  }

  // ── Step 1: Optional per-profile tier customization ───────────────────────

  if (!nonInteractive) {
    if (!jsonMode) {
      console.log(chalk.bold('Step 1: Tier Model Configuration (optional)'));
      console.log(
        chalk.dim(
          'All three profiles (eco / premium / agentic) are always available in the OpenClaw'
        )
      );
      console.log(
        chalk.dim('model picker. You can customize any of them — the rest use sensible defaults.')
      );
      console.log('');
    }

    const { wantToCustomize } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'wantToCustomize',
        message: 'Would you like to customize tier mappings for any profile?',
        default: false,
      },
    ]);

    if (wantToCustomize) {
      const { profilesToCustomize } = await inquirer.prompt([
        {
          type: 'checkbox',
          name: 'profilesToCustomize',
          message: 'Which profile(s) do you want to configure? (space to select)',
          choices: VALID_PROFILES.map((p) => ({
            name: `${p.padEnd(10)} ${PROFILE_DESCRIPTIONS[p]}${
              tierOverridesByProfile[p] ? chalk.green(' (configured)') : chalk.dim(' (defaults)')
            }`,
            value: p,
            checked: !!tierOverridesByProfile[p],
          })),
        },
      ]);

      // Group models by provider for display (shared across profiles).
      const grouped = new Map<string, DiscoveredModel[]>();
      for (const m of effectiveWizard) {
        const list = grouped.get(m.provider) || [];
        list.push(m);
        grouped.set(m.provider, list);
      }

      for (const profile of profilesToCustomize as RoutingProfile[]) {
        if (!jsonMode) {
          console.log('');
          console.log(
            chalk.bold.cyan(`── ${profile} profile — ${PROFILE_DESCRIPTIONS[profile]} ──`)
          );
        }

        const profileTiers = profileDefaults[profile];
        const slot = (tierOverridesByProfile[profile] ?? {}) as Partial<
          Record<Tier, TierModelConfig>
        >;

        for (const tier of TIERS) {
          const currentModel = slot[tier]?.primary || profileTiers[tier].primary;
          const isOverridden = !!slot[tier];

          if (!jsonMode) {
            console.log('');
            console.log(chalk.cyan(`   ${tier}: ${TIER_DESCRIPTIONS[tier]}`));
            if (isOverridden) {
              console.log(chalk.dim(`   Currently set to: ${currentModel}`));
            }
          }

          const profileModel = profileTiers[tier].primary;
          const topLabel = isOverridden
            ? `${currentModel} ${chalk.green('(your current choice)')}`
            : `${profileModel} ${chalk.dim(`(${profile} profile pick)`)}`;
          const topValue = isOverridden ? currentModel : '__default__';

          const choices: Array<
            { name: string; value: string } | typeof inquirer.Separator.prototype
          > = [{ name: topLabel, value: topValue }];

          if (isOverridden && currentModel !== profileModel) {
            const profileEntry = effectiveWizard.find((m) => m.id === profileModel);
            if (profileEntry) {
              choices.push({
                name: `${formatModelChoice(profileEntry).name} ${chalk.dim(
                  `(${profile} profile pick)`
                )}`,
                value: '__default__',
              });
            }
          }

          for (const [provider, models] of grouped) {
            choices.push(new inquirer.Separator(chalk.dim(`── ${provider} ──`)));
            for (const m of models) {
              if (m.id === profileModel) continue;
              if (isOverridden && m.id === currentModel) continue;
              choices.push(formatModelChoice(m));
            }
          }

          choices.push(new inquirer.Separator(chalk.dim('──────────')));
          choices.push({ name: 'Custom model...', value: '__custom__' });

          const { modelChoice } = await inquirer.prompt([
            {
              type: 'list',
              name: 'modelChoice',
              message: `${tier} tier model:`,
              choices,
              default: isOverridden ? currentModel : '__default__',
            },
          ]);

          if (modelChoice === '__default__') {
            slot[tier] = {
              primary: profileTiers[tier].primary,
              fallbacks: [...profileTiers[tier].fallbacks],
            };
          } else if (modelChoice === currentModel && isOverridden) {
            // keep as-is
          } else if (modelChoice === '__custom__') {
            const { customModel } = await inquirer.prompt([
              {
                type: 'input',
                name: 'customModel',
                message: `Enter model name for ${tier}:`,
                validate: (val: string) => val.trim().length > 0 || 'Model name cannot be empty',
              },
            ]);
            slot[tier] = { primary: customModel.trim(), fallbacks: [] };
          } else {
            slot[tier] = { primary: modelChoice, fallbacks: [] };
          }
        }

        tierOverridesByProfile[profile] = slot;

        if (!jsonMode) {
          console.log('');
          console.log(chalk.dim(`   Final ${profile} tier configuration:`));
          formatTierTable(buildEffectiveTiers(profileTiers, slot));
        }
      }
    } else if (!jsonMode) {
      console.log(
        chalk.green('   Skipping customization — saving discovery-based defaults for all profiles.')
      );
      console.log('');
    }
  }

  // For any profile the user didn't customize (and that doesn't already have
  // a saved override slot from a previous run), persist the discovery-based
  // defaults so the runtime has an explicit configuration for every profile.
  for (const p of VALID_PROFILES) {
    if (!tierOverridesByProfile[p] || Object.keys(tierOverridesByProfile[p]!).length === 0) {
      tierOverridesByProfile[p] = { ...profileDefaults[p] };
    }
  }

  // ── Step 2: Universal fallback model ──────────────────────────────────────

  if (!nonInteractive && !jsonMode) {
    console.log(chalk.bold('Step 2: Universal Fallback Model'));
    console.log(
      chalk.dim('Set a fallback model that will be added to ALL tiers across all profiles.')
    );
    console.log('');

    const { wantsFallback } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'wantsFallback',
        message: 'Would you like to set a universal fallback model for all tiers?',
        default: false,
      },
    ]);

    if (wantsFallback) {
      const fallbackChoices: Array<
        { name: string; value: string } | typeof inquirer.Separator.prototype
      > = [];
      const grouped = new Map<string, DiscoveredModel[]>();
      for (const m of effectiveWizard) {
        const list = grouped.get(m.provider) || [];
        list.push(m);
        grouped.set(m.provider, list);
      }
      for (const [provider, models] of grouped) {
        fallbackChoices.push(new inquirer.Separator(chalk.dim(`── ${provider} ──`)));
        for (const m of models) {
          fallbackChoices.push(formatModelChoice(m));
        }
      }
      fallbackChoices.push(new inquirer.Separator(chalk.dim('──────────')));
      fallbackChoices.push({ name: 'Custom model...', value: '__custom__' });

      const { fallbackModel } = await inquirer.prompt([
        {
          type: 'list',
          name: 'fallbackModel',
          message: 'Select universal fallback model:',
          choices: fallbackChoices,
        },
      ]);

      let finalFallbackModel = fallbackModel;
      if (fallbackModel === '__custom__') {
        const { customFb } = await inquirer.prompt([
          {
            type: 'input',
            name: 'customFb',
            message: 'Enter fallback model name:',
            validate: (val: string) => val.trim().length > 0 || 'Model name cannot be empty',
          },
        ]);
        finalFallbackModel = customFb.trim();
      }

      // Apply fallback across every tier of every profile.
      for (const profile of VALID_PROFILES) {
        const slot = tierOverridesByProfile[profile]!;
        for (const tier of TIERS) {
          const cfg = slot[tier] || profileDefaults[profile][tier];
          if (cfg.primary !== finalFallbackModel) {
            const existingFallbacks = cfg.fallbacks.filter((f) => f !== finalFallbackModel);
            slot[tier] = {
              primary: cfg.primary,
              fallbacks: [...existingFallbacks, finalFallbackModel],
            };
          }
        }
      }

      console.log(chalk.green(`   Universal fallback set: ${finalFallbackModel}`));
      console.log('');
    }
  }

  // ── Resolve and save provider configs from every tier of every profile ──
  // Collect all unique model IDs across tiers across profiles (primary + fallbacks)
  const allModelIds = new Set<string>();
  for (const profile of VALID_PROFILES) {
    const effective = buildEffectiveTiers(
      profileDefaults[profile],
      tierOverridesByProfile[profile]
    );
    for (const cfg of Object.values(effective)) {
      allModelIds.add(cfg.primary);
      for (const fb of cfg.fallbacks) allModelIds.add(fb);
    }
  }

  // Build provider configs for every provider the user has an API key for,
  // not just those whose models appear in the current tier picks. The
  // dashboard's "Configured Providers" panel reads from store.providerConfigs,
  // so narrowing this to tier-referenced providers would hide providers the
  // user has set up in OpenClaw auth but hasn't routed to yet. Merge over
  // any pre-existing providerConfigs so earlier-run providers survive.
  const resolvedProviders: string[] = [];
  const mergedProviderConfigs: Record<string, ProviderConfig> = {
    ...(existingData.providerConfigs ?? {}),
  };
  for (const provider of configuredProviders) {
    const providerCfg = resolveProviderConfig(provider);
    if (providerCfg) {
      mergedProviderConfigs[provider] = providerCfg;
      resolvedProviders.push(provider);
    }
  }

  // Separately: warn if a tier references a provider with no resolvable key.
  // Build the set of providers referenced by tier primary + fallback ids.
  const tierReferencedProviders = new Set<string>();
  for (const modelId of allModelIds) {
    const catalogEntry = lookupModel(catalog, modelId);
    if (catalogEntry) {
      tierReferencedProviders.add(catalogEntry.provider);
      continue;
    }
    // Infer provider from model name prefix when not in catalog
    if (modelId.startsWith('claude-') || modelId.startsWith('anthropic/')) {
      tierReferencedProviders.add('anthropic');
    } else if (
      modelId.startsWith('gemini-') ||
      modelId.startsWith('gemini/') ||
      modelId.startsWith('google/')
    ) {
      tierReferencedProviders.add('google');
    } else if (
      modelId.startsWith('gpt-') ||
      modelId.startsWith('o1-') ||
      modelId.startsWith('o3-') ||
      modelId.startsWith('o4-') ||
      modelId.startsWith('openai/')
    ) {
      tierReferencedProviders.add('openai');
    }
  }
  const missingProviders = [...tierReferencedProviders].filter(
    (p) => !resolvedProviders.includes(p)
  );

  if (!jsonMode && resolvedProviders.length > 0) {
    console.log(chalk.green(`  Providers resolved: ${resolvedProviders.join(', ')}`));
  }
  if (!jsonMode && missingProviders.length > 0) {
    const warning = `Missing API keys for: ${missingProviders.join(', ')}. Configure these providers in OpenClaw settings.`;
    console.log(chalk.yellow(`  ⚠ ${warning}`));
    warnings.push(warning);
  }

  // Commit per-profile tier overrides + providerConfigs in one merge-save.
  // Sibling fields (weightOverrides, boundaryOverrides, exclusions, pinning
  // toggles, defaultProfile) are preserved via update()'s shallow merge.
  await ModelRoutingPolicyStore.update({
    tierOverridesByProfile,
    providerConfigs: mergedProviderConfigs,
  });

  if (!jsonMode) {
    console.log(chalk.green('  Configuration saved to unified store.'));
    console.log(chalk.dim(`   Store: ${SAPIENCE_MW_STORE_FILE}`));
    console.log('');
  }

  // ── Stage provider config + allowlist, then flush to openclaw.json ───────
  // Changes are staged in sapience-ai-suite.json first, then flushed to
  // openclaw.json in a single write at the end of init.
  const routerPort = 9000;
  const modelList = buildRouterModelList();
  await injectModelsConfig(routerPort, modelList);
  injectAuthProfile();
  await flushToOpenClaw();

  if (!jsonMode) {
    console.log(chalk.green('  OpenClaw provider config and model allowlist updated.'));
    console.log('');
  }

  // ── Summary and next steps ────────────────────────────────────────────────

  if (!jsonMode) {
    console.log(chalk.green('  Model Routing setup complete.'));
    console.log('');
    console.log(chalk.bold('Quick Commands:'));
    console.log(chalk.dim('   Test a prompt:           sai router test "your prompt here"'));
    console.log(chalk.dim('   View stats:              sai router stats'));
    console.log(chalk.dim('   View tier mappings:      sai router tiers'));
    console.log(
      chalk.dim(
        '   Edit a profile tier:     sai router tiers --profile premium --set "COMPLEX claude-opus-4-6"'
      )
    );
    console.log(chalk.dim('   View current config:     sai router config'));
    console.log('');
  }

  return {
    ok: true,
    configPath: paths.openclawConfig,
    policyPath: ModelRoutingPolicyStore.getPath(),
    openclawHome: paths.openclawHome,
    restartRecommended: !nonInteractive,
    warnings,
    nextSteps: [
      'Test a prompt: sai router test "your prompt here"',
      'View stats: sai router stats',
      'View tier mappings: sai router tiers',
      'Edit a profile tier: sai router tiers --profile premium --set "COMPLEX claude-opus-4-6"',
    ],
  };
}
