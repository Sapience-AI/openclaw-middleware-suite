/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

import { useState, useEffect } from 'preact/hooks';
import {
  fetchPiiPolicy,
  updatePiiPolicy,
  fetchPiiAudit,
  fetchPiiPolicyPath,
  resetPiiPolicy,
} from '../services/api';
import { LogViewer } from '../components/LogViewer';
import { ConfigForm, FormField } from '../components/ConfigForm';
import { StatCard } from '../components/StatCard';
import { GradientButton } from '../components/GradientButton';
import { showToast } from '../components/Toast';
import { formatTimestamp } from '../services/formatters';
import { DataTable } from '../components/DataTable';
import { useMiddlewareEnabled } from '../services/useMiddlewareEnabled';

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type ScannerAction = 'ALLOW' | 'REDACT' | 'ESCALATE' | 'BLOCK';
type FieldPolicy = 'SCALABLE' | 'VALIDATE' | 'IGNORE';
type RuleType = 'regex' | 'heuristic' | 'prefix';

interface DlpRule {
  name: string;
  type: RuleType;
  pattern: string;
  severity: Severity;
  action: ScannerAction;
  enabled: boolean;
  description?: string;
}

interface ToolMethodPolicy {
  fields: Record<string, FieldPolicy>;
  additionalRules?: DlpRule[];
}

interface DlpPolicy {
  version?: string;
  dryRunMode?: boolean;
  globalRules?: DlpRule[];
  toolPolicies?: Record<string, Record<string, ToolMethodPolicy>>;
}

const ACTIONS: ScannerAction[] = ['ALLOW', 'REDACT', 'ESCALATE', 'BLOCK'];
const SEVERITIES: Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const RULE_TYPES: RuleType[] = ['regex', 'heuristic', 'prefix'];
const FIELD_POLICIES: FieldPolicy[] = ['SCALABLE', 'VALIDATE', 'IGNORE'];

const generalFields: FormField[] = [
  {
    key: 'dryRunMode',
    label: 'Dry-Run Mode',
    description: 'Log detections without redacting or blocking. Useful for auditing before enforcing.',
    type: 'toggle',
  },
];

type Tab = 'overview' | 'general' | 'rules' | 'tools' | 'logs';

function pillForAction(a: ScannerAction): string {
  if (a === 'BLOCK' || a === 'ESCALATE') return 'pill pill-red';
  if (a === 'REDACT') return 'pill pill-purple';
  return 'pill pill-green';
}

