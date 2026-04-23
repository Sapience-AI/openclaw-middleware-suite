import { useEffect, useState } from 'preact/hooks';
import { GradientButton } from './GradientButton';
import { showToast } from './Toast';

type Action = 'ALLOW' | 'ASK' | 'DENY';

interface Rule {
  action: Action;
  description?: string;
  allowPaths?: string[];
  denyPaths?: string[];
}

type ModuleMap = Record<string, Record<string, Rule>>;

interface HitlRuleEditorProps {
  modules: ModuleMap;
  readOnly?: boolean;
  onSave: (modules: ModuleMap) => Promise<void>;
}

const ACTION_OPTIONS: Action[] = ['ALLOW', 'ASK', 'DENY'];

function pillClass(action: Action): string {
  if (action === 'ALLOW') return 'pill pill-green';
  if (action === 'DENY') return 'pill pill-red';
  return 'pill pill-yellow';
}

function parseGlobs(input: string): string[] | undefined {
  const parts = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function joinGlobs(globs: string[] | undefined): string {
  return globs && globs.length > 0 ? globs.join(', ') : '';
}

function cloneModules(m: ModuleMap): ModuleMap {
  return JSON.parse(JSON.stringify(m));
}

export function HitlRuleEditor({ modules, readOnly, onSave }: HitlRuleEditorProps) {
  const [draft, setDraft] = useState<ModuleMap>(() => cloneModules(modules));
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setDraft(cloneModules(modules));
  }, [modules]);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(modules);

  const updateRule = (mod: string, method: string, patch: Partial<Rule>) => {
    setDraft((prev) => {
      const next = cloneModules(prev);
      next[mod][method] = { ...next[mod][method], ...patch };
      return next;
    });
  };

  const removeRule = (mod: string, method: string) => {
    setDraft((prev) => {
      const next = cloneModules(prev);
      delete next[mod][method];
      return next;
    });
  };

  const removeModule = (mod: string) => {
    if (!window.confirm(`Remove module "${mod}" and all its rules?`)) return;
    setDraft((prev) => {
      const next = cloneModules(prev);
      delete next[mod];
      return next;
    });
  };

  const addMethod = (mod: string) => {
    const name = window.prompt(`New method name for ${mod}:`);
    if (!name) return;
    const key = name.trim();
    if (!key) return;
    if (draft[mod]?.[key]) {
      showToast(`Method "${key}" already exists in ${mod}`, 'error');
      return;
    }
    setDraft((prev) => {
      const next = cloneModules(prev);
      if (!next[mod]) next[mod] = {};
      next[mod][key] = { action: 'ASK' };
      return next;
    });
    setExpanded((e) => ({ ...e, [`${mod}::${key}`]: true }));
  };

  const addModule = () => {
    const name = window.prompt('New module name (e.g., "CustomTool"):');
    if (!name) return;
    const key = name.trim();
    if (!key) return;
    if (draft[key]) {
      showToast(`Module "${key}" already exists`, 'error');
      return;
    }
    setDraft((prev) => ({
      ...prev,
      [key]: { '*': { action: 'ASK', description: 'Default rule for all methods' } },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft);
      showToast('Rules saved', 'success');
    } catch {
      showToast('Failed to save rules', 'error');
    } finally {
      setSaving(false);
    }
  };

  const moduleNames = Object.keys(draft).sort();

  return (
    <div class="hitl-rule-editor">
      {moduleNames.length === 0 && (
        <div style={{ color: 'var(--sai-text-muted)', padding: '16px 0' }}>
          No modules configured. Click "Add Module" below to create one.
        </div>
      )}

      {moduleNames.map((mod) => {
        const methods = Object.keys(draft[mod]).sort();
        return (
          <div
            key={mod}
            style={{
              border: '1px solid var(--sai-border)',
              borderRadius: '8px',
              padding: '12px',
              marginBottom: '12px',
              background: 'var(--sai-surface)',
            }}
          >
            <div class="flex-between" style={{ marginBottom: '12px' }}>
              <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--sai-accent)' }}>
                {mod}
                <span style={{ marginLeft: '8px', fontSize: '12px', color: 'var(--sai-text-muted)', fontWeight: 400 }}>
                  ({methods.length} {methods.length === 1 ? 'rule' : 'rules'})
                </span>
              </div>
              {!readOnly && (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button class="btn-secondary btn-sm" onClick={() => addMethod(mod)}>
                    + Method
                  </button>
                  <button class="btn-secondary btn-sm" onClick={() => removeModule(mod)}>
                    Remove
                  </button>
                </div>
              )}
            </div>

            {methods.length === 0 && (
              <div style={{ color: 'var(--sai-text-muted)', fontSize: '13px' }}>
                No methods yet.
              </div>
            )}

            {methods.map((method) => {
              const rule = draft[mod][method];
              const id = `${mod}::${method}`;
              const isOpen = expanded[id] ?? false;
              return (
                <div
                  key={id}
                  style={{
                    borderTop: '1px solid var(--sai-border)',
                    padding: '10px 0',
                  }}
                >
                  <div class="flex-between">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        class="btn-secondary btn-sm"
                        style={{ minWidth: '28px' }}
                        onClick={() => setExpanded((e) => ({ ...e, [id]: !isOpen }))}
                      >
                        {isOpen ? '▾' : '▸'}
                      </button>
                      <code style={{ fontSize: '13px' }}>{method}</code>
                      <span class={pillClass(rule.action)}>{rule.action}</span>
                      {rule.description && (
                        <span style={{ fontSize: '12px', color: 'var(--sai-text-muted)' }}>
                          — {rule.description}
                        </span>
                      )}
                    </div>
                    {!readOnly && (
                      <button
                        class="btn-secondary btn-sm"
                        onClick={() => removeRule(mod, method)}
                      >
                        Remove
                      </button>
                    )}
                  </div>

                  {isOpen && (
                    <div style={{ marginTop: '10px', display: 'grid', gap: '8px' }}>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <label style={{ width: '110px', fontSize: '12px' }}>Action</label>
                        <select
                          class="form-select"
                          value={rule.action}
                          disabled={readOnly}
                          onChange={(e) =>
                            updateRule(mod, method, {
                              action: (e.target as HTMLSelectElement).value as Action,
                            })
                          }
                        >
                          {ACTION_OPTIONS.map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <label style={{ width: '110px', fontSize: '12px' }}>Description</label>
                        <input
                          class="form-input"
                          style={{ flex: 1 }}
                          type="text"
                          value={rule.description || ''}
                          disabled={readOnly}
                          placeholder="Optional description"
                          onInput={(e) =>
                            updateRule(mod, method, {
                              description: (e.target as HTMLInputElement).value || undefined,
                            })
                          }
                        />
                      </div>

                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <label style={{ width: '110px', fontSize: '12px' }}>Allow paths</label>
                        <input
                          class="form-input"
                          style={{ flex: 1 }}
                          type="text"
                          value={joinGlobs(rule.allowPaths)}
                          disabled={readOnly}
                          placeholder="Comma-separated globs, e.g. /workspace/**, /tmp/**"
                          onInput={(e) =>
                            updateRule(mod, method, {
                              allowPaths: parseGlobs((e.target as HTMLInputElement).value),
                            })
                          }
                        />
                      </div>

                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <label style={{ width: '110px', fontSize: '12px' }}>Deny paths</label>
                        <input
                          class="form-input"
                          style={{ flex: 1 }}
                          type="text"
                          value={joinGlobs(rule.denyPaths)}
                          disabled={readOnly}
                          placeholder="Comma-separated globs, e.g. **/.ssh/**, **/.env"
                          onInput={(e) =>
                            updateRule(mod, method, {
                              denyPaths: parseGlobs((e.target as HTMLInputElement).value),
                            })
                          }
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {!readOnly && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
          <GradientButton onClick={handleSave} disabled={saving || !isDirty}>
            {saving ? 'Saving...' : 'Save Rules'}
          </GradientButton>
          <GradientButton secondary onClick={addModule}>
            + Add Module
          </GradientButton>
          <GradientButton
            secondary
            onClick={() => setDraft(cloneModules(modules))}
            disabled={!isDirty}
          >
            Discard Changes
          </GradientButton>
        </div>
      )}
    </div>
  );
}
