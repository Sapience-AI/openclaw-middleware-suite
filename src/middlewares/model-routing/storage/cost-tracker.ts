/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Cost Tracker — Accumulates cost calculated from LiteLLM catalog pricing.
 *
 *  - Calculates cost from token counts + LiteLLM model catalog pricing
 *  - Pricing priority: live catalog → fallback table → mid-range default
 *  - Configurable alert thresholds (warn: $5, critical: $20)
 *  - On threshold breach: logs warning + writes to audit log
 *  - No hard enforcement — developers control spend at provider level
 *  - sai router stats shows daily/weekly/monthly spend with trend
 *  - Persists cost data to disk so it survives restarts
 */

import path from 'path';
import fs from 'fs-extra';
import { logger } from '../../../shared/Logger.js';
import type { DiscoveredModel } from '../types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Per-source budget thresholds. A "source" labels the caller of an LLM
 * request — currently `chat` (user-facing turns) or `icc` (CE compaction
 * extraction). Each source can have its own warn/critical thresholds so
 * a runaway compaction loop can't drain the chat budget and vice versa.
 *
 * Both fields are optional. If absent, no per-source alerting fires for
 * that source — the aggregate `warnThresholdUsd` / `criticalThresholdUsd`
 * still applies.
 */
export interface SourceBudget {
  /** Per-source daily warning threshold (USD). */
  dailyWarn?: number;
  /** Per-source daily critical threshold (USD). */
  dailyCritical?: number;
}

/**
 * Known sources for cost attribution. The `string & NonNullable<unknown>`
 * branch keeps the union open to future caller kinds while preserving
 * editor autocomplete for the known `'chat'` / `'icc'` literals.
 * (`string & {}` would do the same but trips eslint `@typescript-eslint/ban-types`.)
 */
export type CostSource = 'chat' | 'icc' | (string & NonNullable<unknown>);

export interface CostAlertConfig {
  /** Whether cost tracking is enabled */
  enabled: boolean;
  /** Daily spend warning threshold (USD) — applies across all sources combined. */
  warnThresholdUsd: number;
  /** Daily spend critical threshold (USD) — applies across all sources combined. */
  criticalThresholdUsd: number;
  /**
   * Optional per-source budgets. Keyed by source name (`'chat'`, `'icc'`, …).
   * Sources without an entry are tracked but not alerted on individually.
   */
  budgets?: Partial<Record<CostSource, SourceBudget>>;
}

export const DEFAULT_COST_ALERT_CONFIG: CostAlertConfig = {
  enabled: true,
  warnThresholdUsd: 5.0,
  criticalThresholdUsd: 20.0,
  budgets: {
    // Sensible default: ICC compaction shouldn't be a meaningful share of
    // the daily bill. A separate $1/$5 budget makes a runaway compaction
    // loop visible without affecting normal chat alerting.
    icc: { dailyWarn: 1.0, dailyCritical: 5.0 },
  },
};

// ---------------------------------------------------------------------------
// Model pricing (USD per million tokens)
// ---------------------------------------------------------------------------

export interface ModelPricing {
  input: number;
  output: number;
  /** Cache read rate (per 1M tokens). Defaults to input * 0.1 if not specified. */
  cacheRead?: number;
  /** Cache write rate (per 1M tokens). Defaults to input * 1.25 if not specified. */
  cacheWrite?: number;
}

/**
 * Fallback pricing — used only when the live catalog hasn't loaded yet.
 * Once the catalog is injected via setCatalog(), all lookups use live data.
 */
const FALLBACK_PRICING: Record<string, ModelPricing> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-6': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
};

// ---------------------------------------------------------------------------
// Daily cost entry
// ---------------------------------------------------------------------------

