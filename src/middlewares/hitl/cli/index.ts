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
