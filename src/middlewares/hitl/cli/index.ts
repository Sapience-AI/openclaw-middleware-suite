/*
 * Copyright (c) Kevin Wu and Pegasi contributors
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * This file is derived from the Reins project (https://github.com/pegasi-ai/reins)
 * and has been modified for use in the OpenClaw Middleware Suite.
 */

import { Command } from 'commander';
import { policyCommand } from './policy.js';
import { statsCommand } from './stats.js';
import { auditCommand } from './audit.js';
import { resetCommand } from './reset.js';

export function registerHitlCommands(program: Command) {
  const hitl = program
    .command('hitl')
    .description('Manage the Human-in-the-Loop (HITL) middleware');

  hitl.command('policy').description('Manage HITL security policies').action(policyCommand);

  hitl.command('stats').description('View HITL decision statistics').action(statsCommand);

  hitl
    .command('audit')
    .description('View HITL decision audit trail')
    .option('-n, --lines <number>', 'Number of recent decisions to show', '50')
    .action(auditCommand);

  hitl.command('reset').description('Reset HITL statistics').action(resetCommand);
}
