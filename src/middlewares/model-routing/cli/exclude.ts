/**
 * CLI: sai router exclude — Manage model exclusion list.
 *
 * Ported from ClawRouter's exclude-models.ts CLI integration.
 */

import chalk from 'chalk';
import { ModelRoutingStore } from '../storage/ModelRoutingStore.js';

export async function routerExcludeCommand(opts: {
  add?: string;
  remove?: string;
  list?: boolean;
  clear?: boolean;
}): Promise<void> {
  const store = new ModelRoutingStore();
  store.load();

  if (opts.add) {
    store.addExclusion(opts.add);
    await store.save();
    console.log(chalk.green(`Added "${opts.add}" to exclusion list`));
    printList(store.getExclusions());
    return;
  }

  if (opts.remove) {
    store.removeExclusion(opts.remove);
    await store.save();
    console.log(chalk.yellow(`Removed "${opts.remove}" from exclusion list`));
    printList(store.getExclusions());
    return;
  }

  if (opts.clear) {
    const data = store.getData() as Record<string, unknown>;
    data.exclusions = [];
    await store.save();
    console.log(chalk.yellow('Exclusion list cleared'));
    return;
  }

  // Default: list
  const exclusions = store.getExclusions();
  if (exclusions.length === 0) {
    console.log(chalk.dim('No models excluded. Use --add <model> to exclude a model.'));
    console.log(chalk.dim('Supports exact IDs (gpt-4o-mini) and prefix globs (gpt-4*)'));
    return;
  }

  printList(exclusions);
}

function printList(exclusions: string[]): void {
  console.log('');
  console.log(chalk.bold('Excluded Models:'));
  for (const model of exclusions) {
    console.log(`  ${chalk.red('✕')} ${model}`);
  }
  console.log('');
  console.log(chalk.dim(`${exclusions.length} model(s) excluded`));
  console.log(
    chalk.dim(
      'Safety: if all models in a tier are excluded, the exclusion list is ignored for that tier.'
    )
  );
}
