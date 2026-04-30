/*
 * Copyright (c) 2026 BlockRun
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * This file is derived from the ClawRouter project
 * (https://github.com/BlockRunAI/ClawRouter) and has been modified for use
 * in the OpenClaw Middleware Suite.
 *
 * Used under the MIT License — see NOTICE for the full license text.
 */

/**
 * Handler — Request handler for the routing proxy.
 *
 * Phase 1 pipeline: parse → score → select model → set headers → forward → pipe back.
 * Phase 2 additions: dedup, LLM classifier, fallback chains, param stripping.
 * Phase 3 additions: multi-provider forwarding via registry.
 * Phase 4 additions: session momentum, model pinning, three-strike, profiles.
 * Phase 5 additions: response caching, cost tracking, plugin hooks.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { scoreRequest } from '../scoring/scorer.js';
import { classifyWithLLM } from '../scoring/llm-classifier.js';
import { ModelRoutingConfig } from '../config.js';
import { RoutingDecision, RoutingStats, FallbackAttempt, DiscoveredModel } from '../types.js';
import {
  getFallbackChain,
  filterFallbackChain,
  requestHasVision,
  shouldTriggerFallback,
} from '../selection/fallback.js';
import { RequestDeduplicator, CachedResponse } from '../cache/dedup.js';
import { ResponseCache, CachedResponseEntry } from '../cache/response-cache.js';
import { resolveProvider, stripModelPrefix } from '../providers/registry.js';
import { stripIncompatibleParams } from '../providers/types.js';
import { estimateTotalTokens } from '../scoring/text-extractor.js';
import { MomentumTracker } from '../session/momentum.js';
import { SessionStore } from '../session/session-store.js';
import { RoutingProfile, isValidProfile } from '../selection/profiles.js';
import { CostTracker } from '../storage/cost-tracker.js';
import { PluginRegistry, AfterForwardEvent } from '../plugins/types.js';
import { fetchModelCatalog, toDiscoveredModels, CatalogModel } from '../storage/model-catalog.js';
import { normalizeDiscoveredModels } from '../providers/discovery.js';
import { MODEL_ROUTE_PROXY_LOG, MODEL_ROUTE_COST_FILE } from '../../../shared/storage/paths.js';
import { stripIccMarker } from '../../../shared/icc-detection.js';

// ---------------------------------------------------------------------------
// Proxy Audit Logger — detailed step-by-step request tracing
// ---------------------------------------------------------------------------

const PROXY_AUDIT_FILE = MODEL_ROUTE_PROXY_LOG;

let proxyAuditEnsured = false;

/**
 * Strip newlines and control characters from a logged field, and cap length.
 * Prevents log injection (CodeQL js/http-to-file-access) where attacker-
 * controlled HTTP input could forge log lines or bloat the audit file.
 */
function sanitizeLogField(s: string, maxLen = 2048): string {
  // Replace CR/LF and other ASCII control chars (0x00-0x1F, 0x7F) with a
  // single space so a malicious header cannot fabricate a fake log line.
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\x00-\x1f\x7f]/g, ' ');
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}

function proxyLog(reqId: string, step: string, detail?: string | Record<string, unknown>): void {
  try {
    if (!proxyAuditEnsured) {
      fs.mkdirSync(path.dirname(PROXY_AUDIT_FILE), { recursive: true });
      proxyAuditEnsured = true;
    }
    const ts = new Date().toISOString();
    const safeReqId = sanitizeLogField(reqId, 128);
    const safeStep = sanitizeLogField(step, 256);
    const detailStr =
      detail === undefined
        ? ''
        : typeof detail === 'string'
          ? ` | ${sanitizeLogField(detail)}`
          : ` | ${sanitizeLogField(JSON.stringify(detail))}`;
    fs.appendFileSync(PROXY_AUDIT_FILE, `[${ts}] [${safeReqId}] ${safeStep}${detailStr}\n`);
  } catch {
    /* never crash the proxy for logging */
  }
}

/** Maximum time for an entire request including all fallback attempts (3 minutes).
 *  Matches CLawRouter DEFAULT_REQUEST_TIMEOUT_MS (proxy.ts:147). */
const GLOBAL_REQUEST_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Stats (in-memory, reset on restart)
// ---------------------------------------------------------------------------

const stats: RoutingStats = {
  total: 0,
  byTier: { SIMPLE: 0, STANDARD: 0, COMPLEX: 0, REASONING: 0 },
  startedAt: new Date().toISOString(),
};

export function getStats(): RoutingStats {
  return { ...stats, byTier: { ...stats.byTier } };
}

export function resetStats(): void {
  stats.total = 0;
  stats.byTier = { SIMPLE: 0, STANDARD: 0, COMPLEX: 0, REASONING: 0 };
  stats.startedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Route logger callback (set by middleware to write audit entries)
// ---------------------------------------------------------------------------

type OnRouteCallback = (decision: RoutingDecision) => void;
let onRouteCallback: OnRouteCallback | null = null;

export function setOnRouteCallback(cb: OnRouteCallback): void {
  onRouteCallback = cb;
}

// ---------------------------------------------------------------------------
// Deduplicator (shared instance, created on first use)
// ---------------------------------------------------------------------------

let deduplicator: RequestDeduplicator | null = null;

function getDeduplicator(config: ModelRoutingConfig): RequestDeduplicator {
  if (!deduplicator) {
    deduplicator = new RequestDeduplicator(config.dedup.ttlMs, config.dedup.maxBodySize);
  }
  return deduplicator;
}

// ---------------------------------------------------------------------------
// Discovered models cache (fed by middleware index.ts)
// ---------------------------------------------------------------------------

let discoveredModelsCache: DiscoveredModel[] = [];

export function setDiscoveredModels(models: DiscoveredModel[]): void {
  discoveredModelsCache = models;
  // Keep cost tracker pricing in sync with the live discovered set.
  if (costTracker) {
    costTracker.setDiscoveredModels(models);
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Session intelligence (shared instances)
// ---------------------------------------------------------------------------

let momentumTracker: MomentumTracker | null = null;
let sessionStore: SessionStore | null = null;

export function initSessionIntelligence(config: ModelRoutingConfig): void {
  momentumTracker = new MomentumTracker(config.momentum);
  sessionStore = new SessionStore(config.session);
}

export function getMomentumTracker(): MomentumTracker | null {
  return momentumTracker;
}

export function getSessionStore(): SessionStore | null {
  return sessionStore;
}

// ---------------------------------------------------------------------------
// Phase 5: Response cache (shared instance)
// ---------------------------------------------------------------------------

let responseCache: ResponseCache | null = null;

export function initResponseCache(config: ModelRoutingConfig): void {
  responseCache = new ResponseCache(config.responseCache);
}

export function getResponseCache(): ResponseCache | null {
  return responseCache;
}

// ---------------------------------------------------------------------------
// Phase 5: Cost tracker (shared instance)
// ---------------------------------------------------------------------------

let costTracker: CostTracker | null = null;

export function initCostTracker(config: ModelRoutingConfig): void {
  costTracker = new CostTracker(config.costAlerts, MODEL_ROUTE_COST_FILE);
}

export function getCostTracker(): CostTracker | null {
  return costTracker;
}

// ---------------------------------------------------------------------------
// Model catalog (live LiteLLM data — feeds discoveredModels + cost tracker)
// ---------------------------------------------------------------------------

let catalogCache: CatalogModel[] = [];

/**
 * Load the LiteLLM model catalog asynchronously.
 * Bootstraps the discovered models cache (until real provider discovery runs)
 * and injects pricing into the cost tracker. After real discovery completes,
 * setDiscoveredModels() will overwrite the bootstrap data with provider-API
 * authoritative entries.
 * Safe to call multiple times (no-ops if already loaded).
 */
export async function loadModelCatalog(): Promise<void> {
  try {
    catalogCache = await fetchModelCatalog();
    if (catalogCache.length > 0) {
      const bootstrap = normalizeDiscoveredModels(
        toDiscoveredModels(catalogCache) as DiscoveredModel[]
      );
      // Bootstrap discovered models for fallback chain + capability checks
      discoveredModelsCache = bootstrap;
      // Feed pricing into cost tracker via the discovered model surface
      if (costTracker) {
        costTracker.setDiscoveredModels(bootstrap);
      }
    }
  } catch {
    // Non-fatal — will use fallback pricing
  }
}

/**
 * Check if a model supports function calling (tool use) via discovered models.
 */
export function modelSupportsFunctionCalling(modelId: string): boolean {
  if (discoveredModelsCache.length === 0) return false;
  const exact = discoveredModelsCache.find((m) => m.id === modelId || m.name === modelId);
  const matched = exact ?? discoveredModelsCache.find((m) => modelId.startsWith(m.id));
  if (!matched) return false;
  // Prefer the more specific functionCalling capability (set during enrichment),
  // fall back to toolCalling which adapters report directly.
  return matched.capabilities.functionCalling ?? matched.capabilities.toolCalling ?? false;
}

export function getCatalog(): CatalogModel[] {
  return catalogCache;
}

// ---------------------------------------------------------------------------
// Phase 5: Plugin registry (shared instance)
// ---------------------------------------------------------------------------

let pluginRegistry: PluginRegistry | null = null;

export function initPluginRegistry(): PluginRegistry {
  pluginRegistry = new PluginRegistry();
  return pluginRegistry;
}

export function getPluginRegistry(): PluginRegistry | null {
  return pluginRegistry;
}

// ---------------------------------------------------------------------------
// Health / stats endpoints
// ---------------------------------------------------------------------------

export function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  config: ModelRoutingConfig
): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      status: 'ok',
      port: config.port,
      tiersByProfile: Object.fromEntries(
        Object.entries(config.tiersByProfile).map(([p, tiers]) => [
          p,
          Object.fromEntries(Object.entries(tiers).map(([t, c]) => [t, c.primary])),
        ])
      ),
      providers: Object.keys(config.providers),
      profile: config.defaultProfile,
      sessions: sessionStore?.size || 0,
      cacheSize: responseCache?.size || 0,
      plugins: pluginRegistry?.getNames() || [],
    })
  );
}

