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
 * Sensitive Path Blocklist — L2 Guard
 *
 * Blocks tool calls that target sensitive file paths BEFORE the file
 * is even opened. Zero false positives — path matching, not content scanning.
 *
 * Covers: .ssh, .aws, .env, credentials files, private keys, etc.
 * Configurable via CLI: sai guardrail paths allow/block/list
 */

import { SensitivePathConfig } from '../types.js';
import { logger } from '../../../shared/Logger.js';
import * as path from 'path';
import * as os from 'os';

const TAG = '[guard:sensitive-paths]';

// ── Default blocked path patterns ──────────────────────────────

export const DEFAULT_SENSITIVE_PATHS: string[] = [
  // SSH keys & config
  '**/.ssh/*',
  '**/.ssh',

  // AWS credentials
  '**/.aws/credentials',
  '**/.aws/config',

  // GCP/Azure credentials
  '**/.config/gcloud/**',
  '**/.azure/**',

  // Environment files
  '**/.env',
  '**/.env.*',
  '**/.env.local',
  '**/.env.production',

  // Git credentials
  '**/.git-credentials',
  '**/.gitconfig',
  '**/.netrc',

  // Docker secrets
  '**/.docker/config.json',

  // NPM/Yarn tokens
  '**/.npmrc',
  '**/.yarnrc',
  '**/.yarnrc.yml',

  // Package manager tokens
  '**/.gem/credentials',
  '**/.pypirc',
  '**/.nuget/NuGet.Config',

  // Kubernetes
  '**/.kube/config',
  '**/.kube/**',

  // OpenClaw sensitive config (contains auth tokens)
  '**/.openclaw/openclaw.json',

  // Database files
  '**/*.sqlite',
  '**/*.sqlite3',
  '**/*.db',

  // Private keys (by extension)
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',

  // Credential files
  '**/credentials.json',
  '**/service-account*.json',
  '**/secrets.json',
  '**/secrets.yml',
  '**/secrets.yaml',
  '**/vault.json',

  // OS credential stores
  '**/etc/shadow',
  '**/etc/passwd',
  '**/etc/sudoers',
  '**/etc/security/**',

  // Windows credential paths
  '**/AppData/Roaming/Microsoft/Credentials/**',
  '**/AppData/Local/Microsoft/Credentials/**',

  // History files (may contain secrets typed in terminal)
  '**/.bash_history',
  '**/.zsh_history',
  '**/.node_repl_history',
  '**/.python_history',
  '**/.psql_history',
  '**/.mysql_history',
];

// ── Default allowed paths (overrides) ──────────────────────────

export const DEFAULT_ALLOWED_PATHS: string[] = [
  // Allow reading .env.example (not real secrets)
  '**/.env.example',
  '**/.env.sample',
  '**/.env.template',
];

// ── Default config ─────────────────────────────────────────────

export const DEFAULT_SENSITIVE_PATH_CONFIG: SensitivePathConfig = {
  enabled: true,
  action: 'BLOCK',
  blockedPaths: DEFAULT_SENSITIVE_PATHS,
  allowedPaths: DEFAULT_ALLOWED_PATHS,
};

// ── Pattern matching ───────────────────────────────────────────

/**
 * Convert a simple glob pattern to a regex.
 * Supports: ** (any path), * (any segment), ? (single char)
 */
function globToRegex(pattern: string): RegExp {
  // Normalize to forward slashes
  let p = pattern.replace(/\\/g, '/');

  // Escape regex special chars (except * and ?)
  p = p.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Convert glob patterns
  p = p.replace(/\*\*/g, '___DOUBLESTAR___');
  p = p.replace(/\*/g, '[^/]*');
  p = p.replace(/___DOUBLESTAR___/g, '.*');
  p = p.replace(/\?/g, '.');

  return new RegExp(`^${p}$`, 'i');
}

/**
 * Normalize a file path for matching:
 * - Resolve to absolute
 * - Replace backslashes with forward slashes
 * - Expand ~ to home directory
 */
function normalizePath(filePath: string): string {
  let normalized = filePath;

  // Expand ~
  if (normalized.startsWith('~')) {
    normalized = path.join(os.homedir(), normalized.slice(1));
  }

  // Resolve to absolute
  normalized = path.resolve(normalized);

  // Forward slashes for matching
  normalized = normalized.replace(/\\/g, '/');

  return normalized;
}

/**
 * Check if a file path matches any pattern in a list.
 */
function matchesAny(filePath: string, patterns: string[]): { matched: boolean; pattern?: string } {
  const normalized = normalizePath(filePath);

  for (const pattern of patterns) {
    const regex = globToRegex(pattern);
    if (regex.test(normalized)) {
      return { matched: true, pattern };
    }

    // Also test against just the relative-from-home path
    const homePath = os.homedir().replace(/\\/g, '/');
    if (normalized.startsWith(homePath)) {
      const relative = normalized.slice(homePath.length);
      // Test with leading slash and without
      if (regex.test(relative) || regex.test(relative.replace(/^\//, ''))) {
        return { matched: true, pattern };
      }
    }
  }

  return { matched: false };
}

// ── Main check function ────────────────────────────────────────

export interface SensitivePathResult {
  blocked: boolean;
  reason?: string;
  matchedPattern?: string;
  filePath?: string;
}

/**
 * Check if a file path is on the sensitive path blocklist.
 * Returns block/allow decision with reason.
 *
 * @param filePath - The file path to check
 * @param config - Sensitive path configuration (uses defaults if not provided)
 * @param dryRun - If true, log but don't block
 */
export function checkSensitivePath(
  filePath: string,
  config?: SensitivePathConfig,
  dryRun = false
): SensitivePathResult {
  const cfg = config ?? DEFAULT_SENSITIVE_PATH_CONFIG;

  if (!cfg.enabled) return { blocked: false };

  // Check allowlist first (overrides blocklist)
  const allowMatch = matchesAny(filePath, cfg.allowedPaths);
  if (allowMatch.matched) {
    logger.debug(`${TAG} ALLOW (allowlisted) | path=${filePath} | pattern=${allowMatch.pattern}`);
    return { blocked: false };
  }

  // Check blocklist
  const blockMatch = matchesAny(filePath, cfg.blockedPaths);
  if (!blockMatch.matched) {
    return { blocked: false };
  }

  const action = dryRun ? 'DRY-RUN' : cfg.action;
  logger.info(`${TAG} ${action} | path=${filePath} | pattern=${blockMatch.pattern}`);

  if (dryRun) {
    return {
      blocked: false,
      reason: `DRY-RUN: sensitive path blocked`,
      matchedPattern: blockMatch.pattern,
      filePath,
    };
  }

  if (cfg.action === 'BLOCK') {
    return {
      blocked: true,
      reason: `Sensitive path blocked: "${path.basename(filePath)}" matches pattern "${blockMatch.pattern}"`,
      matchedPattern: blockMatch.pattern,
      filePath,
    };
  }

  // WARN action — don't block, just flag
  return {
    blocked: false,
    reason: `Sensitive path warning: "${path.basename(filePath)}" matches pattern "${blockMatch.pattern}"`,
    matchedPattern: blockMatch.pattern,
    filePath,
  };
}