export function PiiSanitizerPage(_props: { path?: string }) {
  const [policy, setPolicy] = useState<DlpPolicy>({});
  const [audit, setAudit] = useState<unknown[]>([]);
  const [policyPath, setPolicyPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');
  const [resetting, setResetting] = useState(false);
  const [newRule, setNewRule] = useState<Partial<DlpRule>>({
    type: 'regex',
    severity: 'HIGH',
    action: 'REDACT',
    enabled: true,
  });
  const [newField, setNewField] = useState<{
    module: string;
    method: string;
    field: string;
    action: FieldPolicy;
  }>({ module: '', method: '', field: '', action: 'SCALABLE' });

  const enabled = useMiddlewareEnabled('pii-sanitizer');
  const readOnly = enabled === false;

  const reload = async () => {
    const p = await fetchPiiPolicy().catch(() => ({}));
    setPolicy(p as DlpPolicy);
  };

  useEffect(() => {
    Promise.all([
      reload(),
      fetchPiiAudit(100).then((a) => setAudit(a)).catch(() => {}),
      fetchPiiPolicyPath().then((p) => setPolicyPath(p.path)).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  const save = async (next: DlpPolicy) => {
    await updatePiiPolicy(next as unknown as Record<string, unknown>);
    setPolicy(next);
  };

  const saveGeneral = async (val: Record<string, unknown>) => {
    const next: DlpPolicy = { ...policy, dryRunMode: !!val.dryRunMode };
    await save(next);
    showToast('General config saved', 'success');
  };

  const handleReset = async () => {
    if (
      !confirm(
        'Reset PII Sanitizer to factory defaults? This discards custom rules and tool field policies.'
      )
    )
      return;
    setResetting(true);
    try {
      await resetPiiPolicy();
      await reload();
      showToast('PII policy reset to defaults', 'success');
    } catch (err) {
      showToast(`Reset failed: ${err}`, 'error');
    } finally {
      setResetting(false);
    }
  };

  const toggleRule = async (name: string) => {
    const list = (policy.globalRules ?? []).map((r) =>
      r.name === name ? { ...r, enabled: !r.enabled } : r
    );
    await save({ ...policy, globalRules: list });
  };

  const setRuleAction = async (name: string, action: ScannerAction) => {
    const list = (policy.globalRules ?? []).map((r) => (r.name === name ? { ...r, action } : r));
    await save({ ...policy, globalRules: list });
  };

  const removeRule = async (name: string) => {
    if (!confirm(`Remove DLP rule "${name}"?`)) return;
    const list = (policy.globalRules ?? []).filter((r) => r.name !== name);
    await save({ ...policy, globalRules: list });
    showToast(`Removed ${name}`, 'success');
  };

  const addRule = async () => {
    if (!newRule.name || !newRule.pattern) {
      showToast('Rule name and pattern are required', 'error');
      return;
    }
    if (newRule.type === 'regex') {
      try {
        new RegExp(newRule.pattern, 'gi');
      } catch {
        showToast('Invalid regex pattern', 'error');
        return;
      }
    }
    const rule: DlpRule = {
      name: newRule.name,
      type: (newRule.type ?? 'regex') as RuleType,
      pattern: newRule.pattern,
      severity: (newRule.severity ?? 'HIGH') as Severity,
      action: (newRule.action ?? 'REDACT') as ScannerAction,
      enabled: newRule.enabled ?? true,
      description: newRule.description,
    };
    const list = [...(policy.globalRules ?? []).filter((r) => r.name !== rule.name), rule];
    await save({ ...policy, globalRules: list });
    setNewRule({ type: 'regex', severity: 'HIGH', action: 'REDACT', enabled: true });
    showToast(`Added rule "${rule.name}"`, 'success');
  };

  const setFieldPolicy = async (
    moduleName: string,
    methodName: string,
    field: string,
    action: FieldPolicy
  ) => {
    const tp = { ...(policy.toolPolicies ?? {}) };
    if (!tp[moduleName]) tp[moduleName] = {};
    if (!tp[moduleName][methodName]) tp[moduleName][methodName] = { fields: {} };
    tp[moduleName][methodName] = {
      ...tp[moduleName][methodName],
      fields: { ...tp[moduleName][methodName].fields, [field]: action },
    };
    await save({ ...policy, toolPolicies: tp });
  };

  const removeFieldPolicy = async (
    moduleName: string,
    methodName: string,
    field: string
  ) => {
    const tp = { ...(policy.toolPolicies ?? {}) };
    const fields = { ...(tp[moduleName]?.[methodName]?.fields ?? {}) };
    delete fields[field];
    if (Object.keys(fields).length === 0) {
      delete tp[moduleName]?.[methodName];
      if (tp[moduleName] && Object.keys(tp[moduleName]).length === 0) delete tp[moduleName];
    } else {
      tp[moduleName][methodName] = { ...tp[moduleName][methodName], fields };
    }
    await save({ ...policy, toolPolicies: tp });
  };

  const addFieldPolicy = async () => {
    const { module, method, field, action } = newField;
    if (!module.trim() || !method.trim() || !field.trim()) {
      showToast('Module, method, and field are required', 'error');
      return;
    }
    await setFieldPolicy(module.trim(), method.trim(), field.trim(), action);
    setNewField({ module: '', method: '', field: '', action: 'SCALABLE' });
    showToast(`Set ${module}.${method}.${field} = ${action}`, 'success');
  };

  const rules = policy.globalRules ?? [];
  const toolPolicies = policy.toolPolicies ?? {};
  const toolRows: {
    module: string;
    method: string;
    field: string;
    action: FieldPolicy;
  }[] = [];
  for (const [moduleName, methods] of Object.entries(toolPolicies)) {
    for (const [methodName, m] of Object.entries(methods)) {
      for (const [field, action] of Object.entries(m.fields ?? {})) {
        toolRows.push({ module: moduleName, method: methodName, field, action: action as FieldPolicy });
      }
    }
  }

  const generalValues: Record<string, unknown> = {
    dryRunMode: policy.dryRunMode ?? false,
  };

  const tabs: Tab[] = ['overview', 'general', 'rules', 'tools', 'logs'];

  return (
    <div>
      <div class="section-eyebrow">Middleware</div>
      <h1 class="section-title">PII Sanitizer</h1>

      <div class="flex-between mb-16">
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {tabs.map((t) => (
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
          Loading PII sanitizer data…
        </div>
      )}

      {!loading && tab === 'overview' && (
        <>
          <div class="grid-3 mb-16">
            <StatCard
              label="Status"
              value={enabled ? (policy.dryRunMode ? 'Dry-Run' : 'Enforcing') : 'Disabled'}
            />
            <StatCard
              label="Global Rules (active / total)"
              value={`${rules.filter((r) => r.enabled).length} / ${rules.length}`}
            />
            <StatCard label="Tool Field Policies" value={String(toolRows.length)} />
          </div>
          <div class="page-section">
            <div class="page-section-title">Recent Detections</div>
            <DataTable
              columns={[
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
              ]}
              data={[...(audit as Record<string, unknown>[])].reverse().slice(0, 20)}
              emptyText="No PII detections recorded yet"
            />
          </div>
        </>
      )}

      {!loading && tab === 'general' && (
        <>
          <div class="page-section">
            <ConfigForm
              fields={generalFields}
              values={generalValues}
              readOnly={readOnly}
              onSave={saveGeneral}
            />
          </div>
          {!readOnly && (
            <div class="page-section">
              <div class="page-section-title" style={{ color: 'var(--sai-danger, #dc2626)' }}>
                Danger Zone
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button class="btn-secondary" onClick={handleReset} disabled={resetting}>
                  {resetting ? 'Resetting…' : 'Reset to Factory Defaults'}
                </button>
                <span style={{ color: 'var(--sai-text-muted)', fontSize: '13px' }}>
                  Restores default PII rules and tool field policies.
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

      {!loading && tab === 'rules' && (
        <>
          <div class="page-section">
            <div class="page-section-title">Global DLP Rules</div>
            <div class="data-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Severity</th>
                    <th>Action</th>
                    <th>Enabled</th>
                    {!readOnly && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.name}>
                      <td class="mono" title={r.description}>
                        {r.name}
                      </td>
                      <td>{r.type}</td>
                      <td>
                        <span
                          class={`pill ${
                            r.severity === 'CRITICAL' || r.severity === 'HIGH'
                              ? 'pill-red'
                              : 'pill-purple'
                          }`}
                        >
                          {r.severity}
                        </span>
                      </td>
                      <td>
                        {readOnly ? (
                          <span class={pillForAction(r.action)}>{r.action}</span>
                        ) : (
                          <select
                            class="input input-sm"
                            value={r.action}
                            onChange={(e) =>
                              setRuleAction(
                                r.name,
                                (e.target as HTMLSelectElement).value as ScannerAction
                              )
                            }
                          >
                            {ACTIONS.map((a) => (
                              <option key={a} value={a}>
                                {a}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        {readOnly ? (
                          <span class={`pill ${r.enabled ? 'pill-green' : 'pill-red'}`}>
                            {r.enabled ? 'On' : 'Off'}
                          </span>
                        ) : (
                          <button class="btn-secondary btn-sm" onClick={() => toggleRule(r.name)}>
                            {r.enabled ? 'Disable' : 'Enable'}
                          </button>
                        )}
                      </td>
                      {!readOnly && (
                        <td>
                          <button class="btn-secondary btn-sm" onClick={() => removeRule(r.name)}>
                            ×
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {rules.length === 0 && (
                    <tr>
                      <td colSpan={readOnly ? 5 : 6} style={{ color: 'var(--sai-text-muted)' }}>
                        No global rules configured.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {!readOnly && (
            <div class="page-section">
              <div class="page-section-title">Add Global Rule</div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(6, 1fr)',
                  gap: '6px',
                  alignItems: 'end',
                }}
              >
                <div>
                  <label style={{ fontSize: '12px', color: 'var(--sai-text-muted)' }}>Name</label>
                  <input
                    class="input input-sm"
                    value={newRule.name ?? ''}
                    onInput={(e) =>
                      setNewRule({ ...newRule, name: (e.target as HTMLInputElement).value })
                    }
                  />
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: 'var(--sai-text-muted)' }}>Type</label>
                  <select
                    class="input input-sm"
                    value={newRule.type}
                    onChange={(e) =>
                      setNewRule({
                        ...newRule,
                        type: (e.target as HTMLSelectElement).value as RuleType,
                      })
                    }
                  >
                    {RULE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                  <label style={{ fontSize: '12px', color: 'var(--sai-text-muted)' }}>Pattern</label>
                  <input
                    class="input input-sm"
                    value={newRule.pattern ?? ''}
                    onInput={(e) =>
                      setNewRule({ ...newRule, pattern: (e.target as HTMLInputElement).value })
                    }
                  />
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: 'var(--sai-text-muted)' }}>
                    Severity
                  </label>
                  <select
                    class="input input-sm"
                    value={newRule.severity}
                    onChange={(e) =>
                      setNewRule({
                        ...newRule,
                        severity: (e.target as HTMLSelectElement).value as Severity,
                      })
                    }
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: 'var(--sai-text-muted)' }}>Action</label>
                  <select
                    class="input input-sm"
                    value={newRule.action}
                    onChange={(e) =>
                      setNewRule({
                        ...newRule,
                        action: (e.target as HTMLSelectElement).value as ScannerAction,
                      })
                    }
                  >
                    {ACTIONS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={{ marginTop: '8px' }}>
                <input
                  class="input input-sm"
                  style={{ width: '100%' }}
                  placeholder="Description (optional)"
                  value={newRule.description ?? ''}
                  onInput={(e) =>
                    setNewRule({ ...newRule, description: (e.target as HTMLInputElement).value })
                  }
                />
              </div>
              <div style={{ marginTop: '12px' }}>
                <GradientButton onClick={addRule}>Add rule</GradientButton>
              </div>
            </div>
          )}
        </>
      )}

      {!loading && tab === 'tools' && (
        <>
          <div class="page-section">
            <div class="page-section-title">Tool Field Policies</div>
            <div style={{ fontSize: '13px', color: 'var(--sai-text-muted)', marginBottom: '8px' }}>
              Per-field scan policy: <span class="mono">SCALABLE</span> (scan + redact),{' '}
              <span class="mono">VALIDATE</span> (scan + escalate on match),{' '}
              <span class="mono">IGNORE</span> (skip).
            </div>
            <div class="data-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Module</th>
                    <th>Method</th>
                    <th>Field</th>
                    <th>Policy</th>
                    {!readOnly && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {toolRows.map((row) => (
                    <tr key={`${row.module}.${row.method}.${row.field}`}>
                      <td class="mono">{row.module}</td>
                      <td class="mono">{row.method}</td>
                      <td class="mono">{row.field}</td>
                      <td>
                        {readOnly ? (
                          row.action
                        ) : (
                          <select
                            class="input input-sm"
                            value={row.action}
                            onChange={(e) =>
                              setFieldPolicy(
                                row.module,
                                row.method,
                                row.field,
                                (e.target as HTMLSelectElement).value as FieldPolicy
                              )
                            }
                          >
                            {FIELD_POLICIES.map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      {!readOnly && (
                        <td>
                          <button
                            class="btn-secondary btn-sm"
                            onClick={() => removeFieldPolicy(row.module, row.method, row.field)}
                          >
                            ×
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {toolRows.length === 0 && (
                    <tr>
                      <td colSpan={readOnly ? 4 : 5} style={{ color: 'var(--sai-text-muted)' }}>
                        No tool field policies configured.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {!readOnly && (
            <div class="page-section">
              <div class="page-section-title">Add Tool Field Policy</div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr) auto',
                  gap: '6px',
                  alignItems: 'end',
                }}
              >
                <div>
                  <label style={{ fontSize: '12px', color: 'var(--sai-text-muted)' }}>Module</label>
                  <input
                    class="input input-sm"
                    placeholder="e.g. Network"
                    value={newField.module}
                    onInput={(e) =>
                      setNewField({ ...newField, module: (e.target as HTMLInputElement).value })
                    }
                  />
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: 'var(--sai-text-muted)' }}>Method</label>
                  <input
                    class="input input-sm"
                    placeholder="e.g. fetch"
                    value={newField.method}
                    onInput={(e) =>
                      setNewField({ ...newField, method: (e.target as HTMLInputElement).value })
                    }
                  />
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: 'var(--sai-text-muted)' }}>Field</label>
                  <input
                    class="input input-sm"
                    placeholder="e.g. body"
                    value={newField.field}
                    onInput={(e) =>
                      setNewField({ ...newField, field: (e.target as HTMLInputElement).value })
                    }
                  />
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: 'var(--sai-text-muted)' }}>Policy</label>
                  <select
                    class="input input-sm"
                    value={newField.action}
                    onChange={(e) =>
                      setNewField({
                        ...newField,
                        action: (e.target as HTMLSelectElement).value as FieldPolicy,
                      })
                    }
                  >
                    {FIELD_POLICIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <GradientButton onClick={addFieldPolicy}>Add</GradientButton>
              </div>
            </div>
          )}
        </>
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
