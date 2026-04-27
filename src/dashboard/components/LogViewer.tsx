/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { useState, useEffect, useRef } from 'preact/hooks';
import { createLogStream, LogSource } from '../services/sse';
import { formatTimestamp } from '../services/formatters';

interface LogViewerProps {
  source: LogSource;
  initialRecords?: Record<string, unknown>[];
  title?: string;
  maxEntries?: number;
  /** 'summary' (default) renders a one-line human-readable line per entry.
   *  'json' renders each entry as a pretty-printed JSON block — useful for
   *  rich records where the summary would drop most of the fields. */
  renderMode?: 'summary' | 'json';
}

export function LogViewer({
  source,
  initialRecords = [],
  title,
  maxEntries = 500,
  renderMode = 'summary',
}: LogViewerProps) {
  const [records, setRecords] = useState<Record<string, unknown>[]>(initialRecords);
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialRecords.length > 0) {
      setRecords(initialRecords);
    }
  }, [initialRecords]);

  useEffect(() => {
    const es = createLogStream(source, (record) => {
      setRecords((prev) => {
        const next = [...prev, record];
        return next.length > maxEntries ? next.slice(-maxEntries) : next;
      });
    });

    return () => es.close();
  }, [source, maxEntries]);

  useEffect(() => {
    if (autoScroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [records, autoScroll]);

  const handleScroll = () => {
    if (!bodyRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = bodyRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  const formatEntry = (record: Record<string, unknown>): string => {
    const ts = record.timestamp as string;
    const decision = record.decision as string;
    const module = record.module as string;
    const method = record.method as string;
    const tier = record.tier as string;
    const model = record.model as string;

    if (decision) {
      return `${module || '?'}.${method || '?'} → ${decision}`;
    }
    if (tier) {
      return `${tier} → ${model || '?'}`;
    }
    // Fallback: show key fields
    const keys = Object.keys(record).filter((k) => k !== 'timestamp');
    return keys.slice(0, 4).map((k) => `${k}=${JSON.stringify(record[k])}`).join(' ');
  };

  const getDecisionClass = (record: Record<string, unknown>): string => {
    const d = record.decision as string;
    if (d) return `log-decision-${d}`;
    return '';
  };

  return (
    <div class="log-viewer">
      <div class="log-viewer-header">
        <span class="log-viewer-title">{title || `Live Logs — ${source}`}</span>
        <span style={{ fontSize: '12px', color: 'var(--sai-sidebar-text)' }}>
          {records.length} entries
        </span>
      </div>
      <div class="log-viewer-body" ref={bodyRef} onScroll={handleScroll}>
        {records.length === 0 ? (
          <div style={{ color: 'var(--sai-text-muted)', textAlign: 'center', padding: '20px' }}>
            Waiting for log entries...
          </div>
        ) : renderMode === 'json' ? (
          records.map((record, i) => (
            <div class="log-entry log-entry--json" key={i}>
              {record.timestamp && (
                <div class="log-time">{formatTimestamp(record.timestamp as string)}</div>
              )}
              <pre
                style={{
                  margin: 0,
                  padding: '8px 10px',
                  background: 'rgba(0,0,0,0.25)',
                  borderRadius: '4px',
                  fontFamily: 'var(--sai-font-mono, monospace)',
                  fontSize: '12px',
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {JSON.stringify(record, null, 2)}
              </pre>
            </div>
          ))
        ) : (
          records.map((record, i) => (
            <div class="log-entry" key={i}>
              {record.timestamp && (
                <span class="log-time">
                  {formatTimestamp(record.timestamp as string)}
                </span>
              )}
              <span class={getDecisionClass(record)}>
                {formatEntry(record)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