export function handleStats(_req: IncomingMessage, res: ServerResponse): void {
  const costSummary = costTracker?.getSummary();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      ...getStats(),
      cost: costSummary || null,
    })
  );
}

// ---------------------------------------------------------------------------
// Main chat completions handler
// ---------------------------------------------------------------------------

export function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  config: ModelRoutingConfig
): void {
  const reqId = createHash('sha256')
    .update(String(Date.now()) + String(Math.random()))
    .digest('hex')
    .slice(0, 8);
  proxyLog(
    reqId,
    'REQUEST_RECEIVED',
    `${req.method} ${req.url} from ${req.socket?.remoteAddress || 'unknown'}`
  );

  collectBody(req, (err, raw) => {
    if (err || !raw) {
      proxyLog(reqId, 'BODY_READ_ERROR', err?.message || 'empty body');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }));
      return;
    }

    proxyLog(reqId, 'BODY_PARSED', `${raw.length} bytes`);

    // ── Dedup check ─────────────────────────────────────────────────────
    if (config.dedup.enabled && !getDeduplicator(config).shouldSkip(raw.length)) {
      const dedupKey = RequestDeduplicator.hash(raw);
      const dedup = getDeduplicator(config);

      // Check completed cache
      const cached = dedup.getCached(dedupKey);
      if (cached) {
        proxyLog(reqId, 'DEDUP_CACHE_HIT', `key=${dedupKey.slice(0, 12)}`);
        serveCachedResponse(res, cached);
        return;
      }

      // Check inflight
      const inflight = dedup.getInflight(dedupKey);
      if (inflight) {
        proxyLog(reqId, 'DEDUP_INFLIGHT_HIT', `key=${dedupKey.slice(0, 12)}`);
        inflight
          .then((result) => serveCachedResponse(res, result))
          .catch(() => {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Upstream request failed (dedup)' } }));
          });
        return;
      }

      // Mark inflight and continue
      dedup.markInflight(dedupKey);
      proxyLog(reqId, 'DEDUP_MARKED_INFLIGHT', `key=${dedupKey.slice(0, 12)}`);
      processRequest(req, res, raw, config, dedupKey, reqId);
    } else {
      processRequest(req, res, raw, config, null, reqId);
    }
  });
}

// ---------------------------------------------------------------------------
// Core request processing (after dedup check)
// ---------------------------------------------------------------------------

