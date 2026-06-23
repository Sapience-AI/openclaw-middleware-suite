/*
 * Copyright (c) Knostic
 * Copyright (c) OpenGuardrails contributors
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); the
 * OpenGuardrails-derived portions are additionally subject to the
 * additional conditions stated in the upstream OpenGuardrails LICENSE.
 * You may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * This file contains code and detection rules derived from both:
 *   - OpenClaw Shield (https://github.com/knostic/openclaw-shield)
 *   - OpenGuardrails (https://github.com/openguardrails/openguardrails)
 * and has been modified for use in the OpenClaw Middleware Suite.
 * Individual rule entries are annotated inline with their respective origin.
 */

/**
 * Suspicious Pattern Rules — default detection rules
 *
 * Categories:
 * - Punctuation anomalies (repeated !, ?)
 * - Encoding hints (base64, cipher)
 * - Web attacks (SQL injection, XSS)
 * - Command injection (shell chaining)
 * - Sensitive file paths (.env, .ssh/, credentials)
 * - Destructive commands (rm -rf, dd if=, mkfs)
 */

import { DetectionRule } from '../types.js';

export const SUSPICIOUS_RULES: DetectionRule[] = [
  {
    name: 'multiple_exclamations',
    type: 'regex',
    pattern: '!{5,}',
    severity: 'LOW',
    action: 'LOG',
    enabled: true,
    confidence: 'medium',
    description: 'Detects multiple consecutive exclamation marks (needs 2+ signals)',
  },
  {
    name: 'multiple_questions',
    type: 'regex',
    pattern: '\\?{5,}',
    severity: 'LOW',
    action: 'LOG',
    enabled: true,
    confidence: 'medium',
    description: 'Detects multiple consecutive question marks (needs 2+ signals)',
  },
  {
    name: 'base64_hint',
    type: 'regex',
    pattern: 'base64|encoded|cipher|decrypt|obfuscate',
    severity: 'MEDIUM',
    action: 'LOG',
    enabled: true,
    confidence: 'medium',
    description: 'Detects encoding/cipher hints (needs 2+ signals)',
  },
  {
    name: 'sql_injection',
    type: 'regex',
    pattern: "('\\s*OR\\s+'|'\\s*;\\s*DROP|UNION\\s+SELECT|'\\s*--)",
    severity: 'HIGH',
    action: 'WARN',
    enabled: true,
    confidence: 'high',
    description: 'Detects SQL injection patterns (improved precision)',
  },
  {
    name: 'xss_attempt',
    type: 'regex',
    pattern: '<script[^>]*>|javascript\\s*:|on(?:load|error|click|mouse)\\s*=',
    severity: 'HIGH',
    action: 'WARN',
    enabled: true,
    confidence: 'high',
    description: 'Detects XSS/script injection attempts (from openguardrails S03)',
  },
  {
    name: 'command_injection',
    type: 'regex',
    pattern: '(?:;|&&|\\|\\|)\\s*(?:rm|cat|curl|wget|nc|netcat|python|node|bash|sh)\\s',
    severity: 'HIGH',
    action: 'WARN',
    enabled: true,
    confidence: 'high',
    description: 'Detects shell command injection via chaining operators',
  },
  {
    name: 'sensitive_file_path',
    type: 'regex',
    pattern:
      '(?:\\.env(?:\\.[a-z]+)?|\\.ssh/|id_rsa|id_ed25519|\\.aws/credentials|\\.kube/config|credentials\\.json|secrets?\\.[a-z]+|/etc/shadow|/etc/passwd|\\.npmrc|\\.pypirc)',
    severity: 'HIGH',
    action: 'WARN',
    enabled: true,
    confidence: 'high',
    description: 'Detects references to sensitive file paths (from openclaw-shield)',
  },
  {
    name: 'destructive_command',
    type: 'regex',
    pattern:
      '\\b(?:rm\\s+-rf|rmdir|unlink|del\\s+/|format\\s+|mkfs|dd\\s+if=|truncate|shred)(?:\\b|(?=[^a-zA-Z0-9_]))',
    severity: 'HIGH',
    action: 'WARN',
    enabled: true,
    confidence: 'high',
    description: 'Detects destructive shell commands (from openclaw-shield)',
  },
];
