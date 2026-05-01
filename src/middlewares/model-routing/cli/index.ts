/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Model Routing CLI — Command registration.
 */

import { Command } from 'commander';
import { routerStatsCommand } from './stats.js';
import { routerConfigCommand } from './config.js';
import { routerTiersCommand } from './tiers.js';
import { routerTestCommand } from './test.js';
import { routerResetCommand } from './reset.js';
import { routerExcludeCommand } from './exclude.js';
import { routerModelsCommand } from './models.js';

export function registerModelRoutingCommands(program: Command): void {
  const router = program.command('router').description('Manage the Model Routing middleware');

  router
    .command('stats')
    .description('View routing statistics and tier distribution')
    .option('-n, --lines <number>', 'Number of recent decisions to show', '10')
    .action(routerStatsCommand);

  router
    .command('config')
    .description('View or edit scoring configuration')
    .option('--set-weight <value>', 'Set dimension weight: "dimensionName 0.05"')
    .option('--set-boundary <value>', 'Set tier boundary: "simpleStandard -0.1"')
    .option(
      '--set-override <value>',
      'Set override threshold: "shortMessageChars 100" (also: largeContextTokens, reasoningKeywordMin, structuredOutputMinTier)'
    )
    .option('--enable-pinning', 'Turn session pinning on (default)')
    .option('--disable-pinning', 'Turn session pinning off — also disables provider prompt caching')
    .option('--enable-cache', 'Turn provider prompt caching on (requires pinning)')
    .option('--disable-cache', 'Turn provider prompt caching off')
    .action(routerConfigCommand);

  router
    .command('tiers')
    .description('View or edit per-profile tier-to-model mappings')
    .option('--profile <p>', 'Scope to a profile: eco|premium|agentic')
    .option(
      '--set <value>',
      'Set tier primary model: "COMPLEX claude-sonnet-4-6" (requires --profile)'
    )
    .action(routerTiersCommand);

  router
    .command('test <prompt>')
    .description('Dry-run scoring on a prompt (no API call)')
    .action(routerTestCommand);

  router
    .command('reset')
    .description('Reset routing stats and/or config overrides')
    .option('--stats', 'Reset only the audit log')
    .option('--config', 'Reset only config overrides')
    .option('--all', 'Reset everything (default)')
    .action(routerResetCommand);

  // Phase 2: Model exclusion
  router
    .command('exclude')
    .description('Manage model exclusion list')
    .option('--add <model>', 'Add model to exclusion list (supports globs: gpt-4*)')
    .option('--remove <model>', 'Remove model from exclusion list')
    .option('--list', 'List excluded models')
    .option('--clear', 'Clear all exclusions')
    .action(routerExcludeCommand);

  // Phase 3: Model discovery
  router
    .command('models')
    .description('View discovered models and auto-assignments')
    .option('--refresh', 'Re-discover models from all configured providers')
    .action(routerModelsCommand);
}
