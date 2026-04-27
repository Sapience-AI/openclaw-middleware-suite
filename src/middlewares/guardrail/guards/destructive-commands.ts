/*
 * Copyright (c) Knostic
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * This file is derived from the OpenClaw Shield project
 * (https://github.com/knostic/openclaw-shield) and has been modified for use
 * in the OpenClaw Middleware Suite.
 */

/**
 * Destructive Command Blocker — L2 Guard
 *
 * Hard-blocks dangerous shell commands that cause irreversible damage.
 * Runs as a fast-path check BEFORE the guardrail regex engine — no rule
 * configuration needed, these are always dangerous.
 *
 * Categories:
 *   - File system destruction (rm -rf, format, del /s /q)
 *   - Disk operations (dd, mkfs, fdisk)
 *   - Database destruction (DROP DATABASE, TRUNCATE, DELETE without WHERE)
 *   - Git destructive ops (push --force to main/master, reset --hard)
 *   - Permission escalation (chmod 777, chown root)
 *   - Service disruption (kill -9, shutdown, reboot)
 *
 * Configurable via CLI: sai guardrail destructive toggle/status
 */

import { DestructiveCommandConfig } from '../types.js';
import { logger } from '../../../shared/Logger.js';

const TAG = '[guard:destructive]';

// ── Built-in destructive patterns ──────────────────────────────

interface DestructivePattern {
  name: string;
  pattern: RegExp;
  description: string;
  severity: 'HIGH' | 'CRITICAL';
}

