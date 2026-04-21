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
