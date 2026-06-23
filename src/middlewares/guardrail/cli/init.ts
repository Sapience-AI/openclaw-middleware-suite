/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Guardrail — init hook for the suite's init wizard.
 *
 * Called by `src/cli/init.ts` alongside the other middlewares. In interactive
 * mode it prompts for the main toggles; in non-interactive mode it writes the
 * defaults. The plugin-level enable decision is owned by the suite-level init
 * via the `middlewares` map — this hook only configures guardrail's internal
 * behavior (dry-run mode, unicode normalization).
 *
 * Signature matches the convention shared by all middleware init hooks:
 *   init<Name>Middleware(options, jsonMode, nonInteractive, paths, warnings)
 */

import inquirer from 'inquirer';
import { ConfigStore } from '../storage/ConfigStore.js';
import { GUARDRAIL_CONFIG_FILE } from '../../../shared/storage/paths.js';

export interface GuardrailInitResult {
  ok: true;
  configPath: string;
  dryRunMode: boolean;
  unicodeNormalization: boolean;
}

export async function initGuardrailMiddleware(
  _options: Record<string, unknown>,
  jsonMode: boolean,
  nonInteractive: boolean,
  _paths: { openclawConfig?: string; openclawHome?: string } = {},
  warnings: string[] = []
): Promise<GuardrailInitResult> {
  void warnings;
  const config = ConfigStore.loadSync();

  if (!nonInteractive && !jsonMode) {
    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'dryRunMode',
        message: 'Run in dry-run mode (detect and log but do not block)?',
        default: config.dryRunMode,
      },
      {
        type: 'confirm',
        name: 'unicodeNormalization',
        message: 'Enable Unicode normalization (recommended — blocks homoglyph bypasses)?',
        default: config.unicodeNormalization,
      },
    ]);

    config.dryRunMode = answers.dryRunMode;
    config.unicodeNormalization = answers.unicodeNormalization;
  }

  await ConfigStore.save(config);

  return {
    ok: true,
    configPath: GUARDRAIL_CONFIG_FILE,
    dryRunMode: config.dryRunMode,
    unicodeNormalization: config.unicodeNormalization,
  };
}
