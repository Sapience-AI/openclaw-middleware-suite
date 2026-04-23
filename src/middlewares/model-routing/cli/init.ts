/**
 * Model Routing Init Wizard
 * Interactive setup for SAI-Model-Routing-Middleware within OpenClaw.
 *
 * Steps:
 *  1. Select a routing profile (eco / auto / premium / agentic)
 *  2. Configure tier-to-model mappings (or accept profile defaults)
 *  3. (Optional) Set a universal fallback model for all tiers
 *
 * Model list sources:
 *  - Live provider API discovery (Anthropic, Google, OpenAI) for the
 *    authoritative set of models available to the user.
 *  - LiteLLM catalog for pricing and capability enrichment, and as a
 *    fallback when a provider's discovery call returns nothing.
 *
 * Writes:
 *  - sapience-ai-suite.json → model_routing: profile, tier overrides,
 *    provider configs for every configured provider.
 *  - model-routing/discovered-models.json: authoritative list for the
 *    dashboard dropdown. Written once per sai init; the gateway is a
 *    pure consumer.
 *  - openclaw.json: sai-router provider entry + allowlist (via stage
 *    + flush).
 *
 * On re-run, shows the user's previous tier configuration and allows
 * editing rather than starting from scratch.
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { ModelRoutingStore } from '../storage/ModelRoutingStore.js';
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
  const store = new ModelRoutingStore();
  store.load();
  const existingData = store.getData();
  const isRerun = !!(existingData.defaultProfile || existingData.tierOverrides);

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

  // (existing config shown after profile selection below)

  // ── Step 1: Select routing profile ────────────────────────────────────────

  let selectedProfile: RoutingProfile;

  if (nonInteractive) {
    selectedProfile = existingData.defaultProfile || 'auto';
  } else {
    if (!jsonMode) {
      console.log(chalk.bold('Step 1: Routing Profile'));
      console.log(chalk.dim('Profiles control the cost-vs-quality tradeoff across all tiers.'));
      console.log('');
    }

    const currentProfile = existingData.defaultProfile || 'auto';

    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'profile',
        message: 'Which routing profile would you like to use?',
        choices: VALID_PROFILES.map((p) => ({
          name: `${p.padEnd(10)} ${PROFILE_DESCRIPTIONS[p]}${p === currentProfile ? chalk.green(' (current)') : ''}`,
          value: p,
        })),
        default: currentProfile,
      },
    ]);

    selectedProfile = answer.profile;

    if (!jsonMode) {
      console.log(chalk.green(`   Profile set to: ${selectedProfile}`));
    }
  }

  // Build profile tiers from the effective wizard list. Either real
  // discovery or the date-stripped catalog projection — both produce
  // already-stripped names so tier overrides match the dashboard dropdown.
  const profileTiers = buildProfileFromDiscovered(selectedProfile, effectiveWizard);

  if (!jsonMode && !nonInteractive) {
    if (
      isRerun &&
      existingData.tierOverrides &&
      Object.keys(existingData.tierOverrides).length > 0
    ) {
      // Re-run: show user's saved config (profile + their overrides)
      const savedEffective = buildEffectiveTiers(profileTiers, existingData.tierOverrides);
      console.log(chalk.dim('\n   Your current tier configuration:'));
      formatTierTable(savedEffective);
    } else {
      // First run: show what the profile algorithm picked
      console.log(chalk.dim('\n   Default models for this profile:'));
      formatTierTable(profileTiers);
    }
  }

  // ── Step 2: Configure tier models ─────────────────────────────────────────

  // Start from previous user overrides (not blank) so re-runs preserve config
  let tierOverrides: Partial<Record<Tier, TierModelConfig>> = {};
  if (existingData.tierOverrides) {
    tierOverrides = { ...existingData.tierOverrides };
  }

  if (!nonInteractive) {
    if (!jsonMode) {
      console.log(chalk.bold('Step 2: Tier Model Configuration'));
      console.log(
        chalk.dim(
          'Override which model handles each complexity tier, or keep the profile defaults.'
        )
      );
      console.log('');
    }

    const hasExistingOverrides = Object.keys(tierOverrides).length > 0;

    const { customizeTiers } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'customizeTiers',
        message: hasExistingOverrides
          ? 'Would you like to edit your tier model configuration?'
          : 'Would you like to customize the model for any tier?',
        default: hasExistingOverrides,
      },
    ]);

    if (customizeTiers) {
      // Group models by provider for display
      const grouped = new Map<string, DiscoveredModel[]>();
      for (const m of effectiveWizard) {
        const list = grouped.get(m.provider) || [];
        list.push(m);
        grouped.set(m.provider, list);
      }

      for (const tier of TIERS) {
        // Show previous override or profile default
        const currentModel = tierOverrides[tier]?.primary || profileTiers[tier].primary;
        const isOverridden = !!tierOverrides[tier];

        if (!jsonMode) {
          console.log('');
          console.log(chalk.cyan(`   ${tier}: ${TIER_DESCRIPTIONS[tier]}`));
          if (isOverridden) {
            console.log(chalk.dim(`   Currently set to: ${currentModel}`));
          }
        }

        // Build choices: current/recommended first, then all models grouped by provider
        const profileModel = profileTiers[tier].primary;
        const topLabel = isOverridden
          ? `${currentModel} ${chalk.green('(your current choice)')}`
          : `${profileModel} ${chalk.dim(`(${selectedProfile} profile pick)`)}`;
        const topValue = isOverridden ? currentModel : '__default__';

        const choices: Array<
          { name: string; value: string } | typeof inquirer.Separator.prototype
        > = [{ name: topLabel, value: topValue }];

        // If user's current choice differs from profile pick, also offer the profile pick
        if (isOverridden && currentModel !== profileModel) {
          const profileEntry = effectiveWizard.find((m) => m.id === profileModel);
          if (profileEntry) {
            choices.push({
              name: `${formatModelChoice(profileEntry).name} ${chalk.dim(`(${selectedProfile} profile pick)`)}`,
              value: '__default__',
            });
          }
        }

        for (const [provider, models] of grouped) {
          choices.push(new inquirer.Separator(chalk.dim(`── ${provider} ──`)));
          for (const m of models) {
            // Skip models already shown above
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
          // User accepted the profile pick — save it explicitly so runtime
          // uses exactly this model (not a different auto-assigned one).
          tierOverrides[tier] = {
            primary: profileTiers[tier].primary,
            fallbacks: [...profileTiers[tier].fallbacks],
          };
        } else if (modelChoice === currentModel && isOverridden) {
          // User kept their existing choice — keep the override as-is
        } else if (modelChoice === '__custom__') {
          const { customModel } = await inquirer.prompt([
            {
              type: 'input',
              name: 'customModel',
              message: `Enter model name for ${tier}:`,
              validate: (val: string) => val.trim().length > 0 || 'Model name cannot be empty',
            },
          ]);
          tierOverrides[tier] = { primary: customModel.trim(), fallbacks: [] };
        } else {
          tierOverrides[tier] = { primary: modelChoice, fallbacks: [] };
        }
      }

      if (!jsonMode) {
        console.log('');
        console.log(chalk.dim('   Final tier configuration:'));
        const merged = buildEffectiveTiers(profileTiers, tierOverrides);
        formatTierTable(merged);
      }
    } else {
      if (hasExistingOverrides) {
        // Re-run: keep user's existing config
        if (!jsonMode) {
          console.log(chalk.green('   Keeping your existing tier configuration.'));
          console.log('');
        }
      } else {
        // First run: save profile defaults explicitly so runtime matches init
        for (const tier of TIERS) {
          tierOverrides[tier] = {
            primary: profileTiers[tier].primary,
            fallbacks: [...profileTiers[tier].fallbacks],
          };
        }
        if (!jsonMode) {
          console.log(chalk.green('   Using profile defaults (saved to config).'));
          console.log('');
        }
      }
    }
  }

  // ── Step 3: Universal fallback model ──────────────────────────────────────

  if (!nonInteractive && !jsonMode) {
    console.log(chalk.bold('Step 3: Universal Fallback Model'));
    console.log(chalk.dim('Set a fallback model that will be added to ALL tiers as a safety net.'));
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
      // Build flat model list for fallback selection
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

      // Apply fallback to all tiers — both profile defaults and user overrides
      const finalTiersBeforeFallback = buildEffectiveTiers(profileTiers, tierOverrides);
      for (const tier of TIERS) {
        const cfg = finalTiersBeforeFallback[tier];
        // Add fallback if it's not already the primary
        if (cfg.primary !== finalFallbackModel) {
          const existingFallbacks = cfg.fallbacks.filter((f) => f !== finalFallbackModel);
          tierOverrides[tier] = {
            primary: cfg.primary,
            fallbacks: [...existingFallbacks, finalFallbackModel],
          };
        }
      }

      console.log(chalk.green(`   Universal fallback set: ${finalFallbackModel}`));
      console.log('');
      console.log(chalk.dim('   Updated tier configuration:'));
      formatTierTable(buildEffectiveTiers(profileTiers, tierOverrides));
    }
  }

  // ── Save to unified store ─────────────────────────────────────────────────

  store.setDefaultProfile(selectedProfile);

  const freshStore = store.getData() as any;
  // Always persist effective tiers so the dashboard and runtime can read them.
  // If the user didn't customize, save the profile defaults as the baseline.
  freshStore.tierOverrides = Object.keys(tierOverrides).length > 0 ? tierOverrides : profileTiers;
  freshStore.defaultProfile = selectedProfile;

  // ── Resolve and save provider configs from selected tier models ──────────
  // Merge profile defaults with overrides to get the final tier models
  const finalTiers = buildEffectiveTiers(profileTiers, tierOverrides);

  // Collect all unique model IDs across tiers (primary + fallbacks)
  const allModelIds = new Set<string>();
  for (const cfg of Object.values(finalTiers)) {
    allModelIds.add(cfg.primary);
    for (const fb of cfg.fallbacks) allModelIds.add(fb);
  }

  // Save provider configs for every provider the user has an API key for,
  // not just those whose models appear in the current tier picks. The
  // dashboard's "Configured Providers" panel reads from store.providerConfigs,
  // so narrowing this to tier-referenced providers would hide providers the
  // user has set up in OpenClaw auth but hasn't routed to yet.
  const resolvedProviders: string[] = [];
  for (const provider of configuredProviders) {
    const providerCfg = resolveProviderConfig(provider);
    if (providerCfg) {
      store.setProviderConfig(provider, providerCfg);
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

  store.saveSync();

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
    console.log(chalk.dim('   Test a prompt:         sai router test "your prompt here"'));
    console.log(chalk.dim('   View stats:            sai router stats'));
    console.log(chalk.dim('   Change profile:        sai router config --set-profile <profile>'));
    console.log(
      chalk.dim('   Override a tier model:  sai router tiers --set "COMPLEX claude-opus-4-6"')
    );
    console.log(chalk.dim('   View current config:    sai router config'));
    console.log('');
  }

  return {
    ok: true,
    configPath: paths.openclawConfig,
    policyPath: ModelRoutingStore.getPath(),
    openclawHome: paths.openclawHome,
    restartRecommended: !nonInteractive,
    warnings,
    nextSteps: [
      'Test a prompt: sai router test "your prompt here"',
      'View stats: sai router stats',
      'Change profile: sai router config --set-profile <profile>',
      'Override tier model: sai router tiers --set "COMPLEX claude-opus-4-6"',
    ],
  };
}
