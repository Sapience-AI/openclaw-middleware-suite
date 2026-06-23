/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

import {
  Middleware,
  MiddlewareContext,
  MiddlewareResult,
  LimitPolicy,
  LimitRule,
  LimitState,
  EnforcementStatus,
  DEFAULT_LIMIT_POLICY,
} from './types.js';
import { logger } from '../../shared/Logger.js';
import { TrackerStore } from './storage/TrackerStore.js';
import { LimitPolicyStore } from './storage/LimitPolicyStore.js';

const TOOL_CALL_LIMIT_VERSION = '1.0.0';

/**
 * Tool Call Limit Middleware
 * Tracks and enforces budgets per session and request to prevent runaway agents.
 *
 * Configuration model (mirrors `ModelRoutingMiddleware`):
 *   defaults < initialize-inline < disk overlay < updateConfig() patches
 *
 * The hot path reads `this.policy` instead of `LimitPolicyStore.getCached()`,
 * so programmatic consumers can supply inline config at `initialize()`,
 * patch in-process via `updateConfig(partial)`, or go disk-backed via
 * `LimitPolicyStore.update()` + `reloadConfig()`. Plugin behavior is
 * unchanged because the plugin passes `{}` and disk overlay is the only
 * non-default source — equivalent to the previous `getCached()` result.
 */
export class ToolCallLimitMiddleware implements Middleware {
  readonly name = 'tool-call-limit';
  readonly version = TOOL_CALL_LIMIT_VERSION;

  private static readonly DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

  private trackers: Map<string, Map<string, LimitState>> = new Map();
  private requestTrackers: Map<string, Map<string, LimitState>> = new Map();

  private lastActivity: Map<string, number> = new Map();
  private virtualIds: Map<string, string> = new Map();

  private initialized = false;
  private mutex: Promise<any> = Promise.resolve();

  /**
   * In-memory current policy. Source of truth for the hot path.
   * `null` until `initialize()` runs — `beforeToolCall` falls back to
   * `LimitPolicyStore.getCached()` if invoked pre-init.
   */
  private policy: LimitPolicy | null = null;

  /**
   * Tracks the last observed `resetAt` from the policy. When it changes,
   * the CLI has issued `sai limits reset` and we must clear in-memory
   * tracker Maps so the freshly-wiped on-disk state isn't overwritten on
   * the next tool call.
   */
  private lastSeenResetAt: string | null = null;

  /**
   * Clears in-memory tracker state based on the scope of the reset.
   * Also flushes the (now-empty) state to disk so persisted trackers match.
   */
  private async applyReset(scope: 'all' | 'session' | 'request' | undefined): Promise<void> {
    const effectiveScope = scope || 'all';
    if (effectiveScope === 'all' || effectiveScope === 'session') {
      this.trackers.clear();
      this.lastActivity.clear();
      this.virtualIds.clear();
    }
    if (effectiveScope === 'all' || effectiveScope === 'request') {
      this.requestTrackers.clear();
    }
    try {
      await TrackerStore.save(this.trackers, this.requestTrackers);
    } catch (err) {
      logger.error('Failed to persist empty tracker state after reset', { error: err });
    }
    logger.info(`Tool call limit trackers cleared in-memory (scope=${effectiveScope})`);
  }

  /**
   * Build the merged policy from defaults + base + inline + disk overlay.
   * Precedence: `DEFAULT_LIMIT_POLICY < base < inline < disk-overlay`.
   *
   * The "disk overlay" is the raw `tool_call_limit` sub-tree from
   * `sapience-ai-suite.json` (via `LimitPolicyStore.loadOverlay()`) — empty
   * `{}` when the file is absent or the key is unset, so a hermetic embedded
   * consumer's inline config applies fully. A consumer running alongside the
   * plugin gets `defaults < inline < disk` (disk shadows inline — escape
   * hatch: `updateConfig()`).
   */
  private buildPolicy(
    inline: Partial<LimitPolicy>,
    base: Partial<LimitPolicy> = DEFAULT_LIMIT_POLICY
  ): LimitPolicy {
    const disk = LimitPolicyStore.loadOverlay();
    return {
      ...DEFAULT_LIMIT_POLICY,
      ...base,
      ...inline,
      ...disk,
    } as LimitPolicy;
  }

