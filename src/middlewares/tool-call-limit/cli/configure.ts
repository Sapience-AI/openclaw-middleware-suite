/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Tool Call Limit Configuration Command
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { LimitPolicyStore } from '../storage/LimitPolicyStore.js';
import { LimitPolicy } from '../types.js';
import { logger } from '../../../shared/Logger.js';

export async function configureLimitsCommand(): Promise<void> {
  console.log('');
  console.log(chalk.bold.blue('═'.repeat(80)));
  console.log(chalk.bold.blue('   🛡️ Tool Call Budget Manager'));
  console.log(chalk.bold.blue('═'.repeat(80)));
  console.log('');

  try {
    const policy = await LimitPolicyStore.load();

    // Display current limits
    const globalSession = policy.globalSessionCallLimit ?? 'Unlimited';
    const globalRequest = policy.globalRequestCallLimit ?? 'Unlimited';

    console.log(chalk.bold('Global Configuration:'));
    console.log(chalk.dim(`  Global Session Limit:  ${globalSession}`));
    console.log(chalk.dim(`  Global Request Limit:  ${globalRequest}`));
    console.log('');

    console.log(chalk.bold('Per-Tool Budgets:'));
    const rules = Object.entries(policy.modules || {});
    if (rules.length === 0) {
      console.log(chalk.dim('  (No custom tool limits configured)'));
    } else {
      rules.forEach(([moduleName, methods]) => {
        console.log(chalk.cyan(`  ${moduleName}:`));
        Object.entries(methods).forEach(([methodName, rule]) => {
          const sLimit = rule.sessionCallLimit?.max ?? '∞';
          const rLimit = rule.requestCallLimit?.max ?? '∞';
          console.log(`    ${methodName.padEnd(14)}: (S:${sLimit}, R:${rLimit})`);
        });
      });
    }
    console.log('');

    // Action menu
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Budget Management:',
        choices: [
          { name: 'Modify global thresholds', value: 'modify_global' },
          { name: 'Modify/Add a tool limit', value: 'modify_tool' },
          { name: 'Reset all budgets', value: 'reset' },
          { name: 'Exit', value: 'exit' },
        ],
      },
    ]);

    switch (action) {
      case 'modify_global':
        await modifyGlobalThresholds(policy);
        break;
      case 'modify_tool':
        await modifyToolLimit(policy);
        break;
      case 'reset':
        await resetLimits();
        break;
      case 'exit':
        break;
    }
  } catch (error) {
    console.error(chalk.red('❌ Failed to manage budgets:'), error);
    logger.error('Limit configuration failed', { error });
  }
}

async function modifyGlobalThresholds(policy: LimitPolicy): Promise<void> {
  const { newGlobalLimit, newGlobalReqLimit } = await inquirer.prompt([
    {
      type: 'input',
      name: 'newGlobalLimit',
      message: 'Global session call limit (0 for unlimited):',
      default: policy.globalSessionCallLimit?.toString() || '100',
      validate: (v) =>
        !isNaN(parseInt(v)) && parseInt(v) >= 0 ? true : 'Please enter a non-negative number',
    },
    {
      type: 'input',
      name: 'newGlobalReqLimit',
      message: 'Global request call limit (0 for unlimited):',
      default: policy.globalRequestCallLimit?.toString() || '10',
      validate: (v) =>
        !isNaN(parseInt(v)) && parseInt(v) >= 0 ? true : 'Please enter a non-negative number',
    },
  ]);

  policy.globalSessionCallLimit = parseInt(newGlobalLimit, 10);
  policy.globalRequestCallLimit = parseInt(newGlobalReqLimit, 10);

  await LimitPolicyStore.save(policy);
  console.log(chalk.green('✅ Global budgets updated.'));
}

async function modifyToolLimit(policy: LimitPolicy): Promise<void> {
  const { moduleName, methodName } = await inquirer.prompt([
    {
      type: 'input',
      name: 'moduleName',
      message: 'Module name (e.g. FileSystem):',
      validate: (v) => (v.trim() ? true : 'Required'),
    },
    {
      type: 'input',
      name: 'methodName',
      message: 'Method name (e.g. write, or * for all):',
      validate: (v) => (v.trim() ? true : 'Required'),
    },
  ]);

  const currentRule = (policy.modules[moduleName] && policy.modules[moduleName][methodName]) || {};

  const { newSMax, newRMax } = await inquirer.prompt([
    {
      type: 'input',
      name: 'newSMax',
      message: 'Session limit (max calls, 0 for unlimited):',
      default: currentRule.sessionCallLimit?.max?.toString() || '0',
      validate: (v) =>
        !isNaN(parseInt(v)) && parseInt(v) >= 0 ? true : 'Please enter a non-negative number',
    },
    {
      type: 'input',
      name: 'newRMax',
      message: 'Request limit (max calls, 0 for unlimited):',
      default: currentRule.requestCallLimit?.max?.toString() || '0',
      validate: (v) =>
        !isNaN(parseInt(v)) && parseInt(v) >= 0 ? true : 'Please enter a non-negative number',
    },
  ]);

  if (!policy.modules[moduleName]) policy.modules[moduleName] = {};

  const sMax = parseInt(newSMax, 10);
  const rMax = parseInt(newRMax, 10);

  policy.modules[moduleName][methodName] = {
    sessionCallLimit: sMax > 0 ? { max: sMax } : undefined,
    requestCallLimit: rMax > 0 ? { max: rMax } : undefined,
  };

  await LimitPolicyStore.save(policy);
  console.log(chalk.green(`✅ Budget updated for ${moduleName}.${methodName}`));
}

async function resetLimits(): Promise<void> {
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: chalk.red('Reset all tool call budgets to default?'),
      default: false,
    },
  ]);

  if (confirm) {
    await LimitPolicyStore.reset();
    console.log(chalk.green('✅ Budgets reset to factory defaults.'));
  }
}
