/**
 * Dashboard API client — typed fetch wrapper for /api/* endpoints.
 */

const BASE = '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

// ── Middleware list ─────────────────────────────────────────────────────────

export interface MiddlewareInfo {
  name: string;
  version: string;
  enabled: boolean;
  description: string;
  stats?: Record<string, unknown>;
}

export const fetchMiddlewares = () => request<MiddlewareInfo[]>('/api/middlewares');

export const toggleMiddleware = (name: string, enabled: boolean) =>
  request<{ name: string; enabled: boolean }>(`/api/middlewares/${name}/toggle`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });

// ── HITL ───────────────────────────────────────────────────────────────────

export const fetchHitlStats = () => request<Record<string, unknown>>('/api/hitl/stats');

export const fetchHitlPolicy = () => request<Record<string, unknown>>('/api/hitl/policy');

export const updateHitlPolicy = (policy: Record<string, unknown>) =>
  request<{ ok: boolean }>('/api/hitl/policy', {
    method: 'PUT',
    body: JSON.stringify(policy),
  });

export const fetchHitlDecisions = (limit = 100) =>
  request<unknown[]>(`/api/hitl/decisions?limit=${limit}`);

// ── Model Routing ──────────────────────────────────────────────────────────

export const fetchRoutingStats = () => request<Record<string, unknown>>('/api/routing/stats');

export const fetchRoutingConfig = () => request<Record<string, unknown>>('/api/routing/config');

export const updateRoutingTiers = (tiers: Record<string, unknown>) =>
  request<{ ok: boolean }>('/api/routing/tiers', {
    method: 'PUT',
    body: JSON.stringify(tiers),
  });

export const fetchRoutingModels = () => request<unknown[]>('/api/routing/models');

export const fetchRoutingProviders = () =>
  request<Record<string, unknown>>('/api/routing/providers');

export const fetchRoutingCost = () => request<Record<string, unknown>>('/api/routing/cost');

export const fetchRoutingAudit = (limit = 100) =>
  request<unknown[]>(`/api/routing/audit?limit=${limit}`);

// ── Context Editing ────────────────────────────────────────────────────────

export const fetchContextEditingConfig = () =>
  request<Record<string, unknown>>('/api/context-editing/config');

export const updateContextEditingConfig = (config: Record<string, unknown>) =>
  request<{ ok: boolean }>('/api/context-editing/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  });

export const fetchContextEditingStats = () =>
  request<Record<string, unknown>>('/api/context-editing/stats');

export const fetchContextEditingAudit = (limit = 100) =>
  request<unknown[]>(`/api/context-editing/audit?limit=${limit}`);

// ── Guardrail ──────────────────────────────────────────────────────────────

export const fetchGuardrailConfig = () => request<Record<string, unknown>>('/api/guardrail/config');

export const updateGuardrailConfig = (config: Record<string, unknown>) =>
  request<{ ok: boolean }>('/api/guardrail/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  });

export const fetchGuardrailAudit = (limit = 100) =>
  request<unknown[]>(`/api/guardrail/audit?limit=${limit}`);

// ── PII Sanitizer ──────────────────────────────────────────────────────────

export const fetchPiiPolicy = () => request<Record<string, unknown>>('/api/pii/policy');

export const updatePiiPolicy = (policy: Record<string, unknown>) =>
  request<{ ok: boolean }>('/api/pii/policy', {
    method: 'PUT',
    body: JSON.stringify(policy),
  });

export const fetchPiiAudit = (limit = 100) => request<unknown[]>(`/api/pii/audit?limit=${limit}`);

// ── Tool Call Limit ────────────────────────────────────────────────────────

export const fetchLimitsPolicy = () => request<Record<string, unknown>>('/api/limits/policy');

export const updateLimitsPolicy = (policy: Record<string, unknown>) =>
  request<{ ok: boolean }>('/api/limits/policy', {
    method: 'PUT',
    body: JSON.stringify(policy),
  });

export const fetchLimitsSessions = () => request<Record<string, unknown>>('/api/limits/sessions');

// ── Full config ────────────────────────────────────────────────────────────

export const fetchFullConfig = () => request<Record<string, unknown>>('/api/config');
