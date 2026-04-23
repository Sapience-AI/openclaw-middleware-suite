import { useState, useEffect } from 'preact/hooks';
import {
  fetchLimitsPolicy,
  updateLimitsPolicy,
  fetchLimitsSessions,
  fetchLimitsPolicyPath,
  fetchLimitsDefaults,
  resetLimitsPolicy,
  resetLimitsTrackers,
} from '../services/api';
import { StatCard } from '../components/StatCard';
import { ConfigForm, FormField } from '../components/ConfigForm';
import { LimitRuleEditor } from '../components/LimitRuleEditor';
import { GradientButton } from '../components/GradientButton';
import { showToast } from '../components/Toast';
import { formatNumber } from '../services/formatters';
import { useMiddlewareEnabled } from '../services/useMiddlewareEnabled';

interface LimitRule {
  sessionCallLimit?: { max: number; windowMs?: number };
  requestCallLimit?: { max: number };
}

interface LimitPolicy {
  version?: string;
  globalSessionCallLimit?: number;
  globalRequestCallLimit?: number;
  resetAt?: string;
  resetScope?: 'all' | 'session' | 'request';
  modules?: Record<string, Record<string, LimitRule>>;
}

interface LimitState {
  count: number;
  warnedSoftLimit?: boolean;
  expiresAt?: number;
}

type TrackerData = {
  sessions?: Record<string, Record<string, LimitState>>;
  requests?: Record<string, Record<string, LimitState>>;
};

const globalFields: FormField[] = [
  {
    key: 'globalSessionCallLimit',
    label: 'Global Session Limit',
    description: 'Maximum tool calls per agent session. Leave blank (or 0) for unlimited.',
    type: 'number',
    min: 0,
    max: 100000,
    step: 10,
    placeholder: '∞',
  },
  {
    key: 'globalRequestCallLimit',
    label: 'Global Request Limit',
    description: 'Maximum tool calls per individual request. Leave blank (or 0) for unlimited.',
    type: 'number',
    min: 0,
    max: 10000,
    step: 1,
    placeholder: '∞',
  },
];

