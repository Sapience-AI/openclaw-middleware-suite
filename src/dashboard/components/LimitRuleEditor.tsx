/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { useEffect, useState } from 'preact/hooks';
import { GradientButton } from './GradientButton';
import { showToast } from './Toast';

interface LimitRule {
  sessionCallLimit?: { max: number; windowMs?: number };
  requestCallLimit?: { max: number };
}

type ModuleMap = Record<string, Record<string, LimitRule>>;

interface LimitRuleEditorProps {
  modules: ModuleMap;
  readOnly?: boolean;
  onSave: (modules: ModuleMap) => Promise<void>;
}

function cloneModules(m: ModuleMap): ModuleMap {
  return JSON.parse(JSON.stringify(m));
}

function renderLimit(n: number | undefined): string {
  return typeof n === 'number' ? String(n) : '∞';
}

export function LimitRuleEditor({ modules, readOnly, onSave }: LimitRuleEditorProps) {
  const [draft, setDraft] = useState<ModuleMap>(() => cloneModules(modules));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [newModule, setNewModule] = useState('');
  const [newMethod, setNewMethod] = useState<Record<string, string>>({});

  useEffect(() => {
    setDraft(cloneModules(modules));
    setDirty(false);
  }, [modules]);

  const markDirty = (next: ModuleMap) => {
    setDraft(next);
    setDirty(true);
  };

  const toggle = (mod: string) => setExpanded((p) => ({ ...p, [mod]: !p[mod] }));

  const updateMax = (
    mod: string,
    method: string,
    scope: 'session' | 'request',
    raw: string
  ) => {
    const next = cloneModules(draft);
    const rule = next[mod][method] ?? {};
    const key = scope === 'session' ? 'sessionCallLimit' : 'requestCallLimit';
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '0') {
      delete rule[key];
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0) return;
      rule[key] = { max: Math.floor(n) };
    }
    next[mod][method] = rule;
    markDirty(next);
  };

  const addMethod = (mod: string) => {
    const name = (newMethod[mod] || '').trim();
    if (!name) return;
    const next = cloneModules(draft);
    if (!next[mod]) next[mod] = {};
    if (next[mod][name]) {
      showToast('Method already exists', 'error');
      return;
    }
    next[mod][name] = {};
    markDirty(next);
    setNewMethod((p) => ({ ...p, [mod]: '' }));
  };

  const removeMethod = (mod: string, method: string) => {
    const next = cloneModules(draft);
    delete next[mod][method];
    markDirty(next);
  };

  const addModule = () => {
    const name = newModule.trim();
    if (!name) return;
    const next = cloneModules(draft);
    if (next[name]) {
      showToast('Module already exists', 'error');
      return;
    }
    next[name] = {};
    markDirty(next);
    setNewModule('');
    setExpanded((p) => ({ ...p, [name]: true }));
  };

  const removeModule = (mod: string) => {
    if (!confirm(`Remove module "${mod}" and all its rules?`)) return;
    const next = cloneModules(draft);
    delete next[mod];
    markDirty(next);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft);
      setDirty(false);
      showToast('Limit rules saved', 'success');
    } catch (err) {
      showToast(`Save failed: ${err}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(cloneModules(modules));
    setDirty(false);
  };

  const moduleNames = Object.keys(draft).sort();

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {moduleNames.map((mod) => {
          const methods = Object.keys(draft[mod] || {}).sort();
          const isOpen = !!expanded[mod];
          return (
            <div
              key={mod}
              style={{
                border: '1px solid var(--sai-border)',
                borderRadius: '8px',
                overflow: 'hidden',
              }}
            >
              <div
                class="flex-between"
                style={{ padding: '10px 12px', cursor: 'pointer' }}
                onClick={() => toggle(mod)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontWeight: 600 }}>{mod}</span>
                  <span class="pill" style={{ background: 'var(--sai-bg-elev)' }}>
                    {methods.length} method{methods.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {!readOnly && (
                    <button
                      class="btn-secondary btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeModule(mod);
                      }}
                    >
                      Remove
                    </button>
                  )}
                  <span style={{ color: 'var(--sai-text-muted)' }}>{isOpen ? '▾' : '▸'}</span>
                </div>
              </div>
              {isOpen && (
                <div
                  style={{
                    borderTop: '1px solid var(--sai-border)',
                    padding: '10px 12px',
                    background: 'var(--sai-bg-elev)',
                  }}
                >
                  <table class="data-table" style={{ width: '100%', marginBottom: '8px' }}>
                    <thead>
                      <tr>
                        <th>Method</th>
                        <th>Session Max</th>
                        <th>Request Max</th>
                        {!readOnly && <th></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {methods.map((method) => {
                        const rule = draft[mod][method];
                        return (
                          <tr key={method}>
                            <td class="mono">{method}</td>
                            <td>
                              {readOnly ? (
                                renderLimit(rule.sessionCallLimit?.max)
                              ) : (
                                <input
                                  type="number"
                                  min={0}
                                  class="input input-sm"
                                  placeholder="∞"
                                  value={rule.sessionCallLimit?.max ?? ''}
                                  onInput={(e) =>
                                    updateMax(mod, method, 'session', (e.target as HTMLInputElement).value)
                                  }
                                  style={{ width: '90px' }}
                                />
                              )}
                            </td>
                            <td>
                              {readOnly ? (
                                renderLimit(rule.requestCallLimit?.max)
                              ) : (
                                <input
                                  type="number"
                                  min={0}
                                  class="input input-sm"
                                  placeholder="∞"
                                  value={rule.requestCallLimit?.max ?? ''}
                                  onInput={(e) =>
                                    updateMax(mod, method, 'request', (e.target as HTMLInputElement).value)
                                  }
                                  style={{ width: '90px' }}
                                />
                              )}
                            </td>
                            {!readOnly && (
                              <td>
                                <button
                                  class="btn-secondary btn-sm"
                                  onClick={() => removeMethod(mod, method)}
                                >
                                  ×
                                </button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                      {methods.length === 0 && (
                        <tr>
                          <td colSpan={readOnly ? 3 : 4} style={{ color: 'var(--sai-text-muted)' }}>
                            No methods configured. Global ceilings apply.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  {!readOnly && (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <input
                        class="input input-sm"
                        placeholder="new method name (e.g. read)"
                        value={newMethod[mod] || ''}
                        onInput={(e) =>
                          setNewMethod((p) => ({
                            ...p,
                            [mod]: (e.target as HTMLInputElement).value,
                          }))
                        }
                        style={{ flex: 1 }}
                      />
                      <button class="btn-secondary btn-sm" onClick={() => addMethod(mod)}>
                        + Add method
                      </button>
                    </div>
                  )}
                  <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--sai-text-muted)' }}>
                    Leave a value blank (or 0) for unlimited — global ceilings still apply.
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!readOnly && (
        <div style={{ display: 'flex', gap: '6px', marginTop: '12px' }}>
          <input
            class="input input-sm"
            placeholder="new module name (e.g. FileSystem)"
            value={newModule}
            onInput={(e) => setNewModule((e.target as HTMLInputElement).value)}
            style={{ flex: 1 }}
          />
          <button class="btn-secondary btn-sm" onClick={addModule}>
            + Add module
          </button>
        </div>
      )}

      {!readOnly && dirty && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
          <GradientButton onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save rules'}
          </GradientButton>
          <button class="btn-secondary" onClick={discard} disabled={saving}>
            Discard
          </button>
        </div>
      )}
    </div>
  );
}
