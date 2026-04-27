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
  fetchGuardrailConfig,
  updateGuardrailConfig,
  fetchGuardrailAudit,
  fetchGuardrailConfigPath,
  resetGuardrailConfig,
} from '../services/api';
import { DataTable } from '../components/DataTable';
import { LogViewer } from '../components/LogViewer';
import { ConfigForm, FormField } from '../components/ConfigForm';
import { StatCard } from '../components/StatCard';
import { GradientButton } from '../components/GradientButton';
import { showToast } from '../components/Toast';
import { formatTimestamp } from '../services/formatters';
import { useMiddlewareEnabled } from '../services/useMiddlewareEnabled';

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type Action = 'LOG' | 'WARN' | 'BLOCK';
type RuleType = 'regex' | 'prefix' | 'heuristic';

interface DetectionRule {
  name: string;
  type: RuleType;
  pattern: string;
  severity: Severity;
  action: Action;
  enabled: boolean;
  confidence?: 'high' | 'medium';
  description?: string;
}

type RuleCategory = 'promptInjection' | 'pii' | 'suspicious';

interface SensitivePathConfig {
  enabled: boolean;
  action: Action;
  blockedPaths: string[];
  allowedPaths: string[];
}

interface EgressConfig {
  enabled: boolean;
  defaultAction: Action;
  allowedDomains: string[];
  blockDataSending: boolean;
  blockPrivateIPs: boolean;
}

interface DestructiveConfig {
  enabled: boolean;
  action: Action;
  customPatterns: string[];
}

interface OutputScrubberConfig {
  enabled: boolean;
  dryRunMode: boolean;
  replacementText: string;
  customPatterns: string[];
}

