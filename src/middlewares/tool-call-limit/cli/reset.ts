/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Tool Call Limit — `reset` command.
 *
 * Usage:
 *   sai limits reset [--session] [--request] [--json]
 *
 * Clears tracker state for the running gateway:
 *   1. Wipes on-disk tracker files (sessions.json / requests.json).
 *   2. Bumps `tool_call_limit.resetAt` in the unified store, which the
 *      middleware watches; on the next tool call it sees the new timestamp
 *      and clears its in-memory Maps before incrementing.
 *
 * Default (no flags) resets both session and request counters.
 */

import chalk from 'chalk';
import fs from 'fs-extra';
import {
  TOOL_CALL_LIMIT_SESSIONS_FILE,
  TOOL_CALL_LIMIT_REQUESTS_FILE,
  TOOL_CALL_LIMIT_LAST_REQ_FILE,
} from '../../../shared/storage/paths.js';
import { LimitPolicyStore } from '../storage/LimitPolicyStore.js';
import { logger } from '../../../shared/Logger.js';

interface ResetOptions {
  session?: boolean;
  request?: boolean;
  json?: boolean;
}

export async function resetLimitCommand(options: ResetOptions): Promise<void> {
  try {
    const resetSession = !!options.session || (!options.session && !options.request);
    const resetRequest = !!options.request || (!options.session && !options.request);

    // 1. Wipe tracker files on disk
    if (resetSession) {
      await fs.remove(TOOL_CALL_LIMIT_SESSIONS_FILE);
    }
    if (resetRequest) {
      await fs.remove(TOOL_CALL_LIMIT_REQUESTS_FILE);
      await fs.remove(TOOL_CALL_LIMIT_LAST_REQ_FILE);
    }

    // 2. Signal the running middleware to clear in-memory state by bumping
    //    resetAt in the policy. The middleware watches the store mtime and
    //    compares resetAt against its last-seen value on each tool call.
    const policy = await LimitPolicyStore.load();
    const now = new Date().toISOString();
    const nextPolicy = {
      ...policy,
      resetAt: now,
      resetScope: resetSession && resetRequest ? 'all' : resetSession ? 'session' : 'request',
    };
    await LimitPolicyStore.save(nextPolicy as typeof policy);

    const scope =
      resetSession && resetRequest ? 'session + request' : resetSession ? 'session' : 'request';

    if (options.json) {
      console.log(JSON.stringify({ ok: true, resetAt: now, scope }, null, 2));
    } else {
      console.log(chalk.green('✅') + ` Tool call limit trackers reset (${scope}) at ${now}`);
    }
  } catch (err) {
    logger.error('sai limits reset failed', { err });
    console.error(chalk.red('❌ Failed to reset limits:'), err);
    process.exit(1);
  }
}
