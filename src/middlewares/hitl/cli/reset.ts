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

/**
 * Sapience Middleware Reset Command
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { StatsTracker } from '../storage/StatsTracker.js';
import { logger } from '../../../shared/Logger.js';

export async function resetCommand(): Promise<void> {
  console.log('');
  console.log(chalk.bold.yellow('⚠️  Reset Statistics'));
  console.log('');

  try {
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: chalk.red('Are you sure you want to reset all statistics?'),
        default: false,
      },
    ]);

    if (confirm) {
      await StatsTracker.reset();
      console.log(chalk.green('✅ Statistics reset successfully'));
      console.log('');
    } else {
      console.log(chalk.dim('Reset cancelled'));
      console.log('');
    }
  } catch (error) {
    console.error(chalk.red('❌ Failed to reset statistics:'), error);
    logger.error('Reset command failed', { error });
    process.exit(1);
  }
}