const BUILTIN_PATTERNS: DestructivePattern[] = [
  // ── File system destruction ────────────────────
  {
    name: 'rm_recursive_root',
    pattern: /rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)*(?:\/|~\/?\s|"\/|'\/)[\s;|&]?/i,
    description: 'rm -rf / or home directory',
    severity: 'CRITICAL',
  },
  {
    name: 'rm_force_recursive',
    pattern: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f|rm\s+-[a-zA-Z]*f[a-zA-Z]*r/i,
    description: 'rm with recursive + force flags',
    severity: 'HIGH',
  },
  {
    name: 'del_recursive_windows',
    pattern: /(?:del|erase)\s+\/[sS]\s+\/[qQ]|(?:rd|rmdir)\s+\/[sS]\s+\/[qQ]/i,
    description: 'Windows recursive forced delete',
    severity: 'CRITICAL',
  },
  {
    name: 'format_disk',
    pattern: /\bformat\s+[a-zA-Z]:\s*/i,
    description: 'Format disk drive',
    severity: 'CRITICAL',
  },

  // ── Disk operations ────────────────────────────
  {
    name: 'dd_disk_write',
    pattern: /\bdd\s+.*\bof=\/dev\//i,
    description: 'dd writing to raw device',
    severity: 'CRITICAL',
  },
  {
    name: 'mkfs_format',
    pattern: /\bmkfs(?:\.\w+)?\s+\/dev\//i,
    description: 'Create filesystem (format device)',
    severity: 'CRITICAL',
  },
  {
    name: 'fdisk_partition',
    pattern: /\bfdisk\s+\/dev\//i,
    description: 'Partition disk',
    severity: 'CRITICAL',
  },

  // ── Database destruction ───────────────────────
  {
    name: 'drop_database',
    pattern: /\bDROP\s+(?:DATABASE|SCHEMA)\s/i,
    description: 'DROP DATABASE/SCHEMA',
    severity: 'CRITICAL',
  },
  {
    name: 'drop_table',
    pattern: /\bDROP\s+TABLE\s/i,
    description: 'DROP TABLE',
    severity: 'HIGH',
  },
  {
    name: 'truncate_table',
    pattern: /\bTRUNCATE\s+(?:TABLE\s)?\w/i,
    description: 'TRUNCATE TABLE',
    severity: 'HIGH',
  },
  {
    name: 'delete_no_where',
    pattern: /\bDELETE\s+FROM\s+\w+\s*(?:;|$)/i,
    description: 'DELETE FROM without WHERE clause',
    severity: 'HIGH',
  },

  // ── Git destructive ops ────────────────────────
  {
    name: 'git_force_push_main',
    pattern: /\bgit\s+push\s+(?:.*\s)?--force(?:-with-lease)?\s+.*(?:main|master)\b/i,
    description: 'Force push to main/master',
    severity: 'CRITICAL',
  },
  {
    name: 'git_reset_hard',
    pattern: /\bgit\s+reset\s+--hard\b/i,
    description: 'git reset --hard (discards all local changes)',
    severity: 'HIGH',
  },
  {
    name: 'git_clean_force',
    pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/i,
    description: 'git clean -f (deletes untracked files)',
    severity: 'HIGH',
  },

  // ── Permission escalation ──────────────────────
  {
    name: 'chmod_world_writable',
    pattern: /\bchmod\s+(?:-R\s+)?(?:777|a\+rwx)\s/i,
    description: 'chmod 777 (world-writable)',
    severity: 'HIGH',
  },
  {
    name: 'chmod_recursive_root',
    pattern: /\bchmod\s+-R\s+.*\s+\/\s*$/i,
    description: 'Recursive chmod on root',
    severity: 'CRITICAL',
  },

  // ── Service disruption ─────────────────────────
  {
    name: 'shutdown_system',
    pattern: /\b(?:shutdown|poweroff|halt|init\s+0)\b/i,
    description: 'System shutdown',
    severity: 'CRITICAL',
  },
  {
    name: 'reboot_system',
    pattern: /\b(?:reboot|init\s+6)\b/i,
    description: 'System reboot',
    severity: 'HIGH',
  },
  {
    name: 'kill_all',
    pattern: /\bkillall\s+-9\b|\bkill\s+-9\s+-1\b|\bpkill\s+-9\b/i,
    description: 'Force kill all processes',
    severity: 'CRITICAL',
  },

  // ── Fork bomb / resource exhaustion ────────────
  {
    name: 'fork_bomb',
    pattern: /:\(\)\{\s*:\|:\s*&\s*\};:|\.\/bomb|while\s+true.*fork/i,
    description: 'Fork bomb',
    severity: 'CRITICAL',
  },

  // ── Environment corruption ─────────────────────
  {
    name: 'unset_path',
    pattern: /\bunset\s+PATH\b|export\s+PATH\s*=\s*["']?\s*["']?\s*$/i,
    description: 'Unset/clear PATH variable',
    severity: 'HIGH',
  },
];

// ── Default config ─────────────────────────────────────────────

export const DEFAULT_DESTRUCTIVE_CONFIG: DestructiveCommandConfig = {
  enabled: true,
  action: 'BLOCK',
  customPatterns: [],
};

// ── Main check function ────────────────────────────────────────

export interface DestructiveCheckResult {
  blocked: boolean;
  reason?: string;
  patternName?: string;
  severity?: 'HIGH' | 'CRITICAL';
  description?: string;
}

/**
 * Check a shell command against the destructive command blocklist.
 * Fast-path check — runs before the full guardrail scan.
 */
export function checkDestructiveCommand(
  command: string,
  config?: DestructiveCommandConfig,
  dryRun = false
): DestructiveCheckResult {
  const cfg = config ?? DEFAULT_DESTRUCTIVE_CONFIG;

  if (!cfg.enabled) return { blocked: false };

  const cmd = command.trim();
  if (!cmd) return { blocked: false };

  // Check built-in patterns
  for (const pat of BUILTIN_PATTERNS) {
    if (pat.pattern.test(cmd)) {
      const action = dryRun ? 'DRY-RUN' : cfg.action;
      logger.info(
        `${TAG} ${action} | pattern=${pat.name} | severity=${pat.severity} | desc="${pat.description}"`
      );
      logger.debug(`${TAG} Command: "${cmd.slice(0, 200)}"`);

      if (dryRun) {
        return {
          blocked: false,
          reason: `DRY-RUN: destructive command detected: ${pat.description}`,
          patternName: pat.name,
          severity: pat.severity,
          description: pat.description,
        };
      }

      if (cfg.action === 'BLOCK') {
        return {
          blocked: true,
          reason: `Destructive command blocked: ${pat.description} (${pat.name})`,
          patternName: pat.name,
          severity: pat.severity,
          description: pat.description,
        };
      }

      // WARN — don't block
      return {
        blocked: false,
        reason: `Destructive command warning: ${pat.description} (${pat.name})`,
        patternName: pat.name,
        severity: pat.severity,
        description: pat.description,
      };
    }
  }

  // Check custom patterns
  for (const patternStr of cfg.customPatterns) {
    try {
      const regex = new RegExp(patternStr, 'i');
      if (regex.test(cmd)) {
        const action = dryRun ? 'DRY-RUN' : cfg.action;
        logger.info(`${TAG} ${action} | custom-pattern="${patternStr}"`);

        if (dryRun) {
          return {
            blocked: false,
            reason: `DRY-RUN: custom destructive pattern matched`,
            patternName: `custom:${patternStr.slice(0, 50)}`,
            severity: 'HIGH',
          };
        }

        if (cfg.action === 'BLOCK') {
          return {
            blocked: true,
            reason: `Destructive command blocked (custom pattern: ${patternStr.slice(0, 50)})`,
            patternName: `custom:${patternStr.slice(0, 50)}`,
            severity: 'HIGH',
          };
        }

        return {
          blocked: false,
          reason: `Destructive command warning (custom pattern)`,
          patternName: `custom:${patternStr.slice(0, 50)}`,
          severity: 'HIGH',
        };
      }
    } catch {
      logger.warn(`${TAG} Invalid custom pattern: "${patternStr}"`);
    }
  }

  return { blocked: false };
}

/**
 * Get all built-in destructive patterns (for CLI listing).
 */
export function getBuiltinPatterns(): DestructivePattern[] {
  return [...BUILTIN_PATTERNS];
}
