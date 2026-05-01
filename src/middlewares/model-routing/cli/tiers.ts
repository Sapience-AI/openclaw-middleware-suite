/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: sai router tiers — View/edit per-profile tier-to-model mappings.
 *
 * Each routing profile (eco / premium / agentic) carries its own tier→model
 * map persisted under `tierOverridesByProfile[profile]` in
 * sapience-ai-suite.json. Without `--profile`, this command shows all three
 * profiles. With `--profile <p>`, it scopes a view or edit to that one
 * profile.
 */

import chalk from 'chalk';
import { ModelRoutingPolicyStore } from '../storage/ModelRoutingPolicyStore.js';
import { Tier, TIER_ORDER, TierModelConfig } from '../types.js';
import {
  PROFILE_CONFIGS,
  VALID_PROFILES,
  isValidProfile,
  RoutingProfile,
} from '../selection/profiles.js';

export async function routerTiersCommand(opts: { set?: string; profile?: string }): Promise<void> {
  const data = await ModelRoutingPolicyStore.load();
  const byProfile = data.tierOverridesByProfile ?? {};

  // ── Set tier primary model (scoped to a single profile) ─────────────────
  if (opts.set) {
    if (!opts.profile) {
      console.error(
        chalk.red('--set requires --profile <eco|premium|agentic> to scope the write.')
      );
      console.error(
        chalk.dim('Example: sai router tiers --profile premium --set "COMPLEX claude-opus-4-6"')
      );
      process.exit(1);
    }
    if (!isValidProfile(opts.profile)) {
      console.error(
        chalk.red(`Invalid profile: ${opts.profile}. Must be one of: ${VALID_PROFILES.join(', ')}`)
      );
      process.exit(1);
    }
    const profile = opts.profile as RoutingProfile;

    const parts = opts.set.split(/\s+/);
    if (parts.length < 2) {
      console.error(chalk.red('Usage: --set "<TIER> <model>"'));
      process.exit(1);
    }
    const tier = parts[0].toUpperCase() as Tier;
    const model = parts.slice(1).join(' ');

    if (!TIER_ORDER.includes(tier)) {
      console.error(chalk.red(`Invalid tier: ${tier}. Must be one of: ${TIER_ORDER.join(', ')}`));
      process.exit(1);
    }

    const profileSlot = (byProfile[profile] ?? {}) as Partial<Record<Tier, TierModelConfig>>;
    const existing = profileSlot[tier] || PROFILE_CONFIGS[profile][tier];
    await ModelRoutingPolicyStore.update({
      tierOverridesByProfile: {
        ...byProfile,
        [profile]: {
          ...profileSlot,
          [tier]: { primary: model, fallbacks: existing.fallbacks },
        },
      },
    });
    console.log(chalk.green(`Set ${profile} ${tier} primary model to ${model}`));
    return;
  }

  // ── Display tier mappings ───────────────────────────────────────────────
  const profilesToShow: RoutingProfile[] = opts.profile
    ? isValidProfile(opts.profile)
      ? [opts.profile as RoutingProfile]
      : (() => {
          console.error(
            chalk.red(
              `Invalid profile: ${opts.profile}. Must be one of: ${VALID_PROFILES.join(', ')}`
            )
          );
          process.exit(1);
        })()
    : [...VALID_PROFILES];

  console.log('');
  console.log(chalk.bold.cyan('='.repeat(70)));
  console.log(chalk.bold.cyan('   Tier-to-Model Mappings'));
  console.log(chalk.bold.cyan('='.repeat(70)));

  for (const profile of profilesToShow) {
    const slot = (byProfile[profile] ?? {}) as Partial<Record<Tier, TierModelConfig>>;
    const defaults = PROFILE_CONFIGS[profile];
    console.log('');
    console.log(chalk.bold(`  ${profile}`));
    for (const tier of TIER_ORDER) {
      const override = slot[tier];
      const effective = override || defaults[tier];
      const isOverridden = override !== undefined;
      console.log(
        `    ${tierColor(tier)(tier.padEnd(12))} ` +
          chalk.white(effective.primary) +
          (isOverridden ? chalk.yellow(' (configured)') : chalk.dim(' (default)'))
      );
      if (effective.fallbacks.length > 0) {
        console.log(
          `    ${' '.repeat(12)} ${chalk.dim('fallbacks: ' + effective.fallbacks.join(', '))}`
        );
      }
    }
  }

  console.log('');
  console.log(chalk.dim(`Store: ${ModelRoutingPolicyStore.getPath()}`));
  console.log('');
}

function tierColor(tier: Tier) {
  switch (tier) {
    case 'SIMPLE':
      return chalk.green;
    case 'STANDARD':
      return chalk.blue;
    case 'COMPLEX':
      return chalk.yellow;
    case 'REASONING':
      return chalk.magenta;
    default:
      return chalk.white;
  }
}
