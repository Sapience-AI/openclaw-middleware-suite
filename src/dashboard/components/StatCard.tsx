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
