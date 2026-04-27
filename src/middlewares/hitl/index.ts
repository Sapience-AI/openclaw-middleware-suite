/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * HITL Middleware — Human-in-the-Loop
 * Implements the Middleware interface, wrapping the Interceptor for pipeline integration.
 */

import { Middleware, MiddlewareContext, MiddlewareResult, SecurityPolicy } from '../../types.js';
import { Interceptor } from './Interceptor.js';
import { createToolCallHook } from './tool-interceptor.js';
import { DEFAULT_POLICY } from './config.js';
import { ConfigStore } from '../../shared/storage/ConfigStore.js';
import { logger } from '../../shared/Logger.js';

// Re-export key HITL types and modules for convenience
export { Interceptor } from './Interceptor.js';
export { Arbitrator } from './approval/Arbitrator.js';
export { approvalQueue, hashArgs as approvalHashArgs } from './approval/ApprovalQueue.js';
export { TotpManager } from './approval/TotpManager.js';
export { trustRateLimiter, TrustRateLimiter } from './approval/TrustRateLimiter.js';
export { detectBrowserChallenge } from './scoring/BrowserChallengeDetector.js';
export type {
  BrowserChallengeSignal,
  BrowserChallengeLevel,
  BrowserChallengeKind,
} from './scoring/BrowserChallengeDetector.js';
export { classifyDestructiveAction, hashArgs } from './scoring/DestructiveClassifier.js';
export type {
  DestructiveClassification,
  DestructiveSeverity,
} from './scoring/DestructiveClassifier.js';
export { scoreIrreversibility } from './scoring/IrreversibilityScorer.js';
export type {
  IrreversibilityAssessment,
  IrreversibilityLevel,
} from './scoring/IrreversibilityScorer.js';
export { MemoryRiskForecaster } from './scoring/MemoryRiskForecaster.js';
export type { MemoryRiskAssessment, SimulatedPath } from './scoring/MemoryRiskForecaster.js';
export { BrowserSessionStore } from './storage/BrowserSessionStore.js';
export type { SessionInjectionResult } from './storage/BrowserSessionStore.js';
export { DEFAULT_POLICY } from './config.js';
export type { EscalationLevel, TrustRateLimiterState } from './approval/TrustRateLimiter.js';

const HITL_VERSION = '1.0.0';

export class HitlMiddleware implements Middleware {
  readonly name = 'hitl';
  readonly version = HITL_VERSION;

  private interceptor: Interceptor | null = null;

  /**
   * Buffer for `setPluginEnabled()` calls that arrive before `initialize()`
   * has constructed the underlying Interceptor. The plugin runtime fires
   * `_hitl.initialize({})` then immediately calls `setPluginEnabled(...)` —
   * since `initialize()`'s body is sync, this race is theoretical, but we
   * buffer defensively so future async work in `initialize()` won't drop
   * the flag.
   */
  private pendingPluginEnabled: boolean | null = null;

  /**
   * Build the merged policy from defaults + inline config + disk overlay.
   * Precedence: `DEFAULT_POLICY < inline < disk-store-overrides`.
   *
   * The "disk overlay" is the raw `hitl.policy` sub-tree from
   * `sapience-ai-suite.json` — `undefined` (treated as empty `{}`) when the
   * file is absent or the key is unset. This means a hermetic embedded
   * consumer with no `sapience-ai-suite.json` on disk gets `defaults <
   * inline` (inline applies fully); a consumer running alongside the plugin
   * gets `defaults < inline < disk` (disk shadows inline — escape hatch:
   * `updateConfig()`).
   */
  private mergePolicy(
    inline: Partial<SecurityPolicy>,
    base: Partial<SecurityPolicy> = DEFAULT_POLICY
  ): SecurityPolicy {
    const store = ConfigStore.readSync();
    const diskOverlay = ((store?.hitl as { policy?: Partial<SecurityPolicy> } | undefined)
      ?.policy ?? {}) as Partial<SecurityPolicy>;
    return {
      ...DEFAULT_POLICY,
      ...base,
      ...inline,
      ...diskOverlay,
    } as SecurityPolicy;
  }

  /**
   * Initialize the middleware. Accepts an optional inline `SecurityPolicy`
   * partial — fields you set here apply on top of `DEFAULT_POLICY` but below
   * the disk overlay (`sapience-ai-suite.json[hitl.policy]`). Pass `{}` (or
   * omit) to fall back to defaults + disk.
   */
  async initialize(config: Record<string, unknown> = {}): Promise<void> {
    const inline = config as Partial<SecurityPolicy>;
    const merged = this.mergePolicy(inline);
    this.interceptor = new Interceptor(merged);
    if (this.pendingPluginEnabled !== null) {
      this.interceptor.setPluginEnabled(this.pendingPluginEnabled);
      this.pendingPluginEnabled = null;
    }
    logger.info('[HitlMiddleware] Initialized', {
      defaultAction: merged.defaultAction,
      moduleCount: Object.keys(merged.modules).length,
    });
  }

