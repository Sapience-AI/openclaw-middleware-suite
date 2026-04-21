/**
 * Formatting utilities for the dashboard UI.
 */

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

export function formatCost(cents: number): string {
  if (cents === 0) return '$0.00';
  if (cents < 0.01) return '<$0.01';
  return '$' + cents.toFixed(2);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return ms.toFixed(0) + 'ms';
  if (ms < 60_000) return (ms / 1000).toFixed(1) + 's';
  return (ms / 60_000).toFixed(1) + 'm';
}

export function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
