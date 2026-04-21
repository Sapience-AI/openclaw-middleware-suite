interface StatusBadgeProps {
  enabled: boolean;
}

export function StatusBadge({ enabled }: StatusBadgeProps) {
  const cls = enabled ? 'enabled' : 'disabled';
  return (
    <span class="status-badge">
      <span class={`status-dot ${cls}`} />
      <span class={`status-text ${cls}`}>
        {enabled ? 'Enabled' : 'Disabled'}
      </span>
    </span>
  );
}