async function processRequest(
  req: IncomingMessage,
  res: ServerResponse,
  raw: string,
  config: ModelRoutingConfig,
  dedupKey: string | null,
  reqId: string
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    proxyLog(reqId, 'JSON_PARSE_ERROR', 'Invalid JSON body');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
    if (dedupKey) getDeduplicator(config).removeInflight(dedupKey);
    return;
  }

  const startMs = Date.now();

  // ── Client disconnect cleanup ─────────────────────────────────────────
  // When the client disconnects mid-request, abort upstream requests and
  // clean up dedup entries. Matches CLawRouter pattern (proxy.ts:3863-3874).
  let requestCompleted = false;
  const clientAbort = new AbortController();
  res.on('close', () => {
    if (!requestCompleted) {
      proxyLog(
        reqId,
        'CLIENT_DISCONNECT',
        `elapsed=${Date.now() - startMs}ms, headersSent=${res.headersSent}`
      );
      clientAbort.abort();
      if (dedupKey) getDeduplicator(config).removeInflight(dedupKey);
    }
  });

  // ── Global request timeout ────────────────────────────────────────────
  // Hard deadline for the entire request (all fallback attempts combined).
  // Matches CLawRouter pattern (proxy.ts:3876-3883).
  const globalTimeoutId = setTimeout(() => clientAbort.abort(), GLOBAL_REQUEST_TIMEOUT_MS);

  // ── Extract and normalise the requested model ─────────────────────────
  const requestModel = typeof body.model === 'string' ? body.model : '';
  const isMetaModel = isRoutingMetaModel(requestModel);

  // ── Extract session ID ─────────────────────────────────────────────────
  // Pass body so we can derive session ID from first user message content
  // when OpenClaw doesn't send x-session-id (the default behaviour).
  const sessionId = extractSessionId(req, body);
  proxyLog(reqId, 'SESSION_ID', {
    sessionId: sessionId || '(none)',
    source: req.headers['x-session-id']
      ? 'x-session-id'
      : sessionId && !req.headers['x-request-id']
        ? 'derived-from-content'
        : req.headers['x-request-id']
          ? 'x-request-id (⚠ per-request, pinning will not carry over)'
          : 'none',
    rawSessionHeader: (req.headers['x-session-id'] as string) || '(absent)',
    rawRequestHeader: (req.headers['x-request-id'] as string) || '(absent)',
  });

  // ── Extract request hash (for three-strike) ────────────────────────────
  const requestHash = hashRequestContent(body);

  // ── Determine routing profile ──────────────────────────────────────────
  const profile = resolveProfile(req, config, isMetaModel ? requestModel : undefined);

  // ── Resolve effective tier config based on profile ─────────────────────
  // Per-profile tier map: each profile (eco/premium/agentic) carries its own
  // primary/fallbacks per tier. `tiersByProfile` is fully populated by
  // buildConfig (defaults from `PROFILE_CONFIGS` for any profile without
  // an explicit override), so this lookup never misses.
  const effectiveTiers = config.tiersByProfile[profile];

  const lastMsg = getLastUserMessage(body);
  proxyLog(reqId, 'METADATA', {
    model: requestModel,
    isMetaModel,
    sessionId,
    profile,
    stream: body.stream,
    hasTools: Array.isArray(body.tools) && (body.tools as unknown[]).length > 0,
    msgPreview: lastMsg ? lastMsg.slice(0, 120) : '(none)',
  });

  // ── Response cache check (Phase 5) ─────────────────────────────────────
  const reqHeaders = extractHeaders(req);
  if (responseCache && responseCache.size > 0) {
    const cacheKey = ResponseCache.generateKey(body);
    if (responseCache.isCacheable(body, reqHeaders)) {
      const cachedEntry = responseCache.get(cacheKey);
      if (cachedEntry) {
        proxyLog(reqId, 'RESPONSE_CACHE_HIT', `model=${cachedEntry.model}`);
        serveCachedResponseEntry(res, cachedEntry);
        if (dedupKey) getDeduplicator(config).removeInflight(dedupKey);
        return;
      }
    }
  }

  // ── Plugin: onBeforeScore ──────────────────────────────────────────────
  if (pluginRegistry?.hasPlugins) {
    const pluginInput = await pluginRegistry.runBeforeScore({
      body,
      headers: reqHeaders,
      sessionId,
    });
    body = pluginInput.body;
  }

  // ── Score ──────────────────────────────────────────────────────────────
  let scoringResult = scoreRequest({ body: body as any }, config.scoring);

  proxyLog(reqId, 'SCORING', {
    tier: scoringResult.tier,
    score: scoringResult.score.toFixed(4),
    confidence: scoringResult.confidence.toFixed(3),
    reason: scoringResult.reason,
  });

  // ── LLM classifier for ambiguous results ───────────────────────────────
  if (scoringResult.reason === 'ambiguous' && config.classifier.enabled) {
    try {
      const lastMessage = getLastUserMessage(body);
      if (lastMessage) {
        const classified = await classifyWithLLM(
          lastMessage,
          config.classifier,
          config.targetBaseUrl,
          config.targetApiKey
        );
        if (classified) {
          scoringResult = {
            ...scoringResult,
            tier: classified.tier,
            confidence: classified.confidence,
            reason: 'llm_classified',
          };
        }
      }
    } catch (classifierErr) {
      // Classifier failed — keep ambiguous result (STANDARD)
      proxyLog(
        reqId,
        'LLM_CLASSIFIER_ERROR',
        classifierErr instanceof Error ? classifierErr.message : 'unknown'
      );
    }
  }

  // ── Plugin: onAfterScore ───────────────────────────────────────────────
  const messageLength = getLastUserMessage(body)?.length || 0;
  if (pluginRegistry?.hasPlugins) {
    scoringResult = await pluginRegistry.runAfterScore(scoringResult, {
      sessionId,
      requestHash,
      messageLength,
    });
  }

  // ── Session momentum (Phase 4) ─────────────────────────────────────────
  if (momentumTracker && sessionId) {
    scoringResult = momentumTracker.applyMomentum(
      sessionId,
      scoringResult,
      messageLength,
      config.scoring.boundaries
    );
  }

  // ── Session pinning + three-strike (Phase 4) ──────────────────────────
  // Three-strike escalation runs whenever we have a session (it protects
  // against repeated low-quality answers by bumping the tier). Model
  // pinning is user-toggleable — when config.session.enabled is false,
  // we skip the `usePinned` branch so every turn re-scores fresh.
  let sessionPinned = false;
  if (sessionStore && sessionId) {
    const pinning = sessionStore.checkPinning(sessionId, scoringResult.tier, requestHash);

    if (pinning.escalated && pinning.escalatedTier) {
      proxyLog(reqId, 'THREE_STRIKE_ESCALATION', `tier=${pinning.escalatedTier}`);
      scoringResult = {
        ...scoringResult,
        tier: pinning.escalatedTier,
        reason: 'three_strike',
      };
    } else if (config.session.enabled && pinning.usePinned && pinning.pinnedTier) {
      proxyLog(reqId, 'SESSION_PINNED', `tier=${pinning.pinnedTier}`);
      scoringResult = {
        ...scoringResult,
        tier: pinning.pinnedTier,
        reason: 'session_pinned',
      };
      sessionPinned = true;
    }
  }

  proxyLog(reqId, 'FINAL_TIER', { tier: scoringResult.tier, reason: scoringResult.reason });

  // ── Cost attribution source ────────────────────────────────────────────
  // Cost ledger and budget alerts split spend by caller kind. ICC compaction
  // calls land under `'icc'`; everything else (real user chat turns, manual
  // tier overrides, momentum/pinning hits) lands under `'chat'`.
  const costSource: 'chat' | 'icc' =
    scoringResult.reason === 'icc_extraction' ? 'icc' : 'chat';

  // ── Strip ICC marker before forwarding upstream ────────────────────────
  // The marker was a signal for our scoring override only; the upstream
  // LLM provider must not see it. Mutates the user-role message bodies
  // in-place so the rest of the proxy (dedup hash already computed above,
  // streaming, response cache) continues to work uniformly.
  if (scoringResult.reason === 'icc_extraction' && Array.isArray(body.messages)) {
    body.messages = (body.messages as Array<{ role?: string; content?: unknown }>).map((msg) => {
      if (msg.role !== 'user') return msg;
      if (typeof msg.content === 'string') {
        return { ...msg, content: stripIccMarker(msg.content) };
      }
      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((block) => {
            if (
              block &&
              typeof block === 'object' &&
              'type' in block &&
              (block as { type?: string }).type === 'text' &&
              typeof (block as { text?: unknown }).text === 'string'
            ) {
              return { ...block, text: stripIccMarker((block as { text: string }).text) };
            }
            return block;
          }),
        };
      }
      return msg;
    }) as typeof body.messages;
  }

  // ── Build fallback chain ───────────────────────────────────────────────
  const chain = getFallbackChain(scoringResult.tier, effectiveTiers);
  const exclusions = config.exclusions || [];
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const hasVision = requestHasVision(body);
  const estimatedTokens = estimateTotalTokens(body as any);

  const filteredChain = filterFallbackChain(chain, {
    exclusions,
    estimatedTokens,
    hasTools,
    hasVision,
    discoveredModels: discoveredModelsCache,
  });

  proxyLog(reqId, 'FALLBACK_CHAIN', { chain: filteredChain, estimatedTokens });

  // ── Execute with fallback ──────────────────────────────────────────────
  const attempts: FallbackAttempt[] = [];
  let usedModel = filteredChain[0] || effectiveTiers[scoringResult.tier]?.primary || 'gpt-4o';
  let fallbackFrom: string | undefined;
  let responseStatus = 200;
  let responseInputTokens = 0;
  let responseOutputTokens = 0;
  let responseCacheReadTokens = 0;
  let responseCacheWriteTokens = 0;
  const wasCached = false;

  for (let i = 0; i < filteredChain.length; i++) {
    const modelId = filteredChain[i];

    // Check global timeout / client disconnect before attempting next model
    if (clientAbort.signal.aborted) {
      proxyLog(
        reqId,
        'ABORT_BEFORE_ATTEMPT',
        `model=${modelId}, elapsed=${Date.now() - startMs}ms`
      );
      const errorBody = JSON.stringify({
        error: {
          type: 'timeout',
          message: `Request timed out after ${GLOBAL_REQUEST_TIMEOUT_MS}ms`,
        },
      });
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(errorBody);
      } else {
        safeWrite(res, `data: ${errorBody}\n\n`);
        safeWrite(res, 'data: [DONE]\n\n');
        res.end();
      }
      if (dedupKey) getDeduplicator(config).removeInflight(dedupKey);
      responseStatus = 504;
      break;
    }

    // Resolve provider for this model
    const resolved = resolveProvider(
      modelId,
      config.providers,
      discoveredModelsCache,
      config.targetBaseUrl,
      config.targetApiKey
    );

    // Prepare request body for this specific model
    const modelBody = { ...body };
    const cleanModelId = stripModelPrefix(modelId);
    modelBody.model = cleanModelId;

    // Strip incompatible parameters for this model
    const forwardHeaders: Record<string, string> = {};
    copySelectHeaders(req, forwardHeaders);
    stripIncompatibleParams(modelBody, modelId, forwardHeaders);

    // Convert request body if needed (Anthropic, Google adapters)
    const isNativeOpenAI = resolved.adapter.format === 'openai';
    let providerBody = resolved.adapter.toProviderRequest(modelBody, cleanModelId, {
      promptCacheEnabled: config.providerCache.enabled,
    });

    // Stream mode: if the adapter supports real-time chunk conversion
    // (transformStreamChunk), stream natively from the provider. Otherwise
    // buffer and convert (legacy path for adapters without streaming support).
    const clientWantsStream = body.stream === true;
    const adapterCanStream = !isNativeOpenAI && !!resolved.adapter.createStreamConverter;
    const upstreamStream = isNativeOpenAI
      ? clientWantsStream
      : clientWantsStream && adapterCanStream;

    // Only force non-streaming for adapters that lack transformStreamChunk
    if (!isNativeOpenAI && !adapterCanStream && providerBody.stream !== undefined) {
      providerBody = { ...providerBody, stream: false };
    }

    // Build URL and headers
    const url = resolved.adapter.buildUrl(resolved.baseUrl, cleanModelId, upstreamStream);
    const headers = resolved.adapter.buildHeaders(resolved.apiKey);
    Object.assign(headers, forwardHeaders);

    // ── Plugin: onBeforeForward ──────────────────────────────────────────
    if (pluginRegistry?.hasPlugins) {
      const fwdInput = await pluginRegistry.runBeforeForward({
        body: providerBody,
        headers,
        model: modelId,
        tier: scoringResult.tier,
        provider: resolved.providerName,
        url,
      });
      providerBody = fwdInput.body;
      Object.assign(headers, fwdInput.headers);
    }

    proxyLog(reqId, 'FORWARD_ATTEMPT', {
      attempt: i + 1,
      model: modelId,
      provider: resolved.providerName,
      format: resolved.adapter.format,
      isNativeOpenAI,
      clientWantsStream,
      upstreamStream,
      url,
    });

    // ── SSE heartbeat (prevents OpenClaw streaming timeout) ────────────
    // Same pattern as CLawRouter (proxy.ts:3809-3836): send 200 + SSE
    // headers immediately, then heartbeat comments every 2s while waiting
    // for the upstream response. Without this, OpenClaw kills the
    // connection after its idle timeout (~10-15s).
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
    let headersSentEarly = false;

    if (clientWantsStream && !upstreamStream) {
      // Non-OpenAI provider: we'll buffer the response and convert to SSE.
      // Send SSE headers + heartbeat NOW to keep the connection alive.
      // On fallback attempts, headers are already sent — skip writeHead
      // but resume heartbeat to keep the connection alive.
      if (!res.headersSent) {
        const routerHdrs: Record<string, string> = {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Router-Tier': scoringResult.tier,
          'X-Router-Model': modelId,
          'X-Router-Confidence': scoringResult.confidence.toFixed(3),
          'X-Router-Score': scoringResult.score.toFixed(4),
          'X-Router-Reason': scoringResult.reason,
        };
        if (profile) routerHdrs['X-Router-Profile'] = profile;
        res.writeHead(200, routerHdrs);
      }
      safeWrite(res, ': heartbeat\n\n');
      headersSentEarly = true;
      proxyLog(
        reqId,
        'HEARTBEAT_STARTED',
        `SSE heartbeat ${res.headersSent ? 'resumed' : 'started'} for non-OpenAI provider`
      );

      heartbeatInterval = setInterval(() => {
        if (!res.destroyed && res.writable) {
          safeWrite(res, ': heartbeat\n\n');
        } else {
          clearInterval(heartbeatInterval);
          heartbeatInterval = undefined;
        }
      }, 2000);
    }

    // Forward request
    try {
      const result = await forwardToProvider(
        providerBody,
        url,
        headers,
        upstreamStream,
        clientAbort.signal
      );

      proxyLog(reqId, 'FORWARD_RESPONSE', {
        status: result.status,
        isStream: result.isStream,
        bodyLen: result.body.length,
        elapsed: Date.now() - startMs,
        headersSent: res.headersSent,
        socketDestroyed: res.destroyed,
      });

      if (result.status < 400) {
        // Success — write response
        usedModel = modelId;
        responseStatus = result.status;
        if (i > 0) fallbackFrom = filteredChain[0];

        // For non-OpenAI providers with native streaming, pipe through
        // the adapter's chunk converter for real-time token delivery.
        if (!isNativeOpenAI && result.isStream && result.upstreamRes && adapterCanStream) {
          proxyLog(reqId, 'STREAM_CONVERT_START', {
            model: usedModel,
            provider: resolved.providerName,
          });

          // Send SSE headers if not already sent
          if (!res.headersSent) {
            const routerHdrs: Record<string, string> = {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'X-Router-Tier': scoringResult.tier,
              'X-Router-Model': usedModel,
              'X-Router-Confidence': scoringResult.confidence.toFixed(3),
              'X-Router-Score': scoringResult.score.toFixed(4),
              'X-Router-Reason': scoringResult.reason,
            };
            if (fallbackFrom) routerHdrs['X-Router-Fallback-From'] = fallbackFrom;
            if (profile) routerHdrs['X-Router-Profile'] = profile;
            res.writeHead(200, routerHdrs);
          }

          // Create stateful converter and parse upstream SSE events
          const upstream = result.upstreamRes;
          const converter = resolved.adapter.createStreamConverter!(cleanModelId);
          const streamUsageExtractor = new StreamUsageExtractor();
          let sseBuffer = '';

          upstream.on('data', (chunk: Buffer) => {
            // Normalize \r\n → \n (Google uses \r\n line endings, SSE spec allows both)
            sseBuffer += chunk.toString('utf-8').replace(/\r/g, '');
            // Process complete SSE events (delimited by \n\n)
            let boundary = sseBuffer.indexOf('\n\n');
            while (boundary >= 0) {
              const rawEvent = sseBuffer.slice(0, boundary);
              sseBuffer = sseBuffer.slice(boundary + 2);
              boundary = sseBuffer.indexOf('\n\n');

              // Extract data: lines from the SSE event
              const dataLines = rawEvent
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim());

              for (const data of dataLines) {
                streamUsageExtractor.processDataLine(data);
                if (!data || data === '[DONE]') continue;
                const converted = converter.processEvent(data);
                if (converted) {
                  safeWrite(res, converted);
                }
              }
            }
          });

          upstream.on('end', () => {
            // Flush any remaining state (e.g. unclosed tool calls)
            const remaining = converter.flush();
            for (const chunk of remaining) {
              safeWrite(res, chunk);
            }
            safeWrite(res, 'data: [DONE]\n\n');
            res.end();
            proxyLog(reqId, 'STREAM_CONVERT_DONE', `elapsed=${Date.now() - startMs}ms`);

            // Record authoritative cost from stream usage data
            const streamUsage = streamUsageExtractor.getUsage();
            if (streamUsage && costTracker) {
              costTracker.record({
                model: usedModel,
                inputTokens: streamUsage.input,
                outputTokens: streamUsage.output,
                cacheReadTokens: streamUsage.cacheRead,
                cacheWriteTokens: streamUsage.cacheWrite,
                source: costSource,
              });
              proxyLog(reqId, 'STREAM_COST_RECORDED', { ...streamUsage });
            }
          });

          upstream.on('error', (err: Error) => {
            proxyLog(reqId, 'STREAM_CONVERT_ERROR', err.message);
            const errPayload = JSON.stringify({
              error: { message: 'Upstream stream error: ' + err.message, type: 'stream_error' },
            });
            safeWrite(res, `data: ${errPayload}\n\n`);
            safeWrite(res, 'data: [DONE]\n\n');
            res.end();
          });

          res.on('close', () => {
            upstream.destroy();
          });

          // Complete dedup (can't cache streams)
          if (dedupKey) getDeduplicator(config).removeInflight(dedupKey);
          break;
        }

        // For non-OpenAI providers WITHOUT streaming support, buffer and convert
        if (!isNativeOpenAI && !result.isStream && result.body.length > 0) {
          try {
            const providerJson = JSON.parse(result.body.toString('utf-8'));
            // Log raw provider response for diagnostics (truncated)
            const rawPreview = result.body.toString('utf-8').slice(0, 500);
            proxyLog(reqId, 'PROVIDER_RAW_RESPONSE', rawPreview);
            const openaiJson = resolved.adapter.fromProviderResponse(
              providerJson,
              cleanModelId
            ) as Record<string, unknown>;

            // Extract usage before writing
            const usage = extractUsage(Buffer.from(JSON.stringify(openaiJson), 'utf-8'));
            responseInputTokens = usage.input;
            responseOutputTokens = usage.output;
            responseCacheReadTokens = usage.cacheRead;
            responseCacheWriteTokens = usage.cacheWrite;

            if (clientWantsStream) {
              // Stop heartbeat — real data is coming now
              if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = undefined;
              }

              proxyLog(reqId, 'WRITE_STREAMED_RESPONSE', {
                model: usedModel,
                headersSentEarly,
                canWrite: canWrite(res),
                socketDestroyed: res.destroyed,
              });

              // Client expects SSE — emit OpenAI streaming chunks.
              // Same pattern as CLawRouter (proxy.ts:4498-4640).
              // If headers were sent early (heartbeat), skip writing them again.
              writeStreamedResponse(
                res,
                openaiJson,
                scoringResult,
                usedModel,
                fallbackFrom,
                profile,
                headersSentEarly
              );

              proxyLog(reqId, 'STREAMED_RESPONSE_DONE', `elapsed=${Date.now() - startMs}ms`);

              // Complete dedup (can't cache streams)
              if (dedupKey) getDeduplicator(config).removeInflight(dedupKey);
              break;
            }

            result.body = Buffer.from(JSON.stringify(openaiJson), 'utf-8');
            result.headers['content-type'] = 'application/json';
            result.headers['content-length'] = String(result.body.length);
          } catch (convErr) {
            // If conversion fails, pass through raw (best-effort)
            proxyLog(
              reqId,
              'CONVERSION_ERROR',
              convErr instanceof Error ? convErr.message : 'unknown'
            );
          }
        }

        // Extract token usage from response (for stats/audit and cost estimation)
        if (!result.isStream) {
          const usage = extractUsage(result.body);
          responseInputTokens = usage.input;
          responseOutputTokens = usage.output;
          responseCacheReadTokens = usage.cacheRead;
          responseCacheWriteTokens = usage.cacheWrite;
        }

        proxyLog(reqId, 'WRITE_RESPONSE', {
          model: usedModel,
          isStream: result.isStream,
          canWrite: canWrite(res),
          socketDestroyed: res.destroyed,
        });

        writeResponse(
          res,
          result,
          scoringResult,
          usedModel,
          fallbackFrom,
          profile,
          result.isStream
            ? (streamUsage) => {
                if (streamUsage && costTracker) {
                  costTracker.record({
                    model: usedModel,
                    inputTokens: streamUsage.input,
                    outputTokens: streamUsage.output,
                    cacheReadTokens: streamUsage.cacheRead,
                    cacheWriteTokens: streamUsage.cacheWrite,
                    source: costSource,
                  });
                  proxyLog(reqId, 'STREAM_COST_RECORDED', { ...streamUsage });
                }
              }
            : undefined
        );

        proxyLog(reqId, 'RESPONSE_WRITTEN', `elapsed=${Date.now() - startMs}ms`);

        // Complete dedup
        if (dedupKey && !result.isStream) {
          getDeduplicator(config).complete(dedupKey, {
            status: result.status,
            headers: result.headers,
            body: result.body,
            completedAt: Date.now(),
          });
        } else if (dedupKey) {
          // For streaming, remove inflight (can't cache streams)
          getDeduplicator(config).removeInflight(dedupKey);
        }

        // ── Response cache: store (Phase 5) ──────────────────────────────
        if (responseCache && !result.isStream && responseCache.isCacheable(body, reqHeaders)) {
          const cacheKey = ResponseCache.generateKey(body);
          responseCache.set(cacheKey, result.status, result.headers, result.body, usedModel);
        }

        break;
      }

      // Error — record attempt and try next
      const errText = tryParseError(result.body);
      proxyLog(reqId, 'PROVIDER_ERROR', {
        model: modelId,
        provider: resolved.providerName,
        status: result.status,
        error: errText,
        willRetry: shouldTriggerFallback(result.status) && i < filteredChain.length - 1,
      });
      attempts.push({
        model: modelId,
        provider: resolved.providerName,
        status: result.status,
        error: errText,
      });

      if (!shouldTriggerFallback(result.status) || i === filteredChain.length - 1) {
        // Non-retriable error or last attempt — return error
        proxyLog(reqId, 'FINAL_ERROR', {
          status: result.status,
          headersSent: res.headersSent,
          canWrite: canWrite(res),
          elapsed: Date.now() - startMs,
        });
        writeErrorResponse(res, result);
        if (dedupKey) getDeduplicator(config).removeInflight(dedupKey);
        usedModel = modelId;
        responseStatus = result.status;
        break;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      proxyLog(reqId, 'FORWARD_EXCEPTION', {
        model: modelId,
        provider: resolved.providerName,
        error: errMsg,
        attempt: i + 1,
        lastAttempt: i === filteredChain.length - 1,
        headersSent: res.headersSent,
        elapsed: Date.now() - startMs,
      });
      attempts.push({
        model: modelId,
        provider: resolved.providerName,
        status: 502,
        error: errMsg,
      });

      if (i === filteredChain.length - 1) {
        // Last attempt — return 502
        const errorBody = JSON.stringify({
          error: { type: 'proxy_error', message: 'All models failed', attempts },
        });
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(errorBody);
        } else {
          // SSE path — send error as SSE event then close
          safeWrite(res, `data: ${errorBody}\n\n`);
          safeWrite(res, 'data: [DONE]\n\n');
          res.end();
        }
        if (dedupKey) getDeduplicator(config).removeInflight(dedupKey);
        usedModel = modelId;
        responseStatus = 502;
      }
    } finally {
      // Always clean up heartbeat for this attempt
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = undefined;
      }
    }
  }

  // ── Session: record + pin (Phase 4) ────────────────────────────────────
  if (momentumTracker && sessionId) {
    momentumTracker.record(sessionId, scoringResult.tier);
  }
  if (
    sessionStore &&
    sessionId &&
    !sessionPinned &&
    responseStatus < 400 &&
    config.session.enabled
  ) {
    sessionStore.pinModel(sessionId, usedModel, scoringResult.tier);
  }

  // ── Cost tracking ───────────────────────────────────────────────────
  // Non-streaming: tokens are authoritative (from provider response body via
  // extractUsage) — record to CostTracker now.
  // Streaming: authoritative tokens arrive asynchronously via StreamUsageExtractor
  // in the stream end handler — already recorded there (see onStreamUsage callback
  // in writeResponse and the converted-streaming end handler above).
  // The estimateCost() call is read-only and provides a value for the audit log.
  if (
    costTracker &&
    responseStatus < 400 &&
    (responseInputTokens > 0 || responseOutputTokens > 0)
  ) {
    costTracker.record({
      model: usedModel,
      inputTokens: responseInputTokens,
      outputTokens: responseOutputTokens,
      cacheReadTokens: responseCacheReadTokens,
      cacheWriteTokens: responseCacheWriteTokens,
      source: costSource,
    });
  }
  const costEstimateUsd = costTracker
    ? costTracker.estimateCost(
        usedModel,
        responseInputTokens || estimatedTokens,
        responseOutputTokens,
        responseCacheReadTokens,
        responseCacheWriteTokens
      )
    : 0;

  // Mark request as completed (prevents client disconnect handler from
  // redundantly cleaning up dedup entries).
  clearTimeout(globalTimeoutId);
  requestCompleted = true;

  proxyLog(reqId, 'REQUEST_COMPLETE', {
    status: responseStatus,
    model: usedModel,
    tier: scoringResult.tier,
    fallbackFrom,
    attempts: attempts.length,
    elapsed: Date.now() - startMs,
  });

  // ── Update stats ────────────────────────────────────────────────────────
  stats.total++;
  stats.byTier[scoringResult.tier]++;

  // ── Build routing decision for audit log ────────────────────────────────
  const latencyMs = Date.now() - startMs;
  const decision: RoutingDecision = {
    tier: scoringResult.tier,
    model: usedModel,
    confidence: scoringResult.confidence,
    score: scoringResult.score,
    reason: scoringResult.reason,
    dimensions: scoringResult.dimensions,
    latencyMs,
    fallbackFrom,
    fallbackAttempts: attempts.length > 0 ? attempts : undefined,
    costEstimateUsd,
  };

  if (onRouteCallback) {
    try {
      onRouteCallback(decision);
    } catch {
      /* ignore */
    }
  }

  // ── Plugin: onAfterForward (fire-and-forget) ──────────────────────────
  if (pluginRegistry?.hasPlugins) {
    const afterEvent: AfterForwardEvent = {
      tier: scoringResult.tier,
      model: usedModel,
      provider: resolveProvider(
        usedModel,
        config.providers,
        discoveredModelsCache,
        config.targetBaseUrl,
        config.targetApiKey
      ).providerName,
      status: responseStatus,
      latencyMs,
      inputTokens: responseInputTokens || estimatedTokens,
      outputTokens: responseOutputTokens,
      costEstimateUsd,
      cached: wasCached,
      fallback: !!fallbackFrom,
      sessionId,
    };
    pluginRegistry.fireAfterForward(afterEvent);
  }
}

