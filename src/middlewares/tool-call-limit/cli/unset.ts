/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Tool Call Limit — non-interactive `unset` command.
 *
 * Usage:
 *   sai limits unset <module.method> [--json]
 *
 * Removes a per-tool rule so the tool falls back to the global ceiling.
 * Exits 1 if the rule does not exist.
 */

import chalk from 'chalk';
import { LimitPolicyStore } from '../storage/LimitPolicyStore.js';
import { logger } from '../../../shared/Logger.js';

interface UnsetOptions {
  json?: boolean;
}

export async function unsetLimitCommand(toolKey: string, options: UnsetOptions): Promise<void> {
  try {
    const parsed = parseToolKey(toolKey);
    if (!parsed) {
      console.error(
        chalk.red(
          `❌ Invalid tool key "${toolKey}". Expected format: <Module>.<method> (e.g. FileSystem.write)`
        )
      );
      process.exit(1);
    }
    const { moduleName, methodName } = parsed;

    const policy = await LimitPolicyStore.load();
    const module = policy.modules[moduleName];
    if (!module || !module[methodName]) {
      console.error(
        chalk.red(`❌ No custom rule exists for "${moduleName}.${methodName}". Nothing to unset.`)
      );
      process.exit(1);
    }

    delete module[methodName];
    if (Object.keys(module).length === 0) delete policy.modules[moduleName];

    await LimitPolicyStore.save(policy);

    if (options.json) {
      console.log(JSON.stringify({ ok: true, removed: `${moduleName}.${methodName}` }, null, 2));
    } else {
      console.log(
        chalk.green('✅') +
          ` Removed rule for ${chalk.bold(moduleName + '.' + methodName)}. ` +
          chalk.dim('(Global ceiling now applies.)')
      );
    }
  } catch (err) {
    logger.error('sai limits unset failed', { err });
    console.error(chalk.red('❌ Failed to unset limit:'), err);
    process.exit(1);
  }
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
