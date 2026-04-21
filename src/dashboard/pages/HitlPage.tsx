import { useState, useEffect } from 'preact/hooks';
import {
  fetchHitlStats,
  fetchHitlPolicy,
  updateHitlPolicy,
  fetchHitlDecisions,
} from '../services/api';
import { StatCard } from '../components/StatCard';
import { DataTable } from '../components/DataTable';
import { LogViewer } from '../components/LogViewer';
import { ConfigForm, FormField } from '../components/ConfigForm';
import { formatNumber, formatTimestamp, formatDuration } from '../services/formatters';
import { useMiddlewareEnabled } from '../services/useMiddlewareEnabled';

const HITL_MODULES = [
  { value: 'FileSystem', label: 'FileSystem' },
  { value: 'Shell', label: 'Shell' },
  { value: 'Browser', label: 'Browser' },
  { value: 'GoogleDrive', label: 'Google Drive' },
  { value: 'Gmail', label: 'Gmail' },
  { value: 'Memory', label: 'Memory' },
  { value: 'Process', label: 'Process' },
];

const hitlFields: FormField[] = [
  {
    key: 'securityLevel',
    label: 'Security Policy Preset',
    description: 'Controls the overall strictness of tool call approval requirements.',
    type: 'dropdown',
    options: [
      { value: 'PERMISSIVE', label: 'Permissive — Minimal intervention' },
      { value: 'BALANCED', label: 'Balanced — Recommended default' },
      { value: 'STRICT', label: 'Strict — Approve most operations' },
      { value: 'CUSTOM', label: 'Custom — Manual threshold tuning' },
    ],
  },
  {
    key: '_modules',
    label: 'Protected Modules',
    description: 'Select which OpenClaw tool modules require HITL approval.',
    type: 'checkbox-group',
    options: HITL_MODULES,
  },
  {
    key: 'forceAskIrreversibilityThreshold',
    label: 'Force ASK Threshold',
    description: 'Irreversibility score above which the system forces an ASK decision.',
    type: 'slider',
    min: 0,
    max: 100,
    showWhen: (v) => v.securityLevel === 'CUSTOM',
  },
  {
    key: 'explicitConfirmIrreversibilityThreshold',
    label: 'Explicit Confirm Threshold',
    description: 'Irreversibility score above which explicit user confirmation is required.',
    type: 'slider',
    min: 0,
    max: 100,
    showWhen: (v) => v.securityLevel === 'CUSTOM',
  },
  {
    key: 'attackPauseThreshold',
    label: 'Attack Pause Threshold',
    description: 'Prompt injection confidence above which the session is paused for review.',
    type: 'slider',
    min: 0,
    max: 100,
    showWhen: (v) => v.securityLevel === 'CUSTOM',
  },
  {
    key: 'explicitConfirmMemoryThreshold',
    label: 'Memory Confirm Threshold',
    description: 'Threshold for requiring confirmation on memory-write operations.',
    type: 'slider',
    min: 0,
    max: 100,
    showWhen: (v) => v.securityLevel === 'CUSTOM',
  },
  {
    key: 'destructiveGatingEnabled',
    label: 'Destructive Gating',
    description: 'Block bulk destructive operations (delete, overwrite) exceeding the threshold.',
    type: 'toggle',
    showWhen: (v) => v.securityLevel === 'CUSTOM',
  },
  {
    key: 'destructiveBulkThreshold',
    label: 'Destructive Bulk Threshold',
    description: 'Number of destructive operations in a burst that triggers gating.',
    type: 'number',
    min: 1,
    max: 100,
    showWhen: (v) => v.securityLevel === 'CUSTOM' && Boolean(v.destructiveGatingEnabled),
  },
  {
    key: 'trustRateLimitLevel1',
    label: 'Trust Rate Limit — Level 1',
    description: 'Auto-approve quota for low-risk repeat operations.',
    type: 'number',
    min: 0,
    max: 50,
    showWhen: (v) => v.securityLevel === 'CUSTOM',
  },
  {
    key: 'trustRateLimitLevel2',
    label: 'Trust Rate Limit — Level 2',
    description: 'Auto-approve quota for medium-risk repeat operations.',
    type: 'number',
    min: 0,
    max: 50,
    showWhen: (v) => v.securityLevel === 'CUSTOM',
  },
];

export function HitlPage(_props: { path?: string }) {
  const [stats, setStats] = useState<Record<string, unknown>>({});
  const [policy, setPolicy] = useState<Record<string, unknown>>({});
  const [decisions, setDecisions] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'overview' | 'policy' | 'logs'>('overview');
  const enabled = useMiddlewareEnabled('hitl');

  useEffect(() => {
    Promise.all([
      fetchHitlStats().then(setStats).catch(() => {}),
      fetchHitlPolicy().then(setPolicy).catch(() => {}),
      fetchHitlDecisions(200).then(setDecisions).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  // Marshal policy → flat form values
  const modules = policy.modules as Record<string, unknown> | undefined;
  const activeModules = modules ? Object.keys(modules) : [];

  const formValues: Record<string, unknown> = {
    ...policy,
    _modules: activeModules,
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
          </div>

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
        <div class="page-section">
          <ConfigForm
            fields={hitlFields}
            values={formValues}
            readOnly={enabled === false}
            onSave={async (val) => {
              // Unmarshal: convert _modules array back to modules object
              const selectedModules = (val._modules as string[]) || [];
              const existingModules = (policy.modules || {}) as Record<string, unknown>;
              const newModules: Record<string, unknown> = {};
              for (const mod of selectedModules) {
                newModules[mod] = existingModules[mod] || {};
              }

              const { _modules: _, ...rest } = val;
              const updated = { ...rest, modules: newModules };
              await updateHitlPolicy(updated);
              setPolicy(updated);
            }}
          />
        </div>
      )}

      {!loading && tab === 'logs' && (
        <div class="page-section">
          <LogViewer
            source="hitl"
            initialRecords={decisions as Record<string, unknown>[]}
            title="HITL Decision Log"
          />
        </div>
      )}
    </div>
  );
}