// ---------------------------------------------------------------------------
// Forward request to a specific provider
// ---------------------------------------------------------------------------

interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  isStream: boolean;
  /** For streaming responses, the upstream IncomingMessage to pipe from. */
  upstreamRes?: IncomingMessage;
}

function forwardToProvider(
  body: Record<string, unknown>,
  url: string,
  headers: Record<string, string>,
  isStream: boolean,
  abortSignal?: AbortSignal
): Promise<ProviderResponse> {
  return new Promise((resolve, reject) => {
    // Early-out if already aborted (client disconnected or global timeout)
    if (abortSignal?.aborted) {
      reject(new Error('Request aborted'));
      return;
    }

    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    headers['Content-Length'] = String(Buffer.byteLength(payload));

    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
      timeout: 60000, // 60s per model attempt
    };

    const req = transport.request(options, (upstream) => {
      const responseHeaders: Record<string, string> = {};
      for (const [key, val] of Object.entries(upstream.headers)) {
        if (val) responseHeaders[key] = Array.isArray(val) ? val.join(', ') : val;
      }

      if (isStream && upstream.statusCode && upstream.statusCode < 400) {
        // For successful streams, return immediately with empty body
        // The caller will pipe the response via result.upstreamRes
        resolve({
          status: upstream.statusCode || 200,
          headers: responseHeaders,
          body: Buffer.alloc(0),
          isStream: true,
          upstreamRes: upstream,
        });
      } else {
        // Buffer the response
        const chunks: Buffer[] = [];
        upstream.on('data', (chunk: Buffer) => chunks.push(chunk));
        upstream.on('end', () => {
          resolve({
            status: upstream.statusCode || 200,
            headers: responseHeaders,
            body: Buffer.concat(chunks),
            isStream: false,
          });
        });
      }
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    // Abort when client disconnects or global timeout fires
    if (abortSignal) {
      const onAbort = () => {
        req.destroy();
        reject(new Error('Request aborted'));
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
      // Clean up listener when request completes normally
      req.on('close', () => abortSignal.removeEventListener('abort', onAbort));
    }

    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Response writing helpers
// ---------------------------------------------------------------------------

function writeResponse(
  res: ServerResponse,
  result: ProviderResponse,
  scoringResult: { tier: string; confidence: number; score: number; reason: string },
  model: string,
  fallbackFrom?: string,
  profile?: string,
  onStreamUsage?: (usage: ExtractedUsage | null) => void
): void {
  // Set routing metadata headers
  const routerHeaders: Record<string, string> = {
    'X-Router-Tier': scoringResult.tier,
    'X-Router-Model': model,
    'X-Router-Confidence': scoringResult.confidence.toFixed(3),
    'X-Router-Score': scoringResult.score.toFixed(4),
    'X-Router-Reason': scoringResult.reason,
  };
  if (fallbackFrom) {
    routerHeaders['X-Router-Fallback-From'] = fallbackFrom;
  }
  if (profile) {
    routerHeaders['X-Router-Profile'] = profile;
  }

  if (result.isStream && result.upstreamRes) {
    // For streams, forward upstream data to the client with error handling.
    // Unlike bare .pipe(), this ensures res is properly ended on upstream errors
    // and prevents truncated responses without [DONE].
    res.writeHead(result.status, {
      ...result.headers,
      ...routerHeaders,
    });
    const upstream = result.upstreamRes;
    const usageExtractor = onStreamUsage ? new StreamUsageExtractor() : null;

    upstream.on('data', (chunk: Buffer) => {
      safeWrite(res, chunk);
      usageExtractor?.processChunk(chunk);
    });

    upstream.on('end', () => {
      res.end();
      onStreamUsage?.(usageExtractor?.getUsage() ?? null);
    });

    upstream.on('error', (err: Error) => {
      // Upstream died mid-stream — send error as SSE event and close
      const errPayload = JSON.stringify({
        error: { message: 'Upstream connection error: ' + err.message, type: 'stream_error' },
      });
      safeWrite(res, `data: ${errPayload}\n\n`);
      safeWrite(res, 'data: [DONE]\n\n');
      res.end();
      onStreamUsage?.(usageExtractor?.getUsage() ?? null);
    });

    // Clean up upstream if client disconnects
    res.on('close', () => {
      upstream.destroy();
    });
  } else if (!result.isStream) {
    res.writeHead(result.status, {
      ...result.headers,
      ...routerHeaders,
    });
    res.end(result.body);
  }
}

/**
 * Convert a buffered OpenAI JSON response into SSE streaming chunks.
 * Matches CLawRouter's exact format (proxy.ts:4498-4640):
 *   Chunk 1: role delta
 *   Chunk 2: content delta
 *   Chunk 2b: tool_calls delta (if present)
 *   Chunk 3: finish_reason
 *   data: [DONE]
 */
function writeStreamedResponse(
  res: ServerResponse,
  openaiJson: Record<string, unknown>,
  scoringResult: { tier: string; confidence: number; score: number; reason: string },
  model: string,
  fallbackFrom?: string,
  profile?: string,
  headersAlreadySent?: boolean
): void {
  if (!headersAlreadySent) {
    const routerHeaders: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Router-Tier': scoringResult.tier,
      'X-Router-Model': model,
      'X-Router-Confidence': scoringResult.confidence.toFixed(3),
      'X-Router-Score': scoringResult.score.toFixed(4),
      'X-Router-Reason': scoringResult.reason,
    };
    if (fallbackFrom) routerHeaders['X-Router-Fallback-From'] = fallbackFrom;
    if (profile) routerHeaders['X-Router-Profile'] = profile;

    res.writeHead(200, routerHeaders);
  }

  const baseChunk = {
    id: openaiJson.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: openaiJson.created || Math.floor(Date.now() / 1000),
    model: model,
    system_fingerprint: null,
  };

  const choices = openaiJson.choices as Array<Record<string, unknown>> | undefined;
  if (choices && Array.isArray(choices)) {
    for (const choice of choices) {
      const msg = choice.message as Record<string, unknown> | undefined;
      const content = (msg?.content as string) || '';
      const role = (msg?.role as string) || 'assistant';
      const index = (choice.index as number) || 0;
      const toolCalls = msg?.tool_calls as Array<unknown> | undefined;

      // Chunk 1: role
      safeWrite(
        res,
        `data: ${JSON.stringify({
          ...baseChunk,
          choices: [{ index, delta: { role }, logprobs: null, finish_reason: null }],
        })}\n\n`
      );

      // Chunk 2: content
      if (content) {
        safeWrite(
          res,
          `data: ${JSON.stringify({
            ...baseChunk,
            choices: [{ index, delta: { content }, logprobs: null, finish_reason: null }],
          })}\n\n`
        );
      }

      // Chunk 2b: tool_calls
      if (toolCalls && toolCalls.length > 0) {
        safeWrite(
          res,
          `data: ${JSON.stringify({
            ...baseChunk,
            choices: [
              { index, delta: { tool_calls: toolCalls }, logprobs: null, finish_reason: null },
            ],
          })}\n\n`
        );
      }

      // Chunk 3: finish_reason
      const finishReason =
        toolCalls && toolCalls.length > 0
          ? 'tool_calls'
          : (choice.finish_reason as string) || 'stop';
      safeWrite(
        res,
        `data: ${JSON.stringify({
          ...baseChunk,
          choices: [{ index, delta: {}, logprobs: null, finish_reason: finishReason }],
        })}\n\n`
      );
    }
  }

  // Usage chunk (OpenAI includes usage in final streaming chunk)
  if (openaiJson.usage) {
    safeWrite(
      res,
      `data: ${JSON.stringify({
        ...baseChunk,
        choices: [],
        usage: openaiJson.usage,
      })}\n\n`
    );
  }

  safeWrite(res, 'data: [DONE]\n\n');
  res.end();
}

function writeErrorResponse(res: ServerResponse, result: ProviderResponse): void {
  if (!res.headersSent) {
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  } else {
    // Headers already sent (SSE heartbeat path) — send error as SSE event
    // so the client sees a meaningful error instead of hanging forever.
    // Matches CLawRouter pattern (proxy.ts:4370-4396).
    let errPayload: string;
    try {
      const parsed = JSON.parse(result.body.toString('utf-8'));
      errPayload = parsed?.error
        ? JSON.stringify(parsed)
        : JSON.stringify({
            error: {
              message: result.body.toString('utf-8').slice(0, 500),
              type: 'provider_error',
              status: result.status,
            },
          });
    } catch {
      errPayload = JSON.stringify({
        error: {
          message: result.body.toString('utf-8').slice(0, 500),
          type: 'provider_error',
          status: result.status,
        },
      });
    }
    safeWrite(res, `data: ${errPayload}\n\n`);
    safeWrite(res, 'data: [DONE]\n\n');
    res.end();
  }
}

/**
 * Check if response socket is writable (prevents write-after-close errors).
 * Matches CLawRouter pattern (proxy.ts:514-522).
 */
function canWrite(res: ServerResponse): boolean {
  return (
    !res.writableEnded &&
    !res.destroyed &&
    res.socket !== null &&
    !res.socket.destroyed &&
    res.socket.writable
  );
}

/**
 * Safe write with socket-closed protection.
 * Returns true if write succeeded, false if socket is closed.
 * Matches CLawRouter pattern (proxy.ts:528-535).
 */
function safeWrite(res: ServerResponse, data: string | Buffer): boolean {
  if (!canWrite(res)) return false;
  return res.write(data);
}

function serveCachedResponse(res: ServerResponse, cached: CachedResponse): void {
  res.writeHead(cached.status, {
    ...cached.headers,
    'X-Router-Cache': 'dedup',
  });
  res.end(cached.body);
}

function serveCachedResponseEntry(res: ServerResponse, entry: CachedResponseEntry): void {
  res.writeHead(entry.status, {
    ...entry.headers,
    'X-Router-Cache': 'response',
    'X-Router-Cache-Model': entry.model,
  });
  res.end(entry.body);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectBody(
  req: IncomingMessage,
  cb: (err: Error | null, body: string | null) => void
): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    try {
      cb(null, Buffer.concat(chunks).toString('utf-8'));
    } catch (err) {
      cb(err as Error, null);
    }
  });
  req.on('error', (err) => cb(err, null));
}

function copySelectHeaders(req: IncomingMessage, target: Record<string, string>): void {
  const forwardHeaders = ['anthropic-version', 'anthropic-beta', 'x-api-key'];
  for (const h of forwardHeaders) {
    if (req.headers[h]) {
      target[h] = req.headers[h] as string;
    }
  }
}

function getLastUserMessage(body: Record<string, unknown>): string | null {
  const messages = body.messages;
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const content = messages[i].content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            return block.text;
          }
        }
      }
    }
  }
  return null;
}

