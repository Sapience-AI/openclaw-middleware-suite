/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { useState, useEffect, useRef } from 'preact/hooks';
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
  // Recent-decisions table is sized to the viewport so the page never
  // scrolls vertically. Default `15` is a safe starting size before the
  // first measurement runs (covers ~720px content area).
  const auditTableWrapRef = useRef<HTMLDivElement>(null);
  const [auditPageSize, setAuditPageSize] = useState(15);
  // Overview-tab chart height — measured against the viewport so the page
  // never scrolls vertically. Default 220 is the previous fixed value, used
  // as a fallback before the first measurement runs.
  const overviewChartWrapRef = useRef<HTMLDivElement>(null);
  const [chartHeight, setChartHeight] = useState(220);
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

  // Dynamic page-size for the Recent Routing Decisions table on the Logs
  // tab. Measures the available viewport height below the table's top edge
  // and divides by the compact-row height so the table fills the screen
  // without overflowing. Re-runs on tab switch and on window resize.
  //
  // Constants are tuned to the compact CSS modifier:
  //   ROW_HEIGHT 28  ≈ 6+6 padding + ~16 line-height
  //   CHROME 96      ≈ table header (28) + pagination strip (~52) + bottom buffer (~16)
  // The 5-row floor keeps the table usable on tiny viewports.
  useEffect(() => {
    if (tab !== 'logs') return;
    const ROW_HEIGHT = 28;
    const CHROME = 96;
    const recompute = () => {
      const wrap = auditTableWrapRef.current;
      if (!wrap) return;
      const top = wrap.getBoundingClientRect().top;
      const available = window.innerHeight - top - CHROME;
      const rows = Math.max(5, Math.floor(available / ROW_HEIGHT));
      setAuditPageSize((prev) => (prev === rows ? prev : rows));
    };
    // Defer to next frame so layout has settled after the tab switch.
    const raf = requestAnimationFrame(recompute);
    window.addEventListener('resize', recompute);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', recompute);
    };
  }, [tab]);

  // Overview chart fills the remaining vertical space below rows 1+2 so the
  // page never scrolls. Sized analogously to the audit-table effect above:
  // measure the chart wrapper's top edge against the viewport and assign
  // remaining height (minus chart-wrap padding + title + bottom buffer).
  // Recomputes when stats / cost data lands (rows above can grow) and on
  // window resize.
  //
  // CHART_CHROME shrinks at the same breakpoints the short-viewport CSS
  // compression in pages.css uses (`@media (max-height: 900/760px)`), so
  // the JS-computed `available` matches the actual chart-wrap padding +
  // title height the browser is rendering. Floor is intentionally low
  // (110px) — short viewports still show a legible chart, and combined
  // with the CSS compression above the rows shrink enough that floor is
  // rarely hit on real screen sizes.
  useEffect(() => {
    if (tab !== 'overview' || loading) return;
    const recompute = () => {
      const el = overviewChartWrapRef.current;
      if (!el) return;
      const vh = window.innerHeight;
      // Chart-wrap padding + title row + bottom margin shrinks via CSS at
      // 900/760 height breakpoints — mirror that here so we don't over-
      // subtract on short viewports and accidentally force the page to
      // scroll a single pixel because of rounding.
      const chartChrome = vh <= 760 ? 56 : vh <= 900 ? 68 : 80;
      const top = el.getBoundingClientRect().top;
      const available = vh - top - chartChrome;
      const next = Math.max(110, available);
      setChartHeight((prev) => (Math.abs(prev - next) < 4 ? prev : next));
    };
    const raf = requestAnimationFrame(recompute);
    window.addEventListener('resize', recompute);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', recompute);
    };
  }, [tab, loading, stats, costData, providers]);

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

  // Pricing lookup map for the audit table's `$/1M in` and `$/1M out`
  // columns — keyed by every alias each discovered model exposes (id,
  // name, model_name) so audit rows whose `model` field captured any of
  // those forms can find their rates. Values come from the LiteLLM
  // catalog's `input_cost_per_token` / `output_cost_per_token` fields,
  // already converted to `$/1M` by the discovery pipeline.
  const pricingByModel = new Map<string, { input?: number; output?: number }>();
  for (const m of (models || []) as Array<Record<string, unknown>>) {
    const entry = {
      input: typeof m.inputPrice === 'number' ? (m.inputPrice as number) : undefined,
      output: typeof m.outputPrice === 'number' ? (m.outputPrice as number) : undefined,
    };
    for (const alias of [m.id, m.name, m.model_name]) {
      if (typeof alias === 'string' && alias) pricingByModel.set(alias, entry);
    }
  }

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
        'Send provider-specific cache markers on system prompt + tools so that repeated prefixes aren\u2019t re-processed.',
      type: 'dropdown',
      options: [
        { value: 'disabled', label: 'Disabled' },
        { value: 'enabled', label: 'Enabled (default)' },
      ],
    },
  ];

  // Marshal config → flat form values.
  // Defaults mirror the server-side defaults in DEFAULT_SESSION_STORE_CONFIG
  // and DEFAULT_PROVIDER_CACHE_CONFIG: pinning is off by default (users
  // opt in), caching only counts when pinning is explicitly on.
  // Toggles are independent: pinning is off by default (opt-in); caching is
  // on by default (opt-out, matching DEFAULT_PROVIDER_CACHE_CONFIG.enabled).
  const pinningOn = config.sessionPinningEnabled === true;
  const cacheOn = config.providerCacheEnabled !== false;
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

  // Audit columns map to RoutingAuditEntry fields written by RoutingAuditLog.
  // To fit on screen without horizontal scroll we collapse 16 logical fields
  // into 11 displayed columns by pairing closely-related values (Score+Conf,
  // Input+Output tokens, Cache R+W, In Cost+Out Cost, $/1M in+out) into
  // single cells separated by a faint divider. The compact-table CSS
  // modifier (`data-table--compact`, see components.css) tightens padding
  // and font size further. `$/1M` rates come from the LiteLLM model catalog
  // via `pricingByModel`, not from per-row cost÷tokens math.
  const auditColumns = [
    {
      key: 'ts',
      label: 'Time',
      render: (v: unknown) => formatTimestamp(v as string),
    },
    { key: 'tier', label: 'Tier' },
    { key: 'model', label: 'Model', mono: true },
    {
      key: 'score',
      label: 'Score / Conf',
      render: (_v: unknown, row?: Record<string, unknown>) =>
        renderPair(formatNum(row?.score, 2), formatNum(row?.confidence, 2)),
    },
    { key: 'reason', label: 'Reason', render: (v: unknown) => (typeof v === 'string' ? v : '-') },
    {
      key: 'latencyMs',
      label: 'Latency',
      render: (v: unknown) => (typeof v === 'number' ? `${v}ms` : '-'),
    },
    {
      key: 'inputTokens',
      label: 'In / Out',
      render: (_v: unknown, row?: Record<string, unknown>) =>
        renderPair(formatTokenCount(row?.inputTokens), formatTokenCount(row?.outputTokens)),
    },
    {
      key: 'cacheReadTokens',
      label: 'Cache R / W',
      render: (_v: unknown, row?: Record<string, unknown>) =>
        renderPair(
          formatTokenCount(row?.cacheReadTokens),
          formatTokenCount(row?.cacheWriteTokens),
        ),
    },
    {
      key: 'inputCostUsd',
      label: 'In / Out Cost',
      render: (_v: unknown, row?: Record<string, unknown>) =>
        renderPair(formatUsd(row?.inputCostUsd, 4), formatUsd(row?.outputCostUsd, 4)),
    },
    { key: 'costEstimateUsd', label: 'Total', render: (v: unknown) => formatUsd(v, 4) },
    {
      key: 'model',
      label: '$/1M in / out',
      render: (_v: unknown, row?: Record<string, unknown>) => {
        const p = pricingByModel.get(String(row?.model ?? ''));
        return renderPair(formatCatalogRate(p?.input), formatCatalogRate(p?.output));
      },
    },
  ];

  // Sort the audit data descending by timestamp so the most recent decision
  // is always at the top — matches how chat / log surfaces typically render.
  // The audit log is appended chronologically; reversing in-place isn't safe
  // because the data array is also referenced by LogViewer.
  const auditDescending = [...(audit as Record<string, unknown>[])].sort((a, b) => {
    const ta = String(a.ts ?? '');
    const tb = String(b.ts ?? '');
    return tb.localeCompare(ta);
  });

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
          {/* Row 1: Routing Stats (left) + Cost Sources Today (right).
              Two-column outer wrap so both blocks fit one viewport line.
              `align-items: start` prevents the right column's taller
              cards (with budget bars) from forcing the left column to
              grow to match. */}
          <div class="grid-2 mb-16" style={{ alignItems: 'start' }}>
            <div>
              <div class="page-section-title">Routing Stats</div>
              <div class="grid-2">
                {/* `valueColor` matches the plum tone the cost-source cards
                    use for their dollar values (#674C67, also `--sai-purple`),
                    so the two top-row blocks read as a paired numeric set. */}
                <StatCard
                  label="Requests Routed"
                  value={formatNumber((stats.total as number) || 0)}
                  valueColor="var(--sai-purple)"
                />
                <StatCard
                  label="Simple"
                  value={formatNumber(((stats.byTier as Record<string, number>)?.SIMPLE) || 0)}
                  valueColor="var(--sai-purple)"
                />
                <StatCard
                  label="Standard"
                  value={formatNumber(((stats.byTier as Record<string, number>)?.STANDARD) || 0)}
                  valueColor="var(--sai-purple)"
                />
                <StatCard
                  label="Complex + Reasoning"
                  value={formatNumber(
                    (((stats.byTier as Record<string, number>)?.COMPLEX) || 0) +
                      (((stats.byTier as Record<string, number>)?.REASONING) || 0)
                  )}
                  valueColor="var(--sai-purple)"
                />
              </div>
            </div>

            <div>
              <div class="page-section-title">Cost Sources Today</div>
              <div class="grid-2">
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
          </div>

          {/* Row 2: Configured Models (left) + Configured Providers (right).
              Tier cards used `tier-grid` (4-up row) before; we switch to a
              2x2 inner grid since each row half is constrained to 50%. */}
          <div class="grid-2 mb-16" style={{ alignItems: 'start' }}>
            <div>
              <div class="page-section-title">Configured Models</div>
              <div class="grid-2">
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

            <div>
              <div class="page-section-title">Configured Providers</div>
              {providerList.length > 0 ? (
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
              ) : (
                <div
                  class="data-table-wrap"
                  style={{ padding: '32px', textAlign: 'center', color: 'var(--sai-text-muted)' }}
                >
                  No providers configured
                </div>
              )}
            </div>
          </div>

          {/* Cost chart — line chart (one point per day). Bar mode was
              tried but produced visual artifacts with sparse data: with
              only one day's data the single bar looked frozen as more
              requests aggregated into the same daily bucket, and uPlot's
              default point markers landed on top of the bars. */}
          {/* Daily routing cost — line chart, one point per day. The
              old "Routing Cost (24h)" title implied last-24h scrubbing;
              actually each dot is the day's accumulated `totalUsd` from
              CostTracker.saveToDisk's persisted DailyCost[], so the
              x-axis spans days, not hours. Bar mode was tried but
              produced visual artifacts with sparse data. The chart's
              height is computed by the `tab === 'overview'` effect above
              so it fills the remaining viewport without forcing a scroll. */}
          <div class="page-section" ref={overviewChartWrapRef} style={{ marginBottom: 0 }}>
            <Chart title="Daily Routing Cost ($/day)" data={chartData} height={chartHeight} />
          </div>

          {/* "Recent Routing Decisions" used to live here on Overview;
              it now lives on the Logs tab, where the wider per-token /
              per-cost columns have room to breathe and don't compete with
              the at-a-glance stat cards. */}
        </>
      )}

      {!loading && tab === 'config' && (
        // The page-section wrapper used to add 32px bottom margin which,
        // combined with the editing-profile field + 7 form fields + actions,
        // tipped the page into vertical-scroll territory on a 768-900px
        // viewport. We drop the bottom margin and pass `dense` to ConfigForm
        // (tighter per-field padding) so all controls fit without scroll.
        <div class="page-section" style={{ marginBottom: 0 }}>
          {/* Editing-profile selector \u2014 uses the same .config-field row
              layout as the form fields below (info on left, control right-
              aligned) so the visual rhythm of the page stays consistent.
              The selector lives outside <ConfigForm> so changing it remounts
              the form via `key={editingProfile}` and the tier dropdowns
              re-seed from the new profile's saved values.

              `marginBottom: 12px` adds breathing room between this field's
              bottom border and the first nested tier dropdown. The CSS
              `.config-field:has(+ .config-field--nested)` merge rule that
              normally collapses parent + child can't help here because the
              tier fields live inside a `.config-form` wrapper, breaking
              the adjacent-sibling relationship the selector needs. */}
          <div class="config-field" style={{ marginBottom: '12px', padding: '8px 0' }}>
            <div class="config-field-row">
              <div class="config-field-info">
                <label class="config-field-label">Routing profile</label>
                <div class="config-field-desc">
                  Pick which profile's tier mappings you want to edit.
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
                  <option value="eco">Eco (Prefer cheaper models)</option>
                  <option value="premium">Premium (Prefer top-tier models)</option>
                  <option value="agentic">Agentic (Optimized for agent workloads)</option>
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
            dense
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

              // Pinning + caching are now independent toggles \u2014 neither
              // coerces the other. Pinning defaults off; caching defaults on.
              const pinning = val.sessionPinningEnabled === 'enabled';
              const cache = val.providerCacheEnabled === 'enabled';

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
        // Recent Routing Decisions takes the full Logs tab. The previous
        // raw `<LogViewer>` block was redundant — every audit-log line was
        // already surfaced in the table above with richer per-row columns,
        // and the side-by-side layout split attention without adding info.
        // The wrapper div carries `auditTableWrapRef` so the dynamic
        // page-size effect can measure where the table starts on screen.
        <div class="page-section">
          <div class="page-section-title">Recent Routing Decisions</div>
          <div ref={auditTableWrapRef}>
            <DataTable
              columns={auditColumns}
              data={auditDescending}
              emptyText="No routing decisions recorded yet"
              pageSize={auditPageSize}
              compact
            />
          </div>
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

// ── Audit-table cell formatters ────────────────────────────────────────────
// Mirror the formatting `sai router stats` uses for its CLI tables so the
// dashboard readout stays consistent with what users see in the terminal.

/** Format a token count with K/M suffix for readability. Mirrors the
 *  `formatTokenCount` helper in `cli/stats.ts`. Returns "-" for missing. */
function formatTokenCount(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K';
  return v.toString();
}

/** Format a USD amount with the requested decimal precision. Returns "-"
 *  for missing/zero so the table doesn't fill with `$0.000000` rows on
 *  cache-only or upstream-error decisions. */
function formatUsd(v: unknown, decimals = 4): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v === 0) return '-';
  return '$' + v.toFixed(decimals);
}

