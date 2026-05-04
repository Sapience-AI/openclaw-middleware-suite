/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

interface StatCardProps {
  label: string;
  value: string | number;
  trend?: string;
  trendDir?: 'up' | 'down';
  /** Optional override for the stat-value color. Default is `--sai-purple`
   *  (set via `.stat-value` in components.css); pass any CSS color string
   *  here to override per-card — e.g. red for an error count, green for a
   *  success indicator. */
  valueColor?: string;
}

export function StatCard({ label, value, trend, trendDir, valueColor }: StatCardProps) {
  return (
    <div class="stat-card">
      <div class="stat-label">{label}</div>
      <div class="stat-value" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </div>
      {trend && (
        <div class={`stat-trend ${trendDir || ''}`}>{trend}</div>
      )}
    </div>
  );
}