function tryParseError(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString('utf-8'));
    return parsed?.error?.message || parsed?.error?.type || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract session ID from request headers, falling back to deriving one from
 * the first user message content (same approach as ClawRouter — session.ts:288).
 *
 * OpenClaw's openai-completions transport does NOT forward session headers, so
 * the header path almost never fires.  The content-derived ID is stable across
 * turns within the same conversation as long as the first user message stays
 * the same.
 *
 * Context-Editing interaction (intentional re-anchor): when CE compacts a
 * session it rewrites the JSONL so the original first user message is no
 * longer at index 0 of the prompt sent here. The next request therefore
 * derives a new session ID, and all session-keyed routing state — pinned
 * tier, momentum history, three-strike state, provider-cache locality —
 * effectively resets. This is by design: compaction is treated as a context
 * phase boundary, and pre-compaction routing signals are not necessarily
 * appropriate after the conversation's character has materially changed.
 * The matching surface signal for operators is the "Compaction completed
 * successfully" log emitted by ContextEditingMiddleware (carrying
 * `routingSessionWillReanchor: true`) — correlate timestamps if a pinned
 * model appears to flip mid-conversation.
 */
function extractSessionId(req: IncomingMessage, body?: Record<string, unknown>): string | null {
  // 1. Explicit header (ideal but rarely present from OpenClaw)
  const fromHeader = (req.headers['x-session-id'] as string) || null;
  if (fromHeader) return fromHeader;

  // 2. Derive from first user message content (ClawRouter pattern)
  if (body) {
    const derived = deriveSessionIdFromMessages(body);
    if (derived) return derived;
  }

  // 3. x-request-id is per-turn (NOT stable across turns) — last resort
  return (req.headers['x-request-id'] as string) || null;
}

