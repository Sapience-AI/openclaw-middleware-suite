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
