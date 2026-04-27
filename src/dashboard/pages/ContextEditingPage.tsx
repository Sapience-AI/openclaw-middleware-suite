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
  fetchContextEditingConfig,
  updateContextEditingConfig,
  fetchContextEditingStats,
  fetchContextEditingAudit,
} from '../services/api';
import { StatCard } from '../components/StatCard';
import { DataTable } from '../components/DataTable';
import { ConfigForm, FormField } from '../components/ConfigForm';
import { formatNumber, formatTimestamp } from '../services/formatters';
import { useMiddlewareEnabled } from '../services/useMiddlewareEnabled';
import {
  DEFAULT_ICC_SYSTEM_PROMPT,
  DEFAULT_ICC_SCHEMA_JSON,
} from '../../middlewares/context-editing/config';

const contextEditingFields: FormField[] = [
  {
    key: 'triggerMode',
    label: 'Trigger Mode',
    description:
      'Which signal fires compaction — token count, message count, or either exceeded.',
    type: 'dropdown',
    options: [
      { value: 'both', label: 'Both (either threshold)' },
      { value: 'token', label: 'Token threshold only' },
      { value: 'message', label: 'Message threshold only' },
    ],
  },
  {
    key: 'tokenThreshold',
    label: 'Token Threshold',
    description: 'Trigger compaction when session context exceeds this token count.',
    type: 'number',
    min: 1000,
    max: 200000,
    step: 1000,
    unit: 'tokens',
    placeholder: '80000',
  },
  {
    key: 'messageThreshold',
    label: 'Message Threshold',
    description: 'Trigger compaction when session exceeds this many messages.',
    type: 'number',
    min: 5,
    max: 500,
    step: 5,
    unit: 'messages',
    placeholder: '50',
  },
  {
    key: 'pruningMode',
    label: 'Inactive Session Pruning',
    description: 'Automatically prune cached context for idle sessions to save memory.',
    type: 'dropdown',
    options: [
      { value: 'enabled', label: 'Enabled' },
      { value: 'disabled', label: 'Disabled' },
    ],
    restartHint: true,
  },
  {
    key: 'ttl',
    label: 'Cache TTL',
    description: 'How long to keep idle session context in cache (e.g. 5m, 1h, 30s).',
    type: 'text',
    placeholder: '5m',
    showWhen: (v) => v.pruningMode === 'enabled',
    indent: true,
  },
  {
    key: 'model',
    label: 'Compaction Model',
    description: 'Model to use for intelligent context compaction. Leave empty to use the agent primary model.',
    type: 'text',
    placeholder: 'Use agent primary model',
    restartHint: true,
  },
  {
    key: 'messagesKeptBeforeCompaction',
    label: 'Messages Kept Before Compaction',
    description:
      'How many user messages immediately before the compaction summary survive into the next session. 0 = drop everything prior.',
    type: 'number',
    min: 0,
    max: 50,
    step: 1,
    placeholder: '0',
  },
  {
    key: 'customPromptEnabled',
    label: 'Custom ICC Prompt',
    description:
      'Override the built-in extraction prompt and output schema. WARNING: regex fallback is disabled — LLM/parse errors will skip compaction silently.',
    type: 'dropdown',
    options: [
      { value: 'enabled', label: 'Enabled' },
      { value: 'disabled', label: 'Disabled' },
    ],
  },
  {
    key: 'customInstructions',
    label: 'Custom Instructions',
    description:
      'System instructions for the ICC LLM call. The LLM is asked to return ONLY JSON matching the schema below.',
    type: 'textarea',
    rows: 16,
    placeholder: 'You are a structured extraction function...',
    showWhen: (v) => v.customPromptEnabled === 'enabled',
    validate: (val) => (val.trim().length === 0 ? 'Instructions cannot be empty' : null),
  },
  {
    key: 'customSchema',
    label: 'Custom Output Schema (JSON)',
    description:
      'A JSON object whose top-level keys are arrays. Each key becomes a section in the compaction summary; each item becomes a bullet.',
    type: 'textarea',
    rows: 16,
    placeholder: '{\n  "items": []\n}',
    showWhen: (v) => v.customPromptEnabled === 'enabled',
    validate: (val) => {
      if (val.trim().length === 0) return 'Schema cannot be empty';
      try {
        const obj = JSON.parse(val);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'Schema must be a JSON object';
        return null;
      } catch (e) {
        return `Invalid JSON: ${(e as Error).message}`;
      }
    },
  },
];

