/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { useState, useEffect } from 'preact/hooks';
import { GradientButton } from './GradientButton';

interface JsonEditorProps {
  value: Record<string, unknown>;
  onSave: (value: Record<string, unknown>) => Promise<void>;
  label?: string;
}

export function JsonEditor({ value, onSave, label }: JsonEditorProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setText(JSON.stringify(value, null, 2));
    setError('');
  }, [value]);

  const handleChange = (e: Event) => {
    const val = (e.target as HTMLTextAreaElement).value;
    setText(val);
    try {
      JSON.parse(val);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSave = async () => {
    if (error) return;
    try {
      setSaving(true);
      const parsed = JSON.parse(text);
      await onSave(parsed);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="form-group">
      {label && <label class="form-label">{label}</label>}
      <textarea
        class={`json-editor ${error ? 'error' : ''}`}
        value={text}
        onInput={handleChange}
        rows={12}
        spellcheck={false}
      />
      {error && (
        <div style={{ color: 'var(--sai-error)', fontSize: '13px' }}>{error}</div>
      )}
      <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
        <GradientButton onClick={handleSave} disabled={!!error || saving}>
          {saving ? 'Saving...' : 'Save Configuration'}
        </GradientButton>
        <GradientButton
          secondary
          onClick={() => {
            setText(JSON.stringify(value, null, 2));
            setError('');
          }}
        >
          Reset
        </GradientButton>
      </div>
    </div>
  );
}
