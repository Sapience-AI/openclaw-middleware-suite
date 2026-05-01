/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: guardrail:status — display enabled state, mode, rule counts, severity breakdown,
 * and L2/L3 guard statuses. Enabled state reflects the per-middleware plugin
 * flag (flipped via the dashboard or `sai init`, stored in sapience-ai-suite.json).
 */

import { ConfigStore } from '../storage/ConfigStore.js';
import { DetectionRule } from '../types.js';
import { DEFAULT_SENSITIVE_PATH_CONFIG } from '../guards/sensitive-paths.js';
import { DEFAULT_EGRESS_CONFIG } from '../guards/egress-control.js';
import { DEFAULT_DESTRUCTIVE_CONFIG } from '../guards/destructive-commands.js';
import { getPluginMiddlewaresConfigSync } from '../../../plugin/config-manager.js';

export const guardrailStatusCommand = async () => {
  const config = await ConfigStore.load();
  const pluginEnabled = getPluginMiddlewaresConfigSync().guardrail === true;

  const countEnabled = (rules: DetectionRule[]) => rules.filter((r) => r.enabled).length;
  const allRules = [
    ...config.rules.promptInjection,
    ...config.rules.pii,
    ...config.rules.suspicious,
  ];

  console.log('');
  console.log('🛡️ Guardrail Status');
  console.log('═'.repeat(60));
  console.log(`State:   ${pluginEnabled ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(
    `Mode:    ${config.dryRunMode ? '🔍 DRY RUN (Logging Only)' : '🚫 ACTIVE (Blocking Enabled)'}`
  );
  console.log(`Unicode: ${config.unicodeNormalization ? '✅ NFKC + Homoglyph' : '❌ OFF'}`);
  console.log(`Entropy: >= ${config.entropyThreshold}`);
  console.log(`Version: ${config.version}`);
  console.log('');

  console.log('📋 Detection Rules');
  console.log('─'.repeat(40));
  console.log(`  Prompt Injection:  ${countEnabled(config.rules.promptInjection)} rules`);
  console.log(`  PII Detection:     ${countEnabled(config.rules.pii)} rules`);
  console.log(`  Suspicious:        ${countEnabled(config.rules.suspicious)} rules`);
  console.log(`  Total:             ${countEnabled(allRules)} / ${allRules.length} rules`);
  console.log('');

  console.log('📊 Severity Breakdown');
  console.log('─'.repeat(40));
  const bySeverity = new Map<string, number>();
  for (const rule of allRules.filter((r) => r.enabled)) {
    bySeverity.set(rule.severity, (bySeverity.get(rule.severity) || 0) + 1);
  }
  for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
    console.log(`  ${severity.padEnd(10)}: ${bySeverity.get(severity) || 0} rules`);
  }
  console.log('');

  // L2 Guards
  const sensitivePaths = config.sensitivePaths ?? DEFAULT_SENSITIVE_PATH_CONFIG;
  const egressControl = config.egressControl ?? DEFAULT_EGRESS_CONFIG;
  const destructiveCmd = config.destructiveCommands ?? DEFAULT_DESTRUCTIVE_CONFIG;

  console.log('🔒 L2 Guards (before_tool_call)');
  console.log('─'.repeat(40));
  console.log(
    `  Sensitive Paths:   ${sensitivePaths.enabled ? '✅ ON' : '❌ OFF'}  (${sensitivePaths.blockedPaths.length} patterns)`
  );
  console.log(
    `  Egress Control:    ${egressControl.enabled ? '✅ ON' : '❌ OFF'}  (${egressControl.allowedDomains.length} allowed domains)`
  );
  console.log(
    `  Destructive Cmds:  ${destructiveCmd.enabled ? '✅ ON' : '❌ OFF'}  (${destructiveCmd.customPatterns.length} custom patterns)`
  );
  console.log('');

  console.log('🔍 L3 Guards (before_message_write)');
  console.log('─'.repeat(40));
  console.log(`  Role Impersonation: ✅ ON  (always active)`);
  console.log(`  Canary Leakback:    ✅ ON  (in-memory tracker)`);
  console.log('');
};