  /**
   * In-process patch — bypasses disk. Shallow-merges `partial` into the
   * current in-memory policy and re-applies it to the underlying Interceptor.
   * Sibling fields are preserved.
   *
   *   hitl.updateConfig({ defaultAction: 'DENY' });
   *
   * For disk-backed updates that survive process restarts, use
   * `PolicyStore.update()` + `reloadPolicy()` instead.
   *
   * Throws if called before `initialize()`.
   */
  updateConfig(partial: Partial<SecurityPolicy>): void {
    if (!this.interceptor) {
      throw new Error('HitlMiddleware.updateConfig: call initialize() first');
    }
    const current = this.interceptor.getPolicy();
    const merged = { ...current, ...partial } as SecurityPolicy;
    this.interceptor.setPolicy(merged);
    logger.debug('[HitlMiddleware] In-process config updated', {
      keys: Object.keys(partial),
    });
  }

  /**
   * Hot-reload the policy from disk. Re-reads `sapience-ai-suite.json[hitl.policy]`
   * and re-merges over the current in-memory policy (which preserves any
   * `updateConfig()` patches for fields the disk doesn't set). Pair with
   * `PolicyStore.save()` for programmatic config updates:
   *
   *   await PolicyStore.save(newPolicy);
   *   hitl.reloadPolicy();
   *
   * No-op if the middleware hasn't been initialized yet.
   *
   * Note: disk-set fields shadow in-process `updateConfig()` patches —
   * matches `ModelRoutingMiddleware.reloadConfig()` semantics. To re-assert
   * an in-process override after reload, call `updateConfig()` again.
   */
  reloadPolicy(): void {
    if (!this.interceptor) return;
    const current = this.interceptor.getPolicy();
    const merged = this.mergePolicy({}, current);
    this.interceptor.setPolicy(merged);
    logger.info('[HitlMiddleware] Policy reloaded', {
      defaultAction: merged.defaultAction,
      moduleCount: Object.keys(merged.modules).length,
    });
  }

  async beforeToolCall(context: MiddlewareContext): Promise<MiddlewareResult> {
    if (!this.interceptor) {
      return { block: true, reason: 'HITL middleware not initialized' };
    }

    try {
      await this.interceptor.evaluate(
        context.moduleName,
        context.methodName,
        [context.params],
        context.sessionKey,
        context.agentId
      );
      return { block: false };
    } catch (err: unknown) {
      const reason =
        err instanceof Error
          ? err.message
          : `${context.moduleName}.${context.methodName}() blocked by HITL policy`;
      return { block: true, reason };
    }
  }

  getStatus(): { enabled: boolean; stats?: Record<string, unknown> } {
    // The plugin-level on/off switch lives upstream (dashboard / `sai init`
    // → `plugin_config.middlewares.hitl`, gated in plugin/index.ts via
    // `Interceptor.isPluginEnabled`). Once this middleware is constructed,
    // it is always active by the Middleware-interface contract — disable
    // by not calling its methods.
    return { enabled: true };
  }

  async shutdown(): Promise<void> {
    logger.info('[HitlMiddleware] Shutting down');
  }

  // ── Plugin-runtime support ──────────────────────────────────────────────
  // These thin proxies let the OpenClaw plugin runtime drive HITL through
  // this class instead of touching the underlying Interceptor directly.
  // Programmatic consumers typically don't need them — they call
  // `beforeToolCall()` via `MiddlewareRegistry` and rely on the dashboard
  // for plugin-level enable/disable.

  /**
   * Set the live plugin-level on/off flag. Wired by the plugin runtime to
   * `plugin_config.middlewares.hitl` so dashboard toggles take effect on
   * the next tool call without a gateway restart. Buffered if called
   * before `initialize()`.
   */
  setPluginEnabled(enabled: boolean): void {
    if (this.interceptor) {
      this.interceptor.setPluginEnabled(enabled);
    } else {
      this.pendingPluginEnabled = enabled;
    }
  }

  /** Read the live plugin-level on/off flag. Used by the composed tool-call hook. */
  isPluginEnabled(): boolean {
    return this.interceptor?.isPluginEnabled() ?? this.pendingPluginEnabled === true;
  }

  /**
   * Build an OpenClaw-shaped `before_tool_call` hook bound to this
   * middleware's Interceptor. The plugin runtime uses this to wire HITL
   * directly into OpenClaw with the native return shape (`blockReason`),
   * preserving the tool-name → module/method heuristics inside
   * `createToolCallHook` (Shell ↔ Drive/Gmail indirection, FileSystem.write
   * content scan, etc.). Returns null if `initialize()` hasn't run yet.
   */
  buildToolCallHook(): ReturnType<typeof createToolCallHook> | null {
    if (!this.interceptor) return null;
    return createToolCallHook(this.interceptor);
  }
}
