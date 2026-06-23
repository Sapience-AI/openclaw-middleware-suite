/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Dashboard REST API + SSE Handlers
 *
 * All endpoints are served under /api/* and /sse/* by the suite server.
 * Uses existing store classes — no new storage infrastructure.
 */

import http from 'http';
import fs from 'fs';
import { ConfigStore } from '../storage/ConfigStore.js';
import { logger } from '../Logger.js';
import {
  HITL_STATS_FILE,
  HITL_DECISIONS_FILE,
  CTX_EDIT_AUDIT_FILE,
  CTX_EDIT_STATS_FILE,
  MODEL_ROUTE_AUDIT_FILE,
  MODEL_ROUTE_PROXY_LOG,
  MODEL_ROUTE_COST_FILE,
  MODEL_ROUTE_DISCOVERED_FILE,
  GUARDRAIL_AUDIT_FILE,
  PII_SANITIZER_AUDIT_FILE,
  STORE_KEY_PLUGIN_CONFIG,
} from '../storage/paths.js';

// Store class imports (lazy — only resolved when endpoints are hit)
type StoreModule<T> = { default?: T } & Record<string, any>;
const lazyImport = <T>(specifier: string): Promise<StoreModule<T>> =>
  import(specifier) as Promise<StoreModule<T>>;

// ── Body parser utility ────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/**
 * Parse a URL's query string into URLSearchParams.
 *
 * Returning URLSearchParams (rather than a plain object) avoids any dynamic
 * property write keyed on user-controlled input — URLSearchParams stores
 * entries internally with no prototype-chain interaction, which closes the
 * CodeQL js/remote-property-injection finding at the source.
 *
 * Callers read individual fields via `.get(name)`.
 */
function parseQuery(url: string): URLSearchParams {
  const idx = url.indexOf('?');
  if (idx === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(idx + 1));
}

// ── JSONL / Pretty-JSON file reader ────────────────────────────────────────

