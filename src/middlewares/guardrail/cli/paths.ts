/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: guardrail:paths — manage sensitive path blocklist
 *
 * Commands:
 *   sai guardrail paths status          — show path blocklist status
 *   sai guardrail paths toggle          — enable/disable path blocking
 *   sai guardrail paths block <pattern> — add pattern to blocklist
 *   sai guardrail paths allow <pattern> — add pattern to allowlist
 *   sai guardrail paths remove <pattern>— remove from blocklist or allowlist
 *   sai guardrail paths list            — list all blocked/allowed patterns
 */

import { ConfigStore } from '../storage/ConfigStore.js';
import { DEFAULT_SENSITIVE_PATH_CONFIG } from '../guards/sensitive-paths.js';

export const pathsStatusCommand = async () => {
  const config = await ConfigStore.load();
  const paths = config.sensitivePaths ?? DEFAULT_SENSITIVE_PATH_CONFIG;

  console.log('');
  console.log('🔒 Sensitive Path Blocklist');
  console.log('═'.repeat(60));
  console.log(`State:    ${paths.enabled ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`Action:   ${paths.action === 'BLOCK' ? '🚫 BLOCK' : '⚠️ WARN'}`);
  console.log(`Blocked:  ${paths.blockedPaths.length} pattern(s)`);
  console.log(`Allowed:  ${paths.allowedPaths.length} pattern(s) (overrides)`);
  console.log('');
};

export const pathsToggleCommand = async () => {
  const config = await ConfigStore.load();
  if (!config.sensitivePaths) config.sensitivePaths = { ...DEFAULT_SENSITIVE_PATH_CONFIG };
  config.sensitivePaths.enabled = !config.sensitivePaths.enabled;
  await ConfigStore.save(config);

  console.log('');
  if (config.sensitivePaths.enabled) {
    console.log('✅ Sensitive path blocking ENABLED.');
  } else {
    console.log('❌ Sensitive path blocking DISABLED.');
  }
  console.log('');
};

export const pathsBlockCommand = async (pattern: string) => {
  const config = await ConfigStore.load();
  if (!config.sensitivePaths) config.sensitivePaths = { ...DEFAULT_SENSITIVE_PATH_CONFIG };

  if (config.sensitivePaths.blockedPaths.includes(pattern)) {
    console.log(`\nℹ️  "${pattern}" is already in the blocklist.\n`);
    return;
  }

  config.sensitivePaths.blockedPaths.push(pattern);
  await ConfigStore.save(config);

  console.log(`\n🚫 Added "${pattern}" to sensitive path blocklist.\n`);
};

export const pathsAllowCommand = async (pattern: string) => {
  const config = await ConfigStore.load();
  if (!config.sensitivePaths) config.sensitivePaths = { ...DEFAULT_SENSITIVE_PATH_CONFIG };

  if (config.sensitivePaths.allowedPaths.includes(pattern)) {
    console.log(`\nℹ️  "${pattern}" is already in the allowlist.\n`);
    return;
  }

  config.sensitivePaths.allowedPaths.push(pattern);
  await ConfigStore.save(config);

  console.log(`\n✅ Added "${pattern}" to sensitive path allowlist (overrides blocklist).\n`);
};

export const pathsRemoveCommand = async (pattern: string) => {
  const config = await ConfigStore.load();
  if (!config.sensitivePaths) config.sensitivePaths = { ...DEFAULT_SENSITIVE_PATH_CONFIG };

  const blockedIdx = config.sensitivePaths.blockedPaths.indexOf(pattern);
  const allowedIdx = config.sensitivePaths.allowedPaths.indexOf(pattern);

  if (blockedIdx === -1 && allowedIdx === -1) {
    console.log(`\n❌ "${pattern}" not found in blocklist or allowlist.\n`);
    return;
  }

  if (blockedIdx !== -1) {
    config.sensitivePaths.blockedPaths.splice(blockedIdx, 1);
    console.log(`\n🗑️  Removed "${pattern}" from blocklist.`);
  }
  if (allowedIdx !== -1) {
    config.sensitivePaths.allowedPaths.splice(allowedIdx, 1);
    console.log(`🗑️  Removed "${pattern}" from allowlist.`);
  }

  await ConfigStore.save(config);
  console.log('');
};

export const pathsListCommand = async () => {
  const config = await ConfigStore.load();
  const paths = config.sensitivePaths ?? DEFAULT_SENSITIVE_PATH_CONFIG;

  console.log('');
  console.log('🚫 Blocked Paths');
  console.log('─'.repeat(40));
  if (paths.blockedPaths.length === 0) {
    console.log('  (none)');
  } else {
    for (const p of paths.blockedPaths) {
      console.log(`  🔒 ${p}`);
    }
  }
  console.log(`\n  Total: ${paths.blockedPaths.length} pattern(s)`);

  console.log('');
  console.log('✅ Allowed Paths (overrides)');
  console.log('─'.repeat(40));
  if (paths.allowedPaths.length === 0) {
    console.log('  (none)');
  } else {
    for (const p of paths.allowedPaths) {
      console.log(`  ✅ ${p}`);
    }
  }
  console.log(`\n  Total: ${paths.allowedPaths.length} pattern(s)\n`);
};
