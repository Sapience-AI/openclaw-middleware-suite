/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import { ContextEditingStats } from '../storage/ContextEditingStats.js';
import { ContextEditingPolicyStore } from '../storage/ContextEditingPolicyStore.js';
import { loadOpenClawConfig } from '../../../plugin/config-manager.js';
import { stageOpenClawWrite, flushToOpenClaw } from '../../../shared/server/openclaw-sync.js';
import {
  DEFAULT_CONTEXT_EDITING_CONFIG,
  DEFAULT_ICC_SYSTEM_PROMPT,
  DEFAULT_ICC_SCHEMA_JSON,
} from '../config.js';
import { loadStore } from './utils.js';

export async function initContextEditingMiddleware(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _options: any,
  jsonMode: boolean,
  nonInteractive: boolean,
  paths: any,
  warnings: string[]
): Promise<any> {
  if (!jsonMode) {
    console.log(chalk.green('\n✅ Setting up Context Editing middleware.'));
  }

  const store = loadStore();
  const overrides = store.getConfigOverrides();

  // Track whether any openclaw.json changes were staged
  let hasOpenclawChanges = false;

  if (!nonInteractive) {
    // 1. Trigger mode
    console.log('');
    console.log(chalk.bold('Step 1: Trigger Mode'));
    console.log(
      chalk.dim('Choose which signal fires compaction: token count, message count, or either.')
    );

    const triggerModeAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'triggerMode',
        message: 'Trigger compaction on:',
        choices: [
          { name: 'Both (fires when either threshold is exceeded)', value: 'both' },
          { name: 'Token threshold only', value: 'token' },
          { name: 'Message threshold only', value: 'message' },
        ],
        default: overrides.triggerMode || DEFAULT_CONTEXT_EDITING_CONFIG.triggerMode,
      },
    ]);

    await ContextEditingPolicyStore.update({ triggerMode: triggerModeAnswer.triggerMode });
    if (!jsonMode) console.log(chalk.green('   Trigger mode saved.'));

    // 2. Thresholds
    console.log('');
    console.log(chalk.bold('Step 2: Triggers & Thresholds'));
    console.log(
      chalk.dim('Compaction automatically runs when the context window exceeds these thresholds.')
    );

    const thresholdAnswers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'modifyThresholds',
        message: 'Do you want to change the token or message limits?',
        default: false,
      },
      {
        type: 'input',
        name: 'tokenThreshold',
        message: `Token Threshold (default: ${DEFAULT_CONTEXT_EDITING_CONFIG.tokenThreshold}):`,
        when: (answers) => answers.modifyThresholds,
        default:
          overrides.tokenThreshold?.toString() ||
          DEFAULT_CONTEXT_EDITING_CONFIG.tokenThreshold.toString(),
        validate: (val) => !isNaN(parseInt(val)) || 'Please enter a valid number',
      },
      {
        type: 'input',
        name: 'messageThreshold',
        message: `Message Threshold (default: ${DEFAULT_CONTEXT_EDITING_CONFIG.messageThreshold}):`,
        when: (answers) => answers.modifyThresholds,
        default:
          overrides.messageThreshold?.toString() ||
          DEFAULT_CONTEXT_EDITING_CONFIG.messageThreshold.toString(),
        validate: (val) => !isNaN(parseInt(val)) || 'Please enter a valid number',
      },
    ]);

    if (thresholdAnswers.modifyThresholds) {
      await ContextEditingPolicyStore.update({
        tokenThreshold: parseInt(thresholdAnswers.tokenThreshold, 10),
        messageThreshold: parseInt(thresholdAnswers.messageThreshold, 10),
      });
      if (!jsonMode) console.log(chalk.green('   Threshold overrides saved.'));
    }

    // 3. Pruning
    console.log('');
    console.log(chalk.bold('Step 3: Session Pruning'));
    console.log(
      chalk.dim('Automatically remove idle context strings from active RAM memory cache.')
    );

    let config = await loadOpenClawConfig();
    if (!config) config = {} as any;
    const agents = (config as any)?.agents || {};
    const defaults = agents.defaults || {};
    const currentPruning = defaults.contextPruning || {};
    const primaryModel = defaults.model?.primary || '';
    const isAnthropic =
      primaryModel.toLowerCase().includes('anthropic') ||
      primaryModel.toLowerCase().includes('claude');

    if (primaryModel) {
      console.log(chalk.cyan(`   Your primary model is: ${primaryModel}`));
    }
    if (!isAnthropic) {
      console.log(chalk.yellow('   Note: Pruning is off by default for non-Anthropic models.'));
    }

    const pruningAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'pruningMode',
        message: 'Would you like to enable inactive session pruning?',
        choices: [
          { name: 'Enable Pruning (recommended: cache-ttl 5m)', value: 'enable' },
          { name: 'Disable Pruning', value: 'disable' },
          { name: 'Leave as-is', value: 'skip' },
        ],
        default: currentPruning.mode && currentPruning.mode !== 'off' ? 'enable' : 'skip',
      },
    ]);

    if (pruningAnswer.pruningMode !== 'skip') {
      const updatedPruning = { ...currentPruning };

      if (pruningAnswer.pruningMode === 'enable') {
        const extraPruning = await inquirer.prompt([
          {
            type: 'input',
            name: 'ttl',
            message: 'Cache TTL (e.g., 5m, 1h):',
            default: '5m',
          },
        ]);
        updatedPruning.mode = 'cache-ttl';
        updatedPruning.ttl = extraPruning.ttl;
      } else {
        updatedPruning.mode = 'off';
      }

      await stageOpenClawWrite('agents.defaults.contextPruning', updatedPruning);
      hasOpenclawChanges = true;

      // Mirror to our store so the dashboard shows the same state.
      await ContextEditingPolicyStore.update({
        pruningMode: updatedPruning.mode === 'off' ? 'disabled' : 'enabled',
        ttl: typeof updatedPruning.ttl === 'string' ? updatedPruning.ttl : '5m',
      });

      if (!jsonMode) console.log(chalk.green('   Pruning configuration staged.'));
    }

    // 4. Model
    console.log('');
    console.log(chalk.bold('Step 4: Compaction Model'));
    console.log(
      chalk.dim(
        "Choose the LLM used for Intelligent Context Curation (ICC). By default, it follows the agent's primary model."
      )
    );

    const currentModel = defaults.compaction?.model;

    const modelAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'modelChoice',
        message: 'Select compaction model preference:',
        choices: [
          {
            name: `Use agent primary model ${currentModel ? '(Reset to default)' : '(Default)'}`,
            value: 'reset',
          },
          { name: 'Custom model...', value: 'custom' },
        ],
        default: 'reset',
      },
    ]);

    let finalModel = modelAnswer.modelChoice;

    if (finalModel === 'custom') {
      const customInput = await inquirer.prompt([
        {
          type: 'input',
          name: 'model',
          message: 'Enter custom model name (e.g., provider/model-name):',
          validate: (val) => {
            const name = val.trim();
            if (name.length === 0) return 'Model name cannot be empty';
            const isPrimary = defaults.model?.primary === name;
            let isConfigured = false;

            if (Array.isArray(defaults.model?.models)) {
              isConfigured = defaults.model.models.some((m: any) => {
                if (typeof m === 'string') return m === name;
                return m && m.name === name;
              });
            } else if (
              typeof defaults.model?.models === 'object' &&
              defaults.model.models !== null
            ) {
              isConfigured = Object.keys(defaults.model.models).includes(name);
            }

            if (isPrimary || isConfigured) return true;
            return `Model '${name}' not found in OpenClaw config. Provide a valid model from agents.defaults.model.primary or agents.defaults.model.models`;
          },
        },
      ]);
      finalModel = customInput.model.trim();
    }

    if (finalModel) {
      let compactionModel: string | undefined;

      if (finalModel === 'reset') {
        // Write the agent's primary model explicitly — deleting the field
        // causes OpenClaw to fall back to its hardcoded default (openai/gpt-5.4),
        // not the agent's configured primary model.
        const liveConfig = await loadOpenClawConfig();
        const agentPrimary = (liveConfig as any)?.agents?.defaults?.model?.primary as
          | string
          | undefined;
        compactionModel = agentPrimary;
      } else {
        compactionModel = finalModel;
      }

      if (compactionModel) {
        await stageOpenClawWrite('agents.defaults.compaction.model', compactionModel);
      } else {
        // Stage undefined to clear the field — flushToOpenClaw will set it
        await stageOpenClawWrite('agents.defaults.compaction.model', undefined);
      }
      hasOpenclawChanges = true;

      // Mirror to our store so the dashboard shows the same state.
      await ContextEditingPolicyStore.update({ model: compactionModel ?? '' });

      if (!jsonMode) console.log(chalk.green('   Compaction model configuration staged.'));
    }

    // ── Flush all staged openclaw.json changes at once ─────────────────────
    if (hasOpenclawChanges) {
      await flushToOpenClaw();
      if (!jsonMode) console.log(chalk.green('   OpenClaw configuration saved.'));
    }

    // 5. Custom ICC Prompt
    console.log('');
    console.log(chalk.bold('Step 5: Custom Compaction Prompt (advanced)'));
    console.log(
      chalk.dim(
        'Override the default ICC system prompt and output schema. When enabled, regex fallback'
      )
    );
    console.log(chalk.dim('is disabled — LLM/parse errors will skip compaction silently.'));

    const currentCustom = overrides.icc?.customPrompt;
    const customPromptAnswer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'enableCustomPrompt',
        message: 'Use a custom compaction prompt and output schema?',
        default: !!currentCustom?.enabled,
      },
    ]);

    if (customPromptAnswer.enableCustomPrompt) {
      const customAnswers = await inquirer.prompt([
        {
          type: 'editor',
          name: 'instructions',
          message:
            'Enter the custom system instructions (opens your editor — default prompt pre-filled):',
          // Pre-fill with the built-in extraction prompt so the user has a
          // working starting point; they can tweak in-place or save as-is.
          default: currentCustom?.instructions || DEFAULT_ICC_SYSTEM_PROMPT,
          validate: (val: string) => val.trim().length > 0 || 'Instructions cannot be empty',
        },
        {
          type: 'editor',
          name: 'schema',
          message: 'Enter the JSON output schema (opens your editor — default schema pre-filled):',
          default: currentCustom?.schema || DEFAULT_ICC_SCHEMA_JSON,
          validate: (val: string) => {
            try {
              const obj = JSON.parse(val);
              if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
                return 'Schema must be a JSON object';
              }
              return true;
            } catch {
              return 'Schema must be valid JSON';
            }
          },
        },
      ]);

      await ContextEditingPolicyStore.update({
        customPromptEnabled: true,
        customInstructions: customAnswers.instructions,
        customSchema: customAnswers.schema,
      });
      if (!jsonMode) {
        console.log(chalk.green('   Custom prompt saved.'));
        console.log(
          chalk.yellow('   Note: regex fallback is disabled. Compaction failures are silent.')
        );
      }
    } else if (currentCustom?.enabled) {
      await ContextEditingPolicyStore.update({ customPromptEnabled: false });
      if (!jsonMode) console.log(chalk.dim('   Custom prompt disabled.'));
    }

    // 6. Messages Kept Before Compaction
    console.log('');
    console.log(chalk.bold('Step 6: Messages Kept Before Compaction'));
    console.log(
      chalk.dim(
        'Number of user messages immediately before the compaction summary that survive in the next session.'
      )
    );
    console.log(chalk.dim('0 = drop everything prior (default behavior).'));

    const currentMessagesKept = overrides.icc?.messagesKeptBeforeCompaction;
    const keptAnswer = await inquirer.prompt([
      {
        type: 'input',
        name: 'messagesKeptBeforeCompaction',
        message: 'Messages to keep before last compaction:',
        default: currentMessagesKept !== undefined ? String(currentMessagesKept) : '0',
        validate: (val: string) => {
          const n = parseInt(val, 10);
          if (isNaN(n) || n < 0) return 'Please enter a non-negative integer';
          if (n > 50) return 'Maximum is 50';
          return true;
        },
      },
    ]);

    await ContextEditingPolicyStore.update({
      messagesKeptBeforeCompaction: parseInt(keptAnswer.messagesKeptBeforeCompaction, 10),
    });
    if (!jsonMode) console.log(chalk.green('   Messages-kept setting saved.'));
  }

  if (!jsonMode) {
    console.log('');
    console.log(chalk.green('✅ Context Editing setup complete.'));
    console.log('');
    console.log(chalk.bold('Quick Modifications:'));
    console.log(chalk.dim('   View Configuration:        sai ctx config'));
    console.log(chalk.dim('   View Statistics:           sai ctx stats'));
    console.log(chalk.dim('   Enable/Disable Pruning:    sai ctx pruning --enable/--disable'));
    console.log(chalk.dim('   Choose Model:              sai ctx model --set <model>'));
    console.log(
      chalk.dim('   Custom ICC Prompt:         sai ctx config --set-custom-prompt <file.json>')
    );
    console.log(chalk.dim('   Messages Kept Before:      sai ctx config --set-messages-kept <N>'));
    console.log('');
  }

  return {
    ok: true,
    configPath: paths.openclawConfig,
    policyPath: ContextEditingStats.getPath(),
    openclawHome: paths.openclawHome,
    restartRecommended: !nonInteractive,
    warnings,
    nextSteps: [
      'View Configuration: sai ctx config',
      'View Statistics: sai ctx stats',
      'Enable/Disable Pruning: sai ctx pruning --enable/--disable',
      'Choose Model: sai ctx model --set <model>',
      'Custom ICC Prompt: sai ctx config --set-custom-prompt <file.json>',
      'Messages Kept Before: sai ctx config --set-messages-kept <N>',
    ],
  };
}