  /**
   * Initialize the middleware. Loads persisted tracker state and builds the
   * merged policy from `defaults < inline < disk`. Pass `{}` (or omit) to
   * fall back to disk + defaults — the path the OpenClaw plugin runtime uses.
   */
  public async initialize(config: Record<string, unknown> = {}): Promise<void> {
    // Build policy first so beforeToolCall reads from this.policy, not the
    // static cache. Idempotent on repeated calls — re-merges the inline
    // config with the latest disk overlay each time.
    this.policy = this.buildPolicy(config as Partial<LimitPolicy>);

    if (this.initialized) return;
    this.initialized = true;
    try {
      const state = await TrackerStore.load();
      if (state && state.sessions) {
        this.trackers = new Map(
          Object.entries(state.sessions).map(([k, v]) => [k, new Map(Object.entries(v))])
        );
      }
      if (state && state.requests) {
        this.requestTrackers = new Map(
          Object.entries(state.requests).map(([k, v]) => [k, new Map(Object.entries(v))])
        );
      }
    } catch (err) {
      logger.error('Failed to load tracker state', { error: err });
    }
  }

  /**
   * In-process patch — bypasses disk. Shallow-merges `partial` into the
   * current in-memory policy. Sibling fields are preserved.
   *
   *   limits.updateConfig({ globalSessionCallLimit: 50 });
   *
   * For disk-backed updates that survive process restarts, use
   * `LimitPolicyStore.update()` + `reloadConfig()` instead.
   *
   * Throws if called before `initialize()`.
   */
  public updateConfig(partial: Partial<LimitPolicy>): void {
    if (!this.policy) {
      throw new Error('ToolCallLimitMiddleware.updateConfig: call initialize() first');
    }
    this.policy = { ...this.policy, ...partial } as LimitPolicy;
    logger.debug('[ToolCallLimit] In-process config updated', {
      keys: Object.keys(partial),
    });
  }

  /**
   * Re-read the policy from disk and re-merge over the current in-memory
   * policy (`updateConfig()` patches survive for fields the disk doesn't
   * set; disk-set fields shadow them). Called by the plugin's
   * `ConfigStore.onChange('tool_call_limit', …)` watcher and by programmatic
   * consumers after `LimitPolicyStore.save()` / `update()`.
   */
  public reloadConfig(): void {
    const base = this.policy ?? DEFAULT_LIMIT_POLICY;
    this.policy = this.buildPolicy({}, base);
    logger.debug('[ToolCallLimit] Policy hot-reloaded');
  }

  /**
   * Resolve the active policy for hot-path reads. Falls back to the static
   * cache when `initialize()` hasn't run yet — keeps the legacy zero-init
   * path working for direct consumers of the class.
   */
  private resolvePolicy(): LimitPolicy {
    return this.policy ?? LimitPolicyStore.getCached();
  }

  /**
   * Main interception hook for budget enforcement.
   */
  public async beforeToolCall(context: MiddlewareContext): Promise<MiddlewareResult> {
    const { moduleName, methodName, sessionKey, metadata } = context;
    const meta = metadata ?? {};

    // 1. Resolve the active policy and find relevant rule. Reads from
    // this.policy (set by initialize / updateConfig / reloadConfig); falls
    // back to LimitPolicyStore.getCached() when initialize() hasn't run.
    const policy = this.resolvePolicy();
    const rule = LimitPolicyStore.lookupRule(moduleName, methodName, policy);
    const thresholds = {
      globalSessionCallLimit: policy.globalSessionCallLimit,
      globalRequestCallLimit: policy.globalRequestCallLimit,
    };

    const effectiveSessionKey = sessionKey || (meta.sessionKey as string);
    const requestId =
      (meta.requestId as string) || this.resolveRequestId(effectiveSessionKey || 'default');

    // 2. Increment and check counts
    const status = await this.incrementAndCheck(
      effectiveSessionKey,
      moduleName,
      methodName,
      rule,
      thresholds,
      undefined,
      requestId
    );

    if (status === 'HARD_LIMIT') {
      return {
        block: true,
        reason: `⚠️ SECURITY ALERT: Hard limit reached for ${moduleName}.${methodName}`,
        metadata: {
          limitReached: true,
          scope: rule?.requestCallLimit ? 'REQUEST' : 'SESSION',
        },
      };
    }

    if (status === 'SOFT_LIMIT') {
      return {
        block: false,
        metadata: {
          softLimitTriggered: true,
          scope: rule?.requestCallLimit ? 'REQUEST' : 'SESSION',
        },
      };
    }

    return { block: false };
  }

