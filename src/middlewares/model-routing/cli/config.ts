/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: sai router config — View/edit scoring configuration.
 */

import chalk from 'chalk';
import { ModelRoutingDiscovery } from '../storage/ModelRoutingDiscovery.js';
import { ModelRoutingPolicyStore } from '../storage/ModelRoutingPolicyStore.js';
import { DEFAULT_SCORING_CONFIG } from '../config.js';
import { VALID_PROFILES, PROFILE_DESCRIPTIONS } from '../selection/profiles.js';

export async function routerConfigCommand(opts: {
  setWeight?: string;
  setBoundary?: string;
  setOverride?: string;
  enablePinning?: boolean;
  disablePinning?: boolean;
  enableCache?: boolean;
  disableCache?: boolean;
}): Promise<void> {
  const store = new ModelRoutingDiscovery();
  store.load();

  // ── Pinning / provider-cache toggles ────────────────────────────────────
  if (opts.enablePinning && opts.disablePinning) {
    console.error(chalk.red('Cannot pass --enable-pinning and --disable-pinning together.'));
    process.exit(1);
  }
  if (opts.enableCache && opts.disableCache) {
    console.error(chalk.red('Cannot pass --enable-cache and --disable-cache together.'));
    process.exit(1);
  }
  if (opts.enablePinning || opts.disablePinning) {
    const enabled = !!opts.enablePinning;
    await ModelRoutingPolicyStore.update({ sessionPinningEnabled: enabled });
    console.log(chalk.green(`Session pinning ${enabled ? 'enabled' : 'disabled'}.`));
    return;
  }
  if (opts.enableCache || opts.disableCache) {
    const enabled = !!opts.enableCache;
    await ModelRoutingPolicyStore.update({ providerCacheEnabled: enabled });
    console.log(chalk.green(`Provider prompt caching ${enabled ? 'enabled' : 'disabled'}.`));
    return;
  }

  // ── Set weight ──────────────────────────────────────────────────────────
  if (opts.setWeight) {
    const parts = opts.setWeight.split(/\s+/);
    if (parts.length !== 2) {
      console.error(chalk.red('Usage: --set-weight "<dimension> <weight>"'));
      process.exit(1);
    }
    const [dimName, weightStr] = parts;
    const weight = parseFloat(weightStr);
    if (isNaN(weight) || weight < 0 || weight > 1) {
      console.error(chalk.red('Weight must be a number between 0 and 1'));
      process.exit(1);
    }
    const validDim = DEFAULT_SCORING_CONFIG.dimensions.find((d) => d.name === dimName);
    if (!validDim) {
      console.error(chalk.red(`Unknown dimension: ${dimName}`));
      console.error(
        'Valid dimensions: ' + DEFAULT_SCORING_CONFIG.dimensions.map((d) => d.name).join(', ')
      );
      process.exit(1);
    }
    const currentWeights = store.getData().weightOverrides ?? {};
    await ModelRoutingPolicyStore.update({
      weightOverrides: { ...currentWeights, [dimName]: weight },
    });
    console.log(chalk.green(`Set ${dimName} weight to ${weight}`));
    return;
  }

  // ── Set boundary ────────────────────────────────────────────────────────
  if (opts.setBoundary) {
    const parts = opts.setBoundary.split(/\s+/);
    if (parts.length !== 2) {
      console.error(chalk.red('Usage: --set-boundary "<boundary> <value>"'));
      process.exit(1);
    }
    const [name, valStr] = parts;
    const value = parseFloat(valStr);
    if (isNaN(value)) {
      console.error(chalk.red('Value must be a number'));
      process.exit(1);
    }
    const validBoundaries = ['simpleStandard', 'standardComplex', 'complexReasoning'];
    if (!validBoundaries.includes(name)) {
      console.error(chalk.red(`Unknown boundary: ${name}`));
      console.error('Valid boundaries: ' + validBoundaries.join(', '));
      process.exit(1);
    }
    const currentBoundaries = store.getData().boundaryOverrides ?? {};
    await ModelRoutingPolicyStore.update({
      boundaryOverrides: { ...currentBoundaries, [name]: value },
    });
    console.log(chalk.green(`Set ${name} boundary to ${value}`));
    return;
  }

  // ── Set override threshold ─────────────────────────────────────────────
  // 4 fields, three numeric (`shortMessageChars`, `largeContextTokens`,
  // `reasoningKeywordMin`) and one tier-string (`structuredOutputMinTier`).
  // Tier names are normalized to upper-case so users can pass `standard`
  // or `STANDARD` interchangeably.
  if (opts.setOverride) {
    const parts = opts.setOverride.split(/\s+/);
    if (parts.length !== 2) {
      console.error(chalk.red('Usage: --set-override "<name> <value>"'));
      process.exit(1);
    }
    const [name, valStr] = parts;
    const numericFields = [
      'shortMessageChars',
      'largeContextTokens',
      'reasoningKeywordMin',
    ] as const;
    const tierFields = ['structuredOutputMinTier'] as const;
    const validFields = [...numericFields, ...tierFields];
    if (!validFields.includes(name as (typeof validFields)[number])) {
      console.error(chalk.red(`Unknown override field: ${name}`));
      console.error('Valid fields: ' + validFields.join(', '));
      process.exit(1);
    }
    const current = store.getData().overrideThresholds ?? {};
    const next: Record<string, unknown> = { ...current };
    if ((numericFields as readonly string[]).includes(name)) {
      const value = name === 'reasoningKeywordMin' ? parseInt(valStr, 10) : parseFloat(valStr);
      if (isNaN(value) || value < 0) {
        console.error(chalk.red('Value must be a non-negative number'));
        process.exit(1);
      }
      next[name] = value;
    } else {
      // structuredOutputMinTier — must be a valid Tier
      const tier = valStr.toUpperCase();
      const validTiers = ['SIMPLE', 'STANDARD', 'COMPLEX', 'REASONING'];
      if (!validTiers.includes(tier)) {
        console.error(chalk.red(`Invalid tier: ${valStr}`));
        console.error('Valid tiers: ' + validTiers.join(', '));
        process.exit(1);
      }
      next[name] = tier;
    }
    await ModelRoutingPolicyStore.update({
      overrideThresholds: next as Partial<import('../types.js').OverrideConfig>,
    });
    console.log(chalk.green(`Set ${name} override to ${next[name]}`));
    return;
  }

  // ── Display current config ──────────────────────────────────────────────
  const data = store.getData();

  console.log('');
  console.log(chalk.bold.cyan('='.repeat(70)));
  console.log(chalk.bold.cyan('   Model Routing Configuration'));
  console.log(chalk.bold.cyan('='.repeat(70)));
  console.log('');

  // Boundaries — same `<- N` marker for user-overridden values as overrides.
  const b = { ...DEFAULT_SCORING_CONFIG.boundaries, ...data.boundaryOverrides };
  const bOverride = (key: keyof typeof b) =>
    data.boundaryOverrides && key in data.boundaryOverrides
      ? chalk.yellow(` <- ${data.boundaryOverrides[key]}`)
      : '';
  console.log(chalk.bold('Tier Boundaries:'));
  console.log(`  SIMPLE    score < ${b.simpleStandard}${bOverride('simpleStandard')}`);
  console.log(
    `  STANDARD  ${b.simpleStandard} <= score < ${b.standardComplex}${bOverride('standardComplex')}`
  );
  console.log(
    `  COMPLEX   ${b.standardComplex} <= score < ${b.complexReasoning}${bOverride('complexReasoning')}`
  );
  console.log(`  REASONING score >= ${b.complexReasoning}`);
  console.log('');

  // Overrides — show effective values (default + user override). Persisted
  // overrides are highlighted with a yellow `<- N` marker on the same line
  // so a quick `sai router config` makes it obvious which thresholds the
  // user has tuned away from defaults.
  const effectiveOv = { ...DEFAULT_SCORING_CONFIG.overrides, ...data.overrideThresholds };
  const ovOverride = (key: keyof typeof effectiveOv) =>
    data.overrideThresholds && key in data.overrideThresholds
      ? chalk.yellow(`  <- ${data.overrideThresholds[key]}`)
      : '';
  console.log(chalk.bold('Hard Overrides:'));
  console.log(
    `  Reasoning keyword min:    ${effectiveOv.reasoningKeywordMin}${ovOverride('reasoningKeywordMin')}`
  );
  console.log(
    `  Large context tokens:     ${effectiveOv.largeContextTokens}${ovOverride('largeContextTokens')}`
  );
  console.log(
    `  Short message chars:      ${effectiveOv.shortMessageChars}${ovOverride('shortMessageChars')}`
  );
  console.log(
    `  Structured output min:    ${effectiveOv.structuredOutputMinTier}${ovOverride('structuredOutputMinTier')}`
  );
  console.log(`  Confidence threshold:     ${DEFAULT_SCORING_CONFIG.confidenceThreshold}`);
  console.log(`  System prompt scoring:    ${DEFAULT_SCORING_CONFIG.systemPromptScoring}`);
  console.log(`  Scoring message window:   ${DEFAULT_SCORING_CONFIG.scoringMessageWindow}`);
  console.log('');

  // Dimension weights
  console.log(chalk.bold('Dimension Weights:'));
  console.log('');
  console.log(
    chalk.dim(
      '  ' +
        'Dimension'.padEnd(24) +
        'Weight'.padEnd(10) +
        'Type'.padEnd(14) +
        'Dir'.padEnd(6) +
        'Override'
    )
  );
  console.log(chalk.dim('  ' + '-'.repeat(62)));

  for (const dim of DEFAULT_SCORING_CONFIG.dimensions) {
    const override = data.weightOverrides?.[dim.name];
    const effectiveWeight = override !== undefined ? override : dim.weight;
    const overrideStr = override !== undefined ? chalk.yellow(`<- ${override}`) : '';

    console.log(
      '  ' +
        chalk.white(dim.name.padEnd(24)) +
        chalk.cyan(effectiveWeight.toFixed(3).padEnd(10)) +
        chalk.dim(dim.kind.padEnd(14)) +
        chalk.dim(dim.direction.padEnd(6)) +
        overrideStr
    );
  }

  console.log('');

  // Routing profiles — all three are always selectable per request from the
  // OpenClaw model picker. Per-profile tier mappings are edited via
  // `sai router tiers --profile <eco|premium|agentic> --set "<TIER> <model>"`
  // or in the dashboard's Model Routing → Config tab.
  const byProfile = data.tierOverridesByProfile || {};
  console.log(chalk.bold('Routing Profiles:'));
  for (const p of VALID_PROFILES) {
    const configured = byProfile[p] && Object.keys(byProfile[p]!).length > 0;
    const status = configured ? chalk.green(' (configured)') : chalk.dim(' (using defaults)');
    console.log(`  ${chalk.white(p.padEnd(10))} ${chalk.dim(PROFILE_DESCRIPTIONS[p])}${status}`);
  }
  console.log('');

  // Session pinning + provider prompt caching — independently toggleable.
  // Defaults: pinning off (opt-in), cache on (default-on; opt-out).
  const pinningOn = data.sessionPinningEnabled === true;
  const cacheOn = data.providerCacheEnabled !== false;
  console.log(chalk.bold('Session Pinning & Provider Caching:'));
  console.log(`  Session pinning:          ${pinningOn ? chalk.green('on') : chalk.yellow('off')}`);
  console.log(`  Provider prompt caching:  ${cacheOn ? chalk.green('on') : chalk.yellow('off')}`);
  console.log('');

  console.log(chalk.dim(`Store: ${ModelRoutingPolicyStore.getPath()}`));
  console.log('');
}
