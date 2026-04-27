/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * PII Detection Rules — guardrail's wrapper around the shared catalog.
 *
 * Pattern strings live in `src/shared/pii-patterns.ts` (the single source
 * of truth shared with pii-sanitizer). This file maps each catalog entry
 * to a guardrail-specific `DetectionRule` (action + confidence + name)
 * and adds rules that are guardrail-only (e.g. heuristic entropy).
 */

import { DetectionRule, DetectionAction, ConfidenceLevel } from '../types.js';
import { PII_PATTERNS, PiiPatternKey } from '../../pii-sanitizer/pii-patterns.js';

interface GuardrailPiiBinding {
  /** Stable user-facing name persisted in guardrail/config.json */
  name: string;
  action: DetectionAction;
  confidence?: ConfidenceLevel;
}

const BINDINGS: Record<PiiPatternKey, GuardrailPiiBinding> = {
  PHONE_NUMBER: { name: 'phone_number', action: 'LOG' },
  EMAIL: { name: 'email_address', action: 'LOG' },
  CREDIT_CARD: { name: 'credit_card', action: 'BLOCK' },
  SSN: { name: 'ssn', action: 'BLOCK' },
  IBAN: { name: 'iban', action: 'WARN' },
  IP_ADDRESS: { name: 'ip_address', action: 'LOG', confidence: 'medium' },
  AWS_ACCESS_KEY_ID: { name: 'aws_key', action: 'BLOCK' },
  OPENAI_KEY: { name: 'openai_key', action: 'BLOCK' },
  ANTHROPIC_KEY: { name: 'anthropic_key', action: 'BLOCK' },
  HUGGINGFACE_KEY: { name: 'huggingface_key', action: 'BLOCK' },
  SLACK_TOKEN: { name: 'slack_token', action: 'BLOCK' },
  AWS_SECRET_ACCESS_KEY: { name: 'aws_secret_key', action: 'BLOCK' },
  GITHUB_TOKEN: { name: 'github_token', action: 'BLOCK' },
  STRIPE_KEY: { name: 'stripe_key', action: 'BLOCK' },
  SENDGRID_KEY: { name: 'sendgrid_key', action: 'BLOCK' },
  NPM_TOKEN: { name: 'npm_token', action: 'BLOCK' },
  GCP_KEY: { name: 'gcp_key', action: 'BLOCK' },
  SLACK_WEBHOOK: { name: 'slack_webhook', action: 'WARN' },
  PRIVATE_KEY_HEADER: { name: 'private_key_header', action: 'BLOCK' },
  JWT_TOKEN: { name: 'jwt_token', action: 'WARN' },
  BEARER_TOKEN: { name: 'bearer_token', action: 'WARN' },
  DB_CONNECTION_STRING: { name: 'db_connection_string', action: 'BLOCK' },
  GENERIC_API_KEY: { name: 'generic_api_key', action: 'WARN' },
};

const CATALOG_RULES: DetectionRule[] = (Object.keys(BINDINGS) as PiiPatternKey[]).map((key) => {
  const spec = PII_PATTERNS[key];
  const binding = BINDINGS[key];
  return {
    name: binding.name,
    type: spec.type,
    pattern: spec.pattern,
    severity: spec.severity,
    action: binding.action,
    enabled: true,
    confidence: binding.confidence ?? 'high',
    description: spec.description,
  };
});

// ── Guardrail-only rules (not in shared catalog) ─────────────────
const LOCAL_RULES: DetectionRule[] = [
  {
    name: 'high_entropy_secret',
    type: 'heuristic',
    pattern: '',
    severity: 'HIGH',
    action: 'WARN',
    enabled: true,
    confidence: 'high',
    description: 'Detects high-entropy strings likely to be secrets (Shannon entropy >= threshold)',
  },
];

export const PII_RULES: DetectionRule[] = [...CATALOG_RULES, ...LOCAL_RULES];
