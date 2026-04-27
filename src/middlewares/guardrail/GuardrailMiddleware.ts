/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Guardrail Middleware — pipeline-compatible facade
 *
 * Implements every OpenClaw lifecycle surface guardrail cares about through
 * the unified `Middleware` interface:
 *
 *   beforeToolCall       → L2 guards + pre-read + param scan (executeGuardrailScan)
 *   beforeAgentStart     → prompt-guard policy injection + async OpenAI moderation
 *                          (cache populated here for beforeMessageWrite to consume)
 *   beforeMessageWrite   → transcript scanner (regex/prefix/heuristic + role
 *                          impersonation + agent interrogation + canary tracker
 *                          + moderation-cache enforcement)
 *
 * Notes:
 *  - The OpenClaw plugin runtime does NOT route through this class — it
 *    binds the free-function hook factories directly in plugin/index.ts.
 *    This class exists for external programmatic consumers (e.g.
 *    `MiddlewareRegistry`-style use) so they get every guard reachable
 *    through a single instance.
 *  - `escalate: true` from the scanner (WARN detections) is surfaced via
 *    the first-class `MiddlewareResult.escalate` / `escalateReason` fields,
 *    so orchestrators (plugin composedToolHook or external pipelines) can
 *    force HITL approval without reaching for the lower-level
 *    `executeGuardrailScan` free function.
 *  - The class is a dumb delegator: no internal enabled gate. To disable
 *    it in your own pipeline, stop calling its methods.
 */

import {
  Middleware,
  MiddlewareContext,
  MiddlewareResult,
  AgentStartContext,
  AgentStartResult,
  MessageWriteContext,
  MessageWriteResult,
} from '../../types.js';
import { logger } from '../../shared/Logger.js';
import { ConfigStore, DEFAULT_GUARDRAIL_CONFIG } from './storage/ConfigStore.js';
import { executeGuardrailScan } from './GuardrailInterceptorHook.js';
import { getPatternCount } from './scrubbers/MetadataScrubber.js';
import { createPromptGuardHook } from './PromptGuardHook.js';
import { createModerationGuardHook } from './ModerationGuardHook.js';
import { createWriteScannerHook } from './GuardrailWriteScannerHook.js';
import { GuardrailConfig } from './types.js';

const GUARDRAIL_VERSION = '3.1.0';

export class GuardrailMiddleware implements Middleware {
  readonly name = 'guardrail';
  readonly version = GUARDRAIL_VERSION;

  private scanCount = 0;
  private blockCount = 0;
  private escalateCount = 0;

  /**
   * In-memory current config — source of truth for hot-path reads when
   * `initialize()` has run. `null` until then; `resolveConfig()` falls
   * back to `ConfigStore.getCached()` so direct programmatic consumers
   * who skip `initialize()` keep working.
   *
   * Populated by `initialize()`, mutated by `updateConfig()`, re-merged
   * with disk by `reloadConfig()`. Mirrors `ModelRoutingMiddleware`'s
   * config model exactly.
   */
  private config: GuardrailConfig | null = null;

  // Pre-built hook handlers — constructed once per middleware instance so
  // repeated event dispatches don't allocate new closures. Each hook reads
  // its config via `() => this.resolveConfig()` so per-instance updates
  // (initialize inline / updateConfig() patches) flow through to every guard.
  private readonly promptGuardHandler = createPromptGuardHook();
  private readonly moderationGuardHandler = createModerationGuardHook();
  private readonly writeScannerHandler = createWriteScannerHook(() => this.resolveConfig());

  /**
   * Build the merged config from defaults + base + inline + disk overlay.
   * Precedence: `DEFAULT_GUARDRAIL_CONFIG < base < inline < disk-overlay`.
   *
   * The "disk overlay" is the raw `guardrail` sub-tree from
   * `sapience-ai-suite.json` (via `ConfigStore.loadOverlay()`) — empty `{}`
   * when the file is absent or the key is unset, so a hermetic embedded
   * consumer's inline config applies fully. A consumer running alongside
   * the plugin gets `defaults < inline < disk` (disk shadows inline —
   * escape hatch: `updateConfig()`).
   */
  private buildConfig(
    inline: Partial<GuardrailConfig>,
    base: Partial<GuardrailConfig> = DEFAULT_GUARDRAIL_CONFIG
  ): GuardrailConfig {
    const disk = ConfigStore.loadOverlay();
    return {
      ...DEFAULT_GUARDRAIL_CONFIG,
      ...base,
      ...inline,
      ...disk,
    } as GuardrailConfig;
  }

  /**
   * Resolve the active config for hot-path reads. Falls back to the static
   * cache when `initialize()` hasn't run yet — keeps the legacy zero-init
   * path working for direct consumers of the class.
   */
  private resolveConfig(): GuardrailConfig {
    return this.config ?? ConfigStore.getCached();
  }

