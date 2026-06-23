/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Default Rules Aggregator
 *
 * Combines all rule categories into a single export.
 * To add a new category: create <name>.rules.ts and add it here.
 */

import { DetectionRule } from '../types.js';
import { PROMPT_INJECTION_RULES } from './prompt-injection.rules.js';
import { PII_RULES } from './pii.rules.js';
import { SUSPICIOUS_RULES } from './suspicious.rules.js';

export interface DefaultRules {
  promptInjection: DetectionRule[];
  pii: DetectionRule[];
  suspicious: DetectionRule[];
}

export const DEFAULT_RULES: DefaultRules = {
  promptInjection: PROMPT_INJECTION_RULES,
  pii: PII_RULES,
  suspicious: SUSPICIOUS_RULES,
};

export { PROMPT_INJECTION_RULES, PII_RULES, SUSPICIOUS_RULES };
