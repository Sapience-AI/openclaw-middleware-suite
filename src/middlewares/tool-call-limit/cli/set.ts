/**
 * Tool Call Limit — non-interactive `set` command.
 *
 * Usage:
 *   sai limits set <module.method> --session <n> --request <n> [--force] [--json]
 *
 * Mutates a single per-tool rule in the LimitPolicy. At least one of
 * --session / --request must be supplied. Unknown module.method pairs
 * are rejected with a suggestion unless --force is passed (lets users
 * add rules for custom tools).
 */

import chalk from 'chalk';
import { LimitPolicyStore } from '../storage/LimitPolicyStore.js';
import { DEFAULT_LIMIT_POLICY, LimitPolicy } from '../types.js';
import { logger } from '../../../shared/Logger.js';

interface SetOptions {
  session?: string;
  request?: string;
  force?: boolean;
  json?: boolean;
}

export async function setLimitCommand(toolKey: string, options: SetOptions): Promise<void> {
  try {
    const parsed = parseToolKey(toolKey);
    if (!parsed) {
      fail(
        `Invalid tool key "${toolKey}". Expected format: <Module>.<method> (e.g. FileSystem.write)`
      );
    }
    const { moduleName, methodName } = parsed;

    const sessionMax = parseLimitFlag(options.session, '--session');
    const requestMax = parseLimitFlag(options.request, '--request');

    if (sessionMax === undefined && requestMax === undefined) {
      fail('At least one of --session or --request must be provided.');
    }

    const policy = await LimitPolicyStore.load();

    if (!options.force && !isKnownTool(policy, moduleName, methodName)) {
      const suggestion = suggestTool(policy, moduleName, methodName);
      const hint = suggestion ? `\n   Did you mean: ${chalk.cyan(suggestion)}?` : '';
      fail(
        `Unknown tool "${moduleName}.${methodName}".${hint}\n   Use --force to add a new custom rule.`
      );
    }

    if (!policy.modules[moduleName]) policy.modules[moduleName] = {};
    const current = policy.modules[moduleName][methodName] ?? {};

    const next = {
      sessionCallLimit:
        sessionMax !== undefined
          ? sessionMax > 0
            ? { max: sessionMax }
            : undefined
          : current.sessionCallLimit,
      requestCallLimit:
        requestMax !== undefined
          ? requestMax > 0
            ? { max: requestMax }
            : undefined
          : current.requestCallLimit,
    };

    policy.modules[moduleName][methodName] = next;
    await LimitPolicyStore.save(policy);

    const sLabel = next.sessionCallLimit?.max ?? '∞';
    const rLabel = next.requestCallLimit?.max ?? '∞';

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            module: moduleName,
            method: methodName,
            rule: next,
          },
          null,
          2
        )
      );
    } else {
      console.log(
        chalk.green('✅') +
          ` ${chalk.bold(moduleName + '.' + methodName)} updated: (S:${sLabel}, R:${rLabel})`
      );
    }
  } catch (err) {
    logger.error('sai limits set failed', { err });
    if (!(err instanceof CliError)) {
      console.error(chalk.red('❌ Failed to set limit:'), err);
    }
    process.exit(1);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

class CliError extends Error {}

function fail(message: string): never {
  console.error(chalk.red('❌ ' + message));
  throw new CliError(message);
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

function parseLimitFlag(raw: string | undefined, flagName: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    fail(`${flagName} must be a non-negative integer (got "${raw}").`);
  }
  return n;
}

function isKnownTool(policy: LimitPolicy, moduleName: string, methodName: string): boolean {
  const inCurrent = !!policy.modules[moduleName]?.[methodName];
  const inDefault = !!DEFAULT_LIMIT_POLICY.modules[moduleName]?.[methodName];
  const wildcardInCurrent = !!policy.modules[moduleName]?.['*'];
  return inCurrent || inDefault || wildcardInCurrent || methodName === '*';
}

function suggestTool(
  policy: LimitPolicy,
  moduleName: string,
  methodName: string
): string | undefined {
  const allKeys = new Set<string>();
  for (const [m, methods] of Object.entries(DEFAULT_LIMIT_POLICY.modules)) {
    for (const method of Object.keys(methods)) allKeys.add(`${m}.${method}`);
  }
  for (const [m, methods] of Object.entries(policy.modules)) {
    for (const method of Object.keys(methods)) allKeys.add(`${m}.${method}`);
  }

  const target = `${moduleName}.${methodName}`.toLowerCase();
  let best: { key: string; score: number } | undefined;
  for (const key of allKeys) {
    const score = similarity(target, key.toLowerCase());
    if (!best || score > best.score) best = { key, score };
  }
  return best && best.score >= 0.55 ? best.key : undefined;
}

// Tiny similarity: case-insensitive longest-common-substring ratio.
function similarity(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  const lcs = longestCommonSubstring(a, b);
  return (2 * lcs) / (a.length + b.length);
}

function longestCommonSubstring(a: string, b: string): number {
  let max = 0;
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
      if (dp[j] > max) max = dp[j];
      prev = temp;
    }
  }
  return max;
}
