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
  fetchHitlStats,
  fetchHitlPolicy,
  updateHitlPolicy,
  fetchHitlDecisions,
  fetchHitlAuditPath,
  fetchHitlPolicyPath,
  fetchHitlPresets,
  resetHitlStats,
  resetHitlPolicy,
  HitlPresetsResponse,
} from '../services/api';
import { StatCard } from '../components/StatCard';
import { DataTable } from '../components/DataTable';
import { LogViewer } from '../components/LogViewer';
import { ConfigForm, FormField } from '../components/ConfigForm';
import { HitlRuleEditor } from '../components/HitlRuleEditor';
import { GradientButton } from '../components/GradientButton';
import { showToast } from '../components/Toast';
import { formatNumber, formatTimestamp, formatDuration } from '../services/formatters';
import { useMiddlewareEnabled } from '../services/useMiddlewareEnabled';

const hitlFields: FormField[] = [
  {
    key: 'defaultAction',
    label: 'Default Action',
    description: 'Action applied to tools/methods not explicitly covered by a rule.',
    type: 'dropdown',
    options: [
      { value: 'ALLOW', label: 'ALLOW — Pass through without prompting' },
      { value: 'ASK', label: 'ASK — Prompt the user for approval' },
      { value: 'DENY', label: 'DENY — Block automatically' },
    ],
  },
  {
    key: 'forceAskIrreversibilityThreshold',
    label: 'Force ASK Threshold',
    description: 'Irreversibility score above which the system forces an ASK decision.',
    type: 'slider',
    min: 0,
    max: 100,
  },
  {
    key: 'explicitConfirmIrreversibilityThreshold',
    label: 'Explicit Confirm Threshold',
    description: 'Irreversibility score above which explicit user confirmation is required.',
    type: 'slider',
    min: 0,
    max: 100,
  },
  {
    key: 'attackPauseThreshold',
    label: 'Attack Pause Threshold',
    description: 'Prompt injection confidence above which the session is paused for review.',
    type: 'slider',
    min: 0,
    max: 100,
  },
  {
    key: 'explicitConfirmMemoryThreshold',
    label: 'Memory Confirm Threshold',
    description: 'Threshold for requiring confirmation on memory-write operations.',
    type: 'slider',
    min: 0,
    max: 100,
  },
  {
    key: 'destructiveGatingEnabled',
    label: 'Destructive Gating',
    description: 'Block bulk destructive operations (delete, overwrite) exceeding the threshold.',
    type: 'toggle',
  },
  {
    key: 'destructiveBulkThreshold',
    label: 'Destructive Bulk Threshold',
    description: 'Number of destructive operations in a burst that triggers gating.',
    type: 'number',
    min: 1,
    max: 100,
    showWhen: (v) => Boolean(v.destructiveGatingEnabled),
  },
  {
    key: 'trustRateLimitLevel1',
    label: 'Trust Rate Limit — Level 1',
    description: 'Auto-approve quota for low-risk repeat operations.',
    type: 'number',
    min: 0,
    max: 50,
  },
  {
    key: 'trustRateLimitLevel2',
    label: 'Trust Rate Limit — Level 2',
    description: 'Auto-approve quota for medium-risk repeat operations.',
    type: 'number',
    min: 0,
    max: 50,
  },
];

