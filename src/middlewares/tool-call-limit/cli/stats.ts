/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

import chalk from 'chalk';
import { ToolCallLimitMiddleware } from '../ToolCallLimitMiddleware.js';
const mw = new ToolCallLimitMiddleware();
import { TrackerStore } from '../storage/TrackerStore.js';

/**
 * Tool Call Limit Stats CLI Command
 */

export async function statsCommand(options: any) {
  if (options.session) {
    await sessionStats(options.session, options.json, options.reset);
  } else if (options.requestId) {
    await requestStats(options.requestId, options.json);
  } else {
    // Default to summary (if we have access to PolicyStore, we show budgets)
    // For now, let's show all active session stats
    await sessionStats('all', options.json, false);
  }
}

async function sessionStats(sessionKey: string, json: boolean, reset: boolean) {
  if (reset) {
    if (sessionKey === 'all') {
      await mw.initialize();
      await mw.clearAllSessionLimits();
      console.log(chalk.green('✅ All session tool counts reset.'));
    } else {
      await mw.initialize();
      await mw.clearSessionLimits(sessionKey);
      console.log(chalk.green(`✅ Tool counts reset for session: ${sessionKey}`));
    }
    return;
  }

  await mw.initialize();
  const allStats = mw.getSessionStats();

  if (json) {
    console.log(
      JSON.stringify(sessionKey === 'all' ? allStats : allStats[sessionKey] || {}, null, 2)
    );
    return;
  }

  console.log('');
  console.log(chalk.bold.cyan('📊 Tool Call Budgets (Session)'));
  console.log(chalk.gray('═'.repeat(60)));

  const printBox = (key: string, stats: Record<string, any>) => {
    console.log(chalk.bold.blue(`Session: ${key}`));
    for (const [tool, count] of Object.entries(stats)) {
      const label = tool === 'GLOBAL' ? `● GLOBAL BUDGET` : `  ${tool}`;
      console.log(`${label.padEnd(40)} ${chalk.bold(count)}`);
    }
    console.log('');
  };

  if (sessionKey === 'all') {
    for (const [sk, stats] of Object.entries(allStats)) {
      printBox(sk, stats);
    }
  } else {
    printBox(sessionKey, allStats[sessionKey] || {});
  }
}

async function requestStats(requestId: string, json: boolean) {
  const targetId = requestId === 'last' ? await TrackerStore.loadLastRequestId() : requestId;
  if (!targetId) {
    console.log(chalk.yellow('No request ID found.'));
    return;
  }

  await mw.initialize();
  const allStats = mw.getRequestStats();
  if (json) {
    console.log(JSON.stringify(allStats[targetId] || {}, null, 2));
    return;
  }

  console.log('');
  console.log(chalk.bold.magenta(`📊 Tool Call Budgets (Request: ${targetId})`));
  console.log(chalk.gray('─'.repeat(40)));

  const stats = allStats[targetId] || {};
  for (const [tool, count] of Object.entries(stats)) {
    console.log(`${tool.padEnd(40)} ${chalk.bold(count)}`);
  }
  console.log('');
}
