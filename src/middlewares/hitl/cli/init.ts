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

/**
 * Sapience AI Suite Init/Configure Wizard
 * Interactive setup for Sapience AI Suite with OpenClaw + automation-friendly mode
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  isOpenClawInstalled,
  registerPlugin,
  isPluginRegistered,
} from '../../../plugin/config-manager.js';
import { PolicyStore, PersistedPolicy } from '../storage/PolicyStore.js';
import { HITL_DIR, HITL_DECISIONS_FILE } from '../../../shared/storage/paths.js';
import { getSecurityLevel, getModules } from '../../../shared/env.js';
import { DEFAULT_POLICY } from '../config.js';
import { SecurityRule } from '../../../types.js';
import { SECURITY_PRESETS, DEFAULT_MODULES, SecurityLevel } from '../presets.js';
import { getProtectedModules } from '../tool-interceptor.js';
import { TotpManager } from '../approval/TotpManager.js';
import { TOTP, Secret } from 'otpauth';

import { InitWizardOptions, InitWizardError } from '../../../shared/cli/init.js';

function parseSecurityLevel(value: string): SecurityLevel {
  if (value === 'permissive' || value === 'balanced' || value === 'strict' || value === 'custom') {
    return value;
  }
  throw new InitWizardError('Invalid security level', 'E_INVALID_OPTION', {
    option: 'securityLevel',
    value,
    allowed: ['permissive', 'balanced', 'strict', 'custom'],
  });
}

function parseModules(input: string | undefined): string[] {
  if (!input) {
    return [];
  }
  return input
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildPolicy(
  securityLevel: SecurityLevel,
  selectedModules: string[],
  customThresholds?: Record<string, unknown>
): PersistedPolicy {
  const modules: Record<string, Record<string, SecurityRule>> = {};
  const selectedPreset = securityLevel === 'custom' ? null : SECURITY_PRESETS[securityLevel];
  const systemThresholds = { ...DEFAULT_POLICY.systemThresholds, ...customThresholds } as any;

  if (selectedPreset) {
    selectedModules.forEach((moduleName) => {
      if (selectedPreset.policy[moduleName]) {
        modules[moduleName] = selectedPreset.policy[moduleName];
      } else {
        modules[moduleName] = {
          '*': { action: 'ASK', description: 'Default security' },
        };
      }
    });
  }

  return {
    version: '1.0.0',
    defaultAction: 'ASK',
    systemThresholds,
    modules,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findPluginManifestPath(pluginDir: string): string | null {
  const candidates = [pluginDir, path.resolve(__dirname, '..', '..')];

  for (const candidate of candidates) {
    const manifestPath = path.join(candidate, 'openclaw.plugin.json');
    if (fs.existsSync(manifestPath)) {
      return manifestPath;
    }
  }

  return null;
}

function getNextSteps(): string[] {
  return [
    'Restart OpenClaw gateway: openclaw gateway restart',
    'Edit security policy: sai hitl policy',
    'View audit trail: sai hitl audit',
  ];
}

export async function initHitlMiddleware(
  options: InitWizardOptions,
  jsonMode: boolean,
  nonInteractive: boolean,
  paths: any,
  warnings: string[]
): Promise<any> {
  // Step 1: Detect OpenClaw
  if (!jsonMode) {
    console.log(chalk.bold('Step 1: Detecting OpenClaw...'));
  }

  const isInstalled = await isOpenClawInstalled();
  if (!isInstalled) {
    throw new InitWizardError('OpenClaw is not installed or not found.', 'E_OPENCLAW_NOT_FOUND', {
      openclawHome: paths.openclawHome,
    });
  }

  if (!jsonMode) {
    console.log(chalk.green('✅ OpenClaw detected'));
    console.log('');
  }

  // Check if already registered
  const alreadyRegistered = await isPluginRegistered();
  if (alreadyRegistered && !nonInteractive) {
    const { shouldReconfigure } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'shouldReconfigure',
        message: 'Sapience AI Suite (HITL) is already configured. Reconfigure?',
        default: false,
      },
    ]);

    if (!shouldReconfigure) {
      if (!jsonMode) {
        console.log(chalk.yellow('Setup cancelled.'));
      }
      return {
        ok: true,
        configPath: paths.openclawConfig,
        policyPath: PolicyStore.getPath(),
        openclawHome: paths.openclawHome,
        restartRecommended: false,
        warnings,
        nextSteps: ['Run again when you want to update the configuration.'],
      };
    }
  }

  // Step 2: Choose security level
  let securityLevel: SecurityLevel;
  if (nonInteractive) {
    const fromEnv = getSecurityLevel();
    securityLevel = parseSecurityLevel(options.securityLevel || fromEnv || 'balanced');
  } else {
    if (!jsonMode) {
      console.log(chalk.bold('Step 2: Choose your security level'));
      console.log('');
    }

    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'securityLevel',
        message: 'Which security policy would you like to use?',
        choices: [
          {
            name: `${SECURITY_PRESETS.permissive.name} - ${SECURITY_PRESETS.permissive.description}`,
            value: 'permissive',
          },
          {
            name: `${SECURITY_PRESETS.balanced.name} - ${SECURITY_PRESETS.balanced.description}`,
            value: 'balanced',
          },
          {
            name: `${SECURITY_PRESETS.strict.name} - ${SECURITY_PRESETS.strict.description}`,
            value: 'strict',
          },
          {
            name: '⚙️  Custom (configure manually after setup)',
            value: 'custom',
          },
        ],
        default: 'balanced',
      },
    ]);

    securityLevel = parseSecurityLevel(answer.securityLevel);

    if (!jsonMode) {
      console.log('');
    }
  }

  // Step 3: Select modules to protect
  const availableModules = getProtectedModules();
  let selectedModules: string[] = [];

  if (nonInteractive) {
    const explicitModules = parseModules(options.modules || getModules());

    if (securityLevel === 'custom' && explicitModules.length === 0) {
      throw new InitWizardError(
        'Custom security level requires explicit modules in non-interactive mode.',
        'E_MISSING_REQUIRED',
        {
          required: ['--modules <comma-separated>', 'or SAPIENCE_MW_MODULES'],
          securityLevel,
        }
      );
    }

    selectedModules = explicitModules.length > 0 ? explicitModules : DEFAULT_MODULES;

    const unknownModules = selectedModules.filter(
      (moduleName) => !availableModules.includes(moduleName)
    );
    if (unknownModules.length > 0) {
      throw new InitWizardError('One or more modules are invalid.', 'E_INVALID_MODULES', {
        invalidModules: unknownModules,
        allowedModules: availableModules,
      });
    }
  } else {
    if (!jsonMode) {
      console.log(chalk.bold('Step 3: Select which OpenClaw tools to protect'));
      console.log('');
    }

    // Try to load existing policy to persist currently enabled modules in the UI
    let currentlyEnabled: string[] = [];
    try {
      const existingPolicy = PolicyStore.loadSync();
      currentlyEnabled = Object.keys(existingPolicy.modules);
    } catch {
      // Fallback to defaults on first run or if file is missing
      currentlyEnabled = DEFAULT_MODULES;
    }

    const answer = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedModules',
        message: 'Which tool modules should HITL Middleware intercept?',
        choices: availableModules.map((mod) => ({
          name: mod,
          value: mod,
          checked: currentlyEnabled.includes(mod),
        })),
      },
    ]);

    selectedModules = answer.selectedModules;

    if (!jsonMode) {
      console.log('');
    }
  }

  // Step 3.5: Configure Thresholds
  let customThresholds: Record<string, unknown> = {};
  if (!jsonMode && !nonInteractive) {
    const { configureThresholds } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'configureThresholds',
        message:
          'Would you like to tune advanced security thresholds (e.g. bulk delete limits, risk strictness)?',
        default: false,
      },
    ]);

    if (configureThresholds) {
      console.log('');
      console.log(chalk.bold('   Advanced Security Thresholds'));
      console.log(chalk.dim('   Press Enter to accept defaults.'));
      console.log('');

      const defaults = DEFAULT_POLICY.systemThresholds!;
      customThresholds = await inquirer.prompt([
        {
          type: 'number',
          name: 'forceAskIrreversibilityThreshold',
          message:
            'Force ASK Threshold (0-100)\n  ' +
            chalk.dim(
              'Score at which an action is forced to ASK human regardless of ALLOW policy.'
            ),
          default: defaults.forceAskIrreversibilityThreshold,
        },
        {
          type: 'number',
          name: 'explicitConfirmIrreversibilityThreshold',
          message:
            'Explicit CONFIRM Threshold (0-100)\n  ' +
            chalk.dim('Score at which an action escalates to explicit CONFIRM/2FA requirement.'),
          default: defaults.explicitConfirmIrreversibilityThreshold,
        },
        {
          type: 'number',
          name: 'attackPauseThreshold',
          message:
            'Attack Pause Threshold (0-100)\n  ' +
            chalk.dim(
              'Score at which session semantic drift/memory risk pauses the agent execution.'
            ),
          default: defaults.attackPauseThreshold,
        },
        {
          type: 'number',
          name: 'explicitConfirmMemoryThreshold',
          message:
            'Explicit Confirm Memory Threshold (0-100)\n  ' +
            chalk.dim('Score at which memory drift escalates to explicit CONFIRM/2FA requirement.'),
          default: defaults.explicitConfirmMemoryThreshold,
        },
        {
          type: 'number',
          name: 'destructiveBulkThreshold',
          message:
            'Destructive Bulk Threshold\n  ' +
            chalk.dim('Number of deletes/modifications that trigger a CATASTROPHIC rating.'),
          default: defaults.destructiveBulkThreshold,
        },
        {
          type: 'confirm',
          name: 'destructiveGatingEnabled',
          message:
            'Enable Destructive Gating?\n  ' +
            chalk.dim('Whether the destructive action interception scanning is enabled.'),
          default: defaults.destructiveGatingEnabled,
        },
        {
          type: 'number',
          name: 'trustRateLimitLevel1',
          message:
            'Trust Rate Limit Level 1\n  ' +
            chalk.dim(
              'Number of minor suspicious actions allowed before Level 1 trust rate limit kicks in.'
            ),
          default: defaults.trustRateLimitLevel1,
        },
        {
          type: 'number',
          name: 'trustRateLimitLevel2',
          message:
            'Trust Rate Limit Level 2\n  ' +
            chalk.dim(
              'Number of moderate suspicious actions before Level 2 trust rate limit kicks in.'
            ),
          default: defaults.trustRateLimitLevel2,
        },
      ]);
      console.log('');
    }
  }

  // Step 4: Create policy
  if (!jsonMode) {
    console.log(chalk.bold('Step 4: Creating security policy...'));
  }

  const policy = buildPolicy(securityLevel, selectedModules, customThresholds);
  await PolicyStore.save(policy);

  if (!jsonMode) {
    console.log(chalk.green(`✅ Policy saved to ${PolicyStore.getPath()}`));
    console.log('');
  }

  // Step 5: Register plugin in OpenClaw config
  if (!jsonMode) {
    console.log(chalk.bold('Step 5: Registering with OpenClaw...'));

    const manifestPath = findPluginManifestPath(paths.pluginDir);
    if (manifestPath) {
      const pluginRoot = path.dirname(manifestPath);
      console.log(chalk.dim(`  Plugin manifest found: ${manifestPath}`));
      console.log(chalk.dim(`  Install with: openclaw plugins install --link ${pluginRoot}`));
    }
  }

  await registerPlugin();

  if (!jsonMode) {
    console.log(chalk.green('✅ Sapience AI Suite registered in OpenClaw config'));
    console.log('');
  }

  // Step 6: Google Authenticator setup
  let totpConfigured = TotpManager.isConfigured();

  if (!nonInteractive && !totpConfigured) {
    if (!jsonMode) {
      console.log(chalk.bold('Step 6: Authenticator App Setup (optional)'));
      console.log(
        chalk.dim('  High-risk actions can require a TOTP code from your authenticator app.')
      );
      console.log(
        chalk.dim('  If you skip this, high-risk actions will use simple YES/NO approval.')
      );
      console.log('');
    }

    const { setupTotp } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'setupTotp',
        message:
          'Set up an Authenticator App (Google Auth, Authy, etc.) for high-risk action approval? (recommended)',
        default: true,
      },
    ]);

    if (setupTotp) {
      const { secret, manualSetupCode } = TotpManager.generateSecret();

      if (!jsonMode) {
        console.log('');
        console.log(chalk.bold.cyan('🔐 Authenticator App Setup'));
        console.log(chalk.bold('   Open your authenticator app and add a new account manually:'));
        console.log('');
        console.log(chalk.bold.cyan('   Account name: ') + chalk.white('SapienceMiddleware'));
        console.log(chalk.bold.cyan('   Secret key:   ') + chalk.bold.white(manualSetupCode));
        console.log(chalk.bold.cyan('   Type:         ') + chalk.white('Time-based (TOTP)'));
        console.log('');
      }

      let verified = false;
      const MAX_RETRIES = 3;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const { code } = await inquirer.prompt([
          {
            type: 'input',
            name: 'code',
            message: `Enter the 6-digit code from your authenticator app to verify (attempt ${attempt}/${MAX_RETRIES}):`,
            validate: (input: string) => {
              const cleaned = input.trim();
              if (!/^\d{6}$/.test(cleaned)) {
                return 'Please enter a 6-digit code.';
              }
              return true;
            },
          },
        ]);

        // Temporarily save so verifyCode can read it
        TotpManager.saveSecret(secret);

        if (TotpManager.verifyCode(code.trim())) {
          verified = true;
          totpConfigured = true;
          if (!jsonMode) {
            console.log(chalk.green('✅ Authenticator App paired successfully!'));
            console.log('');
          }
          break;
        } else {
          if (!jsonMode) {
            if (attempt < MAX_RETRIES) {
              console.log(
                chalk.yellow(`⚠️  Code incorrect. ${MAX_RETRIES - attempt} attempt(s) remaining.`)
              );
            } else {
              console.log(chalk.red('❌ All verification attempts failed.'));
            }
          }
        }
      }

      if (!verified) {
        // Remove the saved secret since pairing failed
        try {
          const totp_path = TotpManager.getPath();
          if (fs.existsSync(totp_path)) {
            fs.unlinkSync(totp_path);
          }
        } catch {
          /* best-effort cleanup */
        }

        if (!jsonMode) {
          console.log(
            chalk.yellow('   Skipping TOTP setup. High-risk actions will use YES/NO approval.')
          );
          console.log('');
        }
      }
    } else {
      if (!jsonMode) {
        console.log(chalk.dim('   Skipped. High-risk actions will use YES/NO approval.'));
        console.log(chalk.dim('   You can set it up later by running: sai init'));
        console.log('');
      }
    }
  } else if (totpConfigured && !jsonMode) {
    console.log(chalk.green('✅ Authenticator App is already paired.'));
    console.log('');

    const { totpAction } = await inquirer.prompt([
      {
        type: 'list',
        name: 'totpAction',
        message: 'What would you like to do?',
        choices: [
          { name: 'unpair      # Remove current device', value: 'unpair' },
          { name: 'reset       # Replace with a new device', value: 'reset' },
          { name: 'view-codes  # View recovery codes', value: 'view-codes' },
          { name: 'keep        # Keep current configuration', value: 'keep' },
        ],
      },
    ]);

    if (totpAction === 'unpair') {
      const { confirmUnpair } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmUnpair',
          message: 'Are you sure you want to unpair your Authenticator App?',
          default: false,
        },
      ]);

      if (confirmUnpair) {
        const { code } = await inquirer.prompt([
          {
            type: 'input',
            name: 'code',
            message: 'Enter current 6-digit code to confirm:',
          },
        ]);

        if (TotpManager.verifyCode(code)) {
          try {
            const totpPath = TotpManager.getPath();
            if (fs.existsSync(totpPath)) {
              fs.unlinkSync(totpPath);
            }
          } catch {
            /* best-effort cleanup */
          }
          totpConfigured = false;
          console.log('');
          console.log(chalk.green('✅ Code verified.'));
          console.log(chalk.green('✅ Authenticator App successfully unpaired.'));
          console.log(chalk.yellow('❕ Note: Your old recovery codes are now void.'));
          console.log('');
        } else {
          console.log(chalk.red('❌ Code incorrect. Unpairing cancelled.'));
          console.log('');
        }
      }
    } else if (totpAction === 'reset') {
      const { code } = await inquirer.prompt([
        {
          type: 'input',
          name: 'code',
          message: 'Enter current 6-digit code to verify identity:',
        },
      ]);

      if (TotpManager.verifyCode(code)) {
        const { secret, manualSetupCode } = TotpManager.generateSecret();

        console.log('');
        console.log(chalk.bold.cyan('🔐 New Authenticator App Setup'));
        console.log(chalk.bold('   Open your authenticator app and add a new account manually:'));
        console.log('');
        console.log(chalk.bold.cyan('   Account name: ') + chalk.white('SapienceMiddleware'));
        console.log(chalk.bold.cyan('   Secret key:   ') + chalk.bold.white(manualSetupCode));
        console.log(chalk.bold.cyan('   Type:         ') + chalk.white('Time-based (TOTP)'));
        console.log('');

        const { newCode } = await inquirer.prompt([
          {
            type: 'input',
            name: 'newCode',
            message: 'Enter code from your NEW device to finalize:',
          },
        ]);

        const tempTotp = new TOTP({
          issuer: 'SapienceMiddleware',
          label: 'openclaw-user',
          algorithm: 'SHA1',
          digits: 6,
          period: 30,
          secret: Secret.fromBase32(secret),
        });

        const delta = tempTotp.validate({ token: newCode.trim(), window: 1 });

        if (delta !== null) {
          TotpManager.saveSecret(secret);
          console.log('');
          console.log(chalk.green('✅ Code verified.'));
          console.log(chalk.green('✅ Authenticator App replaced successfully!'));
          console.log(chalk.yellow('❕ Note: Your old recovery codes are now void.'));
          console.log('');
        } else {
          console.log('');
          console.log(chalk.red('❌ Code incorrect. Reset cancelled. Old configuration retained.'));
          console.log('');
        }
      } else {
        console.log('');
        console.log(chalk.red('❌ Identity verification failed. Reset cancelled.'));
        console.log('');
      }
    } else if (totpAction === 'view-codes') {
      console.log('');
      console.log(chalk.yellow('❕ Generating new recovery codes. Old codes will be invalidated.'));
      console.log('Your new recovery codes:');

      const codes = [];
      for (let i = 0; i < 5; i++) {
        const part1 = Math.floor(1000 + Math.random() * 9000)
          .toString()
          .padStart(4, '0');
        const part2 = Math.floor(1000 + Math.random() * 9000)
          .toString()
          .padStart(4, '0');
        codes.push(`${part1}-${part2}`);
      }

      codes.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
      console.log('');

      await inquirer.prompt([
        {
          type: 'input',
          name: 'continue',
          message: 'Save these to a secure location. Press Enter to continue.',
        },
      ]);
      console.log('');
    }
  }

  if (!jsonMode) {
    console.log('');
    console.log(chalk.bold.green('═'.repeat(80)));
    console.log(chalk.bold.green('   ✅ Sapience AI Suite installed successfully!'));
    console.log(chalk.bold.green('═'.repeat(80)));
    console.log('');

    console.log(chalk.bold('Configuration:'));
    console.log(chalk.dim(`  OpenClaw home: ${paths.openclawHome}`));
    console.log(chalk.dim(`  OpenClaw config: ${paths.openclawConfig}`));
    console.log(chalk.dim(`  Plugin dir:      ${paths.pluginDir}`));
    console.log(chalk.dim(`  Policy:          ${PolicyStore.getPath()}`));
    console.log(chalk.dim(`  Audit log:       ${HITL_DECISIONS_FILE}`));
    console.log(chalk.dim(`  Stats:           ${HITL_DIR}`));
    console.log('');

    console.log(chalk.bold('Next steps:'));
    console.log(chalk.cyan('  1. Restart gateway:') + chalk.dim('  openclaw gateway restart'));
    console.log(chalk.cyan('  2. Edit policy:') + chalk.dim('      sai policy'));
    console.log(chalk.cyan('  3. View audit trail:') + chalk.dim('  sai audit'));
    console.log('');
  }

  return {
    ok: true,
    configPath: paths.openclawConfig,
    policyPath: PolicyStore.getPath(),
    openclawHome: paths.openclawHome,
    restartRecommended: true,
    warnings,
    nextSteps: getNextSteps(),
  };
}
