/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

import { useState } from 'preact/hooks';

interface Column {
  key: string;
  label: string;
  render?: (value: unknown, row: Record<string, unknown>) => string | preact.ComponentChildren;
  mono?: boolean;
}

interface DataTableProps {
  columns: Column[];
  data: Record<string, unknown>[];
  pageSize?: number;
  emptyText?: string;
  /**
   * When true, applies the `.data-table--compact` modifier — tighter
   * padding, smaller font, `white-space: nowrap`. Used by dense tables
   * (e.g. Recent Routing Decisions) that need to fit many columns on
   * screen without overflowing.
   */
  compact?: boolean;
}

export function DataTable({
  columns,
  data,
  pageSize = 20,
  emptyText = 'No data',
  compact,
}: DataTableProps) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(data.length / pageSize));
  const start = page * pageSize;
  const pageData = data.slice(start, start + pageSize);

  if (data.length === 0) {
    return (
      <div class="data-table-wrap">
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--sai-text-muted)' }}>
          {emptyText}
        </div>
      </div>
    );
  }

  return (
    <div class="data-table-wrap">
      <table class={`data-table${compact ? ' data-table--compact' : ''}`}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pageData.map((row, i) => (
            <tr key={i}>
              {columns.map((col) => (
                <td key={col.key} class={col.mono ? 'mono' : ''}>
                  {col.render
                    ? col.render(row[col.key], row)
                    : String(row[col.key] ?? '-')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', padding: '12px' }}>
          <button
            class="btn-secondary btn-sm"
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
          >
            Prev
          </button>
          <span style={{ fontSize: '13px', lineHeight: '32px', color: 'var(--sai-text-helper)' }}>
            {page + 1} / {totalPages}
          </span>
          <button
            class="btn-secondary btn-sm"
            onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
            disabled={page >= totalPages - 1}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
