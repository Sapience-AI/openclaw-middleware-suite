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
}

export function StatCard({ label, value, trend, trendDir }: StatCardProps) {
  return (
    <div class="stat-card">
      <div class="stat-label">{label}</div>
      <div class="stat-value">{value}</div>
      {trend && (
        <div class={`stat-trend ${trendDir || ''}`}>{trend}</div>
      )}
    </div>
  );
}
