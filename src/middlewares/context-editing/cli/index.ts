/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

import { Command } from 'commander';
import { ctxAuditCommand } from './audit.js';
import { ctxStatsCommand } from './stats.js';
import { ctxResetCommand } from './reset.js';
import { ctxConfigCommand } from './config.js';
import { ctxEntitiesCommand } from './entities.js';
import { ctxConflictsCommand } from './conflicts.js';
import { ctxPrioritiesCommand } from './priorities.js';
import { ctxPruningCommand } from './pruning.js';
import { ctxModelCommand } from './model.js';

export function registerContextEditingCommands(program: Command) {
  const ctxEdit = program
    .command('context-editing')
    .alias('ctx')
    .description('Manage the Context Editing middleware');

  ctxEdit
    .command('audit')
    .description('View compaction audit trail (ICC instructions, entities, conflicts)')
    .option('-n, --lines <number>', 'Number of recent compactions to show', '10')
    .option('-s, --session <key>', 'Filter by session key')
    .option('--full', 'Show full ICC instructions (not truncated)')
    .action(ctxAuditCommand);

  ctxEdit
    .command('stats')
    .description('View compaction statistics (cycles, token savings, entities preserved)')
    .action(ctxStatsCommand);

  ctxEdit
    .command('reset')
    .description('Reset compaction state and counters')
    .action(ctxResetCommand);

  ctxEdit
    .command('config')
    .description('View current context editing configuration')
    .option('--set-token <number>', 'Override token threshold limit')
    .option('--set-message <number>', 'Override message threshold limit')
    .option('--set-mode <mode>', 'Override trigger mode (token/message/both)')
    .option(
      '--set-messages-kept <number>',
      'How many user messages before the last compaction to preserve (0 = drop all)'
    )
    .option(
      '--set-custom-prompt <file>',
      'Enable custom ICC prompt: <file> = path to JSON {"instructions":"...","schema":"..."}'
    )
    .option(
      '--disable-custom-prompt',
      'Disable custom ICC prompt and revert to built-in extraction'
    )
    .action(ctxConfigCommand);

  ctxEdit
    .command('entities')
    .option('-s, --session <key>', 'Session key to inspect')
    .option('--history', 'View entities from all compactions (from audit log)')
    .option('-n, --lines <number>', 'Number of recent audit records to show when using --history')
    .description('View extracted entities from the last compaction')
    .action(ctxEntitiesCommand);

  ctxEdit
    .command('conflicts')
    .option('-s, --session <key>', 'Session key to inspect')
    .option('--history', 'View conflicts from all compactions (from audit log)')
    .option('-n, --lines <number>', 'Number of recent audit records to show when using --history')
    .description('View conflict resolutions resulting from compactions')
    .action(ctxConflictsCommand);

  ctxEdit
    .command('priorities')
    .option('-s, --session <key>', 'Session key to inspect')
    .option('--history', 'View priority preservations from all compactions (from audit log)')
    .option('-n, --lines <number>', 'Number of recent audit records to show when using --history')
    .description('View priority segments preserved during compactions')
    .action(ctxPrioritiesCommand);

  ctxEdit
    .command('pruning')
    .description('View or toggle session pruning in openclaw.json')
    .option('--enable', 'Enable session pruning')
    .option('--disable', 'Disable session pruning')
    .option('--mode <mode>', 'Pruning mode: cache-ttl | off')
    .option('--ttl <duration>', 'Cache TTL (e.g. 5m, 1h)')
    .action(ctxPruningCommand);

  ctxEdit
    .command('model')
    .description('View or set the compaction model in openclaw.json')
    .option('--set <model>', 'Set model (e.g. openrouter/anthropic/claude-sonnet-4-6)')
    .option('--reset', 'Reset to agent primary model')
    .action(ctxModelCommand);
}
