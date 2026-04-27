/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: sai router test "<prompt>" — Dry-run scoring on a prompt.
 */

import chalk from 'chalk';
import { scoreRequest } from '../scoring/scorer.js';
import { DEFAULT_SCORING_CONFIG } from '../config.js';
import { ModelRoutingDiscovery } from '../storage/ModelRoutingDiscovery.js';
import { Tier } from '../types.js';

export async function routerTestCommand(prompt: string): Promise<void> {
  if (!prompt || prompt.trim().length === 0) {
    console.error(chalk.red('Usage: sai router test "<your prompt>"'));
    process.exit(1);
  }

  // Load store overrides for weights/boundaries
  const store = new ModelRoutingDiscovery();
  store.load();
  const storeData = store.getData();

  // Build scoring config with any overrides
  const config = { ...DEFAULT_SCORING_CONFIG };
  if (storeData.weightOverrides) {
    for (const dim of config.dimensions) {
      if (dim.name in storeData.weightOverrides) {
        dim.weight = storeData.weightOverrides[dim.name];
      }
    }
  }
  if (storeData.boundaryOverrides) {
    Object.assign(config.boundaries, storeData.boundaryOverrides);
  }

  // Score
  const body = {
    messages: [{ role: 'user', content: prompt }],
  };

  const start = performance.now();
  const result = scoreRequest({ body }, config);
  const elapsed = (performance.now() - start).toFixed(2);

  // Display
  console.log('');
  console.log(chalk.bold.cyan('='.repeat(70)));
  console.log(chalk.bold.cyan('   Scoring Dry Run'));
  console.log(chalk.bold.cyan('='.repeat(70)));
  console.log('');

  console.log(
    `  ${chalk.bold('Prompt:')}      ${chalk.white(prompt.slice(0, 80))}${prompt.length > 80 ? '...' : ''}`
  );
  console.log(`  ${chalk.bold('Tier:')}        ${tierColor(result.tier)(result.tier)}`);
  console.log(`  ${chalk.bold('Score:')}       ${chalk.white(result.score.toFixed(4))}`);
  console.log(`  ${chalk.bold('Confidence:')}  ${chalk.white(result.confidence.toFixed(3))}`);
  console.log(`  ${chalk.bold('Reason:')}      ${chalk.dim(result.reason)}`);
  console.log(`  ${chalk.bold('Latency:')}     ${chalk.dim(elapsed + 'ms')}`);
  console.log('');

  // Dimension breakdown
  if (result.dimensions.length > 0) {
    console.log(chalk.bold('Dimension Breakdown:'));
    console.log('');
    console.log(
      chalk.dim(
        '  ' +
          'Dimension'.padEnd(24) +
          'Score'.padEnd(10) +
          'Weight'.padEnd(10) +
          'Weighted'.padEnd(10) +
          'Signal'
      )
    );
    console.log(chalk.dim('  ' + '-'.repeat(65)));

    // Sort by absolute weighted contribution (most impactful first)
    const sorted = [...result.dimensions].sort(
      (a, b) => Math.abs(b.weighted) - Math.abs(a.weighted)
    );

    for (const dim of sorted) {
      if (dim.score === 0 && !dim.signal) continue; // Skip zero-impact dims

      const scoreStr =
        dim.score >= 0 ? chalk.green('+' + dim.score.toFixed(2)) : chalk.red(dim.score.toFixed(2));

      console.log(
        '  ' +
          chalk.white(dim.name.padEnd(24)) +
          scoreStr.padEnd(10 + 10) + // chalk adds invisible chars, pad extra
          chalk.dim(dim.weight.toFixed(3).padEnd(10)) +
          chalk.white(dim.weighted.toFixed(4).padEnd(10)) +
          chalk.dim(dim.signal || '')
      );
    }
    console.log('');
  }
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
