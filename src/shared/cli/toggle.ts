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
 * Sapience AI Suite — plugin-level enable/disable commands.
 *
 * These commands operate on the plugin-entry flag in openclaw.json — they
 * turn the whole suite on or off at the OpenClaw host level. Individual
 * middleware toggles live elsewhere (dashboard + `sai init`) and are never
 * touched by `sai enable`.
 *
 * `sai disable` is a full reset: every middleware's files/dirs/store keys
 * are wiped, sapience-ai-suite.json is emptied (including the per-middleware
 * enabled map), and openclaw.json is flipped off. A subsequent `sai enable`
 * brings the plugin back up with no middlewares enabled — the user opts in
 * again via the dashboard or `sai init`.
 */

import chalk from 'chalk';
import { loadOpenClawConfig, saveOpenClawConfig } from '../../plugin/config-manager.js';
import { cleanupMiddleware, type MiddlewareName } from '../storage/cleanup.js';
import { ConfigStore } from '../storage/ConfigStore.js';
import { STORE_KEY_PLUGIN_CONFIG } from '../storage/paths.js';
import { logger } from '../Logger.js';

const ALL_MIDDLEWARES: MiddlewareName[] = [
  'hitl',
  'context-editing',
  'model-routing',
  'guardrail',
  'output-guardrail',
  'pii-sanitizer',
  'tool-call-limit',
];

export async function disableCommand(): Promise<void> {
  try {
    const config = await loadOpenClawConfig();

    if (!config?.plugins?.entries?.['sapience-ai-suite']) {
      console.log(chalk.yellow('Sapience AI Suite is not registered in OpenClaw. Run: sai init'));
      process.exit(0);
    }

    // Wipe each middleware's files, directories, and store keys. model-routing
    // additionally strips its router entries from openclaw.json.
    for (const mw of ALL_MIDDLEWARES) {
      try {
        await cleanupMiddleware(mw);
      } catch (err) {
        logger.debug(`cleanup failed for ${mw} (non-fatal)`, { error: err });
      }
    }

    // Clear the per-middleware enabled map so the next `sai enable` starts
    // the plugin with zero middlewares active.
    try {
      await ConfigStore.deleteKeys([STORE_KEY_PLUGIN_CONFIG]);
    } catch (err) {
      logger.debug('failed to clear plugin_config (non-fatal)', { error: err });
    }

    // Reload openclaw.json — cleanupMiddleware('model-routing') may have
    // rewritten it in-between. Flip the plugin entry off on the fresh copy.
    const fresh = (await loadOpenClawConfig()) ?? config;
    if (fresh.plugins?.entries?.['sapience-ai-suite']) {
      fresh.plugins.entries['sapience-ai-suite'].enabled = false;
      await saveOpenClawConfig(fresh);
    }

    console.log(chalk.green('Sapience AI Suite disabled — all middleware state cleared.'));
  } catch (error) {
    console.error(chalk.red('Failed to disable Sapience AI Suite:'), error);
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

    console.log(chalk.green('Sapience AI Suite enabled — no middlewares active yet.'));
    console.log(chalk.gray('Turn on individual middlewares via the dashboard or `sai init`.'));
  } catch (error) {
    console.error(chalk.red('Failed to enable Sapience AI Suite:'), error);
    logger.error('Enable command failed', { error });
    process.exit(1);
  }
}
