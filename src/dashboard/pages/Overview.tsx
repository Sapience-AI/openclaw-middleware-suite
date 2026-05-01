/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

import { useState, useEffect } from 'preact/hooks';
import { fetchMiddlewares, toggleMiddleware, MiddlewareInfo } from '../services/api';
import { invalidateMiddlewareCache } from '../services/useMiddlewareEnabled';
import { notifyGatewayRestart } from '../services/gateway';
import { StatusBadge } from '../components/StatusBadge';
import { Toggle } from '../components/Toggle';
import { StatCard } from '../components/StatCard';
import { showToast } from '../components/Toast';
import { formatNumber } from '../services/formatters';

export function Overview(_props: { path?: string }) {
  const [middlewares, setMiddlewares] = useState<MiddlewareInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const data = await fetchMiddlewares();
      setMiddlewares(data);
    } catch (err) {
      showToast('Failed to load middlewares', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  /** Middlewares whose toggle triggers a gateway restart. */
  const RESTART_MIDDLEWARES = new Set(['model-routing']);

  const handleToggle = async (name: string, enabled: boolean) => {
    try {
      await toggleMiddleware(name, enabled);
      invalidateMiddlewareCache();
      setMiddlewares((prev) =>
        prev.map((m) => (m.name === name ? { ...m, enabled } : m)),
      );

      if (RESTART_MIDDLEWARES.has(name)) {
        notifyGatewayRestart(
          `${formatMwName(name)} was ${enabled ? 'enabled' : 'disabled'}`,
        );
      } else {
        showToast(`${name} ${enabled ? 'enabled' : 'disabled'}`, 'success');
      }
    } catch {
      showToast(`Failed to toggle ${name}`, 'error');
    }
  };

  const activeCount = middlewares.filter((m) => m.enabled).length;

  const MW_LINKS: Record<string, string> = {
    hitl: '/dashboard/hitl',
    'context-editing': '/dashboard/context-editing',
    'model-routing': '/dashboard/routing',
    guardrail: '/dashboard/guardrail',
    'pii-sanitizer': '/dashboard/pii',
    'tool-call-limit': '/dashboard/limits',
  };

  const MW_ICONS: Record<string, string> = {
    hitl: 'shield-check',
    'context-editing': 'scissors',
    'model-routing': 'network',
    guardrail: 'alert-triangle',
    'pii-sanitizer': 'eye-off',
    'tool-call-limit': 'gauge',
  };

  const getStatSummary = (mw: MiddlewareInfo): string => {
    if (!mw.stats) return '-';
    const s = mw.stats;
    if (s.totalCalls != null) return `${formatNumber(s.totalCalls as number)} calls`;
    if (s.totalCompactions != null) return `${formatNumber(s.totalCompactions as number)} compactions`;
    if (s.totalRouted != null) return `${formatNumber(s.totalRouted as number)} routed`;
    return '-';
  };

  return (
    <div>
      <div class="section-eyebrow">Dashboard</div>
      <h1 class="section-title">Middleware Suite</h1>

      {/* Summary stats */}
      <div class="grid-4 mb-16">
        <StatCard
          label="Active Middlewares"
          value={loading ? '-' : `${activeCount} / ${middlewares.length}`}
        />
        <StatCard
          label="Total Middlewares"
          value={loading ? '-' : String(middlewares.length)}
        />
        <StatCard
          label="Suite Version"
          value="1.0.0"
        />
        <StatCard
          label="Status"
          value={loading ? '-' : activeCount > 0 ? 'Running' : 'Idle'}
        />
      </div>

      {/* Middleware grid */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '48px', color: 'var(--sai-text-muted)' }}>
          Loading middlewares...
        </div>
      ) : (
        <div class="overview-grid">
          {middlewares.map((mw) => (
            <div class="mw-card" key={mw.name}>
              <div class="mw-card-header">
                <div>
                  <div class="mw-card-name">{formatMwName(mw.name)}</div>
                  <div class="mw-card-pills">
                    <span class="pill pill-purple">v{mw.version}</span>
                    {mw.name === 'model-routing' && (
                      <span class="mw-restart-hint">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M1 4v6h6" />
                          <path d="M3.51 15a9 9 0 105.64-12.36L3 9" />
                        </svg>
                        Restarts gateway
                      </span>
                    )}
                  </div>
                </div>
                <Toggle
                  checked={mw.enabled}
                  onChange={(checked) => handleToggle(mw.name, checked)}
                />
              </div>
              <div class="mw-card-desc">{mw.description}</div>
              <div class="mw-card-footer">
                <StatusBadge enabled={mw.enabled} />
                <a href={MW_LINKS[mw.name] || '#'} class="mw-card-link">
                  Configure →
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatMwName(name: string): string {
  const names: Record<string, string> = {
    hitl: 'Human-in-the-Loop',
    'context-editing': 'Context Editing',
    'model-routing': 'Model Routing',
    guardrail: 'Guardrail',
    'pii-sanitizer': 'PII Sanitizer',
    'tool-call-limit': 'Tool Call Limit',
  };
  return names[name] || name;
}
