/**
 * Tool Call Limit — init hook for the suite's init wizard.
 *
 * Called by `src/cli/init.ts` alongside the other middlewares. Minimal:
 * ensures the limit policy exists on disk with sensible defaults and prompts
 * for the global session/request limits in interactive mode.
 */

import inquirer from 'inquirer';
import { LimitPolicyStore } from '../storage/LimitPolicyStore.js';
import { TOOL_CALL_LIMIT_LIMITS_FILE } from '../../../shared/storage/paths.js';

export interface ToolCallLimitInitResult {
  ok: true;
  configPath: string;
  globalSessionCallLimit?: number;
  globalRequestCallLimit?: number;
}

export async function initToolCallLimitMiddleware(
  options: { globalLimit?: string; globalRequestLimit?: string } = {},
  jsonMode: boolean,
  nonInteractive: boolean,
  _paths: { openclawConfig?: string; openclawHome?: string } = {},
  warnings: string[] = []
): Promise<ToolCallLimitInitResult> {
  const policy = await LimitPolicyStore.load();

  // Apply CLI-flag overrides first (works in both interactive and non-interactive modes).
  if (options.globalLimit !== undefined) {
    const n = parseInt(options.globalLimit, 10);
    if (!Number.isNaN(n) && n >= 0) {
      policy.globalSessionCallLimit = n;
    } else {
      warnings.push(`Ignoring invalid --global-limit value: ${options.globalLimit}`);
    }
  }
  if (options.globalRequestLimit !== undefined) {
    const n = parseInt(options.globalRequestLimit, 10);
    if (!Number.isNaN(n) && n >= 0) {
      policy.globalRequestCallLimit = n;
    } else {
      warnings.push(`Ignoring invalid --global-request-limit value: ${options.globalRequestLimit}`);
    }
  }

  if (!nonInteractive && !jsonMode) {
    const answers = await inquirer.prompt([
      {
        type: 'number',
        name: 'globalSessionCallLimit',
        message: 'Global tool calls allowed per session (0 = unlimited):',
        default: policy.globalSessionCallLimit ?? 100,
      },
      {
        type: 'number',
        name: 'globalRequestCallLimit',
        message: 'Global tool calls allowed per request (0 = unlimited):',
        default: policy.globalRequestCallLimit ?? 10,
      },
    ]);

    policy.globalSessionCallLimit = answers.globalSessionCallLimit;
    policy.globalRequestCallLimit = answers.globalRequestCallLimit;
  }

  await LimitPolicyStore.save(policy);

  return {
    ok: true,
    configPath: TOOL_CALL_LIMIT_LIMITS_FILE,
    globalSessionCallLimit: policy.globalSessionCallLimit,
    globalRequestCallLimit: policy.globalRequestCallLimit,
  };
}
