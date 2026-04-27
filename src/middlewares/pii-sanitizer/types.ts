/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * PII Sanitizer Middleware — Type Definitions
 *
 * Core Middleware-interface types are imported from the suite's canonical
 * `src/types.ts` so the escalate channel and other interface extensions
 * stay in one place. Only PII-specific types (DlpPolicy, DlpRule, etc.)
 * live in this file.
 */

// Re-export canonical interface types for any PII-internal consumers that
// still import them from `./types.js`.
export type { Middleware, MiddlewareContext, MiddlewareResult } from '../../types.js';

/**
 * Data classification levels based on risk and impact.
 */
export type SeverityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * Possible actions the DLP engine can take when a match is found.
 */
export type ScannerAction = 'ALLOW' | 'REDACT' | 'ESCALATE' | 'BLOCK';

export interface DlpDetection {
  originalPattern: string; // The regex or pattern name that matched (e.g., 'credit_card')
  matchedString: string;
  startIndex: number;
  endIndex: number;
  severity: SeverityLevel;
  action: ScannerAction;
  replacementText?: string; // E.g., [REDACTED_CC] or sk-****123
}

export interface DlpRule {
  name: string;
  type: 'regex' | 'heuristic' | 'prefix';
  pattern: string;
  severity: SeverityLevel;
  action: ScannerAction;
  enabled: boolean;
  description?: string; // Human-readable explanation of what this rule protects
}

export type FieldPolicy = 'SCALABLE' | 'VALIDATE' | 'IGNORE';

export interface ToolFieldPolicy {
  [fieldName: string]: FieldPolicy;
}

export interface DlpPolicy {
  version: string;
  dryRunMode: boolean; // If true, log violations but do not redact/block
  globalRules: DlpRule[];
  toolPolicies: {
    [moduleName: string]: {
      [methodName: string]: {
        fields: ToolFieldPolicy;
        additionalRules?: DlpRule[]; // Tool-specific overrides or additions
      };
    };
  };
}
