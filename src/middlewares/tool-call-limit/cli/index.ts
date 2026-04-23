/**
 * Tool Call Limit — CLI registration.
 *
 * Call `registerToolCallLimitCommands(program)` from the suite's top-level CLI
 * to attach the `limits` subcommand group. This mounts `configure` and `stats`
 * as children.
 *
 * The top-level `sai stats` and `sai budgets` commands are wired separately in
 * the suite's entry point so they can compose with other middlewares.
 */

import { Command } from 'commander';
import { configureLimitsCommand } from './configure.js';
import { statsCommand as limitStatsCommand } from './stats.js';
import { setLimitCommand } from './set.js';
import { setGlobalLimitCommand } from './set-global.js';
import { unsetLimitCommand } from './unset.js';
import { showLimitCommand } from './show.js';
import { resetLimitCommand } from './reset.js';

export function registerToolCallLimitCommands(program: Command): void {
  const limits = program
    .command('limits')
    .alias('tool-call-limit')
    .description('Manage Tool Call Limits (per-session and per-request budgets)');

  limits
    .command('configure')
    .description('Interactive wizard to configure tool call limits')
    .action(configureLimitsCommand);

  limits
    .command('stats')
    .description('View tool call limit usage statistics')
    .option('-s, --session <id>', 'View call limits for a specific session')
    .option(
      '-q, --request-id <id>',
      'View call limits for a specific request ID (use "last" for most recent)'
    )
    .option('-r, --reset', 'Reset all tool counts for the session')
    .option('--json', 'Output machine-readable JSON only')
    .action(limitStatsCommand);

  limits
    .command('set <tool>')
    .description(
      'Set per-tool budget non-interactively (e.g. sai limits set FileSystem.write --request 10)'
    )
    .option('-s, --session <n>', 'Session-scope max (0 = unlimited)')
    .option('-q, --request <n>', 'Request-scope max (0 = unlimited)')
    .option('--force', 'Allow adding a rule for a tool not in the known registry')
    .option('--json', 'Output machine-readable JSON')
    .action(setLimitCommand);

  limits
    .command('set-global')
    .description('Set global session/request ceilings non-interactively')
    .option('-s, --session <n>', 'Global session ceiling (0 = unlimited)')
    .option('-q, --request <n>', 'Global request ceiling (0 = unlimited)')
    .option('--json', 'Output machine-readable JSON')
    .action(setGlobalLimitCommand);

  limits
    .command('unset <tool>')
    .description('Remove a per-tool rule; the global ceiling will apply')
    .option('--json', 'Output machine-readable JSON')
    .action(unsetLimitCommand);

  limits
    .command('reset')
    .description(
      'Reset tool call limit trackers (clears on-disk files and in-memory counters on the running gateway)'
    )
    .option('-s, --session', 'Reset only session-scope counters')
    .option('-q, --request', 'Reset only request-scope counters')
    .option('--json', 'Output machine-readable JSON')
    .action(resetLimitCommand);

  limits
    .command('show [tool]')
    .description('Print the current policy (all or a single <Module>.<method>)')
    .option('--json', 'Output machine-readable JSON')
    .action(showLimitCommand);
}

// Re-export the stats command so the top-level `sai stats` wiring can still
// call it without reaching into the cli/stats module directly.
export { statsCommand as toolCallLimitStatsCommand } from './stats.js';
