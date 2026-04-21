import { useState, useEffect } from 'preact/hooks';
import {
  fetchLimitsPolicy,
  updateLimitsPolicy,
  fetchLimitsSessions,
} from '../services/api';
import { StatCard } from '../components/StatCard';
import { DataTable } from '../components/DataTable';
import { ConfigForm, FormField } from '../components/ConfigForm';
import { formatNumber } from '../services/formatters';
import { useMiddlewareEnabled } from '../services/useMiddlewareEnabled';

const limitFields: FormField[] = [
  {
    key: 'globalSessionCallLimit',
    label: 'Global Session Limit',
    description: 'Maximum tool calls allowed per agent session. Set to 0 for unlimited.',
    type: 'number',
    min: 0,
    max: 10000,
    step: 10,
    placeholder: '100',
  },
  {
    key: 'globalRequestCallLimit',
    label: 'Global Request Limit',
    description: 'Maximum tool calls allowed per individual request. Set to 0 for unlimited.',
    type: 'number',
    min: 0,
    max: 1000,
    step: 1,
    placeholder: '10',
  },
];

export function ToolCallLimitPage(_props: { path?: string }) {
  const [policy, setPolicy] = useState<Record<string, unknown>>({});
  const [sessions, setSessions] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'overview' | 'config'>('overview');
  const enabled = useMiddlewareEnabled('tool-call-limit');

  useEffect(() => {
    Promise.all([
      fetchLimitsPolicy().then(setPolicy).catch(() => {}),
      fetchLimitsSessions().then(setSessions).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  // Extract rules and sessions for display
  const rules = (policy.rules || policy.limits || []) as Array<Record<string, unknown>>;
  const globalDefaults = (policy.defaults || policy.global || {}) as Record<string, unknown>;
  const sessionData = (sessions.sessions || {}) as Record<string, Record<string, unknown>>;
  const sessionEntries = Object.entries(sessionData);

  // Build form values from policy — map nested defaults to flat keys
  const formValues: Record<string, unknown> = {
    globalSessionCallLimit:
      (policy.globalSessionCallLimit as number) ??
      (globalDefaults.maxPerSession as number) ??
      100,
    globalRequestCallLimit:
      (policy.globalRequestCallLimit as number) ??
      (globalDefaults.maxPerRequest as number) ??
      10,
  };

  const ruleColumns = [
    { key: 'module', label: 'Module' },
    { key: 'method', label: 'Method', mono: true },
    {
      key: 'maxPerSession',
      label: 'Max / Session',
      render: (v: unknown) => typeof v === 'number' ? String(v) : (v as string) || 'default',
    },
    {
      key: 'maxPerRequest',
      label: 'Max / Request',
      render: (v: unknown) => typeof v === 'number' ? String(v) : (v as string) || 'default',
    },
    { key: 'window', label: 'Window' },
  ];

  return (
    <div>
      <div class="section-eyebrow">Middleware</div>
      <h1 class="section-title">Tool Call Limit</h1>

      <div class="flex-between mb-16">
        <div style={{ display: 'flex', gap: '4px' }}>
          {(['overview', 'config'] as const).map((t) => (
            <button
              key={t}
              class="btn-secondary btn-sm"
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
          Loading tool call limit data...
        </div>
      )}

      {!loading && tab === 'overview' && (
        <>
          {/* Global defaults */}
          <div class="grid-3 mb-16">
            <StatCard
              label="Default Max / Session"
              value={String(formValues.globalSessionCallLimit || 'N/A')}
            />
            <StatCard
              label="Default Max / Request"
              value={String(formValues.globalRequestCallLimit || 'N/A')}
            />
            <StatCard
              label="Active Sessions"
              value={formatNumber(sessionEntries.length)}
            />
          </div>

          {/* Limit rules */}
          {rules.length > 0 && (
            <div class="page-section">
              <div class="page-section-title">Limit Rules</div>
              <DataTable
                columns={ruleColumns}
                data={rules}
                emptyText="No custom limit rules — using global defaults"
              />
            </div>
          )}

          {/* Active sessions */}
          {sessionEntries.length > 0 && (
            <div class="page-section">
              <div class="page-section-title">Active Sessions</div>
              <div class="data-table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Session ID</th>
                      <th>Tools Used</th>
                      <th>Total Calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessionEntries.slice(0, 50).map(([sessionId, tools]) => {
                      const toolEntries = Object.entries(tools as Record<string, unknown>);
                      const totalCalls = toolEntries.reduce((sum, [, v]) => {
                        const calls = (v as Record<string, unknown>)?.calls;
                        return sum + (typeof calls === 'number' ? calls : 0);
                      }, 0);
                      return (
                        <tr key={sessionId}>
                          <td class="mono">{sessionId.slice(0, 16)}...</td>
                          <td>{toolEntries.length}</td>
                          <td>{formatNumber(totalCalls)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {rules.length === 0 && sessionEntries.length === 0 && (
            <div style={{ textAlign: 'center', padding: '48px', color: 'var(--sai-text-muted)' }}>
              No limit rules or active sessions. Configure limits in the Config tab.
            </div>
          )}
        </>
      )}

      {!loading && tab === 'config' && (
        <div class="page-section">
          <ConfigForm
            fields={limitFields}
            values={formValues}
            readOnly={enabled === false}
            onSave={async (val) => {
              const updated = { ...policy, ...val };
              await updateLimitsPolicy(updated);
              setPolicy(updated);
            }}
          />
        </div>
      )}
    </div>
  );
}
