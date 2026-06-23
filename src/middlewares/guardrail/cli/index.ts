/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Guardrail — CLI registration.
 *
 * Call `registerGuardrailCommands(program)` from the suite's top-level CLI to
 * attach the `guardrail` subcommand group (plus egress/paths/destructive
 * sub-groups) and its children.
 */

import { Command } from 'commander';
import { guardrailStatusCommand } from './status.js';
import { guardrailToggleCommand } from './toggle.js';
import { guardrailListCommand } from './list.js';
import { guardrailRuleAddCommand } from './rule-add.js';
import { guardrailRuleRemoveCommand } from './rule-remove.js';
import { guardrailRuleToggleCommand } from './rule-toggle.js';
import { guardrailRuleActionCommand } from './rule-action.js';
import { guardrailResetCommand } from './reset.js';
import { guardrailConfigGetCommand } from './config-get.js';
import {
  egressStatusCommand,
  egressToggleCommand,
  egressAllowCommand,
  egressRemoveCommand,
  egressListCommand,
  egressDataSendingCommand,
  egressPrivateIpsCommand,
} from './egress.js';
import {
  pathsStatusCommand,
  pathsToggleCommand,
  pathsBlockCommand,
  pathsAllowCommand,
  pathsRemoveCommand,
  pathsListCommand,
} from './paths.js';
import {
  destructiveStatusCommand,
  destructiveToggleCommand,
  destructiveListCommand,
  destructiveAddCommand,
  destructiveRemoveCommand,
} from './destructive.js';
import { outputStatusCommand, outputToggleCommand } from './output.js';

export function registerGuardrailCommands(program: Command): void {
  const guardrail = program
    .command('guardrail')
    .description(
      'Manage the Input Guardrail middleware (prompt injection, PII, credential scanning)'
    );

  guardrail
    .command('status')
    .description('Display guardrail status, mode, and rule counts')
    .action(guardrailStatusCommand);

  guardrail
    .command('toggle <setting>')
    .description(
      'Toggle guardrail dry-run mode (enable/disable the middleware via the dashboard or `sai init`)'
    )
    .action(guardrailToggleCommand);

  guardrail
    .command('list [category]')
    .description('List rules by category (promptInjection, pii, suspicious, or all)')
    .action(guardrailListCommand);

  guardrail
    .command('rule-add <name> <category>')
    .description('Add or update a guardrail detection rule')
    .option('--type <type>', 'Rule type (regex, prefix, heuristic)', 'regex')
    .option('--pattern <pattern>', 'Regex or prefix pattern')
    .option('--severity <severity>', 'Severity (LOW, MEDIUM, HIGH, CRITICAL)', 'HIGH')
    .option('--action <action>', 'Action (BLOCK, WARN, LOG)', 'WARN')
    .option('--confidence <confidence>', 'Confidence level (high, medium)', 'high')
    .option('--description <description>', 'Human-readable explanation')
    .action(guardrailRuleAddCommand);

  guardrail
    .command('rule-rm <name>')
    .description('Remove a guardrail rule by name')
    .action(guardrailRuleRemoveCommand);

  guardrail
    .command('rule-toggle <name> [enabled]')
    .description('Enable or disable a rule (toggles if no value given)')
    .action((name: string, enabled?: string) => {
      const val = enabled === undefined ? undefined : enabled === 'true' || enabled === '1';
      return guardrailRuleToggleCommand(name, val);
    });

  guardrail
    .command('rule-action <name> <action>')
    .description("Change a rule's action (BLOCK, WARN, LOG)")
    .action(guardrailRuleActionCommand);

  guardrail
    .command('config')
    .description('Print guardrail config file path and full JSON')
    .action(guardrailConfigGetCommand);

  guardrail
    .command('reset')
    .description('Reset all guardrail rules to factory defaults')
    .action(guardrailResetCommand);

  // ── Egress control subcommands ──────────────────────────────────
  const egress = guardrail
    .command('egress')
    .description('Manage network egress control (domain allowlist, data exfiltration blocking)');

  egress
    .command('status')
    .description('Display egress control status and settings')
    .action(egressStatusCommand);
  egress
    .command('toggle')
    .description('Enable/disable network egress control')
    .action(egressToggleCommand);
  egress
    .command('allow <domain>')
    .description('Add a domain to the egress allowlist (e.g. *.github.com)')
    .action(egressAllowCommand);
  egress
    .command('remove <domain>')
    .description('Remove a domain from the egress allowlist')
    .action(egressRemoveCommand);
  egress.command('list').description('List all allowed domains').action(egressListCommand);
  egress
    .command('data-sending <on|off>')
    .description('Toggle blocking of data-sending commands (curl -d, wget --post, etc.)')
    .action(egressDataSendingCommand);
  egress
    .command('private-ips <on|off>')
    .description('Toggle blocking of private/internal IP connections')
    .action(egressPrivateIpsCommand);

  // ── Sensitive paths subcommands ─────────────────────────────────
  const paths = guardrail
    .command('paths')
    .description('Manage sensitive path blocklist (.ssh, .env, credentials, etc.)');

  paths
    .command('status')
    .description('Display sensitive path blocklist status')
    .action(pathsStatusCommand);
  paths
    .command('toggle')
    .description('Enable/disable sensitive path blocking')
    .action(pathsToggleCommand);
  paths
    .command('block <pattern>')
    .description('Add a glob pattern to the path blocklist (e.g. **/.secret/*)')
    .action(pathsBlockCommand);
  paths
    .command('allow <pattern>')
    .description('Add a glob pattern to the allowlist (overrides blocklist)')
    .action(pathsAllowCommand);
  paths
    .command('remove <pattern>')
    .description('Remove a pattern from blocklist or allowlist')
    .action(pathsRemoveCommand);
  paths
    .command('list')
    .description('List all blocked and allowed path patterns')
    .action(pathsListCommand);

  // ── Destructive command subcommands ─────────────────────────────
  const destructive = guardrail
    .command('destructive')
    .description('Manage destructive command blocker (rm -rf, DROP TABLE, etc.)');

  destructive
    .command('status')
    .description('Display destructive command blocker status')
    .action(destructiveStatusCommand);
  destructive
    .command('toggle')
    .description('Enable/disable destructive command blocking')
    .action(destructiveToggleCommand);
  destructive
    .command('list')
    .description('List all built-in and custom destructive patterns')
    .action(destructiveListCommand);
  destructive
    .command('add <pattern>')
    .description('Add a custom destructive command regex pattern')
    .action(destructiveAddCommand);
  destructive
    .command('remove <pattern>')
    .description('Remove a custom destructive command pattern')
    .action(destructiveRemoveCommand);

  // ── Output scrubber subcommands ────────────────────────────────
  const output = guardrail
    .command('output')
    .description('Manage output scrubber (assistant response metadata filtering)');

  output
    .command('status')
    .description('Display output scrubber status and pattern info')
    .action(outputStatusCommand);
  output
    .command('toggle <state>')
    .description('Enable, disable, or set dry-run mode for output scrubbing')
    .action(outputToggleCommand);
}
