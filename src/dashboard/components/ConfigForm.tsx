import { useState, useEffect } from 'preact/hooks';
import { GradientButton } from './GradientButton';
import { showToast } from './Toast';

// ── Field type definitions ────────────────────────────────────────────────

interface FieldBase {
  key: string;
  label: string;
  description?: string;
  showWhen?: (values: Record<string, unknown>) => boolean;
}

interface ToggleField extends FieldBase {
  type: 'toggle';
  /** When this returns true the toggle is visually disabled and the checkbox
   *  cannot be flipped. Used for dependent toggles (e.g. caching requires
   *  pinning to be on). */
  disabledWhen?: (values: Record<string, unknown>) => boolean;
}

interface DropdownField extends FieldBase {
  type: 'dropdown';
  options: { value: string; label: string }[];
  /** When this returns true the dropdown is visually disabled and its
   *  value cannot be changed. Used for dependent fields (e.g. caching
   *  requires pinning to be enabled). */
  disabledWhen?: (values: Record<string, unknown>) => boolean;
}

interface NumberField extends FieldBase {
  type: 'number';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
}

interface SliderField extends FieldBase {
  type: 'slider';
  min: number;
  max: number;
  step?: number;
  unit?: string;
}

interface TextField extends FieldBase {
  type: 'text';
  placeholder?: string;
}

interface TextareaField extends FieldBase {
  type: 'textarea';
  placeholder?: string;
  rows?: number;
  /** Optional client-side validator: return null/undefined when valid, or an error message string. */
  validate?: (val: string) => string | null | undefined;
}

interface CheckboxGroupField extends FieldBase {
  type: 'checkbox-group';
  options: { value: string; label: string }[];
}

export type FormField =
  | ToggleField
  | DropdownField
  | NumberField
  | SliderField
  | TextField
  | TextareaField
  | CheckboxGroupField;

interface ConfigFormProps {
  fields: FormField[];
  values: Record<string, unknown>;
  onSave: (values: Record<string, unknown>) => Promise<void>;
  /** When true, fields are visible but not editable and save/reset buttons are hidden. */
  readOnly?: boolean;
}

// ── ConfigForm component ──────────────────────────────────────────────────