async function readAuditFile(filePath: string, limit: number): Promise<unknown[]> {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const records: unknown[] = [];

    // Support both Pretty-JSON delimited by \n---\n and plain JSONL
    if (content.includes('\n---\n')) {
      for (const block of content.split('\n---\n')) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        try {
          records.push(JSON.parse(trimmed));
        } catch {
          /* skip */
        }
      }
    } else {
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          records.push(JSON.parse(trimmed));
        } catch {
          /* skip */
        }
      }
    }

    return limit > 0 ? records.slice(-limit) : records;
  } catch {
    return [];
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ── Middleware status helpers ───────────────────────────────────────────────

interface MiddlewareInfo {
  name: string;
  version: string;
  enabled: boolean;
  description: string;
  stats?: Record<string, unknown>;
}

async function getMiddlewareList(): Promise<MiddlewareInfo[]> {
  const store = await ConfigStore.read();
  const pluginConfig = store.plugin_config?.middlewares || {};

  return [
    {
      name: 'hitl',
      version: '1.0.0',
      enabled: pluginConfig.hitl === true,
      description: 'Human-in-the-loop approval for destructive operations',
      stats:
        ((await readJsonFile(HITL_STATS_FILE)) as Record<string, unknown> | undefined) ?? undefined,
    },
    {
      name: 'context-editing',
      version: '1.0.0',
      enabled: pluginConfig['context-editing'] === true,
      description: 'Session context pruning and compaction',
      stats:
        ((await readJsonFile(CTX_EDIT_STATS_FILE)) as Record<string, unknown> | undefined) ??
        undefined,
    },
    {
      name: 'model-routing',
      version: '3.0.0',
      enabled: pluginConfig['model-routing'] === true,
      description: 'Intelligent model routing proxy with scoring',
    },
    {
      name: 'guardrail',
      version: '1.0.0',
      enabled: pluginConfig.guardrail === true,
      description: 'Content scanning and detection rules',
    },
    {
      name: 'pii-sanitizer',
      version: '1.0.0',
      enabled: pluginConfig['pii-sanitizer'] === true,
      description: 'PII pattern detection and redaction',
    },
    {
      name: 'tool-call-limit',
      version: '1.0.0',
      enabled: pluginConfig['tool-call-limit'] === true,
      description: 'Rate limiting for tool calls per session',
    },
  ];
}

// ── Persist default config when a middleware is enabled via UI toggle ──────

async function persistMiddlewareDefaults(name: string): Promise<void> {
  switch (name) {
    case 'hitl': {
      const { PolicyStore } = await lazyImport('../../middlewares/hitl/storage/PolicyStore.js');
      await PolicyStore.save(PolicyStore.defaults());
      break;
    }
    case 'context-editing': {
      const { ContextEditingPolicyStore } = await lazyImport(
        '../../middlewares/context-editing/storage/ContextEditingPolicyStore.js'
      );
      const defaults = ContextEditingPolicyStore.defaults();
      await ContextEditingPolicyStore.save(defaults);

      // Keep openclaw.json pruning + compaction-model in sync with the
      // store copy so both sources of truth reset together. flushToOpenClaw
      // is a no-op when values already match disk, so a toggle-enable with
      // openclaw already at defaults won't restart the gateway.
      const { stageOpenClawWrites, flushToOpenClaw } = await lazyImport('./openclaw-sync.js');
      await stageOpenClawWrites([
        {
          dotPath: 'agents.defaults.contextPruning',
          value: { mode: 'off', ttl: defaults.ttl },
        },
        { dotPath: 'agents.defaults.compaction.model', value: undefined },
      ]);
      await flushToOpenClaw();
      break;
    }
    case 'model-routing': {
      // Run the full non-interactive init: fetches model catalog, picks the
      // 'auto' profile, resolves providers, saves store, and injects
      // sai-router provider + allowlist into openclaw.json.
      const { getOpenClawPaths } = await lazyImport('../../plugin/config-manager.js');
      const { initModelRoutingMiddleware } = await lazyImport(
        '../../middlewares/model-routing/cli/init.js'
      );
      const paths = getOpenClawPaths();
      await initModelRoutingMiddleware({}, true, true, paths, []);
      break;
    }
    case 'guardrail': {
      const mod = await lazyImport('../../middlewares/guardrail/storage/ConfigStore.js');
      const GuardrailConfigStore = mod.ConfigStore;
      await GuardrailConfigStore.save(GuardrailConfigStore.defaults());
      break;
    }
    case 'pii-sanitizer': {
      const { DlpStore } = await lazyImport('../../middlewares/pii-sanitizer/storage/DlpStore.js');
      await DlpStore.save(DlpStore.defaults());
      break;
    }
    case 'tool-call-limit': {
      const { LimitPolicyStore } = await lazyImport(
        '../../middlewares/tool-call-limit/storage/LimitPolicyStore.js'
      );
      await LimitPolicyStore.save(LimitPolicyStore.defaults());
      break;
    }
    default:
      logger.debug(`[dashboard] No default persist handler for middleware: ${name}`);
  }
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function handleApiRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const fullUrl = req.url || '';
  const urlPath = fullUrl.split('?')[0];
  const method = req.method || 'GET';
  const query = parseQuery(fullUrl);

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  try {
    // ── Middleware list ───────────────────────────────────────────────────
    if (urlPath === '/api/middlewares' && method === 'GET') {
      const list = await getMiddlewareList();
      json(res, 200, list);
      return;
    }

    // ── Toggle middleware ────────────────────────────────────────────────
    if (urlPath.match(/^\/api\/middlewares\/[\w-]+\/toggle$/) && method === 'PUT') {
      const name = urlPath.split('/')[3];
      const body = JSON.parse(await readBody(req));
      const enabled = Boolean(body.enabled);
      await ConfigStore.update(`${STORE_KEY_PLUGIN_CONFIG}.middlewares.${name}`, enabled);

      // Respond BEFORE running persistMiddlewareDefaults / cleanupMiddleware.
      // For model-routing those write openclaw.json, which triggers a gateway
      // restart that kills the suite-server mid-flight. If the response hasn't
      // left yet, the dashboard's HTTP call aborts and shows a misleading
      // "Failed to toggle" toast before transitioning to "waiting to connect".
      // The flag itself is already saved above; failures from the deferred
      // work were already caught at debug level, so fire-and-forget is safe.
      json(res, 200, { name, enabled });

      if (enabled) {
        persistMiddlewareDefaults(name).catch((err) => {
          logger.debug(`[dashboard] default persist for ${name} failed (non-fatal)`, {
            error: err,
          });
        });
      } else {
        lazyImport('../storage/cleanup.js')
          .then(({ cleanupMiddleware }) => cleanupMiddleware(name))
          .catch((err) => {
            logger.debug(`[dashboard] cleanup for ${name} failed (non-fatal)`, { error: err });
          });
      }
      return;
    }

    // ── HITL endpoints ───────────────────────────────────────────────────
    if (urlPath === '/api/hitl/stats' && method === 'GET') {
      const { StatsTracker } = await lazyImport('../../middlewares/hitl/storage/StatsTracker.js');
      const stats = await StatsTracker.load();
      json(res, 200, stats);
      return;
    }
    if (urlPath === '/api/hitl/policy' && method === 'GET') {
      const { PolicyStore } = await lazyImport('../../middlewares/hitl/storage/PolicyStore.js');
      const policy = await PolicyStore.load();
      json(res, 200, policy);
      return;
    }
    if (urlPath === '/api/hitl/policy' && method === 'PUT') {
      const { PolicyStore } = await lazyImport('../../middlewares/hitl/storage/PolicyStore.js');
      const body = JSON.parse(await readBody(req));
      await PolicyStore.save(body);
      json(res, 200, { ok: true });
      return;
    }
    if (urlPath === '/api/hitl/decisions' && method === 'GET') {
      const limit = parseInt(query.get('limit') || '100', 10);
      const records = await readAuditFile(HITL_DECISIONS_FILE, limit);
      json(res, 200, records);
      return;
    }
    if (urlPath === '/api/hitl/audit-path' && method === 'GET') {
      json(res, 200, { path: HITL_DECISIONS_FILE });
      return;
    }
    if (urlPath === '/api/hitl/policy-path' && method === 'GET') {
      const { PolicyStore } = await lazyImport('../../middlewares/hitl/storage/PolicyStore.js');
      json(res, 200, { path: PolicyStore.getPath() });
      return;
    }
    if (urlPath === '/api/hitl/presets' && method === 'GET') {
      const presetsMod = await lazyImport('../../middlewares/hitl/presets.js');
      const configMod = await lazyImport('../../middlewares/hitl/config.js');
      json(res, 200, {
        presets: presetsMod.SECURITY_PRESETS,
        defaultModules: presetsMod.DEFAULT_MODULES,
        defaultThresholds: configMod.DEFAULT_POLICY?.systemThresholds,
      });
      return;
    }
    if (urlPath === '/api/hitl/stats/reset' && method === 'POST') {
      const { StatsTracker } = await lazyImport('../../middlewares/hitl/storage/StatsTracker.js');
      await StatsTracker.reset();
      json(res, 200, { ok: true });
      return;
    }
    if (urlPath === '/api/hitl/policy/reset' && method === 'POST') {
      const { PolicyStore } = await lazyImport('../../middlewares/hitl/storage/PolicyStore.js');
      await PolicyStore.reset();
      json(res, 200, { ok: true });
      return;
    }

    // ── Model Routing endpoints ──────────────────────────────────────────
    if (urlPath === '/api/routing/stats' && method === 'GET') {
      try {
        const { getStats } = await lazyImport('../../middlewares/model-routing/proxy/handler.js');
        json(res, 200, getStats());
      } catch {
        json(res, 200, {});
      }
      return;
    }
    if (urlPath === '/api/routing/config' && method === 'GET') {
      const { ModelRoutingPolicyStore } = await lazyImport(
        '../../middlewares/model-routing/storage/ModelRoutingPolicyStore.js'
      );
      const config = await ModelRoutingPolicyStore.load();
      json(res, 200, config);
      return;
    }
    if (urlPath === '/api/routing/tiers' && method === 'PUT') {
      const { ModelRoutingPolicyStore } = await lazyImport(
        '../../middlewares/model-routing/storage/ModelRoutingPolicyStore.js'
      );
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;

      // Tier writes are scoped to a single profile via `body.profile`. The
      // dashboard editor surfaces one profile's tiers at a time and submits
      // only that slot, leaving the other profiles' configs untouched.
      const rawProfile = typeof body.profile === 'string' ? body.profile : undefined;
      const incomingTiers = body.tierOverrides;

      const update: Record<string, unknown> = {};
      // Sibling fields the dashboard may submit alongside tier edits — passed
      // through unchanged.
      for (const key of [
        'sessionPinningEnabled',
        'providerCacheEnabled',
        'weightOverrides',
        'boundaryOverrides',
        'overrideThresholds',
        'exclusions',
        'providerConfigs',
      ]) {
        if (key in body) update[key] = body[key];
      }

      if (incomingTiers && typeof incomingTiers === 'object') {
        // Hard allowlist before using `profile` as an object key. Explicit
        // string comparisons + literal assignments narrow `safeProfile` to
        // a finite union, giving CodeQL the dataflow proof it needs to clear
        // the `js/prototype-polluting-assignment` alert (a runtime
        // `isValidProfile()` predicate, while functionally equivalent, is
        // not recognized as a sanitizer by the static analyzer).
        let safeProfile: 'eco' | 'premium' | 'agentic';
        if (rawProfile === 'eco') safeProfile = 'eco';
        else if (rawProfile === 'premium') safeProfile = 'premium';
        else if (rawProfile === 'agentic') safeProfile = 'agentic';
        else {
          json(res, 400, {
            error: 'tierOverrides requires `profile` field set to eco|premium|agentic',
          });
          return;
        }
        const current = await ModelRoutingPolicyStore.load();
        const existingByProfile = current.tierOverridesByProfile ?? {};
        update.tierOverridesByProfile = {
          ...existingByProfile,
          [safeProfile]: incomingTiers,
        };
      }

      await ModelRoutingPolicyStore.update(update);
      json(res, 200, { ok: true });
      return;
    }
    if (urlPath === '/api/routing/models' && method === 'GET') {
      const models = (await readJsonFile(MODEL_ROUTE_DISCOVERED_FILE)) as unknown[] | undefined;
      json(res, 200, models || []);
      return;
    }
    if (urlPath === '/api/routing/providers' && method === 'GET') {
      const store = await ConfigStore.read();
      const providers = store.model_routing?.providerConfigs || {};
      json(res, 200, providers);
      return;
    }
    if (urlPath === '/api/routing/cost' && method === 'GET') {
      const data = await readJsonFile(MODEL_ROUTE_COST_FILE);
      json(res, 200, data || {});
      return;
    }
    if (urlPath === '/api/routing/audit' && method === 'GET') {
      const limit = parseInt(query.get('limit') || '100', 10);
      const records = await readAuditFile(MODEL_ROUTE_AUDIT_FILE, limit);
      json(res, 200, records);
      return;
    }

    // ── Context Editing endpoints ────────────────────────────────────────
    if (urlPath === '/api/context-editing/config' && method === 'GET') {
      const { ContextEditingPolicyStore } = await lazyImport(
        '../../middlewares/context-editing/storage/ContextEditingPolicyStore.js'
      );
      const config = await ContextEditingPolicyStore.load();
      json(res, 200, config);
      return;
    }
    if (urlPath === '/api/context-editing/config' && method === 'PUT') {
      const { ContextEditingPolicyStore } = await lazyImport(
        '../../middlewares/context-editing/storage/ContextEditingPolicyStore.js'
      );
      const body = JSON.parse(await readBody(req));

      // Dual-write: mirror model + pruning into openclaw.json so OpenClaw's
      // runtime pruning + compaction-model stay aligned with the store.
      // flushToOpenClaw only writes the file when values actually changed,
      // so a save that only touched threshold/triggerMode is a no-op here
      // and won't restart the gateway.
      const { stageOpenClawWrites, flushToOpenClaw } = await lazyImport('./openclaw-sync.js');
      const pruningValue = {
        mode: body.pruningMode === 'enabled' ? 'cache-ttl' : 'off',
        ttl: typeof body.ttl === 'string' && body.ttl ? body.ttl : '5m',
      };
      const modelValue =
        typeof body.model === 'string' && body.model.length > 0 ? body.model : undefined;
      await stageOpenClawWrites([
        { dotPath: 'agents.defaults.contextPruning', value: pruningValue },
        { dotPath: 'agents.defaults.compaction.model', value: modelValue },
      ]);
      const flushResult = await flushToOpenClaw();

      await ContextEditingPolicyStore.save(body);
      // `restarted` lets the dashboard drive `notifyGatewayRestart()` only
      // when the flush actually requested a restart — avoids flashing the
      // overlay when nothing changed or when only hot-reloadable paths moved.
      json(res, 200, { ok: true, restarted: flushResult.restarted });
      return;
    }
    if (urlPath === '/api/context-editing/stats' && method === 'GET') {
      const stats = await readJsonFile(CTX_EDIT_STATS_FILE);
      json(res, 200, stats || {});
      return;
    }
    if (urlPath === '/api/context-editing/audit' && method === 'GET') {
      const limit = parseInt(query.get('limit') || '100', 10);
      const records = await readAuditFile(CTX_EDIT_AUDIT_FILE, limit);
      json(res, 200, records);
      return;
    }

    // ── Guardrail endpoints ──────────────────────────────────────────────
    if (urlPath === '/api/guardrail/config' && method === 'GET') {
      try {
        const mod = await lazyImport('../../middlewares/guardrail/storage/ConfigStore.js');
        const GConfigStore = mod.ConfigStore || mod.default;
        const config = await GConfigStore.load();
        json(res, 200, config);
      } catch {
        json(res, 200, {});
      }
      return;
    }
    if (urlPath === '/api/guardrail/config' && method === 'PUT') {
      try {
        const mod = await lazyImport('../../middlewares/guardrail/storage/ConfigStore.js');
        const GConfigStore = mod.ConfigStore || mod.default;
        const body = JSON.parse(await readBody(req));
        await GConfigStore.save(body);
        json(res, 200, { ok: true });
      } catch {
        json(res, 500, { error: 'Failed to save guardrail config' });
      }
      return;
    }
    if (urlPath === '/api/guardrail/audit' && method === 'GET') {
      const limit = parseInt(query.get('limit') || '100', 10);
      const records = await readAuditFile(GUARDRAIL_AUDIT_FILE, limit);
      json(res, 200, records);
      return;
    }
    if (urlPath === '/api/guardrail/config-path' && method === 'GET') {
      try {
        const mod = await lazyImport('../../middlewares/guardrail/storage/ConfigStore.js');
        const GConfigStore = mod.ConfigStore || mod.default;
        json(res, 200, { path: GConfigStore.getPath() });
      } catch {
        json(res, 200, { path: 'sapience-ai-suite.json [guardrail]' });
      }
      return;
    }
    if (urlPath === '/api/guardrail/defaults' && method === 'GET') {
      try {
        const mod = await lazyImport('../../middlewares/guardrail/storage/ConfigStore.js');
        const GConfigStore = mod.ConfigStore || mod.default;
        json(res, 200, GConfigStore.defaults());
      } catch {
        json(res, 500, { error: 'Failed to load guardrail defaults' });
      }
      return;
    }
    if (urlPath === '/api/guardrail/reset' && method === 'POST') {
      try {
        const mod = await lazyImport('../../middlewares/guardrail/storage/ConfigStore.js');
        const GConfigStore = mod.ConfigStore || mod.default;
        await GConfigStore.save(GConfigStore.defaults());
        json(res, 200, { ok: true });
      } catch {
        json(res, 500, { error: 'Failed to reset guardrail config' });
      }
      return;
    }

    // ── PII Sanitizer endpoints ──────────────────────────────────────────
    if (urlPath === '/api/pii/policy' && method === 'GET') {
      try {
        const { DlpStore } = await lazyImport(
          '../../middlewares/pii-sanitizer/storage/DlpStore.js'
        );
        const policy = await DlpStore.load();
        json(res, 200, policy);
      } catch {
        json(res, 200, {});
      }
      return;
    }
    if (urlPath === '/api/pii/policy' && method === 'PUT') {
      try {
        const { DlpStore } = await lazyImport(
          '../../middlewares/pii-sanitizer/storage/DlpStore.js'
        );
        const body = JSON.parse(await readBody(req));
        await DlpStore.save(body);
        json(res, 200, { ok: true });
      } catch {
        json(res, 500, { error: 'Failed to save DLP policy' });
      }
      return;
    }
    if (urlPath === '/api/pii/audit' && method === 'GET') {
      const limit = parseInt(query.get('limit') || '100', 10);
      const records = await readAuditFile(PII_SANITIZER_AUDIT_FILE, limit);
      json(res, 200, records);
      return;
    }
    if (urlPath === '/api/pii/policy-path' && method === 'GET') {
      try {
        const { DlpStore } = await lazyImport(
          '../../middlewares/pii-sanitizer/storage/DlpStore.js'
        );
        json(res, 200, { path: DlpStore.getPath() });
      } catch {
        json(res, 200, { path: 'sapience-ai-suite.json [pii_sanitizer]' });
      }
      return;
    }
    if (urlPath === '/api/pii/defaults' && method === 'GET') {
      try {
        const { DlpStore } = await lazyImport(
          '../../middlewares/pii-sanitizer/storage/DlpStore.js'
        );
        json(res, 200, DlpStore.defaults());
      } catch {
        json(res, 500, { error: 'Failed to load DLP defaults' });
      }
      return;
    }
    if (urlPath === '/api/pii/reset' && method === 'POST') {
      try {
        const { DlpStore } = await lazyImport(
          '../../middlewares/pii-sanitizer/storage/DlpStore.js'
        );
        await DlpStore.save(DlpStore.defaults());
        json(res, 200, { ok: true });
      } catch {
        json(res, 500, { error: 'Failed to reset DLP policy' });
      }
      return;
    }

    // ── Tool Call Limit endpoints ────────────────────────────────────────
    if (urlPath === '/api/limits/policy' && method === 'GET') {
      try {
        const { LimitPolicyStore } = await lazyImport(
          '../../middlewares/tool-call-limit/storage/LimitPolicyStore.js'
        );
        const policy = await LimitPolicyStore.load();
        json(res, 200, policy);
      } catch {
        json(res, 200, {});
      }
      return;
    }
    if (urlPath === '/api/limits/policy' && method === 'PUT') {
      try {
        const { LimitPolicyStore } = await lazyImport(
          '../../middlewares/tool-call-limit/storage/LimitPolicyStore.js'
        );
        const body = JSON.parse(await readBody(req));
        await LimitPolicyStore.save(body);
        json(res, 200, { ok: true });
      } catch {
        json(res, 500, { error: 'Failed to save limit policy' });
      }
      return;
    }
    if (urlPath === '/api/limits/sessions' && method === 'GET') {
      try {
        const { TrackerStore } = await lazyImport(
          '../../middlewares/tool-call-limit/storage/TrackerStore.js'
        );
        const data = await TrackerStore.load();
        json(res, 200, data);
      } catch {
        json(res, 200, { sessions: {}, requests: {} });
      }
      return;
    }
    if (urlPath === '/api/limits/policy-path' && method === 'GET') {
      try {
        const { LimitPolicyStore } = await lazyImport(
          '../../middlewares/tool-call-limit/storage/LimitPolicyStore.js'
        );
        json(res, 200, { path: LimitPolicyStore.getPath() });
      } catch {
        json(res, 200, { path: 'sapience-ai-suite.json [tool_call_limit]' });
      }
      return;
    }
    if (urlPath === '/api/limits/defaults' && method === 'GET') {
      try {
        const { DEFAULT_LIMIT_POLICY } = await lazyImport(
          '../../middlewares/tool-call-limit/types.js'
        );
        json(res, 200, DEFAULT_LIMIT_POLICY);
      } catch {
        json(res, 200, { modules: {} });
      }
      return;
    }
    if (urlPath === '/api/limits/policy/reset' && method === 'POST') {
      try {
        const { LimitPolicyStore } = await lazyImport(
          '../../middlewares/tool-call-limit/storage/LimitPolicyStore.js'
        );
        await LimitPolicyStore.reset();
        json(res, 200, { ok: true });
      } catch {
        json(res, 500, { error: 'Failed to reset limit policy' });
      }
      return;
    }
    if (urlPath === '/api/limits/trackers/reset' && method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          scope?: 'all' | 'session' | 'request';
        };
        const scope = body.scope ?? 'all';
        const resetSession = scope === 'all' || scope === 'session';
        const resetRequest = scope === 'all' || scope === 'request';
        const fsMod = (await import('fs-extra')) as typeof import('fs-extra') & {
          default?: typeof import('fs-extra');
        };
        const fsExtra = fsMod.default ?? fsMod;
        const pathsMod = await lazyImport('../storage/paths.js');
        if (resetSession) {
          await fsExtra.remove(pathsMod.TOOL_CALL_LIMIT_SESSIONS_FILE);
        }
        if (resetRequest) {
          await fsExtra.remove(pathsMod.TOOL_CALL_LIMIT_REQUESTS_FILE);
          await fsExtra.remove(pathsMod.TOOL_CALL_LIMIT_LAST_REQ_FILE);
        }
        const { LimitPolicyStore } = await lazyImport(
          '../../middlewares/tool-call-limit/storage/LimitPolicyStore.js'
        );
        const policy = await LimitPolicyStore.load();
        const now = new Date().toISOString();
        policy.resetAt = now;
        policy.resetScope = scope;
        await LimitPolicyStore.save(policy);
        json(res, 200, { ok: true, resetAt: now, scope });
      } catch (err) {
        json(res, 500, { error: `Failed to reset trackers: ${err}` });
      }
      return;
    }

    // ── OpenClaw sync endpoints ─────────────────────────────────────────
    if (urlPath === '/api/openclaw/pending' && method === 'GET') {
      const { getPendingWrites } = await lazyImport('./openclaw-sync.js');
      const pending = await getPendingWrites();
      json(res, 200, { pending, count: Object.keys(pending).length });
      return;
    }
    if (urlPath === '/api/openclaw/sync' && method === 'POST') {
      const { flushToOpenClaw } = await lazyImport('./openclaw-sync.js');
      const result = await flushToOpenClaw();
      json(res, 200, { ok: true, flushed: result.count, restarted: result.restarted });
      return;
    }
    if (urlPath === '/api/openclaw/stage' && method === 'PUT') {
      const { stageOpenClawWrite } = await lazyImport('./openclaw-sync.js');
      const body = JSON.parse(await readBody(req));
      if (!body.dotPath) {
        json(res, 400, { error: 'Missing dotPath field' });
        return;
      }
      await stageOpenClawWrite(body.dotPath, body.value);
      json(res, 200, { ok: true, dotPath: body.dotPath });
      return;
    }

    // ── Unified config (full store) ──────────────────────────────────────
    if (urlPath === '/api/config' && method === 'GET') {
      const store = await ConfigStore.read();
      json(res, 200, store);
      return;
    }

    // ── 404 ──────────────────────────────────────────────────────────────
    json(res, 404, { error: 'API endpoint not found' });
  } catch (err) {
    logger.error('[dashboard-api] Unhandled error', { error: err });
    json(res, 500, { error: 'Internal server error' });
  }
}