export interface ModelCostEntry {
  costUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Per-source daily totals within a `DailyCost` entry. */
export interface SourceCostEntry {
  costUsd: number;
  requestCount: number;
  /** Whether the per-source warn alert has already fired today. */
  warnFired: boolean;
  /** Whether the per-source critical alert has already fired today. */
  criticalFired: boolean;
}

interface DailyCost {
  date: string; // YYYY-MM-DD
  totalUsd: number;
  requestCount: number;
  byModel: Record<string, ModelCostEntry>;
  /** Per-source daily totals + per-source alert latches. */
  bySource?: Record<string, SourceCostEntry>;
  warnFired: boolean;
  criticalFired: boolean;
}

// ---------------------------------------------------------------------------
// Cost event
// ---------------------------------------------------------------------------

export interface CostEvent {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Cache read tokens (Anthropic: cache_read_input_tokens) */
  cacheReadTokens?: number;
  /** Cache write/creation tokens (Anthropic: cache_creation_input_tokens) */
  cacheWriteTokens?: number;
  timestamp?: number;
  /**
   * Caller kind — used for per-source attribution and budgeting.
   * Defaults to `'chat'` when omitted (legacy callers, raw user requests).
   */
  source?: CostSource;
}

// ---------------------------------------------------------------------------
// Cost summary (for CLI display)
// ---------------------------------------------------------------------------

export interface CostSummary {
  today: DailyCost | null;
  last7Days: { totalUsd: number; requestCount: number; avgDailyUsd: number };
  last30Days: { totalUsd: number; requestCount: number; avgDailyUsd: number };
  allTime: { totalUsd: number; requestCount: number; days: number };
}

// ---------------------------------------------------------------------------
// Cost tracker
// ---------------------------------------------------------------------------

export class CostTracker {
  private dailyCosts = new Map<string, DailyCost>();
  private config: CostAlertConfig;
  /** Live discovered models — injected at runtime for real pricing data. */
  private discoveredModels: DiscoveredModel[] = [];
  /** Path for persisting cost data to disk. */
  private persistPath?: string;
  /** Whether a save is already scheduled for the current tick. */
  private savePending = false;

  constructor(config: CostAlertConfig = DEFAULT_COST_ALERT_CONFIG, persistPath?: string) {
    this.config = config;
    this.persistPath = persistPath;
    if (persistPath) this.loadFromDisk();
  }

  /**
   * Inject live discovered models so pricing lookups use real-time rates.
   * Discovered models carry pricing copied from the LiteLLM catalog (via
   * providers/discovery.ts:enrichModel) plus any provider-specific overrides.
   */
  setDiscoveredModels(models: DiscoveredModel[]): void {
    this.discoveredModels = models;
  }

  /**
   * Record a cost event from a completed request.
   * Calculates cost from token counts using LiteLLM catalog pricing
   * (or fallback pricing if catalog hasn't loaded yet).
   * Returns the calculated cost in USD.
   */
  record(event: CostEvent): number {
    const { inputCostUsd, outputCostUsd, totalCostUsd } = this.splitCostFromEvent(event);

    const dateStr = this.dateString(event.timestamp);
    let daily = this.dailyCosts.get(dateStr);
    if (!daily) {
      daily = {
        date: dateStr,
        totalUsd: 0,
        requestCount: 0,
        byModel: {},
        warnFired: false,
        criticalFired: false,
      };
      this.dailyCosts.set(dateStr, daily);
    }

    daily.totalUsd += totalCostUsd;
    daily.requestCount++;

    if (!daily.byModel[event.model]) {
      daily.byModel[event.model] = {
        costUsd: 0,
        inputCostUsd: 0,
        outputCostUsd: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
    }
    const modelEntry = daily.byModel[event.model];
    modelEntry.costUsd += totalCostUsd;
    modelEntry.inputCostUsd += inputCostUsd;
    modelEntry.outputCostUsd += outputCostUsd;
    modelEntry.requests++;
    modelEntry.inputTokens += event.inputTokens;
    modelEntry.outputTokens += event.outputTokens;
    modelEntry.cacheReadTokens += event.cacheReadTokens ?? 0;
    modelEntry.cacheWriteTokens += event.cacheWriteTokens ?? 0;

    // Per-source bucket — defaults to 'chat' for legacy callers that
    // don't supply a source.
    const source: CostSource = event.source ?? 'chat';
    if (!daily.bySource) daily.bySource = {};
    if (!daily.bySource[source]) {
      daily.bySource[source] = {
        costUsd: 0,
        requestCount: 0,
        warnFired: false,
        criticalFired: false,
      };
    }
    const sourceEntry = daily.bySource[source];
    sourceEntry.costUsd += totalCostUsd;
    sourceEntry.requestCount++;

    // Check alert thresholds (aggregate + per-source)
    this.checkAlerts(daily);
    this.checkSourceAlerts(daily, source, sourceEntry);

    // Evict old days (keep last 90)
    this.evictOldDays(90);

    // Persist to disk (debounced within the same tick)
    this.scheduleSave();

    return totalCostUsd;
  }

