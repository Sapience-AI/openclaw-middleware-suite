/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Tool Call Limit — non-interactive `set-global` command.
 *
 * Usage:
 *   sai limits set-global --session <n> --request <n> [--json]
 *
 * Updates the top-level global ceilings that apply to every tool.
 * At least one of --session / --request must be supplied.
 * A value of 0 is stored as "unlimited" (field cleared from policy).
 */

import chalk from 'chalk';
import { LimitPolicyStore } from '../storage/LimitPolicyStore.js';
import { logger } from '../../../shared/Logger.js';

interface SetGlobalOptions {
  session?: string;
  request?: string;
  json?: boolean;
}

export async function setGlobalLimitCommand(options: SetGlobalOptions): Promise<void> {
  try {
    const sessionMax = parseFlag(options.session, '--session');
    const requestMax = parseFlag(options.request, '--request');

    if (sessionMax === undefined && requestMax === undefined) {
      console.error(chalk.red('❌ At least one of --session or --request must be provided.'));
      process.exit(1);
    }

    const policy = await LimitPolicyStore.load();

    if (sessionMax !== undefined) {
      policy.globalSessionCallLimit = sessionMax > 0 ? sessionMax : undefined;
    }
    if (requestMax !== undefined) {
      policy.globalRequestCallLimit = requestMax > 0 ? requestMax : undefined;
    }

    await LimitPolicyStore.save(policy);

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            globalSessionCallLimit: policy.globalSessionCallLimit ?? null,
            globalRequestCallLimit: policy.globalRequestCallLimit ?? null,
          },
          null,
          2
        )
      );
    } else {
      const s = policy.globalSessionCallLimit ?? '∞';
      const r = policy.globalRequestCallLimit ?? '∞';
      console.log(chalk.green('✅') + ` Global budgets updated: (S:${s}, R:${r})`);
    }
  } catch (err) {
    logger.error('sai limits set-global failed', { err });
    console.error(chalk.red('❌ Failed to update global limits:'), err);
    process.exit(1);
  }
}

function parseFlag(raw: string | undefined, flagName: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(chalk.red(`❌ ${flagName} must be a non-negative integer (got "${raw}").`));
    process.exit(1);
  }
  return n;
}
