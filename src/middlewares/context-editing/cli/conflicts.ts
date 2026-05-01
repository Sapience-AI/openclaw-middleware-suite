/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

import chalk from 'chalk';
import { logger } from '../../../shared/Logger.js';
import { CompactionAuditLog } from '../storage/CompactionAuditLog.js';

export async function ctxConflictsCommand(options: {
  session?: string;
  history?: boolean;
  lines?: string;
}): Promise<void> {
  console.log('');
  console.log(chalk.bold.cyan('═'.repeat(80)));
  console.log(chalk.bold.cyan('   ⚡ Conflict Resolutions'));
  console.log(chalk.bold.cyan('═'.repeat(80)));
  console.log('');

  try {
    const lineCount =
      options.history && options.lines ? parseInt(options.lines, 10) : options.history ? 50 : 1;
    const records = await CompactionAuditLog.readRecent(lineCount, options.session);

    if (records.length === 0) {
      console.log(chalk.yellow('No conflicts found.'));
      console.log('');
      return;
    }

    for (const record of records) {
      if (!record.resolvedConflicts || record.resolvedConflicts.length === 0) continue;

      console.log(
        chalk.bold(
          `Session: ${record.sessionKey} | Compaction: ${new Date(record.timestamp).toLocaleString()}`
        )
      );
      console.log('');
      console.log(chalk.dim('  Original                    → Resolved'));
      console.log(chalk.dim('  ─────────────────────────────────────────────────'));

      for (const conflict of record.resolvedConflicts) {
        console.log(
          `  ${conflict.original.padEnd(27).slice(0, 27)} → ${conflict.resolved.slice(0, 45)}`
        );
      }
      console.log('');
    }
  } catch (error) {
    console.error(chalk.red('❌ Failed to display conflicts:'), error);
    logger.error('ctx conflicts command failed', { error });
    process.exit(1);
  }
}
