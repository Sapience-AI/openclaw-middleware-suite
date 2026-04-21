/**
 * Tool Call Limit — non-interactive `show` command.
 *
 * Usage:
 *   sai limits show                         # full policy
 *   sai limits show <module.method>         # single rule
 *   sai limits show --json                  # machine-readable
 *
 * Mirrors the opening display of the `configure` wizard but without
 * any prompts — safe for scripts, CI, and terminal recording.
 */

import chalk from 'chalk';
import { LimitPolicyStore } from '../storage/LimitPolicyStore.js';
import { LimitPolicy } from '../types.js';
import { logger } from '../../../shared/Logger.js';

interface ShowOptions {
  json?: boolean;
}

export async function showLimitCommand(
  toolKey: string | undefined,
  options: ShowOptions
): Promise<void> {
  try {
    const policy = await LimitPolicyStore.load();

    if (toolKey) {
      await showSingle(policy, toolKey, options);
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(policy, null, 2));
      return;
    }

    printFullPolicy(policy);
  } catch (err) {
    logger.error('sai limits show failed', { err });
    console.error(chalk.red('❌ Failed to load policy:'), err);
    process.exit(1);
  }
}

async function showSingle(
  policy: LimitPolicy,
  toolKey: string,
  options: ShowOptions
): Promise<void> {
  const parsed = parseToolKey(toolKey);
  if (!parsed) {
    console.error(
      chalk.red(
        `❌ Invalid tool key "${toolKey}". Expected format: <Module>.<method> (e.g. FileSystem.write)`
      )
    );
    process.exit(1);
  }

  const rule = policy.modules[parsed.moduleName]?.[parsed.methodName];
  if (!rule) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, reason: 'not_found' }, null, 2));
    } else {
      console.error(
        chalk.yellow(
          `⚠️  No custom rule for "${parsed.moduleName}.${parsed.methodName}". ` +
            'Global ceilings apply:'
        )
      );
      printGlobals(policy);
    }
    process.exit(1);
  }

  if (options.json) {
    console.log(
      JSON.stringify({ module: parsed.moduleName, method: parsed.methodName, rule }, null, 2)
    );
    return;
  }

  const s = rule.sessionCallLimit?.max ?? '∞';
  const r = rule.requestCallLimit?.max ?? '∞';
  console.log('');
  console.log(chalk.bold(`${parsed.moduleName}.${parsed.methodName}`));
  console.log(`  Session limit: ${chalk.bold(s)}`);
  console.log(`  Request limit: ${chalk.bold(r)}`);
  console.log('');
  printGlobals(policy);
}

function printFullPolicy(policy: LimitPolicy): void {
  console.log('');
  console.log(chalk.bold('Global Configuration:'));
  console.log(
    chalk.dim(`  Global Session Limit:  ${policy.globalSessionCallLimit ?? 'Unlimited'}`)
  );
  console.log(
    chalk.dim(`  Global Request Limit:  ${policy.globalRequestCallLimit ?? 'Unlimited'}`)
  );
  console.log('');

  console.log(chalk.bold('Per-Tool Budgets:'));
  const entries = Object.entries(policy.modules || {});
  if (entries.length === 0) {
    console.log(chalk.dim('  (No custom tool limits configured)'));
    console.log('');
    return;
  }

  for (const [moduleName, methods] of entries) {
    console.log(chalk.cyan(`  ${moduleName}:`));
    for (const [methodName, rule] of Object.entries(methods)) {
      const s = rule.sessionCallLimit?.max ?? '∞';
      const r = rule.requestCallLimit?.max ?? '∞';
      console.log(`    ${methodName.padEnd(14)}: (S:${s}, R:${r})`);
    }
  }
  console.log('');
}

function printGlobals(policy: LimitPolicy): void {
  console.log(chalk.dim('Global ceilings:'));
  console.log(
    chalk.dim(
      `  Session: ${policy.globalSessionCallLimit ?? 'Unlimited'} · Request: ${policy.globalRequestCallLimit ?? 'Unlimited'}`
    )
  );
  console.log('');
}

function parseToolKey(key: string): { moduleName: string; methodName: string } | null {
  const trimmed = (key ?? '').trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return null;
  return {
    moduleName: trimmed.slice(0, dot),
    methodName: trimmed.slice(dot + 1),
  };
}
