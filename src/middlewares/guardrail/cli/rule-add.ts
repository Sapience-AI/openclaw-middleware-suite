/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: guardrail:rule:add — add or update a detection rule in a category
 */

import { ConfigStore } from '../storage/ConfigStore.js';
import { DetectionRule, SeverityLevel } from '../types.js';

export const guardrailRuleAddCommand = async (
  name: string,
  category: string,
  options: Record<string, any>
) => {
  const config = await ConfigStore.load();
  console.log('');

  const validCategories = ['promptInjection', 'pii', 'suspicious'];
  if (!validCategories.includes(category)) {
    console.log(`❌ ERROR: Invalid category. Use: ${validCategories.join(', ')}`);
    return;
  }

  const rule: DetectionRule = {
    name,
    type: options.type || 'regex',
    pattern: options.pattern || '',
    severity: (options.severity?.toUpperCase() || 'MEDIUM') as SeverityLevel,
    action: options.action?.toUpperCase() || 'LOG',
    enabled: true,
    confidence: options.confidence || 'high',
    description: options.description,
  };

  const catKey = category as keyof typeof config.rules;
  const existingIndex = config.rules[catKey].findIndex((r) => r.name === name);
  const isUpdate = existingIndex >= 0;

  if (isUpdate) {
    config.rules[catKey][existingIndex] = rule;
  } else {
    config.rules[catKey].push(rule);
  }

  await ConfigStore.save(config);

  const title = isUpdate ? '✏️ RULE UPDATED' : '➕ RULE ADDED';
  console.log(`${title} — ${name}`);
  console.log(`  Type:       ${rule.type}`);
  console.log(`  Severity:   ${rule.severity}`);
  console.log(`  Action:     ${rule.action}`);
  console.log(`  Confidence: ${rule.confidence}`);
  console.log(`  Category:   ${category}`);
  if (rule.description) console.log(`  Purpose:    ${rule.description}`);
  console.log('');
};
