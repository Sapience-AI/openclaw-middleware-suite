/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: guardrail:toggle — toggle dry-run mode.
 *
 * Enabling/disabling the guardrail middleware itself is done through the
 * dashboard or `sai init` (which write the per-middleware flag in
 * sapience-ai-suite.json). There is no guardrail-scoped enabled flag.
 */

import { ConfigStore } from '../storage/ConfigStore.js';

export const guardrailToggleCommand = async (setting: string) => {
  const config = await ConfigStore.load();
  console.log('');

  if (setting === 'dry-run') {
    config.dryRunMode = !config.dryRunMode;
    if (config.dryRunMode) {
      console.log('🔍 DRY-RUN MODE ENABLED — Detections logged but not blocked.');
    } else {
      console.log('🚫 ENFORCEMENT MODE ENABLED — HIGH/CRITICAL detections will be blocked.');
    }
  } else if (setting === 'enable' || setting === 'disable') {
    console.log(
      `ℹ️  Guardrail is turned on/off via the dashboard or 'sai init' ` +
        `(not from this command). Use 'sai ${setting}' only if you want to ` +
        `${setting} the whole Sapience AI Suite.`
    );
    return;
  } else {
    console.log(`❌ ERROR: Unknown setting "${setting}". Use: dry-run`);
    return;
  }

  await ConfigStore.save(config);
  console.log('');
};
