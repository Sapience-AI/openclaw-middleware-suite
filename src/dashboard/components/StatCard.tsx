/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

interface StatCardProps {
  label: string;
  value: string | number;
  trend?: string;
  trendDir?: 'up' | 'down';
  /** Optional override for the stat-value color. Used by Model Routing's
   *  Overview to match the purple tone the cost-source cards use for their
   *  spend numbers, so the Routing Stats and Cost Sources rows read as
   *  visually paired numeric blocks. */
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
