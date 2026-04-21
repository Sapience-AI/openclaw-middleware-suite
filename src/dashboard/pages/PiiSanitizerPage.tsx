import { useState, useEffect } from 'preact/hooks';
import {
  fetchPiiPolicy,
  updatePiiPolicy,
  fetchPiiAudit,
} from '../services/api';
import { DataTable } from '../components/DataTable';
import { LogViewer } from '../components/LogViewer';
import { ConfigForm, FormField } from '../components/ConfigForm';
import { formatTimestamp } from '../services/formatters';
import { useMiddlewareEnabled } from '../services/useMiddlewareEnabled';

const piiFields: FormField[] = [
  {
    key: 'enabled',
    label: 'Enable PII Sanitizer (DLP)',
    description: 'Scan tool call parameters for personally identifiable information and apply redaction or blocking.',
    type: 'toggle',
  },
  {
    key: 'dryRunMode',
    label: 'Dry-Run Mode',
    description: 'Log PII detections without redacting or blocking. Useful for auditing before enforcing.',
    type: 'toggle',
  },
];

export function PiiSanitizerPage(_props: { path?: string }) {
  const [policy, setPolicy] = useState<Record<string, unknown>>({});
  const [audit, setAudit] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'overview' | 'config' | 'logs'>('overview');
  const enabled = useMiddlewareEnabled('pii-sanitizer');

  useEffect(() => {
    Promise.all([
      fetchPiiPolicy().then(setPolicy).catch(() => {}),
      fetchPiiAudit(100).then(setAudit).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  // Extract DLP rules from policy
  const rules = (policy.rules || []) as Array<Record<string, unknown>>;

  const ruleColumns = [
    { key: 'name', label: 'Rule' },
    { key: 'patternType', label: 'Pattern Type' },
    {
      key: 'severity',
      label: 'Severity',
      render: (v: unknown) => {
        const s = v as string;
        const cls = s === 'HIGH' || s === 'CRITICAL' ? 'pill-red' : 'pill-purple';
        return <span class={`pill ${cls}`}>{s || '-'}</span>;
      },
    },
    {
      key: 'action',
      label: 'Action',
      render: (v: unknown) => {
        const a = v as string;
        const cls = a === 'BLOCK' || a === 'ESCALATE' ? 'pill-red'
          : a === 'REDACT' ? 'pill-purple' : 'pill-green';
        return <span class={`pill ${cls}`}>{a || '-'}</span>;
      },
    },
    {
      key: 'enabled',
      label: 'Status',
      render: (v: unknown) => (
        <span class={`pill ${v !== false ? 'pill-green' : 'pill-red'}`}>
          {v !== false ? 'Active' : 'Disabled'}
        </span>
      ),
    },
  ];

  const auditColumns = [
    {
      key: 'timestamp',
      label: 'Time',
      render: (v: unknown) => formatTimestamp(v as string),
    },
    { key: 'rule', label: 'Rule' },
    { key: 'type', label: 'PII Type' },
    { key: 'action', label: 'Action' },
    { key: 'module', label: 'Module' },
    { key: 'field', label: 'Field', mono: true },
  ];

  return (
    <div>
      <div class="section-eyebrow">Middleware</div>
      <h1 class="section-title">PII Sanitizer</h1>

      <div class="flex-between mb-16">
        <div style={{ display: 'flex', gap: '4px' }}>
          {(['overview', 'config', 'logs'] as const).map((t) => (
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
          Loading PII sanitizer data...
        </div>
      )}

      {!loading && tab === 'overview' && (
        <>
          {rules.length > 0 && (
            <div class="page-section">
              <div class="page-section-title">DLP Rules</div>
              <DataTable
                columns={ruleColumns}
                data={rules}
                emptyText="No DLP rules configured"
              />
            </div>
          )}

          <div class="page-section">
            <div class="page-section-title">Recent PII Detections</div>
            <DataTable
              columns={auditColumns}
              data={[...audit as Record<string, unknown>[]].reverse()}
              emptyText="No PII detections recorded yet"
            />
          </div>
        </>
      )}

      {!loading && tab === 'config' && (
        <div class="page-section">
          <ConfigForm
            fields={piiFields}
            values={policy}
            readOnly={enabled === false}
            onSave={async (val) => {
              await updatePiiPolicy(val);
              setPolicy(val);
            }}
          />
        </div>
      )}

      {!loading && tab === 'logs' && (
        <div class="page-section">
          <LogViewer
            source="pii"
            initialRecords={audit as Record<string, unknown>[]}
            title="PII Detection Log"
          />
        </div>
      )}
    </div>
  );
}
