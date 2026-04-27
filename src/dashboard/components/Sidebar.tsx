/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { getCurrentUrl, route } from 'preact-router';
import { useState, useEffect } from 'preact/hooks';

const NAV_ITEMS = [
  { path: '/dashboard', label: 'Overview', icon: 'grid' },
];

const MW_ITEMS = [
  { path: '/dashboard/hitl', label: 'Human-in-the-Loop', icon: 'shield' },
  { path: '/dashboard/routing', label: 'Model Routing', icon: 'route' },
  { path: '/dashboard/context-editing', label: 'Context Editing', icon: 'edit' },
  { path: '/dashboard/guardrail', label: 'Guardrail', icon: 'alert' },
  { path: '/dashboard/pii', label: 'PII Sanitizer', icon: 'lock' },
  { path: '/dashboard/limits', label: 'Tool Call Limit', icon: 'clock' },
];

function NavIcon({ icon }: { icon: string }) {
  const icons: Record<string, string> = {
    grid: 'M3 3h7v7H3V3zm11 0h7v7h-7V3zM3 14h7v7H3v-7zm11 0h7v7h-7v-7z',
    shield: 'M12 2l8 4v6c0 5.5-3.8 10.7-8 12-4.2-1.3-8-6.5-8-12V6l8-4z',
    route: 'M13 5.5a3.5 3.5 0 11-7 0 3.5 3.5 0 017 0zm5 13a3.5 3.5 0 11-7 0 3.5 3.5 0 017 0zM5.5 9v8.5M18.5 5.5V14',
    edit: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
    alert: 'M12 2L2 22h20L12 2zm0 7v5m0 3v.01',
    lock: 'M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2zm-3 0V7a4 4 0 00-8 0v4',
    clock: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 4v6l4 2',
  };
  return (
    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d={icons[icon] || icons.grid} />
    </svg>
  );
}

export function Sidebar() {
  const [currentUrl, setCurrentUrl] = useState(getCurrentUrl() || '/dashboard');

  useEffect(() => {
    const handler = () => setCurrentUrl(getCurrentUrl() || '/dashboard');
    // preact-router fires popstate-like events; listen for URL changes
    addEventListener('popstate', handler);
    // Also poll briefly for route() calls that don't trigger popstate
    const interval = setInterval(handler, 300);
    return () => {
      removeEventListener('popstate', handler);
      clearInterval(interval);
    };
  }, []);

  const isActive = (path: string) => {
    if (path === '/dashboard') return currentUrl === '/dashboard' || currentUrl === '/dashboard/';
    return currentUrl.startsWith(path);
  };

  return (
    <nav class="sidebar">
      <div class="sidebar-logo">
        <img src="/dashboard/sai-logo.svg" alt="SAI" width="32" height="32" />
        <div>
          <div class="sidebar-logo-text">Sapience AI</div>
          <div class="sidebar-logo-sub">Middleware Suite</div>
        </div>
      </div>

      <div class="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <a
            key={item.path}
            href={item.path}
            class={`nav-link ${isActive(item.path) ? 'active' : ''}`}
          >
            <NavIcon icon={item.icon} />
            {item.label}
          </a>
        ))}

        <div class="sidebar-section">Middlewares</div>

        {MW_ITEMS.map((item) => (
          <a
            key={item.path}
            href={item.path}
            class={`nav-link ${isActive(item.path) ? 'active' : ''}`}
          >
            <NavIcon icon={item.icon} />
            {item.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