export function ConfigForm({ fields, values, onSave, readOnly }: ConfigFormProps) {
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const initial: Record<string, unknown> = {};
    for (const f of fields) {
      initial[f.key] = values[f.key];
    }
    setForm(initial);
  }, [values]);

  const set = (key: string, val: unknown) => {
    setForm((prev) => ({ ...prev, [key]: val }));
  };

  const handleSave = async () => {
    // Run any per-field validators before saving
    for (const field of fields) {
      if (field.showWhen && !field.showWhen(form)) continue;
      if (field.type !== 'textarea' || !field.validate) continue;
      const val = (form[field.key] as string) || '';
      const err = field.validate(val);
      if (err) {
        showToast(`${field.label}: ${err}`, 'error');
        return;
      }
    }

    setSaving(true);
    try {
      const merged = { ...values, ...form };
      await onSave(merged);
      showToast('Configuration saved', 'success');
    } catch {
      showToast('Failed to save configuration', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    const initial: Record<string, unknown> = {};
    for (const f of fields) {
      initial[f.key] = values[f.key];
    }
    setForm(initial);
  };

  const noopSet = (_key: string, _val: unknown) => {};

  return (
    <div class={`config-form${readOnly ? ' config-form--readonly' : ''}`}>
      {readOnly && (
        <div class="config-form-banner">
          This middleware is disabled. Enable it to edit configuration.
        </div>
      )}

      {fields.map((field) => {
        if (field.showWhen && !field.showWhen(form)) return null;

        return (
          <div class="config-field" key={field.key}>
            {renderField(field, form, readOnly ? noopSet : set)}
          </div>
        );
      })}

      {!readOnly && (
        <div class="config-form-actions">
          <GradientButton onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </GradientButton>
          <GradientButton secondary onClick={handleReset}>
            Reset
          </GradientButton>
        </div>
      )}
    </div>
  );
}

// ── Field renderers ───────────────────────────────────────────────────────

function renderField(
  field: FormField,
  form: Record<string, unknown>,
  set: (key: string, val: unknown) => void,
) {
  switch (field.type) {
    case 'toggle':
      return renderToggle(field, form, set);
    case 'dropdown':
      return renderDropdown(field, form, set);
    case 'number':
      return renderNumber(field, form, set);
    case 'slider':
      return renderSlider(field, form, set);
    case 'text':
      return renderText(field, form, set);
    case 'textarea':
      return renderTextarea(field, form, set);
    case 'checkbox-group':
      return renderCheckboxGroup(field, form, set);
  }
}

function renderToggle(
  field: ToggleField,
  form: Record<string, unknown>,
  set: (key: string, val: unknown) => void,
) {
  const checked = Boolean(form[field.key]);
  const disabled = field.disabledWhen ? field.disabledWhen(form) : false;
  return (
    <div class="config-field-row" style={disabled ? { opacity: 0.5 } : undefined}>
      <div class="config-field-info">
        <div class="config-field-label">{field.label}</div>
        {field.description && <div class="config-field-desc">{field.description}</div>}
      </div>
      <label class="toggle">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={() => {
            if (disabled) return;
            set(field.key, !checked);
          }}
        />
        <span class="toggle-track" />
        <span class="toggle-thumb" />
      </label>
    </div>
  );
}

function renderDropdown(
  field: DropdownField,
  form: Record<string, unknown>,
  set: (key: string, val: unknown) => void,
) {
  const current = (form[field.key] as string) || '';
  const disabled = field.disabledWhen ? field.disabledWhen(form) : false;
  return (
    <div class="config-field-row" style={disabled ? { opacity: 0.5 } : undefined}>
      <div class="config-field-info">
        <label class="config-field-label">{field.label}</label>
        {field.description && <div class="config-field-desc">{field.description}</div>}
      </div>
      <div class="config-field-control">
        <select
          class="form-select"
          value={current}
          disabled={disabled}
          onChange={(e) => {
            if (disabled) return;
            set(field.key, (e.target as HTMLSelectElement).value);
          }}
        >
          {!field.options.some((o) => o.value === current) && (
            <option value={current} disabled>
              {current || '— Select —'}
            </option>
          )}
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function renderNumber(
  field: NumberField,
  form: Record<string, unknown>,
  set: (key: string, val: unknown) => void,
) {
  const raw = form[field.key];
  const val = typeof raw === 'number' ? raw : 0;
  return (
    <div class="config-field-row">
      <div class="config-field-info">
        <label class="config-field-label">{field.label}</label>
        {field.description && <div class="config-field-desc">{field.description}</div>}
      </div>
      <div class="config-field-control">
        <div class="config-field-number-wrap">
          <input
            type="number"
            class="form-input"
            value={val}
            min={field.min}
            max={field.max}
            step={field.step ?? 1}
            placeholder={field.placeholder}
            onInput={(e) => {
              const n = Number((e.target as HTMLInputElement).value);
              set(field.key, isNaN(n) ? 0 : n);
            }}
          />
          {field.unit && <span class="config-field-unit">{field.unit}</span>}
        </div>
      </div>
    </div>
  );
}

function renderSlider(
  field: SliderField,
  form: Record<string, unknown>,
  set: (key: string, val: unknown) => void,
) {
  const raw = form[field.key];
  const val = typeof raw === 'number' ? raw : field.min;
  const pct = ((val - field.min) / (field.max - field.min)) * 100;
  return (
    <div class="config-field-row config-field-row--slider">
      <div class="config-field-info">
        <label class="config-field-label">{field.label}</label>
        {field.description && <div class="config-field-desc">{field.description}</div>}
      </div>
      <div class="config-field-control">
        <div class="config-field-slider-header">
          <span class="config-field-slider-val">
            {val}{field.unit ? ` ${field.unit}` : ''}
          </span>
        </div>
        <input
          type="range"
          class="config-slider"
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          value={val}
          style={{ '--slider-pct': `${pct}%` } as any}
          onInput={(e) => set(field.key, Number((e.target as HTMLInputElement).value))}
        />
        <div class="config-slider-range">
          <span>{field.min}</span>
          <span>{field.max}</span>
        </div>
      </div>
    </div>
  );
}

function renderText(
  field: TextField,
  form: Record<string, unknown>,
  set: (key: string, val: unknown) => void,
) {
  const val = (form[field.key] as string) || '';
  return (
    <div class="config-field-row">
      <div class="config-field-info">
        <label class="config-field-label">{field.label}</label>
        {field.description && <div class="config-field-desc">{field.description}</div>}
      </div>
      <div class="config-field-control">
        <input
          type="text"
          class="form-input"
          value={val}
          placeholder={field.placeholder}
          onInput={(e) => set(field.key, (e.target as HTMLInputElement).value)}
        />
      </div>
    </div>
  );
}

function renderTextarea(
  field: TextareaField,
  form: Record<string, unknown>,
  set: (key: string, val: unknown) => void,
) {
  const val = (form[field.key] as string) || '';
  return (
    <div class="config-field-row config-field-row--textarea">
      <div class="config-field-info">
        <label class="config-field-label">{field.label}</label>
        {field.description && <div class="config-field-desc">{field.description}</div>}
      </div>
      <div class="config-field-control" style={{ width: '100%' }}>
        <textarea
          class="form-input"
          rows={field.rows ?? 6}
          placeholder={field.placeholder}
          value={val}
          style={{
            width: '100%',
            fontFamily: 'var(--sai-font-mono, monospace)',
            fontSize: '12px',
            resize: 'vertical',
          }}
          onInput={(e) => set(field.key, (e.target as HTMLTextAreaElement).value)}
        />
      </div>
    </div>
  );
}

function renderCheckboxGroup(
  field: CheckboxGroupField,
  form: Record<string, unknown>,
  set: (key: string, val: unknown) => void,
) {
  const selected = Array.isArray(form[field.key])
    ? (form[field.key] as string[])
    : [];

  const toggle = (optVal: string) => {
    const next = selected.includes(optVal)
      ? selected.filter((v) => v !== optVal)
      : [...selected, optVal];
    set(field.key, next);
  };

  return (
    <div class="config-field-row config-field-row--checkbox">
      <div class="config-field-info">
        <label class="config-field-label">{field.label}</label>
        {field.description && <div class="config-field-desc">{field.description}</div>}
      </div>
      <div class="config-field-control">
        <div class="config-checkbox-grid">
          {field.options.map((opt) => (
            <label class="config-checkbox" key={opt.value}>
              <input
                type="checkbox"
                checked={selected.includes(opt.value)}
                onChange={() => toggle(opt.value)}
              />
              <span class="config-checkbox-mark" />
              <span class="config-checkbox-label">{opt.label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
