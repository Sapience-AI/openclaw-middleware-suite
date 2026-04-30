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
const PROFILES = ['eco', 'premium', 'agentic'] as const;
type Profile = (typeof PROFILES)[number];

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
  const [refreshing, setRefreshing] = useState(false);
  // Which profile the config form is currently editing. Independent of any
  // global "default profile" — each profile has its own persisted tier slot
  // in `config.tierOverridesByProfile`, and switching this dropdown swaps
  // which slot the form is bound to.
  const [editingProfile, setEditingProfile] = useState<Profile>('eco');
  const enabled = useMiddlewareEnabled('model-routing');

  // Re-fetch every panel of routing data. Used both at mount and from the
  // explicit refresh button on the Overview tab. Errors per-endpoint are
  // swallowed so a single failing fetch doesn't leave the whole page blank.
  const loadAll = async () => {
    await Promise.all([
      fetchRoutingStats().then(setStats).catch(() => {}),
      fetchRoutingConfig().then(setConfig).catch(() => {}),
      fetchRoutingModels().then(setModels).catch(() => {}),
      fetchRoutingProviders().then(setProviders).catch(() => {}),
      fetchRoutingCost().then(setCostData).catch(() => {}),
      fetchRoutingAudit(100).then(setAudit).catch(() => {}),
    ]);
  };

  useEffect(() => {
    loadAll().finally(() => setLoading(false));
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await loadAll();
    } finally {
      setRefreshing(false);
    }
  };

  // Tier configuration for the *currently edited* profile. Each profile has
  // its own slot in `tierOverridesByProfile`; missing slots fall back to
  // the runtime defaults from `PROFILE_CONFIGS` (rendered as blanks here
  // since the dashboard reads only persisted overrides — saving populates
  // the slot).
  const tierOverridesByProfile =
    (config.tierOverridesByProfile as Record<string, Record<string, unknown>>) || {};
  const tiers = tierOverridesByProfile[editingProfile] || {};
  const providerList = Object.entries(providers);

  // Build model options from discovered models
  const modelOptions = [
    { value: '', label: '— Not configured —' },
    ...((models || []) as Array<Record<string, unknown>>).map((m) => ({
      value: (m.id || m.model_name || m.name || '') as string,
      label: (m.id || m.model_name || m.name || '') as string,
    })),
  ];

  // Build form fields dynamically (need model catalog for dropdowns).
  // The profile selector is rendered outside ConfigForm (parent-level state)
  // so changing it remounts the form with the new profile's tier values.
  // Tier dropdowns are visually nested under the profile selector (`indent: true`)
  // to make it clear they're per-profile mappings, mirroring the indent the
  // Context Editing config page uses for `pruning.maxIdleHours` under
  // "Inactive Session Pruning".
  const routingFields: FormField[] = [
    ...TIERS.map((tier): FormField => ({
      key: `_tier_${tier}`,
      label: `${tier} Tier`,
      description: `Model used for ${tier.toLowerCase()}-complexity requests.`,
      type: 'dropdown',
      options: modelOptions,
      indent: true,
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
  // (types.ts: ts, tier, model, score, confidence, reason, latencyMs, ...).
  // The `reason` column is the same value `sai router stats` prints in its
  // "Reason" column — surfacing it here keeps the dashboard readout consistent
  // with the CLI so users can correlate routing decisions across both surfaces.
  const auditColumns = [
    {
      key: 'ts',
      label: 'Time',
      render: (v: unknown) => formatTimestamp(v as string),
    },
    { key: 'tier', label: 'Tier' },
    { key: 'model', label: 'Model', mono: true },
    { key: 'score', label: 'Score', render: (v: unknown) => typeof v === 'number' ? v.toFixed(2) : '-' },
    {
      key: 'confidence',
      label: 'Conf',
      render: (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : '-'),
    },
    { key: 'reason', label: 'Reason', render: (v: unknown) => (typeof v === 'string' ? v : '-') },
    { key: 'latencyMs', label: 'Latency', render: (v: unknown) => typeof v === 'number' ? `${v}ms` : '-' },
  ];

  // Per-source spend for today (chat vs icc), pulled from DailyCost.bySource
  // written by CostTracker.record(). The cost-attribution + per-source budget
  // changes added these counters; surfacing them here makes ICC compaction
  // spend visible on the same page as the routing tier breakdown.
  const todayBySource = computeTodayBySource(costData);
  // Active per-source budget thresholds — reads `costAlerts.budgets` from the
  // policy store. May be empty when the user hasn't configured budgets and
  // the runtime defaults haven't been mirrored to the persisted config yet.
  const sourceBudgets =
    ((config.costAlerts as Record<string, unknown> | undefined)?.budgets as
      | Record<string, { dailyWarn?: number; dailyCritical?: number }>
      | undefined) || {};

  return (
    <div>
      <div class="section-eyebrow">Middleware</div>
      <h1 class="section-title">Model Routing</h1>

      {/* Tabs + Refresh */}
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
        <button
          class="btn-secondary btn-sm"
          onClick={handleRefresh}
          disabled={loading || refreshing}
          title="Re-fetch stats, config, cost, and audit log"
          aria-label="Refresh routing data"
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              style={refreshing ? { animation: 'sai-spin 0.9s linear infinite' } : undefined}
            >
              <path d="M1 4v6h6" />
              <path d="M3.51 15a9 9 0 105.64-12.36L3 9" />
            </svg>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </span>
        </button>
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

          {/* Cost chart — daily totals are categorical buckets, so render as bars */}
          <div class="page-section">
            <Chart
              title="Routing Cost (24h)"
              data={chartData}
              height={220}
              bars
            />
          </div>

          {/* Cost source attribution + per-source budgets — surfaces the
              chat / icc split written by CostTracker.record(). Budget bars
              are hidden when no per-source threshold is configured. */}
          {(todayBySource.chat || todayBySource.icc) && (
            <div class="page-section">
              <div class="page-section-title">Cost Sources Today</div>
              <div class="grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <SourceCostCard
                  source="chat"
                  label="Chat"
                  description="User-facing turns + manual tier overrides."
                  spend={todayBySource.chat || 0}
                  requestCount={todayBySource.chatRequests || 0}
                  budget={sourceBudgets.chat}
                />
                <SourceCostCard
                  source="icc"
                  label="ICC Compaction"
                  description="Context Editing's compaction-extraction calls."
                  spend={todayBySource.icc || 0}
                  requestCount={todayBySource.iccRequests || 0}
                  budget={sourceBudgets.icc}
                />
              </div>
            </div>
          )}

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
          {/* Editing-profile selector \u2014 uses the same .config-field row
              layout as the form fields below (info on left, control right-
              aligned) so the visual rhythm of the page stays consistent.
              The selector lives outside <ConfigForm> so changing it remounts
              the form via `key={editingProfile}` and the tier dropdowns
              re-seed from the new profile's saved values. */}
          <div class="config-field">
            <div class="config-field-row">
              <div class="config-field-info">
                <label class="config-field-label">Editing profile</label>
                <div class="config-field-desc">
                  Pick which routing profile's tier mappings you want to edit.
                </div>
              </div>
              <div class="config-field-control">
                <select
                  class="form-select"
                  value={editingProfile}
                  disabled={enabled === false}
                  onChange={(e) =>
                    setEditingProfile((e.target as HTMLSelectElement).value as Profile)
                  }
                >
                  <option value="eco">Eco \u2014 Prefer cheaper models</option>
                  <option value="premium">Premium \u2014 Prefer top-tier models</option>
                  <option value="agentic">Agentic \u2014 Optimized for agent workloads</option>
                </select>
              </div>
            </div>
          </div>

          <ConfigForm
            // Force a remount when the profile changes so the tier dropdowns
            // re-seed from the new profile's saved values rather than keeping
            // the previous profile's stale state.
            key={editingProfile}
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

              // Send profile-scoped tier write. The server nests these under
              // `tierOverridesByProfile[profile]`, leaving the other profiles'
              // saved configs untouched.
              await updateRoutingTiers({
                profile: editingProfile,
                tierOverrides: newTierOverrides,
                sessionPinningEnabled: pinning,
                providerCacheEnabled: cache,
              });

              // Refresh client-side config so the next render sees the saved values.
              const fresh = await fetchRoutingConfig().catch(() => null);
              if (fresh) setConfig(fresh);
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

// Pull today's per-source spend from the persisted DailyCost array. Reads
// the `bySource` map written by CostTracker.record() (storage/cost-tracker.ts);
// returns zeros for any source the day's record doesn't have. Decoupled from
// the chart-data builder above so the bySource logic doesn't get tangled in
// the legacy-envelope handling.
function computeTodayBySource(costData: unknown): {
  chat: number;
  icc: number;
  chatRequests: number;
  iccRequests: number;
} {
  const empty = { chat: 0, icc: 0, chatRequests: 0, iccRequests: 0 };
  let entries: Array<Record<string, unknown>> = [];
  if (Array.isArray(costData)) {
    entries = costData as Array<Record<string, unknown>>;
  } else if (costData && typeof costData === 'object') {
    const wrapped = costData as Record<string, unknown>;
    if (Array.isArray(wrapped.entries)) entries = wrapped.entries as Array<Record<string, unknown>>;
  }
  if (entries.length === 0) return empty;

  const todayStr = new Date().toISOString().slice(0, 10);
  const today = entries.find((e) => e.date === todayStr) ?? entries[entries.length - 1];
  const bySource = (today?.bySource as Record<string, { costUsd?: number; requestCount?: number }>) || {};
  return {
    chat: bySource.chat?.costUsd ?? 0,
    icc: bySource.icc?.costUsd ?? 0,
    chatRequests: bySource.chat?.requestCount ?? 0,
    iccRequests: bySource.icc?.requestCount ?? 0,
  };
}

// Renders one source's daily spend with optional warn/critical budget bars.
// Color shifts (green → amber → red) when spend crosses each threshold so a
// runaway compaction loop is visible at a glance without reading numbers.
function SourceCostCard(props: {
  source: 'chat' | 'icc';
  label: string;
  description: string;
  spend: number;
  requestCount: number;
  budget?: { dailyWarn?: number; dailyCritical?: number };
}) {
  const { label, description, spend, requestCount, budget } = props;
  const warn = budget?.dailyWarn;
  const critical = budget?.dailyCritical;

  // Bar fill: cap at 100% of the *highest* threshold present so the meter
  // gives a sense of headroom. Without any budget, render a flat info card.
  const cap = critical ?? warn;
  const pct = cap && cap > 0 ? Math.min(100, (spend / cap) * 100) : 0;
  const status: 'ok' | 'warn' | 'critical' =
    typeof critical === 'number' && spend >= critical
      ? 'critical'
      : typeof warn === 'number' && spend >= warn
        ? 'warn'
        : 'ok';
  const barColor =
    status === 'critical' ? '#b3261e' : status === 'warn' ? '#a96b00' : '#674C67';

  return (
    <div class="stat-card" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div class="stat-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span>{label}</span>
        <span style={{ fontSize: '11px', color: 'var(--sai-text-muted)' }}>
          {requestCount} {requestCount === 1 ? 'request' : 'requests'}
        </span>
      </div>
      <div class="stat-value" style={{ color: barColor }}>${spend.toFixed(4)}</div>
      <div style={{ fontSize: '12px', color: 'var(--sai-text-muted)' }}>{description}</div>
      {cap ? (
        <div style={{ marginTop: '4px' }}>
          <div
            style={{
              height: '6px',
              borderRadius: '3px',
              background: 'rgba(196, 181, 208, 0.18)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: '100%',
                background: barColor,
                transition: 'width 200ms ease',
              }}
            />
          </div>
          <div
            style={{
              marginTop: '4px',
              fontSize: '11px',
              color: 'var(--sai-text-muted)',
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <span>
              {typeof warn === 'number' ? `Warn $${warn.toFixed(2)}` : 'No warn budget'}
            </span>
            <span>
              {typeof critical === 'number' ? `Critical $${critical.toFixed(2)}` : ''}
            </span>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: '11px', color: 'var(--sai-text-muted)' }}>
          No per-source budget configured.
        </div>
      )}
    </div>
  );
}