  /**
   * Initialize the middleware. Accepts an optional inline `GuardrailConfig`
   * partial — fields you set here apply on top of `DEFAULT_GUARDRAIL_CONFIG`
   * but below the disk overlay (`sapience-ai-suite.json[guardrail]`). Pass
   * `{}` (or omit) to fall back to defaults + disk — the path the OpenClaw
   * plugin runtime uses.
   */
  async initialize(config: Record<string, unknown> = {}): Promise<void> {
    this.config = this.buildConfig(config as Partial<GuardrailConfig>);
    // Warm the static cache too — direct consumers of the free-function
    // hook factories (who don't pass a config getter) still rely on it.
    ConfigStore.getCached();
    logger.info('[GuardrailMiddleware] Initialized');
  }

  /**
   * In-process patch — bypasses disk. Shallow-merges `partial` into the
   * current in-memory config. Sibling fields are preserved.
   *
   *   gr.updateConfig({ dryRunMode: true });
   *
   * For disk-backed updates that survive process restarts, use
   * `GuardrailConfigStore.update()` + `reloadConfig()` instead.
   *
   * Throws if called before `initialize()`.
   */
  updateConfig(partial: Partial<GuardrailConfig>): void {
    if (!this.config) {
      throw new Error('GuardrailMiddleware.updateConfig: call initialize() first');
    }
    this.config = { ...this.config, ...partial } as GuardrailConfig;
    logger.debug('[GuardrailMiddleware] In-process config updated', {
      keys: Object.keys(partial),
    });
  }

  /**
   * Re-read config from disk and re-merge over the current in-memory config.
   * `updateConfig()` patches survive for fields the disk doesn't set; disk-
   * set fields shadow them (matches `ModelRoutingMiddleware.reloadConfig()`
   * semantics). Called by the plugin's `ConfigStore.onChange('guardrail',
   * …)` watcher and by programmatic consumers after
   * `GuardrailConfigStore.save()` / `update()`.
   */
  reloadConfig(): void {
    const base = this.config ?? DEFAULT_GUARDRAIL_CONFIG;
    this.config = this.buildConfig({}, base);
    logger.debug('[GuardrailMiddleware] Config hot-reloaded');
  }

  async beforeToolCall(context: MiddlewareContext): Promise<MiddlewareResult> {
    try {
      const result = executeGuardrailScan(
        context.toolName,
        context.moduleName,
        context.methodName,
        context.params,
        context.sessionKey,
        context.agentId,
        this.resolveConfig()
      );

      this.scanCount++;
      if (result.block) {
        this.blockCount++;
        return { block: true, reason: result.reason };
      }
      if (result.escalate) {
        this.escalateCount++;
        // Surface WARN detections via the first-class escalate channel on
        // MiddlewareResult so orchestrators (plugin composed hook or external
        // pipelines) can force HITL approval without dropping down to the
        // lower-level executeGuardrailScan free function.
        return {
          block: false,
          escalate: true,
          escalateReason: result.reason,
        };
      }
      return { block: false };
    } catch (err) {
      logger.warn('[GuardrailMiddleware] scan error — fail-open', { error: err });
      return { block: false };
    }
  }

  /**
   * `before_agent_start` surface. Runs both the prompt-guard (injects the
   * security policy into the system prompt) and the async OpenAI moderation
   * check (caches the result for `beforeMessageWrite` to consume). The
   * return value carries the prompt-guard's `prependContext`; the
   * moderation call's side effect is the cache population.
   */
  async beforeAgentStart(context: AgentStartContext): Promise<AgentStartResult | void> {
    try {
      // Both underlying handlers accept the raw (event, ctx) shape with
      // index signatures — the normalized LifecycleContext satisfies both.
      const [, promptResult] = await Promise.all([
        this.moderationGuardHandler(context, context).catch((err) => {
          logger.warn('[GuardrailMiddleware] moderation error — fail-open', { error: err });
          return {} as Record<string, never>;
        }),
        Promise.resolve(this.promptGuardHandler(context)),
      ]);
      return promptResult ?? {};
    } catch (err) {
      logger.warn('[GuardrailMiddleware] beforeAgentStart error — fail-open', { error: err });
      return {};
    }
  }

  /**
   * `before_message_write` surface. Runs the write scanner (regex/prefix/
   * heuristic + role impersonation + agent interrogation + canary tracker)
   * and applies the cached moderation result from `beforeAgentStart`.
   * Returns `{ message }` to rewrite, `{ block: true }` to drop, or
   * `undefined` to pass through.
   */
  beforeMessageWrite(context: MessageWriteContext): MessageWriteResult | undefined {
    try {
      const result = this.writeScannerHandler(context, context);
      return result ?? undefined;
    } catch (err) {
      logger.warn('[GuardrailMiddleware] beforeMessageWrite error — fail-open', { error: err });
      return undefined;
    }
  }

  getStatus(): { enabled: boolean; stats?: Record<string, unknown> } {
    // The plugin-level on/off switch lives upstream (dashboard / `sai init`
    // → `plugin_config.middlewares.guardrail`, gated in plugin/index.ts
    // hook wrappers). Once this middleware is constructed, it is always
    // active by the Middleware-interface contract — disable by not
    // calling its methods.
    return {
      enabled: true,
      stats: {
        scanCount: this.scanCount,
        blockCount: this.blockCount,
        escalateCount: this.escalateCount,
        metadataPatternCount: getPatternCount(),
      },
    };
  }
}
