/**
 * CLI: sai router tiers — View/edit tier-to-model mappings.
 */

import chalk from 'chalk';
import { ModelRoutingStore } from '../storage/ModelRoutingStore.js';
import { DEFAULT_TIER_MODELS } from '../config.js';
import { Tier, TIER_ORDER } from '../types.js';

export async function routerTiersCommand(opts: { set?: string }): Promise<void> {
  const store = new ModelRoutingStore();
  store.load();

  // ── Set tier primary model ──────────────────────────────────────────────
  if (opts.set) {
    const parts = opts.set.split(/\s+/);
    if (parts.length < 2) {
      console.error(chalk.red('Usage: --set "<TIER> <model>"'));
      process.exit(1);
    }
    const tier = parts[0].toUpperCase() as Tier;
    const model = parts.slice(1).join(' ');

    if (!TIER_ORDER.includes(tier)) {
      console.error(chalk.red(`Invalid tier: ${tier}. Must be one of: ${TIER_ORDER.join(', ')}`));
      process.exit(1);
    }

    const existing = store.getData().tierOverrides?.[tier] || DEFAULT_TIER_MODELS[tier];
    store.setTierOverride(tier, { primary: model, fallbacks: existing.fallbacks });
    await store.save();
    console.log(chalk.green(`Set ${tier} primary model to ${model}`));
    return;
  }

  // ── Display tier mappings ───────────────────────────────────────────────
  const storeData = store.getData();

  console.log('');
  console.log(chalk.bold.cyan('='.repeat(70)));
  console.log(chalk.bold.cyan('   Tier-to-Model Mappings'));
  console.log(chalk.bold.cyan('='.repeat(70)));
  console.log('');

  for (const tier of TIER_ORDER) {
    const defaultCfg = DEFAULT_TIER_MODELS[tier];
    const override = storeData.tierOverrides?.[tier];
    const effective = override || defaultCfg;

    const isOverridden = override !== undefined;

    console.log(
      `  ${tierColor(tier)(tier.padEnd(12))} ` +
        chalk.white(effective.primary) +
        (isOverridden ? chalk.yellow(' (overridden)') : chalk.dim(' (default)'))
    );

    if (effective.fallbacks.length > 0) {
      console.log(
        `  ${' '.repeat(12)} ${chalk.dim('fallbacks: ' + effective.fallbacks.join(', '))}`
      );
    }
  }

  console.log('');
  console.log(chalk.dim(`Store: ${ModelRoutingStore.filePath}`));
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
