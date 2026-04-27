/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * PII Sanitizer — init hook for the suite's init wizard.
 *
 * Called by `src/cli/init.ts` alongside the other middlewares. Minimal:
 * ensures the DLP policy exists on disk with defaults and prompts for
 * the dry-run toggle in interactive mode. The plugin-level enable decision
 * is owned by the suite-level init via the `middlewares` map — this hook
 * only configures PII Sanitizer's internal behavior.
 */

import inquirer from 'inquirer';
import { DlpStore } from '../storage/DlpStore.js';
import { PII_SANITIZER_DLP_FILE } from '../../../shared/storage/paths.js';

export interface PiiSanitizerInitResult {
  ok: true;
  configPath: string;
  dryRunMode: boolean;
}

export async function initPiiSanitizerMiddleware(
  _options: Record<string, unknown>,
  jsonMode: boolean,
  nonInteractive: boolean,
  _paths: { openclawConfig?: string; openclawHome?: string } = {},
  warnings: string[] = []
): Promise<PiiSanitizerInitResult> {
  void warnings;
  const policy = DlpStore.loadSync();

  if (!nonInteractive && !jsonMode) {
    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'dryRunMode',
        message: 'Run in dry-run mode (detect and log but do not redact)?',
        default: policy.dryRunMode,
      },
    ]);

    policy.dryRunMode = answers.dryRunMode;
  }

  await DlpStore.save(policy);

  return {
    ok: true,
    configPath: PII_SANITIZER_DLP_FILE,
    dryRunMode: policy.dryRunMode,
  };
}
