/*
 * Copyright (c) 2026 BlockRun
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * This file is derived from the ClawRouter project
 * (https://github.com/BlockRunAI/ClawRouter) and has been modified for use
 * in the OpenClaw Middleware Suite.
 *
 * Used under the MIT License — see NOTICE for the full license text.
 */

/**
 * CLI: sai router exclude — Manage model exclusion list.
 *
 * Ported from ClawRouter's exclude-models.ts CLI integration.
 */

import chalk from 'chalk';
import { ModelRoutingDiscovery } from '../storage/ModelRoutingDiscovery.js';
import { ModelRoutingPolicyStore } from '../storage/ModelRoutingPolicyStore.js';

export async function routerExcludeCommand(opts: {
  add?: string;
  remove?: string;
  list?: boolean;
  clear?: boolean;
}): Promise<void> {
  const store = new ModelRoutingDiscovery();
  store.load();

  if (opts.add) {
    const current = store.getExclusions();
    const exclusions = current.includes(opts.add) ? current : [...current, opts.add];
    await ModelRoutingPolicyStore.update({ exclusions });
    console.log(chalk.green(`Added "${opts.add}" to exclusion list`));
    printList(exclusions);
    return;
  }

  if (opts.remove) {
    const exclusions = store.getExclusions().filter((m) => m !== opts.remove);
    await ModelRoutingPolicyStore.update({ exclusions });
    console.log(chalk.yellow(`Removed "${opts.remove}" from exclusion list`));
    printList(exclusions);
    return;
  }

  if (opts.clear) {
    await ModelRoutingPolicyStore.update({ exclusions: [] });
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
