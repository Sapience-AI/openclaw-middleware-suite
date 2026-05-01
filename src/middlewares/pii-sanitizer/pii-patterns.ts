/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Shared PII / Secret Pattern Catalog
 *
 * Single source of truth for regex/prefix patterns used to detect
 * personally identifiable information and credentials.
 *
 * Both middlewares import from here:
 *   - guardrail (content scanning at L3 message-write)
 *   - pii-sanitizer (DLP at L2 before-tool-call)
 *
 * Each middleware wraps these patterns into its own rule shape and
 * assigns its own action (LOG/WARN/BLOCK vs ALLOW/REDACT/ESCALATE/BLOCK)
 * and may override severity if its risk model differs.
 *
 * Patterns chosen here are the most comprehensive variants — when the
 * two middlewares previously had divergent regexes for the same concept,
 * the broader/safer one wins.
 */

export type PiiSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type PiiPatternType = 'regex' | 'prefix';

export interface PiiPatternSpec {
  type: PiiPatternType;
  pattern: string;
  severity: PiiSeverity;
  description: string;
}

/**
 * Pattern catalog. Keys are stable identifiers; the consuming middleware
 * picks its own user-facing rule `name` (since on-disk policy files
 * persist under those names).
 */
export const PII_PATTERNS = {
  // ── Standard PII ──────────────────────────────────────────────
  PHONE_NUMBER: {
    type: 'regex',
    pattern:
      '(?<!\\w)(?:\\+\\d{1,3}[-\\.\\s]?)?\\(?\\d{3}\\)?[-\\.\\s]?\\d{3}[-\\.\\s]?\\d{4}(?!\\w)|(?<!\\w)\\+\\d{1,3}[-\\.\\s]?\\d{7,}(?!\\w)',
    severity: 'MEDIUM',
    description: 'Phone numbers (US/International formats)',
  },
  EMAIL: {
    type: 'regex',
    pattern: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}',
    severity: 'LOW',
    description: 'Email addresses',
  },
  CREDIT_CARD: {
    type: 'regex',
    pattern: '\\b[3-6]\\d{3}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{1,7}\\b',
    severity: 'CRITICAL',
    description: 'Credit card numbers (Visa, MC, Amex, Discover)',
  },
  SSN: {
    type: 'regex',
    pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b',
    severity: 'CRITICAL',
    description: 'US Social Security Numbers',
  },
  IBAN: {
    type: 'regex',
    pattern: '\\b[A-Z]{2}\\d{2}[A-Z0-9]{4}\\d{7}[A-Z0-9]{0,23}\\b',
    severity: 'HIGH',
    description: 'International Bank Account Numbers',
  },
  IP_ADDRESS: {
    type: 'regex',
    pattern:
      '\\b(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\b',
    severity: 'LOW',
    description: 'IPv4 addresses',
  },

  // ── Cloud Provider Keys (prefix) ──────────────────────────────
  AWS_ACCESS_KEY_ID: {
    type: 'prefix',
    pattern: 'AKIA',
    severity: 'CRITICAL',
    description: 'AWS access key IDs',
  },
  OPENAI_KEY: {
    type: 'prefix',
    pattern: 'sk-',
    severity: 'CRITICAL',
    description: 'OpenAI API keys',
  },
  ANTHROPIC_KEY: {
    type: 'prefix',
    pattern: 'sk-ant-',
    severity: 'CRITICAL',
    description: 'Anthropic API keys',
  },
  HUGGINGFACE_KEY: {
    type: 'prefix',
    pattern: 'hf_',
    severity: 'CRITICAL',
    description: 'Hugging Face tokens',
  },
  SLACK_TOKEN: {
    type: 'prefix',
    pattern: 'xox',
    severity: 'CRITICAL',
    description: 'Slack tokens (xoxb, xoxp, xoxr, xoxa)',
  },

  // ── Cloud Provider Keys (regex) ───────────────────────────────
  AWS_SECRET_ACCESS_KEY: {
    type: 'regex',
    pattern:
      '(?:aws_secret_access_key|aws[_-]?secret[_-]?key|secret[_-]?access[_-]?key)\\s*[:=]\\s*[A-Za-z0-9/+=]{40}',
    severity: 'CRITICAL',
    description: 'AWS secret access keys (40-char base64 after label)',
  },
  GITHUB_TOKEN: {
    type: 'regex',
    pattern: 'gh[pousr]_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{22,}',
    severity: 'CRITICAL',
    description: 'GitHub tokens and fine-grained PATs',
  },
  STRIPE_KEY: {
    type: 'regex',
    pattern: '[sr]k[-_](?:live|test)[-_][a-zA-Z0-9]{20,}',
    severity: 'CRITICAL',
    description: 'Stripe API keys',
  },
  SENDGRID_KEY: {
    type: 'regex',
    pattern: 'SG\\.[a-zA-Z0-9_-]{22}\\.[a-zA-Z0-9_-]{43}',
    severity: 'CRITICAL',
    description: 'SendGrid API keys',
  },
  NPM_TOKEN: {
    type: 'regex',
    pattern: 'npm_[a-zA-Z0-9]{36,}',
    severity: 'CRITICAL',
    description: 'npm tokens',
  },
  GCP_KEY: {
    type: 'regex',
    pattern: 'AIza[0-9A-Za-z\\-_]{35}',
    severity: 'CRITICAL',
    description: 'Google Cloud Platform API keys',
  },
  SLACK_WEBHOOK: {
    type: 'regex',
    pattern: 'https://hooks\\.slack\\.com/services/T[a-zA-Z0-9_]+/B[a-zA-Z0-9_]+/[a-zA-Z0-9_]+',
    severity: 'HIGH',
    description: 'Slack webhook URLs',
  },

  // ── Generic Credential Surfaces ───────────────────────────────
  PRIVATE_KEY_HEADER: {
    type: 'regex',
    pattern: '-----BEGIN\\s+(?:RSA|OPENSSH|EC|DSA|PGP)?\\s*PRIVATE\\s+KEY-----',
    severity: 'CRITICAL',
    description: 'Private key PEM headers',
  },
  JWT_TOKEN: {
    type: 'regex',
    pattern: 'eyJ[a-zA-Z0-9_-]{10,}\\.eyJ[a-zA-Z0-9_-]{10,}\\.[a-zA-Z0-9_-]+',
    severity: 'HIGH',
    description: 'JSON Web Tokens',
  },
  BEARER_TOKEN: {
    type: 'regex',
    pattern: '(?:Authorization|Bearer)\\s*[:=]?\\s*Bearer\\s+[a-zA-Z0-9._-]{20,}',
    severity: 'HIGH',
    description: 'Bearer auth tokens',
  },
  DB_CONNECTION_STRING: {
    type: 'regex',
    pattern: '(?:mongodb|postgresql|mysql|mssql|redis|amqp)://[^\\s]+:[^\\s]+@[^\\s]+',
    severity: 'CRITICAL',
    description: 'Database connection strings with embedded credentials',
  },
  GENERIC_API_KEY: {
    type: 'regex',
    pattern:
      '(?:api[_-]?key|api[_-]?secret|token|auth[_-]?token|access[_-]?token|secret[_-]?key|password)\\s*[:=]\\s*[a-zA-Z0-9._-]{20,}',
    severity: 'HIGH',
    description: 'Generic API key/secret assignments',
  },
} as const satisfies Record<string, PiiPatternSpec>;

export type PiiPatternKey = keyof typeof PII_PATTERNS;
