/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { useState, useEffect } from 'preact/hooks';
import {
  fetchRoutingStats,
  fetchRoutingConfig,
  fetchRoutingModels,
  fetchRoutingProviders,
  fetchRoutingCost,
  fetchRoutingAudit,
  updateRoutingTiers,
} from '../services/api';
import { StatCard } from '../components/StatCard';
import { DataTable } from '../components/DataTable';
import { LogViewer } from '../components/LogViewer';
import { Chart } from '../components/Chart';
import { ConfigForm, FormField } from '../components/ConfigForm';
import { formatNumber, formatTimestamp } from '../services/formatters';
import { useMiddlewareEnabled } from '../services/useMiddlewareEnabled';

const TIERS = ['SIMPLE', 'STANDARD', 'COMPLEX', 'REASONING'] as const;

export function ModelRoutingPage(_props: { path?: string }) {
  const [stats, setStats] = useState<Record<string, unknown>>({});
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [models, setModels] = useState<unknown[]>([]);
  const [providers, setProviders] = useState<Record<string, unknown>>({});
  // Cost API (/api/routing/cost) returns the raw DailyCost[] persisted by
  // CostTracker.saveToDisk (storage/cost-tracker.ts). Keep the state as
  // unknown and let buildCostChartData handle the shape.
  const [costData, setCostData] = useState<unknown>([]);
  const [audit, setAudit] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'overview' | 'config' | 'logs'>('overview');
  const enabled = useMiddlewareEnabled('model-routing');

  useEffect(() => {
    Promise.all([
      fetchRoutingStats().then(setStats).catch(() => {}),
      fetchRoutingConfig().then(setConfig).catch(() => {}),
      fetchRoutingModels().then(setModels).catch(() => {}),
      fetchRoutingProviders().then(setProviders).catch(() => {}),
      fetchRoutingCost().then(setCostData).catch(() => {}),
      fetchRoutingAudit(100).then(setAudit).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  const tiers = config.tierOverrides as Record<string, unknown> || {};
  const providerList = Object.entries(providers);

  // Build model options from discovered models
  const modelOptions = [
    { value: '', label: '— Not configured —' },
    ...((models || []) as Array<Record<string, unknown>>).map((m) => ({
      value: (m.id || m.model_name || m.name || '') as string,
      label: (m.id || m.model_name || m.name || '') as string,
    })),
  ];

  // Build form fields dynamically (need model catalog for dropdowns)
  const routingFields: FormField[] = [
    {
      key: 'defaultProfile',
      label: 'Routing Profile',
      description: 'Overall routing strategy that controls model selection behavior.',
      type: 'dropdown',
      options: [
        { value: 'eco', label: 'Eco — Prefer cheaper models' },
        { value: 'auto', label: 'Auto — Balance cost and quality (default)' },
        { value: 'premium', label: 'Premium — Prefer top-tier models' },
        { value: 'agentic', label: 'Agentic — Optimized for agent workloads' },
      ],
    },
    ...TIERS.map((tier): FormField => ({
      key: `_tier_${tier}`,
      label: `${tier} Tier`,
      description: `Model used for ${tier.toLowerCase()}-complexity requests.`,
      type: 'dropdown',
      options: modelOptions,
    })),
    {
      key: '_fallback',
      label: 'Universal Fallback Model',
      description: 'Fallback model added to all tiers when the primary is unavailable.',
      type: 'dropdown',
      options: modelOptions,
    },
    {
      key: 'sessionPinningEnabled',
      label: 'Session Pinning',
      description:
        'Lock routing to the same model across a conversation\u2019s follow-up turns.',
      type: 'dropdown',
      options: [
        { value: 'disabled', label: 'Disabled (default)' },
        { value: 'enabled', label: 'Enabled' },
      ],
    },
    {
      key: 'providerCacheEnabled',
      label: 'Provider Prompt Caching',
      description:
        'Send provider-specific cache markers (Anthropic cache_control on system prompt + tools) so repeated prefixes aren\u2019t re-processed. Requires Session Pinning \u2014 a cached prefix is useless if the next turn switches models.',
      type: 'dropdown',
      options: [
        { value: 'disabled', label: 'Disabled' },
        { value: 'enabled', label: 'Enabled' },
      ],
      disabledWhen: (vals) => vals.sessionPinningEnabled !== 'enabled',
    },
  ];

  // Marshal config → flat form values.
  // Defaults mirror the server-side defaults in DEFAULT_SESSION_STORE_CONFIG
  // and DEFAULT_PROVIDER_CACHE_CONFIG: pinning is off by default (users
  // opt in), caching only counts when pinning is explicitly on.
  const pinningOn = config.sessionPinningEnabled === true;
  const cacheOn = pinningOn && config.providerCacheEnabled !== false;
  const formValues: Record<string, unknown> = {
    defaultProfile: (config.defaultProfile as string) || 'auto',
    _fallback: '',
    sessionPinningEnabled: pinningOn ? 'enabled' : 'disabled',
    providerCacheEnabled: cacheOn ? 'enabled' : 'disabled',
  };
  for (const tier of TIERS) {
    const tc = (tiers[tier] || {}) as Record<string, unknown>;
    formValues[`_tier_${tier}`] = (tc.primary as string) || '';
    // Capture first fallback as the universal fallback hint
    const fb = tc.fallbacks as string[] | undefined;
    if (fb?.length && !formValues._fallback) {
      formValues._fallback = fb[0];
    }
  }

  // Build cost chart data
  const chartData = buildCostChartData(costData);

  // Audit columns map to RoutingAuditEntry fields as written by RoutingAuditLog
  // (types.ts: ts, tier, model, score, latencyMs, ...)
  const auditColumns = [
    {
      key: 'ts',
      label: 'Time',
      render: (v: unknown) => formatTimestamp(v as string),
    },
    { key: 'tier', label: 'Tier' },
    { key: 'model', label: 'Model', mono: true },
    { key: 'score', label: 'Score', render: (v: unknown) => typeof v === 'number' ? v.toFixed(2) : '-' },
    { key: 'latencyMs', label: 'Latency', render: (v: unknown) => typeof v === 'number' ? `${v}ms` : '-' },
  ];

  return (
    <div>
      <div class="section-eyebrow">Middleware</div>
      <h1 class="section-title">Model Routing</h1>

      {/* Tabs */}
      <div class="flex-between mb-16">
        <div style={{ display: 'flex', gap: '4px' }}>
          {(['overview', 'config', 'logs'] as const).map((t) => (
            <button
              key={t}
              class={`btn-secondary btn-sm ${tab === t ? 'active' : ''}`}
              style={tab === t ? { background: 'var(--sai-gradient)', color: '#fff', borderColor: 'transparent' } : {}}
              onClick={() => setTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: '48px', color: 'var(--sai-text-muted)' }}>
          Loading routing data...
        </div>
      )}

      {!loading && tab === 'overview' && (
        <>
          {/* Stats — matches RoutingStats shape from proxy/handler.ts:77-81
              (total + per-tier counters; cache/fallback/error counters
              aren\u2019t tracked yet, so we surface the tier breakdown instead). */}
          <div class="grid-4 mb-16">
            <StatCard label="Requests Routed" value={formatNumber((stats.total as number) || 0)} />
            <StatCard
              label="Simple"
              value={formatNumber(((stats.byTier as Record<string, number>)?.SIMPLE) || 0)}
            />
            <StatCard
              label="Standard"
              value={formatNumber(((stats.byTier as Record<string, number>)?.STANDARD) || 0)}
            />
            <StatCard
              label="Complex + Reasoning"
              value={formatNumber(
                (((stats.byTier as Record<string, number>)?.COMPLEX) || 0) +
                  (((stats.byTier as Record<string, number>)?.REASONING) || 0)
              )}
            />
          </div>

          {/* Tier cards */}
          <div class="page-section">
            <div class="page-section-title">Routing Tiers</div>
            <div class="tier-grid">
              {TIERS.map((tier) => {
                const tierConfig = tiers[tier] as Record<string, unknown> || {};
                return (
                  <div class={`tier-card tier-${tier.toLowerCase()}`} key={tier}>
                    <span class="tier-label">{tier}</span>
                    <div class="tier-model">
                      {(tierConfig.primary as string) || 'Not configured'}
                    </div>
                    {tierConfig.fallbacks && (
                      <div class="tier-fallbacks">
                        Fallbacks: {(tierConfig.fallbacks as string[]).join(' → ') || 'none'}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Cost chart */}
          <div class="page-section">
            <Chart
              title="Routing Cost (24h)"
              data={chartData}
              height={220}
            />
          </div>

          {/* Providers */}
          {providerList.length > 0 && (
            <div class="page-section">
              <div class="page-section-title">Configured Providers</div>
              <div class="data-table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Base URL</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providerList.map(([name, cfg]) => {
                      const c = cfg as Record<string, unknown>;
                      return (
                        <tr key={name}>
                          <td style={{ fontWeight: 500 }}>{name}</td>
                          <td class="mono">{(c.baseUrl as string) || '-'}</td>
                          <td>
                            <span class="pill pill-green">Connected</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Recent routing decisions */}
          <div class="page-section">
            <div class="page-section-title">Recent Routing Decisions</div>
            <DataTable
              columns={auditColumns}
              data={audit as Record<string, unknown>[]}
              emptyText="No routing decisions recorded yet"
            />
          </div>
        </>
      )}

      {!loading && tab === 'config' && (
        <div class="page-section">
          <ConfigForm
            fields={routingFields}
            values={formValues}
            readOnly={enabled === false}
            onSave={async (val) => {
              // Unmarshal: convert flat _tier_* and _fallback back to tierOverrides
              const fallback = (val._fallback as string) || '';
              const newTierOverrides: Record<string, unknown> = {};

              for (const tier of TIERS) {
                const primary = (val[`_tier_${tier}`] as string) || '';
                const existing = (tiers[tier] || {}) as Record<string, unknown>;
                const fallbacks: string[] = [];
                if (fallback) fallbacks.push(fallback);
                newTierOverrides[tier] = {
                  ...existing,
                  primary: primary || undefined,
                  fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
                };
              }

              // Cascade rule: pinning off forces caching off. Server enforces
              // this in buildConfig; mirroring here keeps the saved value and
              // the effective value aligned so the next load isn\u2019t confusing.
              const pinning = val.sessionPinningEnabled === 'enabled';
              const cache = pinning && val.providerCacheEnabled === 'enabled';

              const updated = {
                ...config,
                defaultProfile: val.defaultProfile,
                tierOverrides: newTierOverrides,
                sessionPinningEnabled: pinning,
                providerCacheEnabled: cache,
              };
              await updateRoutingTiers(updated);
              setConfig(updated);
            }}
          />
        </div>
      )}

      {!loading && tab === 'logs' && (
        <div class="page-section">
          <LogViewer
            source="routing"
            initialRecords={audit as Record<string, unknown>[]}
            title="Routing Audit Log"
          />
        </div>
      )}
    </div>
  );
}

// Accepts the raw DailyCost[] the cost-tracker persists (storage/cost-tracker.ts
// :397-408 — { date: 'YYYY-MM-DD', totalUsd, requestCount, byModel, ... }),
// and also the older `{ entries | snapshots }` envelope for backwards
// compatibility with any caller still returning that shape.
function buildCostChartData(costData: unknown): [number[], number[]] {
  let entries: Array<Record<string, unknown>> = [];
  if (Array.isArray(costData)) {
    entries = costData as Array<Record<string, unknown>>;
  } else if (costData && typeof costData === 'object') {
    const wrapped = costData as Record<string, unknown>;
    if (Array.isArray(wrapped.entries)) entries = wrapped.entries as Array<Record<string, unknown>>;
    else if (Array.isArray(wrapped.snapshots))
      entries = wrapped.snapshots as Array<Record<string, unknown>>;
  }

  if (entries.length === 0) return [[], []];

  // Sort by date ascending so the chart renders left-to-right chronologically.
  const sorted = [...entries].sort((a, b) => {
    const ad = String(a.date ?? a.timestamp ?? '');
    const bd = String(b.date ?? b.timestamp ?? '');
    return ad.localeCompare(bd);
  });

  const timestamps: number[] = [];
  const values: number[] = [];
  for (const e of sorted) {
    // Prefer DailyCost.date (YYYY-MM-DD); fall back to older timestamp field.
    const dateStr = (e.date ?? e.timestamp) as string | number | undefined;
    const ts =
      typeof dateStr === 'string'
        ? Math.floor(new Date(dateStr).getTime() / 1000)
        : typeof dateStr === 'number'
          ? dateStr
          : 0;
    const val = (e.totalUsd ?? e.cost ?? e.totalCost ?? 0) as number;
    timestamps.push(ts);
    values.push(val);
  }

  return [timestamps, values];
}