  /**
   * Internal logic for incrementing and checking budgets.
   */
  public async incrementAndCheck(
    sessionKey: string | undefined,
    moduleName: string,
    methodName: string,
    rule: LimitRule | undefined,
    thresholds?: { globalSessionCallLimit?: number; globalRequestCallLimit?: number },
    agentId?: string,
    requestId?: string
  ): Promise<EnforcementStatus> {
    return (this.mutex = this.mutex.then(async () => {
      await this.initialize();

      // Detect `sai limits reset` — the CLI bumps `resetAt` on the policy.
      // When it changes vs. what we've seen, wipe in-memory trackers so
      // the stale in-memory state doesn't resurrect deleted on-disk files.
      //
      // Reads from the static cache (not `this.policy`) on purpose — the
      // CLI reset is an out-of-band signal that must always reflect current
      // disk state. `LimitPolicyStore.getCached()` has its own mtime-based
      // auto-refresh, which is stronger than relying on the watcher having
      // already fired `reloadConfig()` here.
      try {
        const currentPolicy = LimitPolicyStore.getCached();
        const currentResetAt = currentPolicy.resetAt || null;
        if (currentResetAt && currentResetAt !== this.lastSeenResetAt) {
          // Skip the very first observation after boot (initialize already
          // loaded whatever was on disk; the user hasn't asked for a reset).
          if (this.lastSeenResetAt !== null) {
            await this.applyReset(currentPolicy.resetScope);
          }
          this.lastSeenResetAt = currentResetAt;
        } else if (!this.lastSeenResetAt && currentResetAt) {
          this.lastSeenResetAt = currentResetAt;
        }
      } catch (err) {
        logger.error('Failed to check reset marker', { error: err });
      }

      const effectiveSessionKey = sessionKey || (agentId ? `agent:${agentId}` : 'LOCAL_SESSION');
      const sessionTrackers = this.getOrCreateTrackers(this.trackers, effectiveSessionKey);
      const toolKey = `${moduleName}.${methodName}`;

      let effectiveStatus: EnforcementStatus = 'OK';

      const updateStatus = (newStatus: EnforcementStatus) => {
        if (newStatus === 'HARD_LIMIT') effectiveStatus = 'HARD_LIMIT';
        else if (newStatus === 'SOFT_LIMIT' && effectiveStatus === 'OK')
          effectiveStatus = 'SOFT_LIMIT';
      };

      // Check Global Session Limit
      const globalSessionLimit = thresholds?.globalSessionCallLimit;
      if (globalSessionLimit && globalSessionLimit > 0) {
        updateStatus(
          this.enforceLimit(
            effectiveSessionKey,
            sessionTrackers,
            'GLOBAL',
            globalSessionLimit,
            ToolCallLimitMiddleware.DEFAULT_WINDOW_MS
          )
        );
      }

      // Check Tool-Specific Session Limit
      if (rule?.sessionCallLimit && rule.sessionCallLimit.max > 0) {
        updateStatus(
          this.enforceLimit(
            effectiveSessionKey,
            sessionTrackers,
            toolKey,
            rule.sessionCallLimit.max,
            ToolCallLimitMiddleware.DEFAULT_WINDOW_MS
          )
        );
      }

      // Check Request Budgets
      if (requestId) {
        await TrackerStore.saveLastRequestId(requestId);
        const reqTrackers = this.getOrCreateTrackers(this.requestTrackers, requestId);

        const globalReqLimit = thresholds?.globalRequestCallLimit;
        if (globalReqLimit && globalReqLimit > 0) {
          updateStatus(
            this.enforceLimit(`request:${requestId}`, reqTrackers, 'GLOBAL', globalReqLimit)
          );
        }

        if (rule?.requestCallLimit && rule.requestCallLimit.max > 0) {
          updateStatus(
            this.enforceLimit(
              `request:${requestId}`,
              reqTrackers,
              toolKey,
              rule.requestCallLimit.max
            )
          );
        }
      }

      await TrackerStore.save(this.trackers, this.requestTrackers);
      return effectiveStatus;
    }));
  }

