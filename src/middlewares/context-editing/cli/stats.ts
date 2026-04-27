/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import chalk from 'chalk';
import { logger } from '../../../shared/Logger.js';
import { ContextEditingStats } from '../storage/ContextEditingStats.js';
import { loadStore } from './utils.js';

export async function ctxStatsCommand(): Promise<void> {
  console.log('');
  console.log(chalk.bold.cyan('═'.repeat(80)));
  console.log(chalk.bold.cyan('   📊 Context Editing Statistics'));
  console.log(chalk.bold.cyan('═'.repeat(80)));
  console.log('');

  try {
    const store = loadStore();
    const stats = store.getFullStats();

    if (stats.totalCompactions === 0) {
      console.log(chalk.yellow('No compaction activity recorded yet.'));
      console.log('');
      return;
    }

    const totalSavings = Object.values(stats.sessionHistories).reduce(
      (acc, hs) => acc + (hs.cumulativeTokensSaved || 0),
      0
    );

    console.log(chalk.bold('Aggregate Statistics:'));
    console.log(`  ${chalk.green('📦 Total Compactions:')}     ${stats.totalCompactions}`);
    console.log(`  ${chalk.green('💰 Total Tokens Saved:')}    ${totalSavings.toLocaleString()}`);
    console.log(`  ${chalk.green('🔒 Entities Preserved:')}    ${stats.totalEntitiesPreserved}`);
    console.log(`  ${chalk.green('⚡ Conflicts Resolved:')}    ${stats.totalConflictsResolved}`);
    console.log(
      `  ${chalk.green('📋 Sessions Tracked:')}      ${Object.keys(stats.sessionHistories).length}`
    );
    console.log('');

    // Per-session breakdown
    const sessions = Object.values(stats.sessionHistories);
    if (sessions.length > 0) {
      console.log(chalk.bold('Per-Session History:'));
      console.log('');
      console.log(
        chalk.dim(
          '  ' +
            'Session'.padEnd(30) +
            'Compactions'.padEnd(15) +
            'Last Compaction'.padEnd(25) +
            'Entities'.padEnd(12) +
            'Saved'
        )
      );
      console.log(chalk.dim('  ' + '─'.repeat(90)));

      for (const session of sessions) {
        const lastTime = session.lastCompactionTimestamp
          ? new Date(session.lastCompactionTimestamp).toLocaleString()
          : 'Never';

        console.log(
          '  ' +
            chalk.white(session.sessionKey.slice(0, 28).padEnd(30)) +
            chalk.white(session.compactionCount.toString().padEnd(15)) +
            chalk.dim(lastTime.padEnd(25)) +
            chalk.white(session.lastEntities.length.toString().padEnd(12)) +
            chalk.green((session.cumulativeTokensSaved || 0).toLocaleString())
        );
      }
      console.log('');
    }

    console.log(chalk.dim(`State file: ${ContextEditingStats.getPath()}`));
    console.log('');
  } catch (error) {
    console.error(chalk.red('❌ Failed to load context editing statistics:'), error);
    logger.error('ctx stats command failed', { error });
    process.exit(1);
  }
}
