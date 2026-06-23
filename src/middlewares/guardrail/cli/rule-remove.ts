/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: guardrail:rule:remove — remove a detection rule by name
 */

import { ConfigStore } from '../storage/ConfigStore.js';

export const guardrailRuleRemoveCommand = async (ruleName: string) => {
  const config = await ConfigStore.load();
  console.log('');

  let found = false;

  for (const [key, category] of Object.entries(config.rules)) {
    const initialLen = category.length;
    const filtered = category.filter((r: any) => r.name !== ruleName);
    if (filtered.length < initialLen) {
      (config.rules as any)[key] = filtered;
      found = true;
      break;
    }
  }

  if (!found) {
    console.log(`❌ Rule not found: ${ruleName}`);
    return;
  }

  await ConfigStore.save(config);
  console.log(`🗑️ RULE REMOVED — ${ruleName}`);
  console.log('');
};
