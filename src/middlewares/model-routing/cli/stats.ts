/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: sai router stats — View routing statistics and cost savings.
 */

import chalk from 'chalk';
import { RoutingAuditLog } from '../storage/RoutingAuditLog.js';
import { getCostTracker } from '../proxy/handler.js';
import { CostTracker } from '../storage/cost-tracker.js';
import { MODEL_ROUTE_COST_FILE } from '../../../shared/storage/paths.js';
import { Tier } from '../types.js';

export async function routerStatsCommand(opts: { lines?: string }): Promise<void> {
  console.log('');
  console.log(chalk.bold.cyan('='.repeat(70)));
  console.log(chalk.bold.cyan('   Model Routing Statistics'));
  console.log(chalk.bold.cyan('='.repeat(70)));
  console.log('');

  const auditLog = new RoutingAuditLog();
  const lineCount = parseInt(opts.lines || '100', 10);
  const entries = auditLog.readLast(Math.max(lineCount, 1000));

  if (entries.length === 0) {
    console.log(chalk.yellow('No routing activity recorded yet.'));
    console.log('');
    return;
  }

  // Aggregate
  const byTier: Record<string, number> = { SIMPLE: 0, STANDARD: 0, COMPLEX: 0, REASONING: 0 };
  let totalLatency = 0;

  for (const e of entries) {
    byTier[e.tier] = (byTier[e.tier] || 0) + 1;
    totalLatency += e.latencyMs;
  }

  const total = entries.length;
  const avgLatency = (totalLatency / total).toFixed(1);

  console.log(chalk.bold('Aggregate:'));
  console.log(`  ${chalk.green('Total Requests:')}      ${total}`);
  console.log(`  ${chalk.green('Avg Scoring Latency:')} ${avgLatency}ms`);
  console.log('');

  console.log(chalk.bold('Distribution by Tier:'));
  for (const tier of ['SIMPLE', 'STANDARD', 'COMPLEX', 'REASONING'] as Tier[]) {
    const count = byTier[tier] || 0;
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
    const bar = '#'.repeat(Math.round((count / Math.max(total, 1)) * 40));
    console.log(
      `  ${chalk.white(tier.padEnd(12))} ${chalk.green(count.toString().padStart(5))} (${pct.padStart(5)}%)  ${chalk.cyan(bar)}`
    );
  }
  console.log('');

  // Recent decisions
  const n = Math.min(parseInt(opts.lines || '10', 10), entries.length);
  const recent = entries.slice(-n);

  console.log(chalk.bold(`Last ${n} Routing Decisions:`));
  console.log('');
  console.log(
    chalk.dim(
      '  ' +
        'Time'.padEnd(12) +
        'Tier'.padEnd(12) +
        'Model'.padEnd(24) +
        'Score'.padEnd(10) +
        'Conf'.padEnd(8) +
        'Reason'
    )
  );
  console.log(chalk.dim('  ' + '-'.repeat(75)));

  for (const e of recent) {
    const time = new Date(e.ts).toLocaleTimeString();
    console.log(
      '  ' +
        chalk.dim(time.padEnd(12)) +
        tierColor(e.tier)(e.tier.padEnd(12)) +
        chalk.white(e.model.slice(0, 22).padEnd(24)) +
        chalk.white(e.score.toFixed(3).padStart(8).padEnd(10)) +
        chalk.white(e.confidence.toFixed(2).padStart(5).padEnd(8)) +
        chalk.dim(e.reason)
    );
  }

  console.log('');

  // ── Cost data from CostTracker (authoritative: proxy-extracted tokens + LiteLLM catalog) ──
  // In the proxy process getCostTracker() returns the live instance.
  // In the CLI process (sai router stats) it returns null — load from disk instead.
  const tracker = getCostTracker() ?? new CostTracker(undefined, MODEL_ROUTE_COST_FILE);
  if (tracker) {
    const summary = tracker.getSummary();
    if (summary.allTime.requestCount > 0) {
      console.log(chalk.bold('Cost Summary:'));
      if (summary.today) {
        console.log(
          `  ${chalk.green('Today:')}      $${summary.today.totalUsd.toFixed(4)}  (${summary.today.requestCount} requests)`
        );
      }
      console.log(
        `  ${chalk.green('Last 7d:')}    $${summary.last7Days.totalUsd.toFixed(4)}  (${summary.last7Days.requestCount} requests, avg $${summary.last7Days.avgDailyUsd.toFixed(4)}/day)`
      );
      console.log(
        `  ${chalk.green('Last 30d:')}   $${summary.last30Days.totalUsd.toFixed(4)}  (${summary.last30Days.requestCount} requests, avg $${summary.last30Days.avgDailyUsd.toFixed(4)}/day)`
      );
      console.log(
        `  ${chalk.green('All time:')}   $${summary.allTime.totalUsd.toFixed(4)}  (${summary.allTime.requestCount} requests over ${summary.allTime.days} days)`
      );

      // Per-model breakdown from today
      if (summary.today && Object.keys(summary.today.byModel).length > 0) {
        console.log('');
        console.log(chalk.bold('Cost by Model (today):'));
        console.log('');

        // Token row
        console.log(
          chalk.dim(
            '  ' +
              'Model'.padEnd(24) +
              'Reqs'.padStart(5) +
              'Input'.padStart(10) +
              'Output'.padStart(10) +
              'Cache R'.padStart(10) +
              'Cache W'.padStart(10) +
              'In Cost'.padStart(10) +
              'Out Cost'.padStart(10) +
              'Total'.padStart(10) +
              '$/1M in'.padStart(9) +
              '$/1M out'.padStart(10)
          )
        );
        console.log(chalk.dim('  ' + '-'.repeat(116)));
        const sorted = Object.entries(summary.today.byModel).sort(
          (a, b) => b[1].costUsd - a[1].costUsd
        );
        for (const [model, data] of sorted) {
          const inTok = data.inputTokens || 0;
          const outTok = data.outputTokens || 0;
          const cacheR = data.cacheReadTokens || 0;
          const cacheW = data.cacheWriteTokens || 0;
          const inCost = data.inputCostUsd || 0;
          const outCost = data.outputCostUsd || 0;

          // Catalog $/1M rates for this model
          const pricing = tracker.getModelPricing(model);

          console.log(
            '  ' +
              chalk.white(model.slice(0, 22).padEnd(24)) +
              chalk.white(data.requests.toString().padStart(5)) +
              chalk.white(formatTokenCount(inTok).padStart(10)) +
              chalk.white(formatTokenCount(outTok).padStart(10)) +
              chalk.white(formatTokenCount(cacheR).padStart(10)) +
              chalk.white(formatTokenCount(cacheW).padStart(10)) +
              chalk.yellow(('$' + inCost.toFixed(4)).padStart(10)) +
              chalk.yellow(('$' + outCost.toFixed(4)).padStart(10)) +
              chalk.green(('$' + data.costUsd.toFixed(4)).padStart(10)) +
              chalk.dim(('$' + pricing.input.toFixed(2)).padStart(9)) +
              chalk.dim(('$' + pricing.output.toFixed(2)).padStart(10))
          );
        }
      }

      console.log('');
    }
  }

  console.log(chalk.dim('  Costs from LiteLLM catalog pricing. Tokens from provider responses.'));
  console.log(chalk.dim(`  Audit file: ${RoutingAuditLog.filePath}`));
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

/** Format token count with K/M suffix for readability. */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + 'M';
  if (tokens >= 1_000) return (tokens / 1_000).toFixed(1) + 'K';
  return tokens.toString();
}
