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
import { loadStore } from './utils.js';

export async function ctxEntitiesCommand(options: {
  session?: string;
  history?: boolean;
  lines?: string;
}): Promise<void> {
  console.log('');
  console.log(chalk.bold.cyan('═'.repeat(80)));
  console.log(chalk.bold.cyan('   🔒 Extracted Entities'));
  console.log(chalk.bold.cyan('═'.repeat(80)));
  console.log('');

  try {
    if (options.history) {
      const lineCount = options.lines ? parseInt(options.lines, 10) : 10;
      const records = await CompactionAuditLog.readRecent(lineCount, options.session);

      if (records.length === 0) {
        console.log(chalk.yellow('No entities found in audit history.'));
        console.log('');
        return;
      }

      for (const record of records) {
        console.log(
          chalk.bold(
            `Session: ${record.sessionKey} | Compaction: ${new Date(record.timestamp).toLocaleString()}`
          )
        );
        if (!record.extractedEntities || record.extractedEntities.length === 0) {
          console.log(chalk.dim('  No entities'));
        } else {
          for (const entity of record.extractedEntities) {
            console.log(
              `  ${chalk.cyan(`[${entity.type}]`)} ${entity.name}: ${chalk.dim(entity.value)}`
            );
          }
        }
        console.log('');
      }
      return;
    }

    const store = loadStore();

    if (options.session) {
      // Show entities for a specific session
      const entities = store.getSessionEntities(options.session);

      if (entities.length === 0) {
        console.log(chalk.yellow(`No entities found for session: ${options.session}`));
        console.log('');
        return;
      }

      console.log(chalk.bold(`Session: ${options.session}`));
      console.log('');
      console.log(chalk.dim('  ' + 'Type'.padEnd(20) + 'Name'.padEnd(30) + 'Value'));
      console.log(chalk.dim('  ' + '─'.repeat(75)));

      for (const entity of entities) {
        console.log(
          '  ' +
            chalk.cyan(entity.type.padEnd(20)) +
            chalk.white(entity.name.slice(0, 28).padEnd(30)) +
            chalk.dim(entity.value.slice(0, 40))
        );
      }
      console.log('');
    } else {
      // Show entities for all sessions
      const sessionKeys = store.getSessionKeys();

      if (sessionKeys.length === 0) {
        console.log(chalk.yellow('No compaction history found.'));
        console.log(chalk.dim('Run a session with context editing enabled to see entities.'));
        console.log('');
        return;
      }

      for (const key of sessionKeys) {
        const entities = store.getSessionEntities(key);
        console.log(chalk.bold(`Session: ${key}`));

        if (entities.length === 0) {
          console.log(chalk.dim('  No entities'));
        } else {
          for (const entity of entities) {
            console.log(
              `  ${chalk.cyan(`[${entity.type}]`)} ${entity.name}: ${chalk.dim(entity.value)}`
            );
          }
        }
        console.log('');
      }
    }
  } catch (error) {
    console.error(chalk.red('❌ Failed to display entities:'), error);
    logger.error('ctx entities command failed', { error });
    process.exit(1);
  }
}
