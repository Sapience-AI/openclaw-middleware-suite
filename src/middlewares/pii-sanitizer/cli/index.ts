/**
 * PII Sanitizer (DLP) — CLI registration.
 *
 * Call `registerPiiSanitizerCommands(program)` from the suite's top-level CLI
 * to attach the `dlp` subcommand group and its children.
 */

import { Command } from 'commander';
import {
  dlpInfoCommand,
  dlpToggleCommand,
  dlpRuleAddCommand,
  dlpRuleRmCommand,
  dlpPolicySetCommand,
} from './dlp.js';

export function registerPiiSanitizerCommands(program: Command): void {
  const dlp = program
    .command('dlp')
    .description('Manage the Data Loss Prevention (DLP) / PII Sanitizer middleware');

  dlp
    .command('info')
    .description('Display DLP status, toggles, global rules, and active tool mappings')
    .action(dlpInfoCommand);

  dlp
    .command('toggle <setting>')
    .description('Toggle DLP settings (enable, disable, dry-run)')
    .action(dlpToggleCommand);

  dlp
    .command('rule-add <name>')
    .description('Add or update a PII scanning rule')
    .option('--type <type>', 'Rule type (regex, prefix, heuristic)', 'regex')
    .option('--pattern <pattern>', 'Regex or prefix pattern')
    .option('--severity <severity>', 'Severity (low, medium, high, critical)', 'high')
    .option('--action <action>', 'Action (allow, redact, escalate, block)', 'redact')
    .option('--description <description>', 'Human-readable explanation of rule purpose')
    .action(dlpRuleAddCommand);

  dlp
    .command('rule-rm <name>')
    .description('Remove a PII scanning rule by name')
    .action(dlpRuleRmCommand);

  dlp
    .command('policy-set <tool> <field> <action>')
    .description('Set scanning policy for a tool field (e.g. Network.fetch body SCALABLE)')
    .action(dlpPolicySetCommand);
}
