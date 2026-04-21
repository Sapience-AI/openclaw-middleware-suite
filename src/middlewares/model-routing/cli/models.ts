/**
 * CLI: sai router models — View discovered models and auto-assignments.
 *
 * Ported from Manifest's model discovery service for CLI display.
 */

import chalk from 'chalk';
import { ModelRoutingStore } from '../storage/ModelRoutingStore.js';
import { DiscoveredModel, Tier, TIER_ORDER } from '../types.js';
import { DEFAULT_MODEL_ROUTING_CONFIG } from '../config.js';
import { discoverAllModels } from '../providers/discovery.js';
import { autoAssignTiers } from '../selection/auto-assign.js';

export async function routerModelsCommand(opts: { refresh?: boolean }): Promise<void> {
  const store = new ModelRoutingStore();
  store.load();
  const storeData = store.getData();

  let models = store.getDiscoveredModels();

  if (opts.refresh || models.length === 0) {
    const providers = storeData.providerConfigs || {};

    if (Object.keys(providers).length === 0) {
      console.log(chalk.yellow('No providers configured.'));
      console.log(chalk.dim('Add providers via openclaw.json model-routing.providers config.'));
      console.log(chalk.dim('Example:'));
      console.log(chalk.dim('  "providers": {'));
      console.log(
        chalk.dim(
          '    "openai": { "name": "openai", "baseUrl": "https://api.openai.com", "apiKey": "sk-...", "format": "openai" },'
        )
      );
      console.log(
        chalk.dim(
          '    "anthropic": { "name": "anthropic", "baseUrl": "https://api.anthropic.com", "apiKey": "sk-...", "format": "anthropic" }'
        )
      );
      console.log(chalk.dim('  }'));
      return;
    }

    console.log(chalk.dim('Discovering models from providers...'));
    models = await discoverAllModels(providers);

    // Cache in store (auto-saves to separate discovered-models.json)
    store.setDiscoveredModels(models);

    console.log(chalk.green(`Discovered ${models.length} models`));
    console.log('');
  }

  if (models.length === 0) {
    console.log(chalk.dim('No models discovered. Use --refresh to fetch from providers.'));
    return;
  }

  // Group by provider
  const byProvider = new Map<string, DiscoveredModel[]>();
  for (const model of models) {
    const list = byProvider.get(model.provider) || [];
    list.push(model);
    byProvider.set(model.provider, list);
  }

  // Display models by provider
  for (const [provider, providerModels] of byProvider) {
    console.log(chalk.bold.cyan(`  ${provider.toUpperCase()} (${providerModels.length} models)`));
    console.log('');
    console.log(
      chalk.dim(
        '    ' +
          'Model'.padEnd(35) +
          'Quality'.padEnd(10) +
          'Input $/M'.padEnd(12) +
          'Output $/M'.padEnd(12) +
          'Capabilities'
      )
    );
    console.log(chalk.dim('    ' + '-'.repeat(80)));

    const sorted = [...providerModels].sort(
      (a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0)
    );

    for (const model of sorted) {
      const caps: string[] = [];
      if (model.capabilities.toolCalling) caps.push('tools');
      if (model.capabilities.vision) caps.push('vision');
      if (model.capabilities.reasoning) caps.push('reasoning');

      const qualityStr = model.qualityScore
        ? chalk.yellow('★'.repeat(model.qualityScore) + '☆'.repeat(5 - model.qualityScore))
        : chalk.dim('?');
      const inputPrice =
        model.inputPrice !== undefined ? `$${model.inputPrice.toFixed(2)}` : chalk.dim('?');
      const outputPrice =
        model.outputPrice !== undefined ? `$${model.outputPrice.toFixed(2)}` : chalk.dim('?');

      console.log(
        '    ' +
          chalk.white(model.id.padEnd(35)) +
          qualityStr.padEnd(10 + 10) + // chalk adds invisible chars
          inputPrice.toString().padEnd(12) +
          outputPrice.toString().padEnd(12) +
          chalk.dim(caps.join(', '))
      );
    }
    console.log('');
  }

  // Show auto-assignment preview
  const overrides = storeData.tierOverrides || {};
  const autoAssigned = autoAssignTiers(models, overrides);

  console.log(chalk.bold('Auto-Assignment Preview:'));
  console.log('');
  for (const tier of TIER_ORDER) {
    const manual = overrides[tier];
    const auto = autoAssigned[tier];
    const current = DEFAULT_MODEL_ROUTING_CONFIG.tiers[tier];

    if (manual) {
      console.log(
        `  ${tierColor(tier)(tier.padEnd(12))} ${chalk.white(manual.primary)} ${chalk.dim('(manual override)')}`
      );
    } else if (auto) {
      console.log(
        `  ${tierColor(tier)(tier.padEnd(12))} ${chalk.white(auto.primary)} ${chalk.green('(auto-assigned)')}`
      );
      if (auto.fallbacks.length > 0) {
        console.log(`  ${''.padEnd(12)} ${chalk.dim('fallbacks: ' + auto.fallbacks.join(', '))}`);
      }
    } else {
      console.log(
        `  ${tierColor(tier)(tier.padEnd(12))} ${chalk.white(current.primary)} ${chalk.dim('(default)')}`
      );
    }
  }
  console.log('');
}

function tierColor(tier: Tier) {
  switch (tier) {
    case 'SIMPLE':
      return chalk.green;
    case 'STANDARD':
      return chalk.blue;
    case 'COMPLEX':
      return chalk.yellow;
    case 'REASONING':
      return chalk.magenta;
    default:
      return chalk.white;
  }
}
