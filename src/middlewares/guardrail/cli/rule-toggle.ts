/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: guardrail:rule:toggle — enable or disable a single rule by name
 */

import { ConfigStore } from '../storage/ConfigStore.js';

export const guardrailRuleToggleCommand = async (ruleName: string, enabled?: boolean) => {
  const config = await ConfigStore.load();
  console.log('');

  let found = false;

  for (const category of [
    config.rules.promptInjection,
    config.rules.pii,
    config.rules.suspicious,
  ]) {
    const rule = category.find((r) => r.name === ruleName);
    if (rule) {
      rule.enabled = enabled !== undefined ? enabled : !rule.enabled;

      const status = rule.enabled ? '✅ ENABLED' : '❌ DISABLED';
      console.log(`${status} — ${ruleName}`);
      console.log(`   Severity: ${rule.severity}, Action: ${rule.action}`);

      found = true;
      break;
    }
  }

  if (!found) {
    console.log(`❌ Rule not found: ${ruleName}`);
    return;
  }

  await ConfigStore.save(config);
  console.log('');
};
