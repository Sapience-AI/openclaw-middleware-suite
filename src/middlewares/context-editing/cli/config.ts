/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import chalk from 'chalk';
import { readFile } from 'fs/promises';
import { logger } from '../../../shared/Logger.js';
import { DEFAULT_CONTEXT_EDITING_CONFIG } from '../config.js';
import {
  ContextEditingPolicyStore,
  ContextEditingPolicyData,
} from '../storage/ContextEditingPolicyStore.js';
import { loadStore } from './utils.js';
import { getPluginMiddlewaresConfigSync } from '../../../plugin/config-manager.js';

export async function ctxConfigCommand(options: {
  setToken?: string;
  setMessage?: string;
  setMode?: string;
  setMessagesKept?: string;
  setCustomPrompt?: string;
  disableCustomPrompt?: boolean;
}): Promise<void> {
  console.log('');
  console.log(chalk.bold.cyan('═'.repeat(80)));
  console.log(chalk.bold.cyan('   ⚙️  Context Editing Configuration'));
  console.log(chalk.bold.cyan('═'.repeat(80)));
  console.log('');

  try {
    const store = loadStore();

    // Handle mutations
    if (
      options.setToken ||
      options.setMessage ||
      options.setMode ||
      options.setMessagesKept ||
      options.setCustomPrompt ||
      options.disableCustomPrompt
    ) {
      const overrides: Partial<ContextEditingPolicyData> = {};
      if (options.setToken) overrides.tokenThreshold = parseInt(options.setToken, 10);
      if (options.setMessage) overrides.messageThreshold = parseInt(options.setMessage, 10);
      if (options.setMode) {
        const mode = options.setMode;
        if (mode !== 'token' && mode !== 'message' && mode !== 'both') {
          console.error(chalk.red('❌ --set-mode must be one of: token, message, both'));
          process.exit(1);
        }
        overrides.triggerMode = mode;
      }

      if (options.setMessagesKept) {
        const n = parseInt(options.setMessagesKept, 10);
        if (isNaN(n) || n < 0) {
          console.error(chalk.red('❌ --set-messages-kept must be a non-negative integer'));
          process.exit(1);
        }
        overrides.messagesKeptBeforeCompaction = n;
      }

      if (options.setCustomPrompt) {
        try {
          const raw = await readFile(options.setCustomPrompt, 'utf-8');
          const parsed = JSON.parse(raw) as { instructions?: unknown; schema?: unknown };
          if (
            typeof parsed.instructions !== 'string' ||
            !parsed.instructions.trim() ||
            typeof parsed.schema !== 'string' ||
            !parsed.schema.trim()
          ) {
            console.error(
              chalk.red(
                '❌ Custom prompt file must contain non-empty "instructions" and "schema" string fields'
              )
            );
            process.exit(1);
          }
          // Validate the schema string is itself valid JSON
          try {
            JSON.parse(parsed.schema);
          } catch {
            console.error(chalk.red('❌ "schema" field must be a valid JSON schema string'));
            process.exit(1);
          }
          overrides.customPromptEnabled = true;
          overrides.customInstructions = parsed.instructions;
          overrides.customSchema = parsed.schema;
          console.log(
            chalk.yellow(
              '⚠ Custom prompt enabled — regex fallback is disabled. LLM/parse errors will skip compaction silently.'
            )
          );
        } catch (err) {
          console.error(chalk.red(`❌ Failed to load custom prompt file: ${err}`));
          process.exit(1);
        }
      }

      if (options.disableCustomPrompt) {
        overrides.customPromptEnabled = false;
      }

      await ContextEditingPolicyStore.update(overrides);
      console.log(chalk.green('✅ Configuration overrides saved.'));
      console.log('');
    }

    const overrides = store.getConfigOverrides();
    const config = { ...DEFAULT_CONTEXT_EDITING_CONFIG, ...overrides };
    const pluginEnabled = getPluginMiddlewaresConfigSync()['context-editing'] === true;

    console.log(chalk.bold('Current Configuration:'));
    console.log('');
    console.log(
      `  ${chalk.cyan('Enabled:')}           ${pluginEnabled ? chalk.green('Yes') : chalk.red('No')}`
    );
    console.log(`  ${chalk.cyan('Trigger Mode:')}      ${chalk.white(config.triggerMode)}`);
    console.log(
      `  ${chalk.cyan('Token Threshold:')}   ${chalk.white(config.tokenThreshold.toLocaleString())} tokens ${options.setToken || overrides.tokenThreshold ? chalk.dim('(override)') : ''}`
    );
    console.log(
      `  ${chalk.cyan('Message Threshold:')} ${chalk.white(config.messageThreshold.toString())} messages ${options.setMessage || overrides.messageThreshold ? chalk.dim('(override)') : ''}`
    );
    console.log('');

    console.log(chalk.bold('  ICC Features:'));
    console.log(
      `    ${chalk.cyan('Weighted Importance:')}   ${config.icc.weightedImportance ? chalk.green('✓') : chalk.red('✗')}`
    );
    console.log(
      `    ${chalk.cyan('Conflict Resolution:')}   ${config.icc.conflictResolution ? chalk.green('✓') : chalk.red('✗')}`
    );
    console.log(
      `    ${chalk.cyan('Entity Preservation:')}   ${config.icc.entityPreservation ? chalk.green('✓') : chalk.red('✗')}`
    );
    console.log(
      `    ${chalk.cyan('Custom Prompt:')}         ${config.icc.customPrompt?.enabled ? chalk.green('Enabled') : chalk.dim('Disabled (built-in extraction)')}`
    );
    console.log(
      `    ${chalk.cyan('Messages Kept Before Compaction:')}  ${chalk.white(String(config.icc.messagesKeptBeforeCompaction ?? 0))}`
    );

    console.log('');

    console.log(chalk.bold('  Pruning (mirror of openclaw.json):'));
    console.log(
      `    ${chalk.cyan('Enabled:')} ${config.pruning.enabled ? chalk.green('Yes') : chalk.red('No')}`
    );
    console.log(`    ${chalk.cyan('Mode:')}    ${chalk.white(config.pruning.mode)}`);
    console.log(`    ${chalk.cyan('TTL:')}     ${chalk.white(config.pruning.ttl)}`);
    console.log('');
  } catch (error) {
    console.error(chalk.red('❌ Failed to display context editing configuration:'), error);
    logger.error('ctx config command failed', { error });
    process.exit(1);
  }
}