export function HitlPage(_props: { path?: string }) {
  const [stats, setStats] = useState<Record<string, unknown>>({});
  const [policy, setPolicy] = useState<Record<string, unknown>>({});
  const [decisions, setDecisions] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'overview' | 'policy' | 'logs'>('overview');
  const [resettingStats, setResettingStats] = useState(false);
  const [resettingPolicy, setResettingPolicy] = useState(false);
  const [auditLimit, setAuditLimit] = useState(100);
  const [auditModule, setAuditModule] = useState('');
  const [auditDecision, setAuditDecision] = useState('');
  const [auditPath, setAuditPath] = useState('');
  const [policyPath, setPolicyPath] = useState('');
  const [presets, setPresets] = useState<HitlPresetsResponse | null>(null);
  const [applyingPreset, setApplyingPreset] = useState<string>('');
  const [auditLoading, setAuditLoading] = useState(false);
  const enabled = useMiddlewareEnabled('hitl');

  useEffect(() => {
    Promise.all([
      fetchHitlStats().then(setStats).catch(() => {}),
      fetchHitlPolicy().then(setPolicy).catch(() => {}),
      fetchHitlDecisions(200).then(setDecisions).catch(() => {}),
      fetchHitlAuditPath().then((r) => setAuditPath(r.path)).catch(() => {}),
      fetchHitlPolicyPath().then((r) => setPolicyPath(r.path)).catch(() => {}),
      fetchHitlPresets().then(setPresets).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  const reloadAudit = async () => {
    setAuditLoading(true);
    try {
      const fresh = await fetchHitlDecisions(auditLimit);
      setDecisions(fresh);
    } catch {
      /* ignore */
    } finally {
      setAuditLoading(false);
    }
  };

  const filteredDecisions = (decisions as Record<string, unknown>[]).filter((d) => {
    if (auditModule && (d.module as string)?.toLowerCase() !== auditModule.toLowerCase()) {
      return false;
    }
    if (auditDecision && (d.decision as string) !== auditDecision) {
      return false;
    }
    return true;
  });

  const availableModules = Array.from(
    new Set(
      (decisions as Record<string, unknown>[])
        .map((d) => d.module as string)
        .filter(Boolean)
    )
  ).sort();

  const moduleMap = (policy.modules || {}) as Record<
    string,
    Record<
      string,
      {
        action: 'ALLOW' | 'ASK' | 'DENY';
        description?: string;
        allowPaths?: string[];
        denyPaths?: string[];
        forceAsk?: boolean;
        overrideDescription?: string;
        interventionReason?: string;
        requiresExplicitConfirmation?: boolean;
        actionSummary?: string;
        recommendScreenshotReview?: boolean;
      }
    >
  >;

  const systemThresholds = (policy.systemThresholds || {}) as Record<string, unknown>;

  const formValues: Record<string, unknown> = {
    defaultAction: policy.defaultAction,
    ...systemThresholds,
  };

  const THRESHOLD_KEYS = [
    'forceAskIrreversibilityThreshold',
    'explicitConfirmIrreversibilityThreshold',
    'attackPauseThreshold',
    'explicitConfirmMemoryThreshold',
    'destructiveBulkThreshold',
    'destructiveGatingEnabled',
    'trustRateLimitLevel1',
    'trustRateLimitLevel2',
  ];

  const splitFormValues = (val: Record<string, unknown>) => {
    const thresholds: Record<string, unknown> = { ...systemThresholds };
    for (const k of THRESHOLD_KEYS) {
      if (k in val) thresholds[k] = val[k];
    }
    const root: Record<string, unknown> = {};
    if ('defaultAction' in val) root.defaultAction = val.defaultAction;
    return { root, thresholds };
  };

  const decisionColumns = [
    {
      key: 'timestamp',
      label: 'Time',
      render: (v: unknown) => formatTimestamp(v as string),
    },
    { key: 'module', label: 'Module' },
    { key: 'method', label: 'Method', mono: true },
    {
      key: 'decision',
      label: 'Decision',
      render: (v: unknown) => {
        const d = v as string;
        const cls = d === 'ALLOWED' || d === 'APPROVED' ? 'pill-green' : 'pill-red';
        return <span class={`pill ${cls}`}>{d}</span>;
      },
    },
    { key: 'severity', label: 'Severity' },
    {
      key: 'decisionTime',
      label: 'Time (ms)',
      render: (v: unknown) => typeof v === 'number' ? formatDuration(v) : '-',
    },
  ];

  return (
    <div>
      <div class="section-eyebrow">Middleware</div>
      <h1 class="section-title">Human-in-the-Loop</h1>

      {/* Tabs */}
      <div class="flex-between mb-16">
        <div style={{ display: 'flex', gap: '4px' }}>
          {(['overview', 'policy', 'logs'] as const).map((t) => (
            <button
              key={t}
              class={`btn-secondary btn-sm`}
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
          Loading HITL data...
        </div>
      )}

      {!loading && tab === 'overview' && (
        <>
          {/* Stats */}
          <div class="grid-4 mb-16">
            <StatCard
              label="Total Calls"
              value={formatNumber((stats.totalCalls as number) || 0)}
            />
            <StatCard
              label="Allowed"
              value={formatNumber((stats.allowed as number) || 0)}
            />
            <StatCard
              label="Approved"
              value={formatNumber((stats.approved as number) || 0)}
            />
            <StatCard
              label="Rejected"
              value={formatNumber((stats.rejected as number) || 0)}
            />
            <StatCard
              label="Blocked"
              value={formatNumber((stats.blocked as number) || 0)}
            />
            <StatCard
              label="Avg Decision Time"
              value={
                typeof stats.avgDecisionTime === 'number'
                  ? formatDuration(stats.avgDecisionTime as number)
                  : '—'
              }
            />
            <StatCard
              label="Last Reset"
              value={
                stats.lastReset ? formatTimestamp(stats.lastReset as string) : '—'
              }
            />
          </div>

          {/* Reset stats control */}
          {enabled !== false && (
            <div class="flex-between mb-16">
              <div style={{ color: 'var(--sai-text-muted)', fontSize: '13px' }}>
                Clear counters and start a fresh measurement window.
              </div>
              <GradientButton
                secondary
                disabled={resettingStats}
                onClick={async () => {
                  if (!window.confirm('Reset all HITL statistics? This cannot be undone.')) return;
                  setResettingStats(true);
                  try {
                    await resetHitlStats();
                    const fresh = await fetchHitlStats();
                    setStats(fresh);
                    showToast('Statistics reset', 'success');
                  } catch {
                    showToast('Failed to reset statistics', 'error');
                  } finally {
                    setResettingStats(false);
                  }
                }}
              >
                {resettingStats ? 'Resetting...' : 'Reset Statistics'}
              </GradientButton>
            </div>
          )}

          {/* Decision log table */}
          <div class="page-section">
            <div class="page-section-title">Recent Decisions</div>
            <DataTable
              columns={decisionColumns}
              data={[...decisions as Record<string, unknown>[]].reverse()}
              emptyText="No decisions recorded yet"
            />
          </div>
        </>
      )}

      {!loading && tab === 'policy' && (
        <>
          {presets && enabled !== false && (
            <div class="page-section">
              <div class="page-section-title">Apply Security Preset</div>
              <div style={{ color: 'var(--sai-text-muted)', fontSize: '13px', marginBottom: '12px' }}>
                Presets replace module rules with a curated set. Thresholds and
                custom modules outside the preset are preserved.
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {Object.entries(presets.presets).map(([level, p]) => (
                  <GradientButton
                    key={level}
                    secondary
                    disabled={applyingPreset === level}
                    onClick={async () => {
                      if (
                        !window.confirm(
                          `Apply "${p.name}" preset? This replaces module rules. Thresholds are preserved.`
                        )
                      )
                        return;
                      setApplyingPreset(level);
                      try {
                        const updated = {
                          ...policy,
                          modules: p.policy,
                        };
                        await updateHitlPolicy(updated);
                        setPolicy(updated);
                        showToast(`Applied ${p.name} preset`, 'success');
                      } catch {
                        showToast('Failed to apply preset', 'error');
                      } finally {
                        setApplyingPreset('');
                      }
                    }}
                  >
                    {applyingPreset === level ? 'Applying...' : p.name}
                  </GradientButton>
                ))}
              </div>
            </div>
          )}

          <div class="page-section">
            <div class="page-section-title">Default Action &amp; Thresholds</div>
            <ConfigForm
              fields={hitlFields}
              values={formValues}
              readOnly={enabled === false}
              onSave={async (val) => {
                const { root, thresholds } = splitFormValues(val);
                const updated = {
                  ...policy,
                  ...root,
                  systemThresholds: thresholds,
                };
                await updateHitlPolicy(updated);
                setPolicy(updated);
              }}
            />
          </div>

          <div class="page-section">
            <div class="page-section-title">Module Rules</div>
            <div style={{ color: 'var(--sai-text-muted)', fontSize: '13px', marginBottom: '12px' }}>
              Per-module / per-method overrides. Action = ALLOW · ASK · DENY.
              Path globs narrow the scope — if <code>allow paths</code> is set, only matching targets pass; <code>deny paths</code> blocks regardless of allow rules.
            </div>
            <HitlRuleEditor
              modules={moduleMap}
              readOnly={enabled === false}
              onSave={async (newModules) => {
                const updated = { ...policy, modules: newModules };
                await updateHitlPolicy(updated);
                setPolicy(updated);
              }}
            />
          </div>

          {enabled !== false && (
            <div class="page-section">
              <div class="page-section-title">Danger Zone</div>
              <div class="flex-between">
                <div style={{ color: 'var(--sai-text-muted)', fontSize: '13px', maxWidth: '70%' }}>
                  Revert the policy to built-in defaults (BALANCED preset, default module rules).
                  Custom rules and thresholds will be lost.
                </div>
                <GradientButton
                  secondary
                  disabled={resettingPolicy}
                  onClick={async () => {
                    if (!window.confirm('Reset HITL policy to defaults? Custom rules will be lost.')) return;
                    setResettingPolicy(true);
                    try {
                      await resetHitlPolicy();
                      const fresh = await fetchHitlPolicy();
                      setPolicy(fresh);
                      showToast('Policy reset to defaults', 'success');
                    } catch {
                      showToast('Failed to reset policy', 'error');
                    } finally {
                      setResettingPolicy(false);
                    }
                  }}
                >
                  {resettingPolicy ? 'Resetting...' : 'Reset Policy to Defaults'}
                </GradientButton>
              </div>
              {policyPath && (
                <div style={{ fontSize: '12px', color: 'var(--sai-text-muted)', marginTop: '12px' }}>
                  Policy file: <code>{policyPath}</code>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {!loading && tab === 'logs' && (
        <>
          <div class="page-section">
            <div class="page-section-title">Audit Snapshot</div>
            <div
              style={{
                display: 'flex',
                gap: '12px',
                alignItems: 'center',
                flexWrap: 'wrap',
                marginBottom: '12px',
              }}
            >
              <label style={{ fontSize: '12px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                Lines
                <select
                  class="form-select"
                  value={String(auditLimit)}
                  onChange={(e) => setAuditLimit(Number((e.target as HTMLSelectElement).value))}
                >
                  {[50, 100, 200, 500, 1000].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ fontSize: '12px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                Module
                <select
                  class="form-select"
                  value={auditModule}
                  onChange={(e) => setAuditModule((e.target as HTMLSelectElement).value)}
                >
                  <option value="">All</option>
                  {availableModules.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ fontSize: '12px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                Decision
                <select
                  class="form-select"
                  value={auditDecision}
                  onChange={(e) => setAuditDecision((e.target as HTMLSelectElement).value)}
                >
                  <option value="">All</option>
                  <option value="ALLOWED">ALLOWED</option>
                  <option value="APPROVED">APPROVED</option>
                  <option value="REJECTED">REJECTED</option>
                  <option value="BLOCKED">BLOCKED</option>
                </select>
              </label>

              <GradientButton secondary onClick={reloadAudit} disabled={auditLoading}>
                {auditLoading ? 'Loading...' : 'Reload'}
              </GradientButton>

              <span style={{ fontSize: '12px', color: 'var(--sai-text-muted)', marginLeft: 'auto' }}>
                Showing {filteredDecisions.length} of {decisions.length}
              </span>
            </div>

            <DataTable
              columns={decisionColumns}
              data={[...filteredDecisions].reverse()}
              emptyText="No decisions match the current filters"
            />

            {auditPath && (
              <div style={{ fontSize: '12px', color: 'var(--sai-text-muted)', marginTop: '12px' }}>
                Audit log: <code>{auditPath}</code>
              </div>
            )}
          </div>

          <div class="page-section">
            <div class="page-section-title">Live Stream</div>
            <LogViewer
              source="hitl"
              initialRecords={decisions as Record<string, unknown>[]}
              title="HITL Decision Log"
            />
          </div>
        </>
      )}
    </div>
  );
}