/** Catalog `$/1M` rate — formatted directly from a `DiscoveredModel`'s
 *  `inputPrice` / `outputPrice` field (LiteLLM `input_cost_per_token` /
 *  `output_cost_per_token` already converted to per-million units by
 *  `discovery.ts`). Returns "-" when the catalog has no entry for the
 *  model — historical audit rows for now-removed models will hit that
 *  branch, which is more honest than fabricating a rate. */
function formatCatalogRate(ratePerMillion: number | undefined): string {
  if (typeof ratePerMillion !== 'number' || !Number.isFinite(ratePerMillion)) return '-';
  return '$' + ratePerMillion.toFixed(2);
}

/** Format an arbitrary number to N decimals, returning "-" for missing /
 *  non-finite. Used by the score+conf cell pair. */
function formatNum(v: unknown, decimals = 2): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
  return v.toFixed(decimals);
}

/** Render two related values as a single compact "a / b" cell. The faint
 *  separator + tabular-nums (set in components.css `.cell-pair`) keeps
 *  the values aligned across rows so the table reads cleanly even with
 *  many rows of mixed-width numbers. */
function renderPair(a: string, b: string): preact.ComponentChildren {
  return (
    <span class="cell-pair">
      <span>{a}</span>
      <span class="cell-pair-sep">/</span>
      <span>{b}</span>
    </span>
  );
}
