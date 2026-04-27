/*
 * Copyright (c) Kevin Wu and Pegasi contributors
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * This file is derived from the Reins project (https://github.com/pegasi-ai/reins)
 * and has been modified for use in the OpenClaw Middleware Suite.
 */

/**
 * Sapience Middleware Arbitrator
 * The UI/Prompt Logic for Human-in-the-Loop Decisions
 *
 * Modes:
 *  1. TTY (interactive terminal)      → inquirer prompt
 *  2. Daemon + sessionKey (channel)   → approval queue (block-and-retry via messaging)
 *  3. Daemon without sessionKey       → auto-deny (fail-secure)
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { ExecutionContext } from '../../../types.js';
import { logger } from '../../../shared/Logger.js';
import { approvalQueue } from './ApprovalQueue.js';
import { hashArgs } from './ApprovalQueue.js';
import { DecisionLog } from '../storage/DecisionLog.js';
import { TotpManager } from './TotpManager.js';

export class Arbitrator {
  async judge(context: ExecutionContext): Promise<boolean> {
    // If a sessionKey is present, this request originated from a remote/web session.
    // Always use channel mode in this case — even if the gateway is running in a TTY terminal.
    // This prevents the interactive terminal prompt from appearing for web UI requests.
    if (context.sessionKey) {
      return this.judgeChannel(context);
    }

    if (process.stdin.isTTY) {
      return this.judgeTTY(context);
    }

    logger.info(
      `ASK policy → auto-denied (no TTY, no session): ${context.moduleName}.${context.methodName}()`,
      { args: context.args }
    );
    return false;
  }

  private async judgeTTY(context: ExecutionContext): Promise<boolean> {
    this.displayBanner();
    this.displayContext(context);

    if (context.intervention?.requiresExplicitConfirmation) {
      return this.judgeTTYExplicitConfirmation(context);
    }

    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'decision',
        message: chalk.bold.yellow('⚠️  What should HITL Middleware do?'),
        choices: [
          {
            name: chalk.green('✓ Approve - Allow this action'),
            value: true,
          },
          {
            name: chalk.red('✗ Reject - Block this action'),
            value: false,
          },
        ],
        default: 1,
      },
    ]);

    console.log('');

    if (answer.decision) {
      console.log(chalk.green('✓ Action APPROVED by user\n'));
    } else {
      console.log(chalk.red('✗ Action REJECTED by user\n'));
    }

    await this.logApprovalDecision(context, answer.decision ? 'yes' : 'no', answer.decision);

    return answer.decision;
  }

  private async judgeTTYExplicitConfirmation(context: ExecutionContext): Promise<boolean> {
    const summary =
      context.intervention?.actionSummary || `${context.moduleName}.${context.methodName}()`;

    console.log(chalk.bold.yellow('🔐 Irreversible action requires explicit confirmation.'));
    console.log(chalk.bold.cyan('Action Summary:'), chalk.white(summary));
    console.log('');

    let approved: boolean;

    if (TotpManager.isConfigured()) {
      // TOTP mode: ask for Google Authenticator code
      console.log(chalk.bold.cyan('Enter your Google Authenticator code to approve this action.'));
      console.log('');

      const answer = await inquirer.prompt([
        {
          type: 'input',
          name: 'code',
          message: '6-digit authenticator code (or press Enter to reject):',
        },
      ]);

      const code = String(answer.code || '').trim();
      approved = code.length > 0 && TotpManager.verifyCode(code);
    } else {
      // Fallback: simple YES/NO when TOTP is not configured
      const answer = await inquirer.prompt([
        {
          type: 'list',
          name: 'decision',
          message: chalk.bold.yellow('⚠️  What should HITL Middleware do?'),
          choices: [
            {
              name: chalk.green('✓ Approve - Allow this action'),
              value: true,
            },
            {
              name: chalk.red('✗ Reject - Block this action'),
              value: false,
            },
          ],
          default: 1,
        },
      ]);

      approved = answer.decision;
    }

    console.log('');
    if (approved) {
      console.log(chalk.green('✓ Action APPROVED by explicit confirmation\n'));
    } else {
      console.log(chalk.red('✗ Action REJECTED\n'));
    }

    await this.logApprovalDecision(context, 'confirm', approved);

    return approved;
  }

  private async judgeChannel(context: ExecutionContext): Promise<boolean> {
    const { sessionKey, moduleName, methodName } = context;
    const strict = context.intervention?.requiresExplicitConfirmation === true;
    const argsHash = hashArgs(context.args);

    if (approvalQueue.consume(sessionKey!, moduleName, methodName, argsHash)) {
      logger.info(`ASK policy → approved via channel: ${moduleName}.${methodName}()`, {
        sessionKey,
        argsHash,
      });
      return true;
    }

    approvalQueue.request(sessionKey!, moduleName, methodName, {
      requiresExplicitConfirmation: strict,
      actionSummary: context.intervention?.actionSummary,
      allowRetryAsApproval: false,
      argsHash,
      args: context.args,
    });

    let notified = false;
    if (context.onBlockCallback) {
      notified = await context.onBlockCallback(sessionKey!, moduleName, methodName);
    }

    if (!notified) {
      // Fallback: If no channel context for WhatsApp/Telegram, leave the queue entry pending
      // and return false so the LLM gets an error, allowing the user to approve directly in chat.
      if (!context.intervention) {
        context.intervention = {};
      }
      context.intervention.oobFailed = true;
      logger.info(
        `ASK policy → fallback to in-chat approval (no channel context for OOB): ${moduleName}.${methodName}()`,
        { sessionKey }
      );
      return false;
    }

    logger.info(`ASK policy → stalling hook until OOB approval: ${moduleName}.${methodName}()`, {
      sessionKey,
      requiresExplicitConfirmation: strict,
    });

    // Hold the before_tool_call hook open — OpenClaw awaits this Promise.
    // Resolves true when the human sends /approve <totp-code>, false on deny/timeout.
    return approvalQueue.waitForApproval(sessionKey!, moduleName, methodName);
  }

  private displayBanner(): void {
    console.log('');
    console.log(chalk.bgRed.white.bold('═'.repeat(80)));
    console.log(
      chalk.bgRed.white.bold('   🛡️ HITL MIDDLEWARE SECURITY ALERT - HUMAN AUTHORIZATION REQUIRED')
    );
    console.log(chalk.bgRed.white.bold('═'.repeat(80)));
    console.log('');
  }

  private displayContext(context: ExecutionContext): void {
    if (context.intervention?.cooldownLevel) {
      const level = context.intervention.cooldownLevel;
      const label = level >= 2 ? 'RESTRICTED' : 'HEIGHTENED';
      console.log(
        chalk.bgYellow.black.bold(
          `   COOLDOWN ACTIVE: Level ${level} (${label}) — repeated denials detected   `
        )
      );
      console.log('');
    }

    console.log(chalk.bold.cyan('📦 Module:'), chalk.white(context.moduleName));
    console.log(chalk.bold.cyan('🔧 Method:'), chalk.white(context.methodName));

    if (context.rule.description) {
      console.log(chalk.bold.cyan('⚠️  Risk:'), chalk.yellow(context.rule.description));
    }
    if (context.intervention?.actionSummary) {
      console.log(chalk.bold.cyan('🧾 Intent Summary:'));
      console.log(chalk.gray(this.indentJson(context.intervention.actionSummary)));
    }

    console.log(chalk.bold.cyan('📋 Arguments:'));

    try {
      const argsJson = JSON.stringify(context.args, null, 2);
      console.log(chalk.gray(this.indentJson(argsJson)));
    } catch {
      console.log(chalk.gray('  [Arguments contain non-serializable data]'));
      console.log(chalk.gray('  ' + String(context.args)));
    }

    console.log('');
    console.log(chalk.dim('─'.repeat(80)));
    console.log('');
  }

  private indentJson(json: string): string {
    return json
      .split('\n')
      .map((line) => '  ' + line)
      .join('\n');
  }

  private async logApprovalDecision(
    context: ExecutionContext,
    decision: 'yes' | 'no' | 'allow' | 'confirm',
    approved: boolean,
    confirmation?: string
  ): Promise<void> {
    try {
      await DecisionLog.append({
        timestamp: new Date().toISOString(),
        module: context.moduleName,
        method: context.methodName,
        args: context.args,
        decision: approved ? 'APPROVED' : 'REJECTED',
        decisionTime: 0,
        reason: 'approval_decision',
        eventType: 'approval_decision',
        approved,
        decisionInput: decision,
        confirmation,
        agentId: context.agentId,
        sessionKey: context.sessionKey,
      });
    } catch {
      // best-effort only
    }
  }
}
