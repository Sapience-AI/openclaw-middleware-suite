/**
 * CLI: guardrail:list — enumerate rules by category with severity and action
 */

import { ConfigStore } from '../storage/ConfigStore.js';

export const guardrailListCommand = async (category?: string) => {
  const config = await ConfigStore.load();

  console.log('');
  console.log(`🔍 Input Guardrail Rules — ${category || 'All'}`);
  console.log('═'.repeat(60));

  const categories = category
    ? { [category]: config.rules[category as keyof typeof config.rules] }
    : config.rules;

  for (const [catName, rules] of Object.entries(categories)) {
    if (!rules) {
      console.log(`\n❌ Unknown category: ${catName}`);
      continue;
    }

    console.log('');
    console.log(`📂 ${catName} (${rules.length} rules)`);
    console.log('─'.repeat(40));

    for (const rule of rules) {
      const status = rule.enabled ? '✅' : '❌';
      const severityEmoji =
        rule.severity === 'CRITICAL'
          ? '🔴'
          : rule.severity === 'HIGH'
            ? '🟠'
            : rule.severity === 'MEDIUM'
              ? '🟡'
              : '🟢';
      const confTag = rule.confidence === 'medium' ? ' (2+sig)' : '';

      console.log(
        `${status} ${severityEmoji} ${rule.name} [${rule.type}] → ${rule.action}${confTag}`
      );
      if (rule.description) {
        console.log(`   ${rule.description}`);
      }
    }
  }
  console.log('');
};
