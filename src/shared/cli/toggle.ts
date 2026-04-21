/**
 * Sapience Middleware Enable/Disable Commands
 */

import chalk from 'chalk';
import { loadOpenClawConfig, saveOpenClawConfig } from '../../plugin/config-manager.js';
import { cleanupMiddleware } from '../storage/cleanup.js';
import { logger } from '../Logger.js';

export async function disableCommand(): Promise<void> {
  try {
    const config = await loadOpenClawConfig();

    if (!config?.plugins?.entries?.['sapience-ai-suite']) {
      console.log(chalk.yellow('Sapience AI Suite is not registered in OpenClaw. Run: sai init'));
      process.exit(0);
    }

    // Clean model-routing entries from openclaw.json so stale provider /
    // allowlist config does not remain after the plugin is disabled.
    try {
      await cleanupMiddleware('model-routing');
    } catch (err) {
      logger.debug('model-routing cleanup during disable failed (non-fatal)', { error: err });
    }

    config.plugins.entries['sapience-ai-suite'].enabled = false;
    await saveOpenClawConfig(config);

    console.log(chalk.green('Sapience Middleware disabled'));
  } catch (error) {
    console.error(chalk.red('Failed to disable Sapience Middleware:'), error);
    logger.error('Disable command failed', { error });
    process.exit(1);
  }
}

export async function enableCommand(): Promise<void> {
  try {
    const config = await loadOpenClawConfig();

    if (!config?.plugins?.entries?.['sapience-ai-suite']) {
      console.log(chalk.yellow('Sapience AI Suite is not registered in OpenClaw. Run: sai init'));
      process.exit(0);
    }

    config.plugins.entries['sapience-ai-suite'].enabled = true;
    await saveOpenClawConfig(config);

    console.log(chalk.green('Sapience Middleware enabled'));
  } catch (error) {
    console.error(chalk.red('Failed to enable Sapience Middleware:'), error);
    logger.error('Enable command failed', { error });
    process.exit(1);
  }
}