  private enforceLimit(
    identifier: string,
    trackers: Map<string, LimitState>,
    key: string,
    max: number,
    windowMs?: number
  ): EnforcementStatus {
    const now = Date.now();
    let state = trackers.get(key);

    if (!state || (state.expiresAt && now > state.expiresAt)) {
      state = {
        count: 0,
        warnedSoftLimit: false,
        expiresAt: windowMs ? now + windowMs : undefined,
      };
      trackers.set(key, state);
    }

    state.count++;

    const isRequest = identifier.startsWith('request:');
    const scope = isRequest ? 'REQUEST' : 'SESSION';
    const resource = key === 'GLOBAL' ? 'Global Budget' : `${key} tool`;

    if (state.count >= max) {
      logger.error(
        `[${scope}] HARD_LIMIT triggered for ${identifier} on ${resource} (${state.count}/${max})`
      );
      return 'HARD_LIMIT';
    }

    const softLimit = max <= 10 ? Math.max(1, max - 2) : Math.max(1, Math.floor(max * 0.9));
    if (state.count >= softLimit && !state.warnedSoftLimit) {
      state.warnedSoftLimit = true;
      logger.warn(
        `[${scope}] SOFT_LIMIT triggered for ${identifier} on ${resource} (${state.count}/${max})`
      );
      return 'SOFT_LIMIT';
    }

    return 'OK';
  }

  private getOrCreateTrackers(
    source: Map<string, Map<string, LimitState>>,
    key: string
  ): Map<string, LimitState> {
    if (!source.has(key)) {
      source.set(key, new Map());
    }
    return source.get(key)!;
  }

  /**
   * Resolves a request ID, generating one if necessary for virtual request tracking.
   */
  public resolveRequestId(sessionKey: string, providedId?: string): string {
    if (providedId) return providedId;
    const now = Date.now();
    const last = this.lastActivity.get(sessionKey) || 0;

    if (now - last > 30000 || !this.virtualIds.has(sessionKey)) {
      this.virtualIds.set(sessionKey, `virtual-${sessionKey}-${now}`);
    }
    this.lastActivity.set(sessionKey, now);
    return this.virtualIds.get(sessionKey)!;
  }

  // Management Methods for CLI
  public getSessionStats(): Record<string, Record<string, number>> {
    const stats: Record<string, Record<string, number>> = {};
    for (const [sKey, sMap] of this.trackers.entries()) {
      stats[sKey] = {};
      for (const [tKey, state] of sMap.entries()) {
        stats[sKey][tKey] = state.count;
      }
    }
    return stats;
  }

  public getRequestStats(): Record<string, Record<string, number>> {
    const stats: Record<string, Record<string, number>> = {};
    for (const [rId, rMap] of this.requestTrackers.entries()) {
      stats[rId] = {};
      for (const [tKey, state] of rMap.entries()) {
        stats[rId][tKey] = state.count;
      }
    }
    return stats;
  }

  public async clearSessionLimits(sessionKey: string) {
    this.trackers.delete(sessionKey);
    await TrackerStore.save(this.trackers, this.requestTrackers);
  }

  public async clearAllSessionLimits() {
    this.trackers.clear();
    this.requestTrackers.clear();
    await TrackerStore.save(this.trackers, this.requestTrackers);
  }

  getStatus(): { enabled: boolean; stats?: Record<string, unknown> } {
    // The plugin-level on/off check lives upstream in the composed
    // tool-call hook (LimitPolicyStore.isPluginEnabled). Once this
    // middleware is initialized, it is always considered active by the
    // Middleware-interface contract — disable in your own pipeline by
    // not calling beforeToolCall.
    return {
      enabled: true,
      stats: {
        sessionTrackers: this.trackers.size,
        requestTrackers: this.requestTrackers.size,
      },
    };
  }
}
