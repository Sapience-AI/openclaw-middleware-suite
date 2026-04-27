/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: guardrail:egress — manage network egress control
 *
 * Commands:
 *   sai guardrail egress status                  — show egress policy
 *   sai guardrail egress toggle                  — enable/disable egress control
 *   sai guardrail egress allow <domain>          — add domain to allowlist
 *   sai guardrail egress remove <domain>         — remove domain from allowlist
 *   sai guardrail egress list                    — list allowed domains
 *   sai guardrail egress data-sending <on|off>   — toggle block-data-sending
 *   sai guardrail egress private-ips <on|off>    — toggle block-private-IPs
 */

import { ConfigStore } from '../storage/ConfigStore.js';
import { DEFAULT_EGRESS_CONFIG } from '../guards/egress-control.js';

export const egressStatusCommand = async () => {
  const config = await ConfigStore.load();
  const egress = config.egressControl ?? DEFAULT_EGRESS_CONFIG;

  console.log('');
  console.log('🌐 Network Egress Control');
  console.log('═'.repeat(60));
  console.log(`State:           ${egress.enabled ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(
    `Default Action:  ${egress.defaultAction === 'BLOCK' ? '🚫 BLOCK' : '⚠️ WARN'} (for unlisted domains)`
  );
  console.log(`Block Data Send: ${egress.blockDataSending ? '✅ ON' : '❌ OFF'}`);
  console.log(`Block Private IP:${egress.blockPrivateIPs ? '✅ ON' : '❌ OFF'}`);
  console.log(`Allowed Domains: ${egress.allowedDomains.length}`);
  console.log('');
};

export const egressToggleCommand = async () => {
  const config = await ConfigStore.load();
  if (!config.egressControl) config.egressControl = { ...DEFAULT_EGRESS_CONFIG };
  config.egressControl.enabled = !config.egressControl.enabled;
  await ConfigStore.save(config);

  console.log('');
  if (config.egressControl.enabled) {
    console.log('✅ Network egress control ENABLED — unlisted domains will be blocked.');
  } else {
    console.log('❌ Network egress control DISABLED — all network commands allowed.');
  }
  console.log('');
};

export const egressAllowCommand = async (domain: string) => {
  const config = await ConfigStore.load();
  if (!config.egressControl) config.egressControl = { ...DEFAULT_EGRESS_CONFIG };

  if (config.egressControl.allowedDomains.includes(domain)) {
    console.log(`\nℹ️  "${domain}" is already in the allowlist.\n`);
    return;
  }

  config.egressControl.allowedDomains.push(domain);
  await ConfigStore.save(config);

  console.log(`\n✅ Added "${domain}" to egress allowlist.\n`);
};

export const egressRemoveCommand = async (domain: string) => {
  const config = await ConfigStore.load();
  if (!config.egressControl) config.egressControl = { ...DEFAULT_EGRESS_CONFIG };

  const idx = config.egressControl.allowedDomains.indexOf(domain);
  if (idx === -1) {
    console.log(`\n❌ "${domain}" is not in the allowlist.\n`);
    return;
  }

  config.egressControl.allowedDomains.splice(idx, 1);
  await ConfigStore.save(config);

  console.log(`\n🗑️  Removed "${domain}" from egress allowlist.\n`);
};

export const egressListCommand = async () => {
  const config = await ConfigStore.load();
  const egress = config.egressControl ?? DEFAULT_EGRESS_CONFIG;

  console.log('');
  console.log('🌐 Allowed Domains');
  console.log('─'.repeat(40));
  if (egress.allowedDomains.length === 0) {
    console.log('  (none — all domains will be blocked)');
  } else {
    for (const domain of egress.allowedDomains) {
      console.log(`  ✅ ${domain}`);
    }
  }
  console.log(`\n  Total: ${egress.allowedDomains.length} domain(s)\n`);
};

export const egressDataSendingCommand = async (onOff: string) => {
  const config = await ConfigStore.load();
  if (!config.egressControl) config.egressControl = { ...DEFAULT_EGRESS_CONFIG };

  const value = onOff.toLowerCase() === 'on' || onOff === 'true' || onOff === '1';
  config.egressControl.blockDataSending = value;
  await ConfigStore.save(config);

  console.log(`\n${value ? '✅' : '❌'} Block data-sending commands: ${value ? 'ON' : 'OFF'}\n`);
};

export const egressPrivateIpsCommand = async (onOff: string) => {
  const config = await ConfigStore.load();
  if (!config.egressControl) config.egressControl = { ...DEFAULT_EGRESS_CONFIG };

  const value = onOff.toLowerCase() === 'on' || onOff === 'true' || onOff === '1';
  config.egressControl.blockPrivateIPs = value;
  await ConfigStore.save(config);

  console.log(`\n${value ? '✅' : '❌'} Block private/internal IPs: ${value ? 'ON' : 'OFF'}\n`);
};
