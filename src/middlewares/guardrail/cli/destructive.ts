/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: guardrail:destructive — manage destructive command blocker
 *
 * Commands:
 *   sai guardrail destructive status             — show destructive blocker status
 *   sai guardrail destructive toggle              — enable/disable
 *   sai guardrail destructive list                — list all built-in patterns
 *   sai guardrail destructive add <pattern>       — add custom regex pattern
 *   sai guardrail destructive remove <pattern>    — remove custom pattern
 */

import { ConfigStore } from '../storage/ConfigStore.js';
import { DEFAULT_DESTRUCTIVE_CONFIG, getBuiltinPatterns } from '../guards/destructive-commands.js';

export const destructiveStatusCommand = async () => {
  const config = await ConfigStore.load();
  const destr = config.destructiveCommands ?? DEFAULT_DESTRUCTIVE_CONFIG;
  const builtins = getBuiltinPatterns();

  console.log('');
  console.log('💥 Destructive Command Blocker');
  console.log('═'.repeat(60));
  console.log(`State:     ${destr.enabled ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`Action:    ${destr.action === 'BLOCK' ? '🚫 BLOCK' : '⚠️ WARN'}`);
  console.log(`Built-in:  ${builtins.length} pattern(s)`);
  console.log(`Custom:    ${destr.customPatterns.length} pattern(s)`);
  console.log('');
};

export const destructiveToggleCommand = async () => {
  const config = await ConfigStore.load();
  if (!config.destructiveCommands) config.destructiveCommands = { ...DEFAULT_DESTRUCTIVE_CONFIG };
  config.destructiveCommands.enabled = !config.destructiveCommands.enabled;
  await ConfigStore.save(config);

  console.log('');
  if (config.destructiveCommands.enabled) {
    console.log('✅ Destructive command blocker ENABLED.');
  } else {
    console.log('❌ Destructive command blocker DISABLED.');
  }
  console.log('');
};

export const destructiveListCommand = async () => {
  const config = await ConfigStore.load();
  const destr = config.destructiveCommands ?? DEFAULT_DESTRUCTIVE_CONFIG;
  const builtins = getBuiltinPatterns();

  console.log('');
  console.log('💥 Built-in Destructive Patterns');
  console.log('─'.repeat(60));
  for (const pat of builtins) {
    const severity = pat.severity === 'CRITICAL' ? '🔴' : '🟡';
    console.log(
      `  ${severity} ${pat.name.padEnd(25)} ${pat.severity.padEnd(10)} ${pat.description}`
    );
  }
  console.log(`\n  Total: ${builtins.length} built-in pattern(s)`);

  if (destr.customPatterns.length > 0) {
    console.log('');
    console.log('📝 Custom Patterns');
    console.log('─'.repeat(60));
    for (const pat of destr.customPatterns) {
      console.log(`  🔧 ${pat}`);
    }
    console.log(`\n  Total: ${destr.customPatterns.length} custom pattern(s)`);
  }

  console.log('');
};

export const destructiveAddCommand = async (pattern: string) => {
  // Validate regex
  try {
    new RegExp(pattern, 'i');
  } catch {
    console.log(`\n❌ Invalid regex pattern: "${pattern}"\n`);
    return;
  }

  const config = await ConfigStore.load();
  if (!config.destructiveCommands) config.destructiveCommands = { ...DEFAULT_DESTRUCTIVE_CONFIG };

  if (config.destructiveCommands.customPatterns.includes(pattern)) {
    console.log(`\nℹ️  Pattern already exists.\n`);
    return;
  }

  config.destructiveCommands.customPatterns.push(pattern);
  await ConfigStore.save(config);

  console.log(`\n💥 Added custom destructive pattern: "${pattern}"\n`);
};

export const destructiveRemoveCommand = async (pattern: string) => {
  const config = await ConfigStore.load();
  if (!config.destructiveCommands) config.destructiveCommands = { ...DEFAULT_DESTRUCTIVE_CONFIG };

  const idx = config.destructiveCommands.customPatterns.indexOf(pattern);
  if (idx === -1) {
    console.log(`\n❌ Pattern not found in custom patterns.\n`);
    return;
  }

  config.destructiveCommands.customPatterns.splice(idx, 1);
  await ConfigStore.save(config);

  console.log(`\n🗑️  Removed custom destructive pattern.\n`);
};
