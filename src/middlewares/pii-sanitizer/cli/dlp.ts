/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

import chalk from 'chalk';
import { DlpStore } from '../storage/DlpStore.js';
import { DlpRule, FieldPolicy, ScannerAction, SeverityLevel } from '../types.js';

export const dlpInfoCommand = async () => {
  const policy = await DlpStore.load();

  console.log('');
  console.log(chalk.bold.cyan('🛡️ PII Sanitizer (DLP Engine) Status'));
  console.log(chalk.gray('═'.repeat(60)));
  console.log(
    chalk.bold('Mode: '),
    policy.dryRunMode
      ? chalk.yellow('DRY RUN (Monitoring Only)')
      : chalk.green('ACTIVE (Intercepting)')
  );
  console.log(chalk.gray('Enable / disable the middleware via the dashboard or `sai init`.'));
  console.log('');

  console.log(chalk.bold.cyan('📋 Active Global Rules'));
  console.log(chalk.gray('─'.repeat(40)));
  if (policy.globalRules.length === 0) {
    console.log(chalk.gray('No rules configured.'));
  } else {
    policy.globalRules.forEach((r) => {
      const status = r.enabled ? chalk.green('ON') : chalk.red('OFF');
      const severityColor =
        r.severity === 'CRITICAL'
          ? chalk.bgRed.white
          : r.severity === 'HIGH'
            ? chalk.red
            : chalk.yellow;
      const actionColor =
        r.action === 'BLOCK' ? chalk.red : r.action === 'ESCALATE' ? chalk.yellow : chalk.cyan;

      console.log(`${chalk.bold(r.name)} [${status}] (${chalk.gray(r.type)})`);
      if (r.description) console.log(`  └─ ${chalk.italic.white(r.description)}`);
      console.log(`  └─ Severity: ${severityColor(r.severity)} | Action: ${actionColor(r.action)}`);
      if (r.pattern) console.log(`  └─ Pattern:  ${chalk.gray(r.pattern)}`);
    });
  }

  console.log('');
  console.log(chalk.bold.cyan('🔧 Tool Configurations'));
  console.log(chalk.gray('─'.repeat(40)));
  for (const [moduleName, methods] of Object.entries(policy.toolPolicies || {})) {
    console.log(chalk.bold.white(moduleName));
    for (const [methodName, config] of Object.entries(methods)) {
      console.log(
        `  └─ ${chalk.cyan(methodName)} (Fields: ${Object.keys(config.fields).join(', ')})`
      );
    }
  }
  console.log('');
};

export const dlpToggleCommand = async (setting: string) => {
  const policy = await DlpStore.load();
  console.log('');
  if (setting === 'dry-run') {
    policy.dryRunMode = !policy.dryRunMode;
    const status = policy.dryRunMode
      ? chalk.yellow('MONITORING ONLY')
      : chalk.green('INTERCEPTING');
    console.log(chalk.bgBlue.black.bold(' 🔍 MODE TOGGLED ') + ` DLP is now in ${status} mode.`);
  } else if (setting === 'enable' || setting === 'disable') {
    console.log(
      chalk.yellow.bold('! ') +
        `PII Sanitizer is turned on/off via the dashboard or 'sai init' ` +
        `(not from this command). Use 'sai ${setting}' only if you want to ${setting} the whole Sapience AI Suite.`
    );
    return;
  } else {
    console.log(chalk.red.bold('! ERROR: ') + `Unknown setting "${setting}". Use: dry-run.`);
    return;
  }
  await DlpStore.save(policy);
  console.log('');
};

export const dlpRuleAddCommand = async (name: string, options: any) => {
  const policy = await DlpStore.load();
  const rule: DlpRule = {
    name,
    type: options.type || 'regex',
    pattern: options.pattern || '',
    severity: (options.severity?.toUpperCase() as SeverityLevel) || 'HIGH',
    action: (options.action?.toUpperCase() as ScannerAction) || 'REDACT',
    enabled: true,
    description: options.description,
  };

  const existingIndex = policy.globalRules.findIndex((r) => r.name === name);
  const isUpdate = existingIndex >= 0;

  if (isUpdate) {
    policy.globalRules[existingIndex] = rule;
  } else {
    policy.globalRules.push(rule);
  }

  await DlpStore.save(policy);

  const title = isUpdate ? '✓ RULE UPDATED' : '✓ RULE ADDED';
  const color = isUpdate ? chalk.yellow : chalk.green;

  console.log('');
  console.log(color.bold(` ${title} `) + chalk.white(` — ${name}`));
  console.log(chalk.gray('  ' + '─'.repeat(40)));
  console.log(`  ${chalk.bold('Type:')}     ${chalk.gray(rule.type)}`);
  console.log(`  ${chalk.bold('Pattern:')}  ${chalk.cyan(rule.pattern)}`);
  console.log(
    `  ${chalk.bold('Severity:')} ${rule.severity === 'CRITICAL' ? chalk.bgRed.white.bold(` ${rule.severity} `) : chalk.red(rule.severity)}`
  );
  console.log(`  ${chalk.bold('Action:')}   ${chalk.bold.blue(rule.action)}`);
  if (rule.description)
    console.log(`  ${chalk.bold('Purpose:')}   ${chalk.gray(rule.description)}`);
  console.log(chalk.gray('  ' + '─'.repeat(40)));
  console.log(chalk.gray('  DLP engine reloaded and active.'));
  console.log('');
};

export const dlpRuleRmCommand = async (name: string) => {
  const policy = await DlpStore.load();
  const initial = policy.globalRules.length;
  policy.globalRules = policy.globalRules.filter((r) => r.name !== name);

  console.log('');
  if (policy.globalRules.length < initial) {
    console.log(
      chalk.bgRed.black.bold(' 🗑️ RULE REMOVED ') + chalk.white(` Deleted rule: ${name}`)
    );
    await DlpStore.save(policy);
  } else {
    console.log(
      chalk.bgYellow.black.bold(' ! NOT FOUND ') +
        chalk.yellow(` No rule exists with name: ${name}`)
    );
  }
  console.log('');
};

export const dlpPolicySetCommand = async (moduleMethod: string, field: string, action: string) => {
  const policy = await DlpStore.load();
  const parts = moduleMethod.split('.');
  if (parts.length !== 2) {
    console.log(
      chalk.red.bold('! ERROR: ') + 'Expected format: Module.method (e.g. Network.fetch)'
    );
    return;
  }
  const [mod, met] = parts;
  const validActions = ['SCALABLE', 'VALIDATE', 'IGNORE'];
  if (!validActions.includes(action.toUpperCase())) {
    console.log(
      chalk.red.bold('! ERROR: ') +
        `Invalid policy action "${action}". Allowed: ${validActions.join(', ')}`
    );
    return;
  }

  if (!policy.toolPolicies) policy.toolPolicies = {};
  if (!policy.toolPolicies[mod]) policy.toolPolicies[mod] = {};
  if (!policy.toolPolicies[mod][met]) policy.toolPolicies[mod][met] = { fields: {} };

  policy.toolPolicies[mod][met].fields[field] = action.toUpperCase() as FieldPolicy;
  await DlpStore.save(policy);

  console.log('');
  console.log(chalk.bgGreen.black.bold(' ✓ POLICY CONFIGURED '));
  console.log(`  Target: ${chalk.bold.white(mod)}.${chalk.cyan(met)}`);
  console.log(`  Field:  ${chalk.bold.yellow(field)}`);
  console.log(`  Action: ${chalk.bold.green(action.toUpperCase())}`);
  console.log('');
};
