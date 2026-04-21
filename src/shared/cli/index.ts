import { Command } from 'commander';
import { disableCommand, enableCommand } from './toggle.js';
import { runInitCommand } from './init.js';

export function registerGeneralCommands(program: Command) {
  // Disable Sapience AI Suite
  program
    .command('disable')
    .description('Temporarily disable Sapience AI Suite')
    .action(disableCommand);

  // Enable Sapience AI Suite
  program.command('enable').description('Re-enable Sapience AI Suite').action(enableCommand);

  // Initialize/configure Sapience AI Suite with OpenClaw
  program
    .command('init')
    .alias('configure')
    .description('Setup Sapience AI Suite with OpenClaw (interactive wizard)')
    .option('--non-interactive', 'Run without prompts using defaults/flags')
    .option('--json', 'Output machine-readable JSON only')
    .option('--security-level <level>', 'Security preset: permissive|balanced|strict|custom')
    .option(
      '--modules <modules>',
      'Comma-separated module list (required for custom in non-interactive mode)'
    )
    .option('--middleware <name>', 'Target middleware to configure (skips the selection prompt)')
    .action(runInitCommand);
}
