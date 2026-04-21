import { useState, useEffect } from 'preact/hooks';
import {
  fetchGuardrailConfig,
  updateGuardrailConfig,
  fetchGuardrailAudit,
} from '../services/api';
import { DataTable } from '../components/DataTable';
import { LogViewer } from '../components/LogViewer';
import { ConfigForm, FormField } from '../components/ConfigForm';
import { formatTimestamp } from '../services/formatters';
import { useMiddlewareEnabled } from '../services/useMiddlewareEnabled';

const guardrailFields: FormField[] = [
  {
    key: 'enabled',
    label: 'Enable Guardrail Scanner',
    description: 'Scan tool call parameters and message content for policy violations.',
    type: 'toggle',
  },
  {
    key: 'dryRunMode',
    label: 'Dry-Run Mode',
    description: 'Log detections without blocking. Useful for tuning rules before enforcing.',
    type: 'toggle',
  },
  {
    key: 'unicodeNormalization',
    label: 'Unicode Normalization',
    description: 'Normalize Unicode characters before scanning to prevent bypass via homoglyphs.',
    type: 'toggle',
  },
];

export function GuardrailPage(_props: { path?: string }) {
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [audit, setAudit] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'overview' | 'config' | 'logs'>('overview');
  const enabled = useMiddlewareEnabled('guardrail');

  useEffect(() => {
    Promise.all([
      fetchGuardrailConfig().then(setConfig).catch(() => {}),
      fetchGuardrailAudit(100).then(setAudit).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  // Extract rules from config
  const rules = (config.scanners || config.rules || []) as Array<Record<string, unknown>>;

  const ruleColumns = [
    { key: 'name', label: 'Rule Name' },
    { key: 'type', label: 'Type' },
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
        return <span class={`pill ${a === 'BLOCK' ? 'pill-red' : 'pill-purple'}`}>{a || '-'}</span>;
      },
    },
    {
      key: 'enabled',
      label: 'Status',
      render: (v: unknown) => (
        <span class={`pill ${v ? 'pill-green' : 'pill-red'}`}>
          {v ? 'Active' : 'Disabled'}
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
    { key: 'severity', label: 'Severity' },
    { key: 'module', label: 'Module' },
    { key: 'method', label: 'Method', mono: true },
    {
      key: 'action',
      label: 'Action',
      render: (v: unknown) => {
        const a = v as string;
        return <span class={`pill ${a === 'BLOCK' ? 'pill-red' : 'pill-purple'}`}>{a || '-'}</span>;
      },
    },
  ];

  return (
    <div>
      <div class="section-eyebrow">Middleware</div>
      <h1 class="section-title">Guardrail</h1>

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
          Loading guardrail data...
        </div>
      )}

      {!loading && tab === 'overview' && (
        <>
          {rules.length > 0 && (
            <div class="page-section">
              <div class="page-section-title">Detection Rules</div>
              <DataTable
                columns={ruleColumns}
                data={rules}
                emptyText="No rules configured"
              />
            </div>
          )}

          <div class="page-section">
            <div class="page-section-title">Recent Detections</div>
            <DataTable
              columns={auditColumns}
              data={[...audit as Record<string, unknown>[]].reverse()}
              emptyText="No detections recorded yet"
            />
          </div>
        </>
      )}

      {!loading && tab === 'config' && (
        <div class="page-section">
          <ConfigForm
            fields={guardrailFields}
            values={config}
            readOnly={enabled === false}
            onSave={async (val) => {
              await updateGuardrailConfig(val);
              setConfig(val);
            }}
          />
        </div>
      )}

      {!loading && tab === 'logs' && (
        <div class="page-section">
          <LogViewer
            source="guardrail"
            initialRecords={audit as Record<string, unknown>[]}
            title="Guardrail Detection Log"
          />
        </div>
      )}
    </div>
  );
}