  /**
   * Estimate cost for a model + token count (without recording).
   */
  estimateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0
  ): number {
    return this.estimateCostFromEvent({
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    });
  }

  /**
   * Split a (model + tokens) tuple into input-side, output-side, and total
   * cost in USD using the same pricing logic `record()` applies internally.
   *
   * Used by `proxy/handler.ts` to attach per-request cost breakdowns to the
   * routing audit log so the dashboard can render Input / Output / Total /
   * $/1M-in / $/1M-out columns without re-deriving rates.
   */
  splitCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0
  ): { inputCostUsd: number; outputCostUsd: number; totalCostUsd: number } {
    return this.splitCostFromEvent({
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    });
  }

  /**
   * Get the baseline cost (what it would cost if all requests used the COMPLEX tier model).
   */
  estimateBaselineCost(inputTokens: number, outputTokens: number): number {
    const baseline = this.getModelPricing('claude-sonnet-4-6');
    return (
      (inputTokens / 1_000_000) * baseline.input + (outputTokens / 1_000_000) * baseline.output
    );
  }

  /**
   * Get cost summary for CLI display.
   */
  getSummary(): CostSummary {
    const today = this.dateString();
    const todayCost = this.dailyCosts.get(today) || null;

    const now = Date.now();
    const last7 = { totalUsd: 0, requestCount: 0 };
    const last30 = { totalUsd: 0, requestCount: 0 };
    const allTime = { totalUsd: 0, requestCount: 0, days: 0 };

    for (const [, daily] of this.dailyCosts) {
      const dayTs = new Date(daily.date).getTime();
      const ageMs = now - dayTs;

      allTime.totalUsd += daily.totalUsd;
      allTime.requestCount += daily.requestCount;
      allTime.days++;

      if (ageMs <= 7 * 24 * 60 * 60 * 1000) {
        last7.totalUsd += daily.totalUsd;
        last7.requestCount += daily.requestCount;
      }
      if (ageMs <= 30 * 24 * 60 * 60 * 1000) {
        last30.totalUsd += daily.totalUsd;
        last30.requestCount += daily.requestCount;
      }
    }

    return {
      today: todayCost,
      last7Days: {
        ...last7,
        avgDailyUsd: last7.totalUsd / Math.max(1, 7),
      },
      last30Days: {
        ...last30,
        avgDailyUsd: last30.totalUsd / Math.max(1, 30),
      },
      allTime,
    };
  }

  /**
   * Get today's total cost.
   */
  getTodayCost(): number {
    const today = this.dailyCosts.get(this.dateString());
    return today?.totalUsd || 0;
  }