interface ModerationConfig {
  rewriteThreshold: 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

interface GuardrailConfig {
  version?: string;
  enabled?: boolean;
  dryRunMode?: boolean;
  unicodeNormalization?: boolean;
  entropyThreshold?: number;
  rules?: {
    promptInjection?: DetectionRule[];
    pii?: DetectionRule[];
    suspicious?: DetectionRule[];
  };
  sensitivePaths?: SensitivePathConfig;
  egressControl?: EgressConfig;
  destructiveCommands?: DestructiveConfig;
  outputScrubber?: OutputScrubberConfig;
  moderation?: ModerationConfig;
}

type Tab =
  | 'overview'
  | 'general'
  | 'rules'
  | 'paths'
  | 'egress'
  | 'destructive'
  | 'output'
  | 'logs';

const ACTIONS: Action[] = ['LOG', 'WARN', 'BLOCK'];
const SEVERITIES: Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const RULE_TYPES: RuleType[] = ['regex', 'prefix', 'heuristic'];

const generalFields: FormField[] = [
  { key: 'dryRunMode', label: 'Dry-Run Mode', type: 'toggle', description: 'Log detections without blocking — useful for tuning rules.' },
  { key: 'unicodeNormalization', label: 'Unicode Normalization', type: 'toggle', description: 'NFKC-normalize input before scanning (prevents homoglyph bypass).' },
  { key: 'entropyThreshold', label: 'Entropy Threshold', type: 'number', min: 1, max: 8, step: 0.1, description: 'Shannon entropy cutoff for secret-like heuristics (1.0–8.0, default 4.0).' },
  { key: 'moderationRewriteThreshold', label: 'Moderation Rewrite Threshold', type: 'dropdown', options: [{ value: 'MEDIUM', label: 'MEDIUM' }, { value: 'HIGH', label: 'HIGH' }, { value: 'CRITICAL', label: 'CRITICAL' }], description: 'Minimum severity at which a flagged prompt is rewritten in the transcript.' },
];

function StringListEditor({
  items,
  placeholder,
  readOnly,
  onChange,
}: {
  items: string[];
  placeholder: string;
  readOnly?: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) return;
    onChange([...items, v]);
    setDraft('');
  };
  const remove = (v: string) => onChange(items.filter((x) => x !== v));
  return (
    <div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        {items.length === 0 && (
          <li style={{ color: 'var(--sai-text-muted)', fontSize: '13px' }}>
            (none)
          </li>
        )}
        {items.map((item) => (
          <li key={item} class="pill" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span class="mono">{item}</span>
            {!readOnly && (
              <button
                class="btn-secondary btn-sm"
                onClick={() => remove(item)}
                style={{ padding: '0 4px' }}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
          <input
            class="input input-sm"
            placeholder={placeholder}
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            style={{ flex: 1 }}
          />
          <button class="btn-secondary btn-sm" onClick={add}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}

export function GuardrailPage(_props: { path?: string }) {
  const [config, setConfig] = useState<GuardrailConfig>({});
  const [audit, setAudit] = useState<unknown[]>([]);
  const [configPath, setConfigPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');
  const [resetting, setResetting] = useState(false);
  const [ruleCategory, setRuleCategory] = useState<RuleCategory>('promptInjection');
  const [newRule, setNewRule] = useState<Partial<DetectionRule>>({
    type: 'regex',
    severity: 'HIGH',
    action: 'WARN',
    enabled: true,
  });
  const enabled = useMiddlewareEnabled('guardrail');
  const readOnly = enabled === false;

  const reload = async () => {
    const c = await fetchGuardrailConfig().catch(() => ({}));
    setConfig(c as GuardrailConfig);
  };

  useEffect(() => {
    Promise.all([
      reload(),
      fetchGuardrailAudit(100).then((a) => setAudit(a)).catch(() => {}),
      fetchGuardrailConfigPath().then((p) => setConfigPath(p.path)).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  const save = async (next: GuardrailConfig): Promise<void> => {
    await updateGuardrailConfig(next as unknown as Record<string, unknown>);
    setConfig(next);
  };

  const saveGeneral = async (val: Record<string, unknown>) => {
    const next: GuardrailConfig = { ...config };
    next.dryRunMode = !!val.dryRunMode;
    next.unicodeNormalization = !!val.unicodeNormalization;
    const entropy = Number(val.entropyThreshold);
    if (Number.isFinite(entropy) && entropy >= 1 && entropy <= 8) {
      next.entropyThreshold = entropy;
    }
    const threshold = val.moderationRewriteThreshold as 'MEDIUM' | 'HIGH' | 'CRITICAL';
    next.moderation = { rewriteThreshold: threshold ?? 'HIGH' };
    await save(next);
    showToast('General config saved', 'success');
  };

  const handleReset = async () => {
    if (!confirm('Reset all guardrail config to factory defaults? This discards custom rules, allowlists, and sub-guard settings.'))
      return;
    setResetting(true);
    try {
      await resetGuardrailConfig();
      await reload();
      showToast('Guardrail reset to defaults', 'success');
    } catch (err) {
      showToast(`Reset failed: ${err}`, 'error');
    } finally {
      setResetting(false);
    }
  };

  const rules = config.rules ?? {};
  const allRules: { category: RuleCategory; rule: DetectionRule }[] = (
    ['promptInjection', 'pii', 'suspicious'] as RuleCategory[]
  ).flatMap((c) => (rules[c] ?? []).map((rule) => ({ category: c, rule })));

  const toggleRule = async (cat: RuleCategory, name: string) => {
    const next: GuardrailConfig = { ...config };
    const list = (next.rules?.[cat] ?? []).map((r) =>
      r.name === name ? { ...r, enabled: !r.enabled } : r
    );
    next.rules = { ...next.rules, [cat]: list };
    await save(next);
  };

  const setRuleAction = async (cat: RuleCategory, name: string, action: Action) => {
    const next: GuardrailConfig = { ...config };
    const list = (next.rules?.[cat] ?? []).map((r) => (r.name === name ? { ...r, action } : r));
    next.rules = { ...next.rules, [cat]: list };
    await save(next);
  };

  const removeRule = async (cat: RuleCategory, name: string) => {
    if (!confirm(`Remove rule "${name}" from ${cat}?`)) return;
    const next: GuardrailConfig = { ...config };
    const list = (next.rules?.[cat] ?? []).filter((r) => r.name !== name);
    next.rules = { ...next.rules, [cat]: list };
    await save(next);
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
    const rule: DetectionRule = {
      name: newRule.name,
      type: (newRule.type ?? 'regex') as RuleType,
      pattern: newRule.pattern,
      severity: (newRule.severity ?? 'HIGH') as Severity,
      action: (newRule.action ?? 'WARN') as Action,
      enabled: newRule.enabled ?? true,
      confidence: newRule.confidence,
      description: newRule.description,
    };
    const next: GuardrailConfig = { ...config };
    const list = [...(next.rules?.[ruleCategory] ?? []).filter((r) => r.name !== rule.name), rule];
    next.rules = { ...next.rules, [ruleCategory]: list };
    await save(next);
    setNewRule({ type: 'regex', severity: 'HIGH', action: 'WARN', enabled: true });
    showToast(`Added rule "${rule.name}"`, 'success');
  };

  const saveSensitivePaths = async (update: Partial<SensitivePathConfig>) => {
    const next: GuardrailConfig = { ...config };
    const current: SensitivePathConfig = next.sensitivePaths ?? {
      enabled: true,
      action: 'BLOCK',
      blockedPaths: [],
      allowedPaths: [],
    };
    next.sensitivePaths = { ...current, ...update };
    await save(next);
  };

  const saveEgress = async (update: Partial<EgressConfig>) => {
    const next: GuardrailConfig = { ...config };
    const current: EgressConfig = next.egressControl ?? {
      enabled: true,
      defaultAction: 'BLOCK',
      allowedDomains: [],
      blockDataSending: true,
      blockPrivateIPs: true,
    };
    next.egressControl = { ...current, ...update };
    await save(next);
  };

  const saveDestructive = async (update: Partial<DestructiveConfig>) => {
    const next: GuardrailConfig = { ...config };
    const current: DestructiveConfig = next.destructiveCommands ?? {
      enabled: true,
      action: 'BLOCK',
      customPatterns: [],
    };
    next.destructiveCommands = { ...current, ...update };
    await save(next);
  };

  const saveOutput = async (update: Partial<OutputScrubberConfig>) => {
    const next: GuardrailConfig = { ...config };
    const current: OutputScrubberConfig = next.outputScrubber ?? {
      enabled: true,
      dryRunMode: false,
      replacementText: '',
      customPatterns: [],
    };
    next.outputScrubber = { ...current, ...update };
    await save(next);
  };

  // ── Tab content ──
  const sp = config.sensitivePaths ?? {
    enabled: true,
    action: 'BLOCK' as Action,
    blockedPaths: [],
    allowedPaths: [],
  };
  const eg = config.egressControl ?? {
    enabled: true,
    defaultAction: 'BLOCK' as Action,
    allowedDomains: [],
    blockDataSending: true,
    blockPrivateIPs: true,
  };
  const dc = config.destructiveCommands ?? {
    enabled: true,
    action: 'BLOCK' as Action,
    customPatterns: [],
  };
  const os_ = config.outputScrubber ?? {
    enabled: true,
    dryRunMode: false,
    replacementText: '',
    customPatterns: [],
  };

  const generalValues: Record<string, unknown> = {
    dryRunMode: config.dryRunMode ?? false,
    unicodeNormalization: config.unicodeNormalization ?? true,
    entropyThreshold: config.entropyThreshold ?? 4.0,
    moderationRewriteThreshold: config.moderation?.rewriteThreshold ?? 'HIGH',
  };

  const tabs: Tab[] = [
    'overview',
    'general',
    'rules',
    'paths',
    'egress',
    'destructive',
    'output',
    'logs',
  ];

  const ruleCount = allRules.length;
  const activeRuleCount = allRules.filter((x) => x.rule.enabled).length;

  return (
    <div>
      <div class="section-eyebrow">Middleware</div>
      <h1 class="section-title">Guardrail</h1>

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
          Loading guardrail data…
        </div>
      )}

      {!loading && tab === 'overview' && (
        <>
          <div class="grid-3 mb-16">
            <StatCard label="Status" value={enabled ? (config.dryRunMode ? 'Dry-Run' : 'Enforcing') : 'Disabled'} />
            <StatCard label="Rules (active / total)" value={`${activeRuleCount} / ${ruleCount}`} />
            <StatCard label="Recent Detections" value={String(audit.length)} />
          </div>
          <div class="grid-3 mb-16">
            <StatCard label="Sensitive Paths" value={sp.enabled ? sp.action : 'Off'} />
            <StatCard label="Egress Control" value={eg.enabled ? eg.defaultAction : 'Off'} />
            <StatCard label="Destructive Commands" value={dc.enabled ? dc.action : 'Off'} />
          </div>
          <div class="page-section">
            <div class="page-section-title">Recent Detections</div>
            <DataTable
              columns={[
                { key: 'timestamp', label: 'Time', render: (v: unknown) => formatTimestamp(v as string) },
                { key: 'rule', label: 'Rule' },
                { key: 'severity', label: 'Severity' },
                { key: 'module', label: 'Module' },
                { key: 'method', label: 'Method', mono: true },
                {
                  key: 'action',
                  label: 'Action',
                  render: (v: unknown) => {
                    const a = v as string;
                    return (
                      <span class={`pill ${a === 'BLOCK' ? 'pill-red' : 'pill-purple'}`}>{a || '-'}</span>
                    );
                  },
                },
              ]}
              data={[...(audit as Record<string, unknown>[])].reverse().slice(0, 20)}
              emptyText="No detections recorded yet"
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
                  Restores default rules, sub-guards, and thresholds. Destructive.
                </span>
              </div>
              {configPath && (
                <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--sai-text-muted)' }}>
                  Config location: <span class="mono">{configPath}</span>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {!loading && tab === 'rules' && (
        <>
          <div class="page-section">
            <div class="page-section-title">Category</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              {(['promptInjection', 'pii', 'suspicious'] as RuleCategory[]).map((c) => (
                <button
                  key={c}
                  class="btn-secondary btn-sm"
                  style={
                    ruleCategory === c
                      ? { background: 'var(--sai-gradient)', color: '#fff', borderColor: 'transparent' }
                      : {}
                  }
                  onClick={() => setRuleCategory(c)}
                >
                  {c} ({(rules[c] ?? []).length})
                </button>
              ))}
            </div>
          </div>

          <div class="page-section">
            <div class="page-section-title">Rules in {ruleCategory}</div>
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
                  {(rules[ruleCategory] ?? []).map((r) => (
                    <tr key={r.name}>
                      <td class="mono" title={r.description}>
                        {r.name}
                      </td>
                      <td>{r.type}</td>
                      <td>
                        <span class={`pill ${r.severity === 'CRITICAL' || r.severity === 'HIGH' ? 'pill-red' : 'pill-purple'}`}>
                          {r.severity}
                        </span>
                      </td>
                      <td>
                        {readOnly ? (
                          r.action
                        ) : (
                          <select
                            class="input input-sm"
                            value={r.action}
                            onChange={(e) =>
                              setRuleAction(
                                ruleCategory,
                                r.name,
                                (e.target as HTMLSelectElement).value as Action
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
                          <button
                            class="btn-secondary btn-sm"
                            onClick={() => toggleRule(ruleCategory, r.name)}
                          >
                            {r.enabled ? 'Disable' : 'Enable'}
                          </button>
                        )}
                      </td>
                      {!readOnly && (
                        <td>
                          <button
                            class="btn-secondary btn-sm"
                            onClick={() => removeRule(ruleCategory, r.name)}
                          >
                            ×
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {(rules[ruleCategory] ?? []).length === 0 && (
                    <tr>
                      <td colSpan={readOnly ? 5 : 6} style={{ color: 'var(--sai-text-muted)' }}>
                        No rules in this category.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {!readOnly && (
            <div class="page-section">
              <div class="page-section-title">Add Rule to {ruleCategory}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '6px', alignItems: 'end' }}>
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
                      setNewRule({ ...newRule, type: (e.target as HTMLSelectElement).value as RuleType })
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
                  <label style={{ fontSize: '12px', color: 'var(--sai-text-muted)' }}>Severity</label>
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
                        action: (e.target as HTMLSelectElement).value as Action,
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

      {!loading && tab === 'paths' && (
        <>
          <div class="page-section">
            <div class="page-section-title">Sensitive Path Blocklist</div>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '12px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                  type="checkbox"
                  checked={sp.enabled}
                  disabled={readOnly}
                  onChange={(e) => saveSensitivePaths({ enabled: (e.target as HTMLInputElement).checked })}
                />
                Enabled
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                Action:
                <select
                  class="input input-sm"
                  value={sp.action}
                  disabled={readOnly}
                  onChange={(e) =>
                    saveSensitivePaths({ action: (e.target as HTMLSelectElement).value as Action })
                  }
                >
                  <option value="BLOCK">BLOCK</option>
                  <option value="WARN">WARN</option>
                </select>
              </label>
            </div>
          </div>
          <div class="page-section">
            <div class="page-section-title">Blocked Paths</div>
            <StringListEditor
              items={sp.blockedPaths}
              placeholder="e.g. **/.ssh/**"
              readOnly={readOnly}
              onChange={(blockedPaths) => saveSensitivePaths({ blockedPaths })}
            />
          </div>
          <div class="page-section">
            <div class="page-section-title">Allowed Paths (override blocks)</div>
            <StringListEditor
              items={sp.allowedPaths}
              placeholder="e.g. **/.ssh/known_hosts"
              readOnly={readOnly}
              onChange={(allowedPaths) => saveSensitivePaths({ allowedPaths })}
            />
          </div>
        </>
      )}

      {!loading && tab === 'egress' && (
        <>
          <div class="page-section">
            <div class="page-section-title">Network Egress Control</div>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                  type="checkbox"
                  checked={eg.enabled}
                  disabled={readOnly}
                  onChange={(e) => saveEgress({ enabled: (e.target as HTMLInputElement).checked })}
                />
                Enabled
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                Default action:
                <select
                  class="input input-sm"
                  value={eg.defaultAction}
                  disabled={readOnly}
                  onChange={(e) =>
                    saveEgress({ defaultAction: (e.target as HTMLSelectElement).value as Action })
                  }
                >
                  <option value="BLOCK">BLOCK</option>
                  <option value="WARN">WARN</option>
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                  type="checkbox"
                  checked={eg.blockDataSending}
                  disabled={readOnly}
                  onChange={(e) =>
                    saveEgress({ blockDataSending: (e.target as HTMLInputElement).checked })
                  }
                />
                Block data-sending (curl -d, wget --post)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                  type="checkbox"
                  checked={eg.blockPrivateIPs}
                  disabled={readOnly}
                  onChange={(e) =>
                    saveEgress({ blockPrivateIPs: (e.target as HTMLInputElement).checked })
                  }
                />
                Block private IPs (127.x, 10.x, 169.254.169.254)
              </label>
            </div>
          </div>
          <div class="page-section">
            <div class="page-section-title">Allowed Domains</div>
            <StringListEditor
              items={eg.allowedDomains}
              placeholder="e.g. *.github.com"
              readOnly={readOnly}
              onChange={(allowedDomains) => saveEgress({ allowedDomains })}
            />
          </div>
        </>
      )}

      {!loading && tab === 'destructive' && (
        <>
          <div class="page-section">
            <div class="page-section-title">Destructive Command Blocker</div>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '12px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                  type="checkbox"
                  checked={dc.enabled}
                  disabled={readOnly}
                  onChange={(e) =>
                    saveDestructive({ enabled: (e.target as HTMLInputElement).checked })
                  }
                />
                Enabled
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                Action:
                <select
                  class="input input-sm"
                  value={dc.action}
                  disabled={readOnly}
                  onChange={(e) =>
                    saveDestructive({ action: (e.target as HTMLSelectElement).value as Action })
                  }
                >
                  <option value="BLOCK">BLOCK</option>
                  <option value="WARN">WARN</option>
                </select>
              </label>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--sai-text-muted)', marginBottom: '8px' }}>
              Built-in rules (rm -rf, DROP TABLE, format, git push --force main, etc.) are always on
              when this is enabled. Add custom regex patterns below.
            </div>
          </div>
          <div class="page-section">
            <div class="page-section-title">Custom Patterns (regex)</div>
            <StringListEditor
              items={dc.customPatterns}
              placeholder="e.g. shred\\s+-[a-z]*u"
              readOnly={readOnly}
              onChange={(customPatterns) => saveDestructive({ customPatterns })}
            />
          </div>
        </>
      )}

      {!loading && tab === 'output' && (
        <>
          <div class="page-section">
            <div class="page-section-title">Output Scrubber</div>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                  type="checkbox"
                  checked={os_.enabled}
                  disabled={readOnly}
                  onChange={(e) =>
                    saveOutput({ enabled: (e.target as HTMLInputElement).checked })
                  }
                />
                Enabled
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                  type="checkbox"
                  checked={os_.dryRunMode}
                  disabled={readOnly}
                  onChange={(e) =>
                    saveOutput({ dryRunMode: (e.target as HTMLInputElement).checked })
                  }
                />
                Dry-Run Mode
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                Replacement text:
                <input
                  class="input input-sm"
                  value={os_.replacementText}
                  placeholder="(blank = remove seamlessly)"
                  disabled={readOnly}
                  onChange={(e) =>
                    saveOutput({ replacementText: (e.target as HTMLInputElement).value })
                  }
                />
              </label>
            </div>
          </div>
          <div class="page-section">
            <div class="page-section-title">Custom Scrubber Patterns (regex)</div>
            <StringListEditor
              items={os_.customPatterns}
              placeholder="e.g. \\binternal-token-[a-z0-9]+\\b"
              readOnly={readOnly}
              onChange={(customPatterns) => saveOutput({ customPatterns })}
            />
          </div>
        </>
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
