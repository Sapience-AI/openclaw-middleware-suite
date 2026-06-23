/*
 * Copyright (c) Kevin Wu and Pegasi contributors
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * This file is derived from the Reins project (https://github.com/pegasi-ai/reins)
 * and has been modified for use in the OpenClaw Middleware Suite.
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getOpenClawPaths,
  getPluginMiddlewaresConfig,
  setPluginMiddlewaresConfig,
} from '../../plugin/config-manager.js';
import { logger } from '../Logger.js';
import { initHitlMiddleware } from '../../middlewares/hitl/cli/init.js';
import { initContextEditingMiddleware } from '../../middlewares/context-editing/cli/init.js';
import { initModelRoutingMiddleware } from '../../middlewares/model-routing/cli/init.js';
import { initGuardrailMiddleware } from '../../middlewares/guardrail/cli/init.js';
// output-guardrail init consolidated into guardrail init (output scrubber config is now part of guardrail config)
import { initPiiSanitizerMiddleware } from '../../middlewares/pii-sanitizer/cli/init.js';
import { initToolCallLimitMiddleware } from '../../middlewares/tool-call-limit/cli/init.js';
import { cleanupMiddleware, MiddlewareName } from '../storage/cleanup.js';

const MIDDLEWARE_REGISTRY: Record<string, { name: string; description: string }> = {
  hitl: {
    name: '🛡️  HITL',
    description: 'Human-in-the-Loop (approve/reject agent actions before execution)',
  },
  'context-editing': {
    name: '✂️  Context Editing',
    description: 'Intelligent context curation & adaptive compaction triggers',
  },
  guardrail: {
    name: '🔒  Guardrail',
    description:
      'Universal security scanner (sensitive paths, egress, destructive commands) + output scrubber for assistant messages',
  },
  'pii-sanitizer': {
    name: '🔐  PII Sanitizer',
    description: 'DLP scanner with regex/heuristic/proximity rules',
  },
  'tool-call-limit': {
    name: '🔢  Tool Call Limit',
    description: 'Limit the number of tool calls',
  },
  'model-routing': {
    name: '🧭  Model Routing',
    description: 'Intelligent complexity-based model routing (SAI-Model-Routing-Middleware)',
  },
  'model-fallback': {
    name: '🔁  Model Fallback',
    description: 'Fallback models',
  },
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getAvailableMiddlewares(): string[] {
  const middlewaresDir = path.join(__dirname, '..', '..', 'middlewares');
  try {
    const entries = fs.readdirSync(middlewaresDir, { withFileTypes: true });
    const available: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          const initPathJs = path.join(middlewaresDir, entry.name, 'cli', 'init.js');
          const initPathTs = path.join(middlewaresDir, entry.name, 'cli', 'init.ts');
          if (fs.existsSync(initPathJs) || fs.existsSync(initPathTs)) {
            available.push(entry.name);
          }
        } catch {
          // ignore
        }
      }
    }
    return available;
  } catch {
    return [];
  }
}

export interface InitWizardOptions {
  nonInteractive?: boolean;
  json?: boolean;
  securityLevel?: string;
  modules?: string;
  middleware?: string;
}

export interface InitSuccessOutput {
  ok: true;
  configPath: string;
  policyPath: string;
  openclawHome: string;
  restartRecommended: boolean;
  warnings: string[];
  nextSteps: string[];
}

export interface InitFailureOutput {
  ok: false;
  error: {
    message: string;
    code: string;
    details?: Record<string, unknown>;
  };
}

export class InitWizardError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'InitWizardError';
    this.code = code;
    this.details = details;
  }
}

function disableLoggerOutput(): void {
  for (const transport of logger.transports) {
    transport.silent = true;
  }
}

export function formatError(error: unknown): InitFailureOutput {
  if (error instanceof InitWizardError) {
    return {
      ok: false,
      error: {
        message: error.message,
        code: error.code,
        details: error.details,
      },
    };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      error: {
        message: error.message,
        code: 'E_INIT_FAILED',
      },
    };
  }

  return {
    ok: false,
    error: {
      message: 'Unknown initialization error',
      code: 'E_INIT_FAILED',
    },
  };
}

export async function initWizard(options: InitWizardOptions = {}): Promise<InitSuccessOutput> {
  const nonInteractive = options.nonInteractive === true;
  const jsonMode = options.json === true;
  const warnings: string[] = [];
  const paths = getOpenClawPaths();

  if (!jsonMode) {
    console.log('');
    console.log(chalk.bold.cyan('═'.repeat(80)));
    console.log(chalk.bold.cyan('   🛡️ Sapience AI Suite Setup Wizard'));
    console.log(chalk.bold.cyan('   Sapience AI Suite is the intervention layer for OpenClaw.'));
    console.log(chalk.bold.cyan('═'.repeat(80)));
    console.log('');
  }

  const availableMiddlewares = getAvailableMiddlewares();
  if (availableMiddlewares.length === 0) {
    throw new InitWizardError('No configurable middlewares found.', 'E_NO_MIDDLEWARES');
  }

  if (nonInteractive && options.securityLevel === 'custom' && !options.modules) {
    throw new InitWizardError(
      '--security-level custom requires --modules to be specified.',
      'E_MISSING_REQUIRED',
      { securityLevel: 'custom' }
    );
  }

  const activeMiddlewares = await getPluginMiddlewaresConfig();

  if (!jsonMode && !nonInteractive && !options.middleware) {
    console.log(chalk.bold('Step 0: Enable/Disable Middlewares'));
    console.log(chalk.dim('Select which middlewares should run globally (Space to toggle).'));
    console.log('');

    const toggleAnswer = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'enabledMiddlewares',
        message: 'Active Middlewares:',
        choices: availableMiddlewares.map((id) => {
          const meta = MIDDLEWARE_REGISTRY[id] || { name: id, description: '' };
          return {
            name: `${meta.name} — ${meta.description}`,
            value: id,
            checked: activeMiddlewares[id] === true,
          };
        }),
      },
    ]);

    const newConfig: Record<string, boolean> = {};
    for (const mw of availableMiddlewares) {
      newConfig[mw] = toggleAnswer.enabledMiddlewares.includes(mw);
      activeMiddlewares[mw] = newConfig[mw];
    }
    await setPluginMiddlewaresConfig(newConfig);

    // Clean up data for any middleware that was just disabled
    for (const mw of availableMiddlewares) {
      if (newConfig[mw] === false) {
        try {
          await cleanupMiddleware(mw as MiddlewareName);
        } catch (err) {
          logger.debug(`Failed to clean up ${mw} on disable`, { error: err });
        }
      }
    }

    console.log('');
  } else if (nonInteractive) {
    // If running in non-interactive mode with no prior selection, enable all discovered middlewares by default
    const hasAnyEnabled = availableMiddlewares.some((mw) => activeMiddlewares[mw] === true);
    const newConfig: Record<string, boolean> = { ...activeMiddlewares };
    for (const mw of availableMiddlewares) {
      if (newConfig[mw] === undefined || !hasAnyEnabled) {
        newConfig[mw] = true;
      }
      activeMiddlewares[mw] = newConfig[mw];
    }
    await setPluginMiddlewaresConfig(newConfig);
  }

  // Determine which middlewares are enabled
  const enabledMiddlewares = availableMiddlewares.filter((id) => activeMiddlewares[id] === true);

  // If no middlewares are active, skip the configure question entirely
  if (enabledMiddlewares.length === 0 && !options.middleware) {
    if (!jsonMode) {
      console.log(
        chalk.yellow('No middlewares are enabled. Enable at least one middleware to configure it.')
      );
      console.log('');
    }
    return {
      ok: true,
      configPath: paths.openclawConfig,
      policyPath: '',
      openclawHome: paths.openclawHome,
      restartRecommended: false,
      warnings: ['No middlewares enabled'],
      nextSteps: ['Run sai init again and enable at least one middleware'],
    };
  }

  // Select middleware to configure
  let selectedMiddleware: string;
  if (options.middleware) {
    selectedMiddleware = options.middleware;
  } else if (nonInteractive) {
    // Default to hitl if available and enabled, otherwise the first available
    if (availableMiddlewares.includes('hitl') && activeMiddlewares['hitl'] === true) {
      selectedMiddleware = 'hitl';
    } else {
      selectedMiddleware = availableMiddlewares[0];
    }
  } else if (enabledMiddlewares.length === 1) {
    // Only one middleware enabled — auto-select it, no need to ask
    selectedMiddleware = enabledMiddlewares[0];
    const meta = MIDDLEWARE_REGISTRY[selectedMiddleware] || {
      name: selectedMiddleware,
      description: '',
    };
    if (!jsonMode) {
      console.log(chalk.dim(`Only one middleware enabled — auto-selecting ${meta.name}.`));
      console.log('');
    }
  } else {
    if (!jsonMode) {
      console.log(chalk.bold('Step 1: Select a middleware to configure'));
      console.log('');
    }

    const mwAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'middleware',
        message: 'Which middleware would you like to configure?',
        choices: enabledMiddlewares.map((id) => {
          const meta = MIDDLEWARE_REGISTRY[id] || { name: id, description: '' };
          return {
            name: `${meta.name} — ${meta.description}`,
            value: id,
          };
        }),
      },
    ]);

    selectedMiddleware = mwAnswer.middleware;

    if (!jsonMode) {
      console.log('');
    }
  }

  if (selectedMiddleware === 'context-editing') {
    return await initContextEditingMiddleware(options, jsonMode, nonInteractive, paths, warnings);
  }

  if (selectedMiddleware === 'hitl') {
    return await initHitlMiddleware(options, jsonMode, nonInteractive, paths, warnings);
  }

  if (selectedMiddleware === 'model-routing') {
    return await initModelRoutingMiddleware(options, jsonMode, nonInteractive, paths, warnings);
  }

  if (selectedMiddleware === 'guardrail') {
    const result = await initGuardrailMiddleware(
      options as Record<string, unknown>,
      jsonMode,
      nonInteractive,
      paths,
      warnings
    );
    return {
      ok: true,
      configPath: result.configPath,
      policyPath: result.configPath,
      openclawHome: paths.openclawHome,
      restartRecommended: false,
      warnings,
      nextSteps: ['Run sai guardrail status to verify configuration'],
    };
  }

  if (selectedMiddleware === 'pii-sanitizer') {
    const result = await initPiiSanitizerMiddleware(
      options as Record<string, unknown>,
      jsonMode,
      nonInteractive,
      paths,
      warnings
    );
    return {
      ok: true,
      configPath: result.configPath,
      policyPath: result.configPath,
      openclawHome: paths.openclawHome,
      restartRecommended: false,
      warnings,
      nextSteps: ['Run sai dlp info to verify configuration'],
    };
  }

  if (selectedMiddleware === 'tool-call-limit') {
    const result = await initToolCallLimitMiddleware(
      options as any,
      jsonMode,
      nonInteractive,
      paths,
      warnings
    );
    return {
      ok: true,
      configPath: result.configPath,
      policyPath: result.configPath,
      openclawHome: paths.openclawHome,
      restartRecommended: false,
      warnings,
      nextSteps: ['Run sai limits stats to verify configuration'],
    };
  }

  throw new InitWizardError(
    `Middleware "${selectedMiddleware}" is not yet available.`,
    'E_MIDDLEWARE_NOT_AVAILABLE',
    { middleware: selectedMiddleware }
  );
}

export async function runInitCommand(options: InitWizardOptions = {}): Promise<void> {
  const jsonMode = options.json === true;

  if (jsonMode) {
    disableLoggerOutput();
  }

  try {
    const result = await initWizard(options);
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    const formatted = formatError(error);

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(formatted)}\n`);
    } else {
      console.error(chalk.red('❌ Setup failed:'), formatted.error.message);
      logger.error('Init/configure command failed', {
        code: formatted.error.code,
        details: formatted.error.details,
      });
    }

    process.exitCode = 1;
  }
}