  /**
   * Clear all cost data.
   */
  clear(): void {
    this.dailyCosts.clear();
    this.scheduleSave();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Estimate cost from a CostEvent using known pricing (including cache tokens).
   */
  private estimateCostFromEvent(event: CostEvent): number {
    const { totalCostUsd } = this.splitCostFromEvent(event);
    return totalCostUsd;
  }

  /**
   * Split cost into input-side and output-side portions.
   * Input cost includes base input tokens + cache read/write tokens.
   * Output cost is purely output tokens.
   */
  private splitCostFromEvent(event: CostEvent): {
    inputCostUsd: number;
    outputCostUsd: number;
    totalCostUsd: number;
  } {
    const pricing = this.getModelPricing(event.model);
    const cacheReadRate = pricing.cacheRead ?? pricing.input * 0.1;
    const cacheWriteRate = pricing.cacheWrite ?? pricing.input * 1.25;

    const inputCostUsd =
      (event.inputTokens / 1_000_000) * pricing.input +
      ((event.cacheReadTokens || 0) / 1_000_000) * cacheReadRate +
      ((event.cacheWriteTokens || 0) / 1_000_000) * cacheWriteRate;
    const outputCostUsd = (event.outputTokens / 1_000_000) * pricing.output;

    return { inputCostUsd, outputCostUsd, totalCostUsd: inputCostUsd + outputCostUsd };
  }

  getModelPricing(model: string): ModelPricing {
    // 1. Try live discovered models (exact id/name match or prefix match)
    if (this.discoveredModels.length > 0) {
      const exact = this.discoveredModels.find((m) => m.id === model || m.name === model);
      const matched = exact ?? this.discoveredModels.find((m) => model.startsWith(m.id));
      if (matched && matched.inputPrice !== undefined && matched.outputPrice !== undefined) {
        return {
          input: matched.inputPrice,
          output: matched.outputPrice,
          cacheRead: matched.cacheReadPrice,
          cacheWrite: matched.cacheWritePrice,
        };
      }
    }

    // 2. Fallback pricing (used before discovery has populated)
    if (FALLBACK_PRICING[model]) return FALLBACK_PRICING[model];
    for (const [prefix, pricing] of Object.entries(FALLBACK_PRICING)) {
      if (model.startsWith(prefix)) return pricing;
    }

    // 3. Default: assume mid-range pricing
    return { input: 2.0, output: 8.0 };
  }

  private checkAlerts(daily: DailyCost): void {
    if (!this.config.enabled) return;

    if (daily.totalUsd >= this.config.criticalThresholdUsd && !daily.criticalFired) {
      daily.criticalFired = true;
      logger.warn(
        `[model-routing] CRITICAL: Daily spend $${daily.totalUsd.toFixed(2)} ` +
          `exceeds critical threshold $${this.config.criticalThresholdUsd.toFixed(2)}`
      );
    } else if (daily.totalUsd >= this.config.warnThresholdUsd && !daily.warnFired) {
      daily.warnFired = true;
      logger.warn(
        `[model-routing] WARNING: Daily spend $${daily.totalUsd.toFixed(2)} ` +
          `exceeds warning threshold $${this.config.warnThresholdUsd.toFixed(2)}`
      );
    }
  }

  /**
   * Per-source alerting. Fires once per source per day at the warn threshold
   * and once at the critical threshold. Independent of the aggregate alert
   * — both can fire on the same call when totals cross both lines.
   */
  private checkSourceAlerts(daily: DailyCost, source: CostSource, entry: SourceCostEntry): void {
    if (!this.config.enabled) return;
    const budget = this.config.budgets?.[source];
    if (!budget) return;

    if (
      typeof budget.dailyCritical === 'number' &&
      entry.costUsd >= budget.dailyCritical &&
      !entry.criticalFired
    ) {
      entry.criticalFired = true;
      logger.warn(
        `[model-routing] CRITICAL [${source}]: Daily spend $${entry.costUsd.toFixed(2)} ` +
          `exceeds ${source} critical threshold $${budget.dailyCritical.toFixed(2)} ` +
          `(${entry.requestCount} requests on ${daily.date})`
      );
    } else if (
      typeof budget.dailyWarn === 'number' &&
      entry.costUsd >= budget.dailyWarn &&
      !entry.warnFired
    ) {
      entry.warnFired = true;
      logger.warn(
        `[model-routing] WARNING [${source}]: Daily spend $${entry.costUsd.toFixed(2)} ` +
          `exceeds ${source} warning threshold $${budget.dailyWarn.toFixed(2)} ` +
          `(${entry.requestCount} requests on ${daily.date})`
      );
    }
  }

  private evictOldDays(maxDays: number): void {
    if (this.dailyCosts.size <= maxDays) return;

    const sortedKeys = [...this.dailyCosts.keys()].sort();
    const toRemove = sortedKeys.length - maxDays;
    for (let i = 0; i < toRemove; i++) {
      this.dailyCosts.delete(sortedKeys[i]);
    }
  }

  private dateString(ts?: number): string {
    const d = ts ? new Date(ts) : new Date();
    return d.toISOString().slice(0, 10);
  }

  // ── Disk persistence ────────────────────────────────────────────────────

  /**
   * Schedule a save for the end of the current tick (batches rapid writes).
   */
  private scheduleSave(): void {
    if (this.savePending || !this.persistPath) return;
    this.savePending = true;
    process.nextTick(() => {
      this.savePending = false;
      this.saveToDisk();
    });
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;
    try {
      const data: DailyCost[] = [];
      for (const [, daily] of this.dailyCosts) {
        data.push(daily);
      }
      fs.ensureDirSync(path.dirname(this.persistPath));
      fs.writeJsonSync(this.persistPath, data);
    } catch (err) {
      logger.debug('[cost-tracker] Failed to persist to disk', { error: err });
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath) return;
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const data = fs.readJsonSync(this.persistPath) as DailyCost[];
      if (!Array.isArray(data)) return;
      for (const daily of data) {
        if (daily.date && typeof daily.totalUsd === 'number') {
          this.dailyCosts.set(daily.date, daily);
        }
      }
      // Evict stale data on load
      this.evictOldDays(90);
    } catch (err) {
      logger.debug('[cost-tracker] Failed to load from disk', { error: err });
    }
  }
}