export function ContextEditingPage(_props: { path?: string }) {
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [stats, setStats] = useState<Record<string, unknown>>({});
  const [audit, setAudit] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'overview' | 'config' | 'logs'>('overview');
  const enabled = useMiddlewareEnabled('context-editing');

  useEffect(() => {
    Promise.all([
      fetchContextEditingConfig()
        .then((c) => {
          setConfig({
            ...c,
            customPromptEnabled: c.customPromptEnabled ? 'enabled' : 'disabled',
            // Pre-fill the custom-prompt textareas with the built-in defaults
            // when no user value is saved, so enabling the toggle reveals a
            // working starting point rather than a blank field.
            customInstructions:
              typeof c.customInstructions === 'string' && c.customInstructions.length > 0
                ? c.customInstructions
                : DEFAULT_ICC_SYSTEM_PROMPT,
            customSchema:
              typeof c.customSchema === 'string' && c.customSchema.length > 0
                ? c.customSchema
                : DEFAULT_ICC_SCHEMA_JSON,
          });
        })
        .catch(() => {}),
      fetchContextEditingStats().then(setStats).catch(() => {}),
      fetchContextEditingAudit(100).then(setAudit).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  const auditColumns = [
    {
      key: 'timestamp',
      label: 'Time',
      render: (v: unknown) => formatTimestamp(v as string),
    },
    { key: 'sessionKey', label: 'Session', mono: true },
    { key: 'triggerType', label: 'Trigger' },
    {
      key: 'tokensSaved',
      label: 'Tokens Saved',
      render: (v: unknown) => typeof v === 'number' ? formatNumber(v) : '-',
    },
    {
      key: 'entitiesPreserved',
      label: 'Entities Kept',
      render: (v: unknown) => typeof v === 'number' ? String(v) : '-',
    },
  ];

  return (
    <div>
      <div class="section-eyebrow">Middleware</div>
      <h1 class="section-title">Context Editing</h1>

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
          Loading context editing data...
        </div>
      )}

      {!loading && tab === 'overview' && (
        <>
          {(() => {
            // stats.json shape (ContextEditingStatsData) stores totalCompactions +
            // sessionHistories keyed by sessionKey, each with cumulativeTokensSaved.
            // avgTokensSaved / sessionsTracked aren\u2019t persisted as top-level
            // fields — derive them here so the cards match `sai ctx stats`.
            const histories = (stats.sessionHistories as Record<
              string,
              { cumulativeTokensSaved?: number }
            >) || {};
            const totalCompactions = (stats.totalCompactions as number) || 0;
            const totalTokensSaved = Object.values(histories).reduce(
              (acc, h) => acc + (h.cumulativeTokensSaved || 0),
              0
            );
            const avgTokensSaved =
              totalCompactions > 0 ? Math.round(totalTokensSaved / totalCompactions) : 0;
            const sessionsTracked = Object.keys(histories).length;
            return (
              <div class="grid-3 mb-16">
                <StatCard label="Total Compactions" value={formatNumber(totalCompactions)} />
                <StatCard label="Avg Tokens Saved" value={formatNumber(avgTokensSaved)} />
                <StatCard label="Sessions Tracked" value={formatNumber(sessionsTracked)} />
              </div>
            );
          })()}

          <div class="page-section">
            <div class="page-section-title">Compaction Audit Trail</div>
            <DataTable
              columns={auditColumns}
              data={[...audit as Record<string, unknown>[]].reverse()}
              emptyText="No compaction events recorded yet"
            />
          </div>
        </>
      )}

      {!loading && tab === 'config' && (
        <div class="page-section">
          <ConfigForm
            fields={contextEditingFields}
            values={config}
            readOnly={enabled === false}
            onSave={async (val) => {
              const enabled = val.customPromptEnabled === 'enabled';
              // When custom prompt is disabled, drop the pre-filled defaults
              // so the stored config stays clean (built-in extraction path is
              // unchanged). When enabled, persist whatever the user edited.
              const toPersist: Record<string, unknown> = {
                ...val,
                customPromptEnabled: enabled,
              };
              if (!enabled) {
                delete toPersist.customInstructions;
                delete toPersist.customSchema;
              }
              await updateContextEditingConfig(toPersist);
              setConfig(val);
            }}
          />
        </div>
      )}

      {!loading && tab === 'logs' && (
        <ContextEditingLogs
          stats={stats}
          audit={audit as Record<string, unknown>[]}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Logs tab — expandable compaction events + aggregate + per-session history.
// Pulls the most useful fields out of stats.json and the audit log so users
// can skim without opening raw JSON, then click any row to drill in.
// ─────────────────────────────────────────────────────────────────────────────

interface AuditRecord {
  timestamp?: string;
  sessionKey?: string;
  trigger?: string;
  instructionHash?: string;
  tokensSaved?: number;
  tokensSavedSource?: string;
  tokensBeforeEstimate?: number;
  tokensAfterEstimate?: number;
  tokenCount?: number;
  messageCount?: number;
  postCompactionMessages?: number;
  postCompactionTokens?: number;
  compactedCount?: number;
  extractedEntities?: Array<{ name?: string; type?: string; value?: string }>;
  resolvedConflicts?: Array<{ original?: string; override?: string; resolved?: string }>;
  prioritySegments?: string[];
  iccInstruction?: string;
  iccInputTranscript?: string;
  [key: string]: unknown;
}

interface SessionHistory {
  sessionKey?: string;
  compactionCount?: number;
  lastCompactionTimestamp?: string;
  cumulativeTokensSaved?: number;
  lastEntities?: unknown[];
  lastSavingsSource?: string;
  [key: string]: unknown;
}

function ContextEditingLogs(props: {
  stats: Record<string, unknown>;
  audit: Record<string, unknown>[];
}) {
  const { stats, audit } = props;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const histories = (stats.sessionHistories as Record<string, SessionHistory>) || {};
  const sessionsTracked = Object.keys(histories).length;

  // Most-recent first.
  const events = [...(audit as AuditRecord[])].reverse();

  const shortSession = (k?: string) =>
    !k ? '—' : k.length > 14 ? `${k.slice(0, 7)}\u2026${k.slice(-6)}` : k;

  const cardStyle = {
    background: 'var(--sai-surface)',
    border: '1px solid var(--sai-border-light)',
    borderRadius: 'var(--sai-radius-sm)',
  };

  return (
    <>
      {/* Compaction events — click any row to drill into its full detail. */}
      <div class="page-section">
        <div class="page-section-title">Compaction Events ({events.length})</div>
        {events.length === 0 ? (
          <div style={{ color: 'var(--sai-text-muted)', padding: '12px' }}>
            No compaction events recorded yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {events.map((e, i) => {
              const key = `evt-${i}`;
              const isOpen = !!expanded[key];
              return (
                <div key={key} style={cardStyle}>
                  <button
                    onClick={() => toggle(key)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '10px 14px',
                      background: 'transparent',
                      border: 'none',
                      color: 'inherit',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '16px',
                      fontSize: '13px',
                    }}
                  >
                    <span
                      style={{
                        color: 'var(--sai-text-muted)',
                        width: '14px',
                        flex: '0 0 14px',
                      }}
                    >
                      {isOpen ? '▾' : '▸'}
                    </span>
                    <span
                      style={{
                        color: 'var(--sai-text-secondary)',
                        flex: '0 0 150px',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {e.timestamp ? formatTimestamp(e.timestamp) : '—'}
                    </span>
                    <span
                      style={{
                        flex: '0 0 auto',
                        padding: '2px 10px',
                        borderRadius: '999px',
                        background: 'var(--sai-surface-hover)',
                        color: 'var(--sai-text-primary)',
                        fontSize: '12px',
                        fontWeight: 500,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {e.trigger || '—'}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--sai-font-mono, monospace)',
                        color: 'var(--sai-text-secondary)',
                        fontSize: '12px',
                        flex: '0 0 auto',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {shortSession(e.sessionKey)}
                    </span>
                    <span
                      style={{
                        marginLeft: 'auto',
                        color: 'var(--sai-text-secondary)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      📦 {(e.extractedEntities?.length ?? 0)}
                      <span style={{ margin: '0 8px', color: 'var(--sai-text-muted)' }}>·</span>
                      ⚡ {(e.resolvedConflicts?.length ?? 0)}
                      <span style={{ margin: '0 8px', color: 'var(--sai-text-muted)' }}>·</span>
                      💰 {formatNumber(e.tokensSaved ?? 0)} saved
                    </span>
                  </button>
                  {isOpen && <EventDetails event={e} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Per-session history — only shown when there\u2019s more than one session.
          With a single session the numbers duplicate the Overview cards, so
          hiding this section removes that redundancy until it\u2019s useful. */}
      {sessionsTracked > 1 && (
        <div class="page-section">
          <div class="page-section-title">Session History ({sessionsTracked})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '2fr 1fr 2fr 1fr 1fr',
                gap: '12px',
                padding: '8px 14px',
                fontSize: '11px',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--sai-text-muted)',
              }}
            >
              <span>Session</span>
              <span>Compactions</span>
              <span>Last Compaction</span>
              <span>Tokens Saved</span>
              <span>Last Entities</span>
            </div>
            {Object.values(histories).map((h, i) => (
              <div
                key={h.sessionKey || i}
                style={{
                  ...cardStyle,
                  display: 'grid',
                  gridTemplateColumns: '2fr 1fr 2fr 1fr 1fr',
                  gap: '12px',
                  padding: '10px 14px',
                  fontSize: '13px',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--sai-font-mono, monospace)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={h.sessionKey}
                >
                  {shortSession(h.sessionKey)}
                </span>
                <span>{formatNumber(h.compactionCount ?? 0)}</span>
                <span style={{ color: 'var(--sai-text-secondary)' }}>
                  {h.lastCompactionTimestamp
                    ? formatTimestamp(h.lastCompactionTimestamp)
                    : '—'}
                </span>
                <span>{formatNumber(h.cumulativeTokensSaved ?? 0)}</span>
                <span>{formatNumber((h.lastEntities ?? []).length)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function EventDetails(props: { event: AuditRecord }) {
  const e = props.event;
  const preStyle = {
    margin: 0,
    padding: '10px 12px',
    background: 'var(--sai-surface-hover)',
    border: '1px solid var(--sai-border-light)',
    borderRadius: 'var(--sai-radius-xs)',
    fontFamily: 'var(--sai-font-mono, monospace)',
    fontSize: '12px',
    lineHeight: 1.5,
    color: 'var(--sai-text-primary)',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    maxHeight: '320px',
    overflow: 'auto' as const,
  };
  return (
    <div
      style={{
        padding: '12px 14px 16px 14px',
        borderTop: '1px solid var(--sai-border-light)',
        fontSize: '13px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
      }}
    >
      {/* Summary grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '8px 16px',
        }}
      >
        <KV label="Session" value={e.sessionKey} mono />
        <KV label="Trigger" value={e.trigger} />
        <KV label="Instruction Hash" value={e.instructionHash} mono />
        <KV
          label="Messages (before → after)"
          value={
            e.messageCount !== undefined || e.postCompactionMessages !== undefined
              ? `${e.messageCount ?? '?'} → ${e.postCompactionMessages ?? '?'}`
              : undefined
          }
        />
        <KV
          label="Tokens (before → after)"
          value={
            e.tokenCount !== undefined || e.postCompactionTokens !== undefined
              ? `${formatNumber(e.tokenCount ?? 0)} → ${formatNumber(e.postCompactionTokens ?? 0)}`
              : undefined
          }
        />
        <KV
          label="Tokens Saved"
          value={
            e.tokensSaved !== undefined
              ? `${formatNumber(e.tokensSaved)} (${e.tokensSavedSource ?? '?'})`
              : undefined
          }
        />
      </div>

      {/* Extracted entities */}
      {Array.isArray(e.extractedEntities) && e.extractedEntities.length > 0 && (
        <DetailSection title={`Extracted Entities (${e.extractedEntities.length})`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {e.extractedEntities.map((ent, i) => (
              <div key={i} style={{ fontSize: '12px' }}>
                <span
                  style={{
                    fontFamily: 'var(--sai-font-mono, monospace)',
                    color: 'var(--sai-text-muted)',
                    marginRight: '8px',
                  }}
                >
                  [{ent.type ?? '?'}]
                </span>
                <span style={{ fontWeight: 500 }}>{ent.name ?? '?'}</span>
                <span style={{ color: 'var(--sai-text-muted)' }}> = </span>
                <span style={{ fontFamily: 'var(--sai-font-mono, monospace)' }}>
                  {String(ent.value ?? '')}
                </span>
              </div>
            ))}
          </div>
        </DetailSection>
      )}

      {/* Resolved conflicts */}
      {Array.isArray(e.resolvedConflicts) && e.resolvedConflicts.length > 0 && (
        <DetailSection title={`Resolved Conflicts (${e.resolvedConflicts.length})`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {e.resolvedConflicts.map((c, i) => (
              <div key={i} style={{ fontSize: '12px', lineHeight: 1.5 }}>
                <div style={{ color: 'var(--sai-text-muted)' }}>
                  {String(c.original ?? '')} → {String(c.override ?? '')}
                </div>
                <div>
                  <span style={{ color: 'var(--sai-text-muted)' }}>Resolved:</span>{' '}
                  <span style={{ fontFamily: 'var(--sai-font-mono, monospace)' }}>
                    {String(c.resolved ?? '')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </DetailSection>
      )}

      {/* Priority segments */}
      {Array.isArray(e.prioritySegments) && e.prioritySegments.length > 0 && (
        <DetailSection title={`Priority Segments (${e.prioritySegments.length})`}>
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '12px', lineHeight: 1.5 }}>
            {e.prioritySegments.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </DetailSection>
      )}

      {/* Compaction summary (the summary the agent receives) */}
      {e.iccInstruction && (
        <DetailSection title="Compaction Summary">
          <pre style={preStyle}>{e.iccInstruction}</pre>
        </DetailSection>
      )}

      {/* Input transcript (what was fed into the ICC) */}
      {e.iccInputTranscript && (
        <DetailSection title="Input Transcript">
          <pre style={preStyle}>{e.iccInputTranscript}</pre>
        </DetailSection>
      )}
    </div>
  );
}

function KV(props: { label: string; value?: string | number; mono?: boolean }) {
  if (props.value === undefined || props.value === null || props.value === '') return null;
  return (
    <div>
      <div
        style={{
          fontSize: '11px',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--sai-text-muted)',
          marginBottom: '2px',
        }}
      >
        {props.label}
      </div>
      <div
        style={{
          fontSize: '13px',
          fontFamily: props.mono ? 'var(--sai-font-mono, monospace)' : undefined,
        }}
      >
        {String(props.value)}
      </div>
    </div>
  );
}

function DetailSection(props: { title: string; children: preact.ComponentChildren }) {
  return (
    <div>
      <div
        style={{
          fontSize: '11px',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--sai-text-muted)',
          marginBottom: '6px',
          fontWeight: 600,
        }}
      >
        {props.title}
      </div>
      {props.children}
    </div>
  );
}
