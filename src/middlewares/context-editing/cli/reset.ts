/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

import chalk from 'chalk';
import { logger } from '../../../shared/Logger.js';
import { loadStore } from './utils.js';

export async function ctxResetCommand(): Promise<void> {
  console.log('');
  console.log(chalk.bold.yellow('⚠️  Reset Context Editing State'));
  console.log('');

  try {
    // Dynamic import to avoid bundling inquirer in non-interactive paths
    const inquirer = await import('inquirer');

    const { confirm } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: chalk.red(
          'Are you sure you want to reset all context editing statistics and state?'
        ),
        default: false,
      },
    ]);

    if (confirm) {
      const store = loadStore();
      store.reset();
      console.log(chalk.green('✅ Context editing state reset successfully'));
      console.log('');
    } else {
      console.log(chalk.dim('Reset cancelled'));
      console.log('');
    }
  } catch (error) {
    console.error(chalk.red('❌ Failed to reset context editing state:'), error);
    logger.error('ctx reset command failed', { error });
    process.exit(1);
  }
}
