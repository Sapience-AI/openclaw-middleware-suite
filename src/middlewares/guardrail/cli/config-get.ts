/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: guardrail:config:get — print config file path and full JSON contents
 */

import { ConfigStore } from '../storage/ConfigStore.js';

export const guardrailConfigGetCommand = async () => {
  const config = await ConfigStore.load();
  const configPath = ConfigStore.getPath();

  console.log('');
  console.log('📄 Configuration File');
  console.log('═'.repeat(60));
  console.log(`Location: ${configPath}`);
  console.log('');
  console.log(JSON.stringify(config, null, 2));
  console.log('');
};
