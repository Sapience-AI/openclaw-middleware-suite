/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Context Editing Audit Command
 */

import chalk from 'chalk';
import { CompactionAuditLog } from '../storage/CompactionAuditLog.js';
import { logger } from '../../../shared/Logger.js';

export async function ctxAuditCommand(options: {
  lines: string;
  session?: string;
  full?: boolean;
}): Promise<void> {
  console.log('');
  console.log(chalk.bold.cyan('═'.repeat(80)));
  console.log(chalk.bold.cyan('   📋 Context Editing Compaction Audit Trail'));
  console.log(chalk.bold.cyan('═'.repeat(80)));
  console.log('');

  try {
    const lineCount = parseInt(options.lines, 10);
    const records = await CompactionAuditLog.readRecent(lineCount, options.session);

    if (records.length === 0) {
      console.log(chalk.yellow('No compactions recorded yet.'));
      console.log('');
      return;
    }

    console.log(chalk.dim(`Showing last ${records.length} compaction(s):`));
    console.log('');

    records.forEach((record) => {
      const timestamp = new Date(record.timestamp).toLocaleString();
      const numEntities = record.extractedEntities?.length || 0;
      const numConflicts = record.resolvedConflicts?.length || 0;
      const numPriorities = record.prioritySegments?.length || 0;
      const hash = record.instructionHash ? record.instructionHash.substring(0, 8) : 'unknown';

      console.log(
        `${chalk.dim(timestamp)} | ${chalk.cyan(record.sessionKey.padEnd(15))} | ${chalk.magenta(record.trigger.padEnd(15))} | ` +
          `${chalk.green(`🔒 ${numEntities} entities`)} | ${chalk.yellow(`⚡ ${numConflicts} conflicts`)} | ${chalk.blue(`📋 ${numPriorities} priorities`)}`
      );

      if (record.tokensSaved !== undefined) {
        console.log(
          `  ${chalk.green('💰 Tokens Saved:')}  ${record.tokensSaved.toLocaleString()} ${chalk.dim(`(${record.tokensSavedSource})`)}`
        );
      }
      if (record.firstKeptEntryId) {
        console.log(`  ${chalk.cyan('✂️  Slice Anchor:')}   ${chalk.dim(record.firstKeptEntryId)}`);
      }

      // Display Compaction Summary
      if (options.full && record.iccInstruction) {
        console.log(chalk.dim('  Compaction Summary:'));
        const indented = record.iccInstruction
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n');
        console.log(chalk.white(indented));
        console.log(chalk.dim(`    [hash: ${hash}]`));
      } else if (record.iccInstruction) {
        const truncated = record.iccInstruction.split('\n')[0].substring(0, 60) + '...';
        console.log(
          `  Compaction Summary: ${chalk.dim(truncated)}  ${chalk.dim(`[hash: ${hash}]`)}`
        );
      } else if (options.full) {
        console.log(
          chalk.dim('  Compaction Summary: (none — no entities/conflicts/priorities extracted)')
        );
      }

      // Always show input transcript in --full mode, even when ICC found nothing.
      // This lets the user verify which messages were analyzed.
      if (options.full && record.iccInputTranscript) {
        console.log('');
        console.log(chalk.dim('  Input Messages passing into ICC:'));
        const transIndented = record.iccInputTranscript
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n');
        console.log(chalk.gray(transIndented));
      }

      // Display missing entities if any
      if (record.entitiesMissing && record.entitiesMissing.length > 0) {
        console.log(
          `  ${chalk.red('⚠️')}  ${chalk.red(`${record.entitiesMissing.length} entity missing after compaction:`)} ${chalk.dim(`[${record.entitiesMissing.join(', ')}]`)}`
        );
      }

      console.log('');
    });

    console.log(chalk.dim(`Audit log: ${CompactionAuditLog.getPath()}`));
    console.log('');
  } catch (error) {
    console.error(chalk.red('❌ Failed to load audit trail:'), error);
    logger.error('ctx audit command failed', { error });
    process.exit(1);
  }
}
