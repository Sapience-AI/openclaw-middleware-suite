/**
 * CLI: guardrail:toggle — enable, disable, dry-run mode switching
 */

import { ConfigStore } from '../storage/ConfigStore.js';

export const guardrailToggleCommand = async (setting: string) => {
  const config = await ConfigStore.load();
  console.log('');

  if (setting === 'enable') {
    config.enabled = true;
    config.dryRunMode = false;
    console.log('✅ GUARDRAIL ENABLED — Input scanning is now ACTIVE.');
  } else if (setting === 'disable') {
    config.enabled = false;
    console.log('❌ GUARDRAIL DISABLED — Input scanning is now BYPASSED.');
  } else if (setting === 'dry-run') {
    config.dryRunMode = !config.dryRunMode;
    if (config.dryRunMode) {
      console.log('🔍 DRY-RUN MODE ENABLED — Detections logged but not blocked.');
    } else {
      console.log('🚫 ENFORCEMENT MODE ENABLED — HIGH/CRITICAL detections will be blocked.');
    }
  } else {
    console.log(`❌ ERROR: Unknown setting "${setting}". Use: enable, disable, or dry-run`);
    return;
  }

  await ConfigStore.save(config);
  console.log('');
};
