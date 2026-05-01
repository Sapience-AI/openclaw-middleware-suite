/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: guardrail output — manage the output scrubber (assistant response metadata filtering)
 */

import { ConfigStore } from '../storage/ConfigStore.js';
import { getPatternCount } from '../scrubbers/MetadataScrubber.js';

export const outputStatusCommand = async () => {
  const config = await ConfigStore.load();
  const scrubber = config.outputScrubber;
  const { builtin, groups } = getPatternCount();

  console.log('');
  console.log('Output Scrubber Status');
  console.log('='.repeat(60));
  console.log(`State:   ${scrubber?.enabled ? 'ENABLED' : 'DISABLED'}`);
  console.log(
    `Mode:    ${scrubber?.dryRunMode ? 'DRY RUN (Logging Only)' : 'ACTIVE (Scrubbing Enabled)'}`
  );
  console.log('');

  console.log('Pattern Groups');
  console.log('-'.repeat(40));
  for (const group of groups) {
    console.log(`  ${group}`);
  }
  console.log(`  Total built-in:  ${builtin} patterns`);
  console.log(`  Custom patterns: ${scrubber?.customPatterns?.length ?? 0}`);
  console.log('');

  console.log('Replacement');
  console.log('-'.repeat(40));
  const rt = scrubber?.replacementText;
  console.log(`  Text: ${rt ? `"${rt}"` : '(empty -- seamless removal)'}`);
  console.log('');

  console.log('Config');
  console.log('-'.repeat(40));
  console.log(`  Path: ${ConfigStore.getPath()}`);
  console.log('');
};

export const outputToggleCommand = async (state: string) => {
  const config = await ConfigStore.load();
  if (!config.outputScrubber) {
    config.outputScrubber = {
      enabled: true,
      dryRunMode: false,
      replacementText: '',
      customPatterns: [],
    };
  }

  switch (state.toLowerCase()) {
    case 'enable':
    case 'on':
      config.outputScrubber.enabled = true;
      config.outputScrubber.dryRunMode = false;
      await ConfigStore.save(config);
      console.log('Output scrubber ENABLED (active scrubbing)');
      break;

    case 'disable':
    case 'off':
      config.outputScrubber.enabled = false;
      await ConfigStore.save(config);
      console.log('Output scrubber DISABLED');
      break;

    case 'dry-run':
    case 'dryrun':
      config.outputScrubber.enabled = true;
      config.outputScrubber.dryRunMode = true;
      await ConfigStore.save(config);
      console.log('Output scrubber DRY RUN (logging only, no modifications)');
      break;

    default:
      console.log('Usage: sai guardrail output toggle <enable|disable|dry-run>');
      break;
  }
};
