/**
 * PII Sanitizer — init hook for the suite's init wizard.
 *
 * Called by `src/cli/init.ts` alongside the other middlewares. Minimal:
 * ensures the DLP policy exists on disk with defaults and prompts for
 * the enable/dryRun toggles in interactive mode.
 */

import inquirer from 'inquirer';
import { DlpStore } from '../storage/DlpStore.js';
import { PII_SANITIZER_DLP_FILE } from '../../../shared/storage/paths.js';

export interface PiiSanitizerInitResult {
  ok: true;
  configPath: string;
  enabled: boolean;
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
        name: 'enabled',
        message: 'Enable the PII Sanitizer (DLP) middleware?',
        default: policy.enabled,
      },
      {
        type: 'confirm',
        name: 'dryRunMode',
        message: 'Run in dry-run mode (detect and log but do not redact)?',
        default: policy.dryRunMode,
      },
    ]);

    policy.enabled = answers.enabled;
    policy.dryRunMode = answers.dryRunMode;
  }

  await DlpStore.save(policy);

  return {
    ok: true,
    configPath: PII_SANITIZER_DLP_FILE,
    enabled: policy.enabled,
    dryRunMode: policy.dryRunMode,
  };
}
