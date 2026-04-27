/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: guardrail:reset — restore all rules to factory defaults
 */

import { ConfigStore, DEFAULT_GUARDRAIL_CONFIG } from '../storage/ConfigStore.js';

export const guardrailResetCommand = async () => {
  console.log('');
  console.log('⚠️ RESET GUARDRAIL TO DEFAULTS');
  console.log('─'.repeat(40));

  const freshConfig = JSON.parse(JSON.stringify(DEFAULT_GUARDRAIL_CONFIG));
  await ConfigStore.save(freshConfig);

  const totalRules =
    freshConfig.rules.promptInjection.length +
    freshConfig.rules.pii.length +
    freshConfig.rules.suspicious.length;

  console.log(`✅ Reset complete — ${totalRules} rules restored to factory defaults`);
  console.log(`   Version: ${freshConfig.version}`);
  console.log(`   Mode: ${freshConfig.dryRunMode ? 'DRY RUN' : 'ENFORCEMENT'}`);
  console.log('');
};
