/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

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