/**
 * Derive a stable session ID from the first user message in the conversation.
 * Uses SHA-256 prefix (8 hex chars) — same as ClawRouter's deriveSessionId().
 */
function deriveSessionIdFromMessages(body: Record<string, unknown>): string | null {
  const messages = body.messages;
  if (!Array.isArray(messages)) return null;

  // Find first user message
  const firstUser = messages.find((m: { role?: string }) => m.role === 'user') as
    | { role: string; content: unknown }
    | undefined;
  if (!firstUser) return null;

  const content =
    typeof firstUser.content === 'string' ? firstUser.content : JSON.stringify(firstUser.content);

  if (!content) return null;

  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

/**
 * Determine the routing profile from request headers or config default.
 */
/** Provider prefix that OpenClaw prepends to model IDs. */
const PROVIDER_PREFIX = 'sai-router/';
/** Legacy prefix kept for backwards compatibility. */
const LEGACY_PROVIDER_PREFIX = 'sapience-router/';

/** Meta-model IDs that trigger smart routing (matched after prefix stripping). */
const ROUTING_META_MODELS = new Set(['eco', 'premium', 'agentic']);

/**
 * Strip the "sai-router/" (or legacy "sapience-router/") prefix from a model ID if present.
 * OpenClaw prepends the provider ID to model names automatically.
 */
function stripProviderPrefix(model: string): string {
  if (model.startsWith(PROVIDER_PREFIX)) {
    return model.slice(PROVIDER_PREFIX.length);
  }
  if (model.startsWith(LEGACY_PROVIDER_PREFIX)) {
    return model.slice(LEGACY_PROVIDER_PREFIX.length);
  }
  return model;
}

/**
 * Check if a model ID (after prefix stripping) is a meta-routing model.
 */
function isRoutingMetaModel(model: string): boolean {
  return ROUTING_META_MODELS.has(stripProviderPrefix(model));
}

/**
 * Resolve the routing profile from (in order):
 *  1. The request model field (auto/eco/premium/agentic meta-models)
 *  2. X-Router-Profile header
 *  3. Config default
 */
function resolveProfile(
  req: IncomingMessage,
  config: ModelRoutingConfig,
  requestModel?: string
): RoutingProfile {
  // Meta-model overrides profile (e.g. model="sai-router/eco" → eco profile)
  if (requestModel) {
    const stripped = stripProviderPrefix(requestModel);
    if (isValidProfile(stripped)) {
      return stripped;
    }
    // Unknown / legacy meta-model (e.g. "sai-router/auto" from older clients)
    // falls through to header-then-default-profile resolution below.
  }

  const headerProfile = req.headers['x-router-profile'] as string | undefined;
  if (headerProfile && isValidProfile(headerProfile)) {
    return headerProfile;
  }
  // Absolute fallback: programmatic consumers can set `defaultProfile` to
  // override which profile unmatched requests route through; otherwise eco
  // (cheapest) is the safest default.
  const fallback: string = config.defaultProfile;
  return isValidProfile(fallback) ? (fallback as RoutingProfile) : 'eco';
}

/**
 * Extract request headers as a flat object.
 */
function extractHeaders(req: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (val) result[key] = Array.isArray(val) ? val.join(', ') : val;
  }
  return result;
}