// ── SSE Log Streaming ──────────────────────────────────────────────────────

const LOG_SOURCES: Record<string, string> = {
  hitl: HITL_DECISIONS_FILE,
  routing: MODEL_ROUTE_AUDIT_FILE,
  'context-editing': CTX_EDIT_AUDIT_FILE,
  guardrail: GUARDRAIL_AUDIT_FILE,
  pii: PII_SANITIZER_AUDIT_FILE,
  proxy: MODEL_ROUTE_PROXY_LOG,
};

export function handleSseRoute(req: http.IncomingMessage, res: http.ServerResponse): void {
  const urlPath = (req.url || '').split('?')[0];
  // /sse/logs/:source
  const match = urlPath.match(/^\/sse\/logs\/([\w-]+)$/);
  if (!match) {
    json(res, 404, { error: 'SSE endpoint not found' });
    return;
  }

  const source = match[1];
  const filePath = LOG_SOURCES[source];
  if (!filePath) {
    json(res, 404, { error: `Unknown log source: ${source}` });
    return;
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send initial heartbeat
  res.write('event: connected\ndata: {"source":"' + source + '"}\n\n');

  // Track current file size to detect appends
  let lastSize = 0;
  try {
    if (fs.existsSync(filePath)) {
      lastSize = fs.statSync(filePath).size;
    }
  } catch {
    /* file may not exist yet */
  }

  // Watch for file changes using fs.watchFile (reliable on Windows)
  const POLL_INTERVAL = 1000; // 1 second

  const onFileChange = (): void => {
    // Open first, then fstat the fd — atomic w.r.t. the file at open time.
    // Eliminates the TOCTOU race between exists/stat and openSync
    // (CodeQL js/file-system-race).
    let fd: number | undefined;
    try {
      try {
        fd = fs.openSync(filePath, 'r');
      } catch (err) {
        // ENOENT etc. — file gone; nothing to do this tick.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      const stat = fs.fstatSync(fd);
      if (stat.size <= lastSize) {
        // File was truncated or unchanged
        if (stat.size < lastSize) lastSize = 0;
        return;
      }

      // Read only the new bytes
      const newBytes = Buffer.alloc(stat.size - lastSize);
      fs.readSync(fd, newBytes, 0, newBytes.length, lastSize);
      lastSize = stat.size;

      const newContent = newBytes.toString('utf-8');

      // Parse new records (supports both Pretty-JSON and JSONL)
      const records: string[] = [];
      if (newContent.includes('\n---\n')) {
        for (const block of newContent.split('\n---\n')) {
          const trimmed = block.trim();
          if (!trimmed) continue;
          try {
            JSON.parse(trimmed); // validate
            records.push(trimmed);
          } catch {
            /* skip invalid */
          }
        }
      } else {
        for (const line of newContent.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            JSON.parse(trimmed); // validate
            records.push(trimmed);
          } catch {
            /* skip non-JSON lines */
          }
        }
      }

      for (const record of records) {
        res.write(`data: ${record}\n\n`);
      }
    } catch (err) {
      logger.debug('[sse] Error reading log file', { source, error: err });
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  };

  fs.watchFile(filePath, { interval: POLL_INTERVAL }, onFileChange);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 30_000);

  // Cleanup on disconnect
  req.on('close', () => {
    fs.unwatchFile(filePath, onFileChange);
    clearInterval(heartbeat);
  });
}