function formatResetAt(iso?: string): string {
  if (!iso) return 'Never';
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function countTotalCalls(
  buckets: Record<string, Record<string, LimitState>> | undefined
): number {
  if (!buckets) return 0;
  let total = 0;
  for (const bucket of Object.values(buckets)) {
    for (const state of Object.values(bucket)) {
      total += state?.count ?? 0;
    }
  }
  return total;
}

export function ToolCallLimitPage(_props: { path?: string }) {
  const [policy, setPolicy] = useState<LimitPolicy>({});
  const [trackers, setTrackers] = useState<TrackerData>({});
  const [policyPath, setPolicyPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'overview' | 'policy' | 'trackers'>('overview');
  const [resettingPolicy, setResettingPolicy] = useState(false);
  const [resettingTrackers, setResettingTrackers] = useState<'all' | 'session' | 'request' | null>(
    null
  );
  const enabled = useMiddlewareEnabled('tool-call-limit');
  const readOnly = enabled === false;

  const reload = async () => {
    const [p, t] = await Promise.all([
      fetchLimitsPolicy().catch(() => ({})),
      fetchLimitsSessions().catch(() => ({})),
    ]);
    setPolicy(p as LimitPolicy);
    setTrackers(t as TrackerData);
  };

  useEffect(() => {
    Promise.all([
      reload(),
      fetchLimitsPolicyPath()
        .then((r) => setPolicyPath(r.path))
        .catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  const sessions = trackers.sessions ?? {};
  const requests = trackers.requests ?? {};
  const sessionEntries = Object.entries(sessions);
  const requestEntries = Object.entries(requests);
  const totalSessionCalls = countTotalCalls(sessions);
  const totalRequestCalls = countTotalCalls(requests);

  const globalValues: Record<string, unknown> = {
    globalSessionCallLimit: policy.globalSessionCallLimit ?? 0,
    globalRequestCallLimit: policy.globalRequestCallLimit ?? 0,
  };

  const saveGlobals = async (val: Record<string, unknown>) => {
    const next: LimitPolicy = { ...policy };
    const s = Number(val.globalSessionCallLimit);
    const r = Number(val.globalRequestCallLimit);
    next.globalSessionCallLimit = Number.isFinite(s) && s > 0 ? Math.floor(s) : undefined;
    next.globalRequestCallLimit = Number.isFinite(r) && r > 0 ? Math.floor(r) : undefined;
    await updateLimitsPolicy(next as Record<string, unknown>);
    setPolicy(next);
  };

  const saveModules = async (modules: Record<string, Record<string, LimitRule>>) => {
    const next: LimitPolicy = { ...policy, modules };
    await updateLimitsPolicy(next as Record<string, unknown>);
    setPolicy(next);
  };

  const handleResetPolicy = async () => {
    if (
      !confirm(
        'Reset limit policy to defaults? This discards all custom per-tool rules and global ceilings.'
      )
    )
      return;
    setResettingPolicy(true);
    try {
      await resetLimitsPolicy();
      const defaults = await fetchLimitsDefaults();
      setPolicy(defaults as LimitPolicy);
      showToast('Limit policy reset to defaults', 'success');
    } catch (err) {
      showToast(`Reset failed: ${err}`, 'error');
    } finally {
      setResettingPolicy(false);
    }
  };

  const handleResetTrackers = async (scope: 'all' | 'session' | 'request') => {
    const label =
      scope === 'all' ? 'session + request' : scope === 'session' ? 'session' : 'request';
    if (!confirm(`Reset ${label} trackers? In-memory counters will clear on next tool call.`))
      return;
    setResettingTrackers(scope);
    try {
      const res = await resetLimitsTrackers(scope);
      await reload();
      showToast(`${label} trackers reset at ${formatResetAt(res.resetAt)}`, 'success');
    } catch (err) {
      showToast(`Reset failed: ${err}`, 'error');
    } finally {
      setResettingTrackers(null);
    }
  };

  const modules = policy.modules ?? {};
  const moduleCount = Object.keys(modules).length;
  const ruleCount = Object.values(modules).reduce((n, m) => n + Object.keys(m).length, 0);

  return (
    <div>
      <div class="section-eyebrow">Middleware</div>
      <h1 class="section-title">Tool Call Limit</h1>

      <div class="flex-between mb-16">
        <div style={{ display: 'flex', gap: '4px' }}>
          {(['overview', 'policy', 'trackers'] as const).map((t) => (
            <button
              key={t}
              class="btn-secondary btn-sm"
              style={
                tab === t
                  ? { background: 'var(--sai-gradient)', color: '#fff', borderColor: 'transparent' }
                  : {}
              }
              onClick={() => setTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: '48px', color: 'var(--sai-text-muted)' }}>
          Loading tool call limit data…
        </div>
      )}

      {!loading && tab === 'overview' && (
        <>
          <div class="grid-3 mb-16">
            <StatCard
              label="Global Session Ceiling"
              value={
                policy.globalSessionCallLimit !== undefined
                  ? formatNumber(policy.globalSessionCallLimit)
                  : '∞'
              }
            />
            <StatCard
              label="Global Request Ceiling"
              value={
                policy.globalRequestCallLimit !== undefined
                  ? formatNumber(policy.globalRequestCallLimit)
                  : '∞'
              }
            />
            <StatCard label="Per-Tool Rules" value={`${ruleCount} (${moduleCount} modules)`} />
          </div>
          <div class="grid-3 mb-16">
            <StatCard label="Active Sessions" value={formatNumber(sessionEntries.length)} />
            <StatCard label="Tracked Requests" value={formatNumber(requestEntries.length)} />
            <StatCard label="Last Reset" value={formatResetAt(policy.resetAt)} />
          </div>
          <div style={{ color: 'var(--sai-text-muted)', fontSize: '13px' }}>
            {policy.resetScope && (
              <>Last reset scope: <span class="mono">{policy.resetScope}</span></>
            )}
          </div>
        </>
      )}

      {!loading && tab === 'policy' && (
        <>
          <div class="page-section">
            <div class="page-section-title">Global Ceilings</div>
            <ConfigForm
              fields={globalFields}
              values={globalValues}
              readOnly={readOnly}
              onSave={saveGlobals}
            />
          </div>

          <div class="page-section">
            <div class="page-section-title">Per-Tool Rules</div>
            <div style={{ color: 'var(--sai-text-muted)', fontSize: '13px', marginBottom: '12px' }}>
              Add rules for individual <span class="mono">Module.method</span> combinations. A rule
              overrides the global ceiling for that tool only. Use <span class="mono">*</span> as
              the method name to apply to all methods in the module.
            </div>
            <LimitRuleEditor modules={modules} readOnly={readOnly} onSave={saveModules} />
          </div>

          {!readOnly && (
            <div class="page-section">
              <div class="page-section-title" style={{ color: 'var(--sai-danger, #dc2626)' }}>
                Danger Zone
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  class="btn-secondary"
                  onClick={handleResetPolicy}
                  disabled={resettingPolicy}
                >
                  {resettingPolicy ? 'Resetting…' : 'Reset Policy to Defaults'}
                </button>
                <span style={{ color: 'var(--sai-text-muted)', fontSize: '13px' }}>
                  Discards all global ceilings + per-tool rules and restores the shipped defaults.
                </span>
              </div>
              {policyPath && (
                <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--sai-text-muted)' }}>
                  Policy location: <span class="mono">{policyPath}</span>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {!loading && tab === 'trackers' && (
        <>
          {!readOnly && (
            <div class="page-section">
              <div class="page-section-title">Reset Trackers</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <GradientButton
                  onClick={() => handleResetTrackers('all')}
                  disabled={!!resettingTrackers}
                >
                  {resettingTrackers === 'all' ? 'Resetting…' : 'Reset All'}
                </GradientButton>
                <button
                  class="btn-secondary"
                  onClick={() => handleResetTrackers('session')}
                  disabled={!!resettingTrackers}
                >
                  {resettingTrackers === 'session' ? 'Resetting…' : 'Reset Session Counters'}
                </button>
                <button
                  class="btn-secondary"
                  onClick={() => handleResetTrackers('request')}
                  disabled={!!resettingTrackers}
                >
                  {resettingTrackers === 'request' ? 'Resetting…' : 'Reset Request Counters'}
                </button>
              </div>
              <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--sai-text-muted)' }}>
                Wipes on-disk tracker files and bumps <span class="mono">resetAt</span>; the running
                gateway clears its in-memory Maps on the next tool call.
              </div>
            </div>
          )}

          <div class="page-section">
            <div class="page-section-title">
              Active Sessions ({formatNumber(sessionEntries.length)} · {formatNumber(totalSessionCalls)} calls)
            </div>
            <div class="data-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Session ID</th>
                    <th>Tools</th>
                    <th>Total Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionEntries.length === 0 && (
                    <tr>
                      <td colSpan={3} style={{ color: 'var(--sai-text-muted)' }}>
                        No active sessions.
                      </td>
                    </tr>
                  )}
                  {sessionEntries.slice(0, 100).map(([sessionId, tools]) => {
                    const entries = Object.entries(tools);
                    const total = entries.reduce((sum, [, s]) => sum + (s?.count ?? 0), 0);
                    return (
                      <tr key={sessionId}>
                        <td class="mono">
                          {sessionId.length > 24 ? sessionId.slice(0, 24) + '…' : sessionId}
                        </td>
                        <td>{entries.length}</td>
                        <td>{formatNumber(total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div class="page-section">
            <div class="page-section-title">
              Tracked Requests ({formatNumber(requestEntries.length)} · {formatNumber(totalRequestCalls)} calls)
            </div>
            <div class="data-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Request ID</th>
                    <th>Tools</th>
                    <th>Total Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {requestEntries.length === 0 && (
                    <tr>
                      <td colSpan={3} style={{ color: 'var(--sai-text-muted)' }}>
                        No tracked requests.
                      </td>
                    </tr>
                  )}
                  {requestEntries.slice(0, 100).map(([requestId, tools]) => {
                    const entries = Object.entries(tools);
                    const total = entries.reduce((sum, [, s]) => sum + (s?.count ?? 0), 0);
                    return (
                      <tr key={requestId}>
                        <td class="mono">
                          {requestId.length > 24 ? requestId.slice(0, 24) + '…' : requestId}
                        </td>
                        <td>{entries.length}</td>
                        <td>{formatNumber(total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