/**
 * Hash the meaningful content of a request for three-strike detection.
 */
function hashRequestContent(body: Record<string, unknown>): string {
  const messages = body.messages;
  const content = Array.isArray(messages) ? JSON.stringify(messages.slice(-2)) : '';
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Full usage data extracted from a provider response.
 */
interface ExtractedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Extract token usage from a buffered response body.
 *
 * Handles multiple provider response formats:
 *  - OpenAI: prompt_tokens, completion_tokens
 *  - Anthropic: input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
 */
function extractUsage(body: Buffer): ExtractedUsage {
  try {
    const parsed = JSON.parse(body.toString('utf-8'));
    const usage = parsed?.usage;
    if (usage) {
      // Extract cache tokens (all provider formats)
      const cacheRead =
        usage.cache_read_input_tokens || // Anthropic / Google (via adapter)
        usage.prompt_tokens_details?.cached_tokens || // OpenAI
        usage.cacheRead || // OpenClaw normalized
        0;
      const cacheWrite =
        usage.cache_creation_input_tokens || // Anthropic
        usage.cacheWrite || // OpenClaw normalized
        0;

      return {
        input: usage.prompt_tokens || usage.input_tokens || 0,
        output: usage.completion_tokens || usage.output_tokens || 0,
        cacheRead,
        cacheWrite,
      };
    }
  } catch {
    /* ignore */
  }
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * Accumulates token usage from SSE stream chunks.
 *
 * OpenClaw sends `stream_options: { include_usage: true }`, so providers
 * include authoritative token counts in the final SSE event.  This class
 * extracts those counts from either raw SSE bytes (native OpenAI pipe-through)
 * or pre-parsed data lines (converted streaming path).
 *
 * Handles OpenAI, Anthropic and OpenClaw-normalised formats.
 */
class StreamUsageExtractor {
  private usage: ExtractedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private found = false;
  private sseBuffer = '';

  /**
   * Feed raw SSE bytes (for native OpenAI streaming where chunks are
   * piped through without parsing).  Buffers until complete SSE events
   * are available, then extracts data lines.
   */
  processChunk(chunk: Buffer | string): void {
    this.sseBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    let boundary = this.sseBuffer.indexOf('\n\n');
    while (boundary >= 0) {
      const rawEvent = this.sseBuffer.slice(0, boundary);
      this.sseBuffer = this.sseBuffer.slice(boundary + 2);
      boundary = this.sseBuffer.indexOf('\n\n');

      const dataLines = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());

      for (const data of dataLines) {
        this.processDataLine(data);
      }
    }
  }

  /**
   * Feed a single pre-parsed SSE data payload (the JSON string after
   * "data: ").  Used by the converted-streaming path which already
   * splits SSE events.
   */
  processDataLine(data: string): void {
    if (!data || data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data);

      // OpenAI format — final chunk: { usage: { prompt_tokens, completion_tokens, ... } }
      if (parsed.usage) {
        const u = parsed.usage;
        if (u.prompt_tokens || u.input_tokens) {
          this.usage.input = u.prompt_tokens || u.input_tokens;
          this.found = true;
        }
        if (u.completion_tokens || u.output_tokens) {
          this.usage.output = u.completion_tokens || u.output_tokens;
          this.found = true;
        }
        const cr = u.cache_read_input_tokens || u.prompt_tokens_details?.cached_tokens || 0;
        if (cr) {
          this.usage.cacheRead = cr;
          this.found = true;
        }
        if (u.cache_creation_input_tokens) {
          this.usage.cacheWrite = u.cache_creation_input_tokens;
          this.found = true;
        }
      }

      // Anthropic message_start: { type: "message_start", message: { usage: { input_tokens } } }
      if (parsed.type === 'message_start' && parsed.message?.usage) {
        const u = parsed.message.usage;
        if (u.input_tokens) {
          this.usage.input = u.input_tokens;
          this.found = true;
        }
        if (u.cache_read_input_tokens) {
          this.usage.cacheRead = u.cache_read_input_tokens;
          this.found = true;
        }
        if (u.cache_creation_input_tokens) {
          this.usage.cacheWrite = u.cache_creation_input_tokens;
          this.found = true;
        }
      }

      // Anthropic message_delta: { type: "message_delta", usage: { output_tokens } }
      if (parsed.type === 'message_delta' && parsed.usage?.output_tokens) {
        this.usage.output = parsed.usage.output_tokens;
        this.found = true;
      }
    } catch {
      /* partial JSON or non-JSON line — safe to ignore */
    }
  }

  /** Return accumulated usage, or null if no usage data was found. */
  getUsage(): ExtractedUsage | null {
    return this.found ? { ...this.usage } : null;
  }
}
