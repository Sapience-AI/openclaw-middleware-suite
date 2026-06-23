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
 * Sapience Middleware approval commands
 *
 * Registers /approve and /deny as plugin commands.
 * OpenClaw routes these BEFORE the LLM loop, so the agent never sees them.
 *
 * Usage:
 *   /approve 123456   → verifies TOTP code & approves the pending action
 *   /deny             → denies the pending action
 */

import { approvalQueue } from './ApprovalQueue.js';
import { trustRateLimiter } from './TrustRateLimiter.js';
import { TotpManager } from './TotpManager.js';
import { logger } from '../../../shared/Logger.js';

// ---------------------------------------------------------------------------
// Minimal local types matching OpenClaw's PluginCommandDefinition surface
// ---------------------------------------------------------------------------

interface CommandContext {
  args?: string;
  isAuthorizedSender: boolean;
  from?: string;
}

interface CommandResult {
  text?: string;
  isError?: boolean;
}

export interface CommandDefinition {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: CommandContext) => CommandResult | Promise<CommandResult>;
}

// ---------------------------------------------------------------------------
// Command factories
// ---------------------------------------------------------------------------

export function createApproveCommand(): CommandDefinition {
  return {
    name: 'approve',
    description:
      'Approve a pending Sapience Middleware action. Usage: /approve <authenticator-code>',
    acceptsArgs: true,
    requireAuth: true,
    handler(ctx: CommandContext): CommandResult {
      if (!ctx.isAuthorizedSender) {
        return { text: 'Not authorized.', isError: true };
      }

      const code = ctx.args?.trim();

      const pending = approvalQueue.peekLatestPending();
      if (!pending) {
        return {
          text: '⚠️ No pending approval found. It may have expired (2 min TTL).',
          isError: true,
        };
      }

      if (TotpManager.isConfigured() && pending.entry.requiresExplicitConfirmation) {
        // TOTP mode: validate the authenticator code for STRICT actions
        if (!code || !/^\d{6}$/.test(code)) {
          return {
            text: '⚠️ Usage: /approve <6-digit-code>\nOpen your authenticator app and enter the current code.',
            isError: true,
          };
        }

        if (!TotpManager.verifyCode(code)) {
          return {
            text: '❌ Invalid authenticator code. Please try again with a fresh code.',
            isError: true,
          };
        }
      }
      // If TOTP is not configured OR it's not a strict action, approve directly

      approvalQueue.resolveLatestPending('approve');

      logger.info('[approval-cmd] Approved', {
        from: ctx.from,
        totpConfigured: TotpManager.isConfigured(),
      });

      let commandDetails = '';
      if (pending.entry.args && Array.isArray(pending.entry.args)) {
        const firstArg = pending.entry.args[0];
        if (typeof firstArg === 'object' && firstArg !== null) {
          // If it's a { command: "..." } object (typical for Shell.exec)
          if ('command' in firstArg && typeof firstArg.command === 'string') {
            commandDetails = `"${firstArg.command}"`;
          } else if ('path' in firstArg && typeof firstArg.path === 'string') {
            // If it's a file path (typical for Reading/Writing files)
            commandDetails = `path: ${firstArg.path}`;
          } else {
            commandDetails = JSON.stringify(pending.entry.args, null, 2);
          }
        } else {
          commandDetails = JSON.stringify(pending.entry.args, null, 2);
        }
      } else if (pending.entry.args) {
        try {
          commandDetails = JSON.stringify(pending.entry.args, null, 2);
        } catch {
          commandDetails = String(pending.entry.args);
        }
      }

      return {
        text:
          `✅ Approved: ${pending.entry.moduleName}.${pending.entry.methodName}\n` +
          `Command details:\n\n${commandDetails}\n\n` +
          `The action is now unlocked.\n(Please tell the agent to "proceed".)`,
      };
    },
  };
}

export function createDenyCommand(): CommandDefinition {
  return {
    name: 'deny',
    description: 'Deny a pending Sapience Middleware action. Usage: /deny',
    acceptsArgs: true,
    requireAuth: true,
    handler(ctx: CommandContext): CommandResult {
      if (!ctx.isAuthorizedSender) {
        return { text: 'Not authorized.', isError: true };
      }

      const resolved = approvalQueue.resolveLatestPending('deny');
      if (!resolved) {
        return {
          text: '⚠️ No pending approval found. It may have expired (2 min TTL).',
          isError: true,
        };
      }

      // Record the denial for cooldown escalation.
      trustRateLimiter.recordDenial('channel-deny');

      logger.info('[approval-cmd] Denied', { from: ctx.from });
      return { text: '🚫 Denied. The action has been blocked.' };
    },
  };
}
