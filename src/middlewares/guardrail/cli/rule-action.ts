/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: guardrail:rule:action — change the action of a rule by name
 *
 * Usage:
 *   sai guardrail rule-action ignore_instructions BLOCK
 *   sai guardrail rule-action ignore_instructions WARN
 *   sai guardrail rule-action ignore_instructions LOG
 */

import { ConfigStore } from '../storage/ConfigStore.js';
import { DetectionAction } from '../types.js';

const VALID_ACTIONS: DetectionAction[] = ['BLOCK', 'WARN', 'LOG'];

export const guardrailRuleActionCommand = async (ruleName: string, action: string) => {
  const normalizedAction = action.toUpperCase() as DetectionAction;
  console.log('');

  if (!VALID_ACTIONS.includes(normalizedAction)) {
    console.log(`❌ Invalid action: "${action}". Use: ${VALID_ACTIONS.join(', ')}`);
    console.log('');
    console.log('  BLOCK → Redact/reject matched content');
    console.log('  WARN  → Flag for human review (HITL escalation)');
    console.log('  LOG   → Log only, allow through');
    console.log('');
    return;
  }

  const config = await ConfigStore.load();

  let found = false;
  let oldAction = '';
  let category = '';

  for (const [catName, rules] of Object.entries(config.rules)) {
    const rule = rules.find((r: any) => r.name === ruleName);
    if (rule) {
      oldAction = rule.action;
      rule.action = normalizedAction as DetectionAction;
      category = catName;
      found = true;
      break;
    }
  }

  if (!found) {
    console.log(`❌ Rule not found: "${ruleName}"`);
    console.log('');
    console.log('Tip: Run "sai guardrail list" to see all available rule names.');
    console.log('');
    return;
  }

  if (oldAction === normalizedAction) {
    console.log(`ℹ️  Rule "${ruleName}" is already set to ${normalizedAction}. No change needed.`);
    console.log('');
    return;
  }

  await ConfigStore.save(config);

  const actionEmoji =
    normalizedAction === 'BLOCK' ? '🚫' : normalizedAction === 'WARN' ? '⚠️' : '📋';
  console.log(`${actionEmoji} RULE ACTION UPDATED — ${ruleName}`);
  console.log(`   Category: ${category}`);
  console.log(`   Action:   ${oldAction} → ${normalizedAction}`);
  console.log('');
  console.log(`   Changes take effect immediately (config is reloaded on each scan).`);
  console.log('');
};
