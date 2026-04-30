/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Sapience Middleware Plugin Entry Point
 * OpenClaw plugin integration.
 *
 * IMPORTANT: register() must be SYNCHRONOUS — the OpenClaw gateway
 * ignores async plugin registration (the returned promise is not awaited).
 *
 * Hooks:
 *  before_tool_call  → tool interception (policy evaluation)
 *
 * Commands:
 *  /approve [<TOTP-code>]  → approve pending action (processed before LLM, agent never sees it)
 *  /deny                   → deny pending action
 */

import { HitlMiddleware } from '../middlewares/hitl/index.js';
import { logger } from '../shared/Logger.js';
import {
  createApproveCommand,
  createDenyCommand,
} from '../middlewares/hitl/approval/approval-commands.js';
import { ContextEditingMiddleware } from '../middlewares/context-editing/index.js';
import { ContextEditingPolicyStore } from '../middlewares/context-editing/storage/ContextEditingPolicyStore.js';
import { ModelRoutingMiddleware } from '../middlewares/model-routing/index.js';
import { ModelRoutingPolicyStore } from '../middlewares/model-routing/storage/ModelRoutingPolicyStore.js';
import { diag } from '../middlewares/context-editing/diagnostic.js';
import {
  buildRouterModelList,
  buildSapienceRouterProvider,
} from '../middlewares/model-routing/router-provider.js';
import { createOutputGuardrailHook } from '../middlewares/guardrail/OutputGuardrailHook.js';
import { ConfigStore as GuardrailConfigStore } from '../middlewares/guardrail/storage/ConfigStore.js';
import { GuardrailMiddleware } from '../middlewares/guardrail/GuardrailMiddleware.js';
import { LimitPolicyStore } from '../middlewares/tool-call-limit/storage/LimitPolicyStore.js';
import { ToolCallLimitMiddleware } from '../middlewares/tool-call-limit/ToolCallLimitMiddleware.js';
import { DlpStore } from '../middlewares/pii-sanitizer/storage/DlpStore.js';
import { PiiSanitizerMiddleware } from '../middlewares/pii-sanitizer/PiiSanitizerMiddleware.js';
// Guardrail, PII, and Limit hooks are imported lazily inside the composed
// before_tool_call closure.  Their module-level singletons call .initialize()
// on import, which auto-creates default configs in sapience-ai-suite.json —
// importing them eagerly would pollute the store even when the middleware is
// disabled.  Dynamic import() is used so the modules are only loaded when at
// least one of the three middlewares is actually enabled.
//
// Guardrail, PII Sanitizer, and Tool Call Limit all route through their
// middleware-class singletons (_guardrail, _piiSanitizer, _toolCallLimit) —
// no lazy-loaded free-function references are needed.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { getPluginMiddlewaresConfigSync, setOpenClawRuntime } from './config-manager.js';
import { getSuiteServer } from '../shared/server/suite-server.js';
import { setGatewayReady } from '../shared/server/gateway-state.js';
import { ConfigStore } from '../shared/storage/ConfigStore.js';

export interface SapienceMiddlewareConfig {
  enabled?: boolean;
  defaultAction?: 'ALLOW' | 'DENY' | 'ASK';
}

export interface SapienceMiddlewarePluginManifest {
  id: string;
  displayName: string;
  version: string;
  configure: {
    command: string;
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getPackageVersion(): string {
  try {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
    return packageJson.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SapienceMiddlewareManifest: SapienceMiddlewarePluginManifest = {
  id: 'sapience-ai-suite',
  displayName: 'Sapience AI Suite',
  version: getPackageVersion(),
  configure: {
    command: 'sai configure',
  },
};

// ---------------------------------------------------------------------------
// Minimal OpenClaw plugin API surface used by Sapience Middleware.
// All methods are optional — the gateway may not support all of them.
// ---------------------------------------------------------------------------

/**
 * Subset of the OpenClaw plugin runtime used by Sapience Middleware.
 *
 * All methods are optional because the runtime surface differs across
 * supported gateway versions:
 *
 *   - openclaw 2026.4.11 – 2026.4.26: only `loadConfig` / `writeConfigFile`
 *     are available. The new APIs (`current`, `replaceConfigFile`) were
 *     introduced in 2026.4.27.
 *   - openclaw >= 2026.4.27: all four are present, but `loadConfig` and
 *     `writeConfigFile` are deprecation shims (compat code
 *     `runtime-config-load-write`) that delegate to the new APIs.
 *
 * Callers MUST feature-detect (prefer the new APIs, fall back to the
 * deprecated ones) instead of assuming a fixed shape.
 */
export interface OpenClawRuntime {
  config: {
    /** New (openclaw >= 2026.4.27): readonly snapshot of the live config. */
    current?(): Record<string, unknown>;
    /**
     * New (openclaw >= 2026.4.27): atomic replace with explicit `afterWrite`
     * policy. `"auto"` lets the gateway reload planner decide; `"restart"`
     * forces a clean restart; `"none"` suppresses reload (caller owns
     * the follow-up).
     */
    replaceConfigFile?(params: {
      nextConfig: Record<string, unknown>;
      afterWrite:
        | { mode: 'auto' }
        | { mode: 'restart'; reason: string }
        | { mode: 'none'; reason: string };
      writeOptions?: { envSnapshotForRestore?: Record<string, string | undefined> };
    }): Promise<unknown>;
    /** Deprecated since openclaw 2026.4.27, still functional. Use `current` instead. */
    loadConfig?(): Record<string, unknown>;
    /** Deprecated since openclaw 2026.4.27, still functional. Use `replaceConfigFile` instead. */
    writeConfigFile?(
      cfg: Record<string, unknown>,
      options?: { envSnapshotForRestore?: Record<string, string | undefined> }
    ): Promise<void>;
  };
}

interface OpenClawPluginApi {
  config?: Record<string, unknown> & {
    models?: { providers?: Record<string, unknown> };
  };
  /** In-process runtime API — only present when running inside the gateway. */
  runtime?: OpenClawRuntime;
  on?(
    hookName: string,
    handler: (...args: unknown[]) => unknown,
    opts?: { priority?: number }
  ): void;
  registerCommand?(command: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: unknown) => unknown;
  }): void;
  registerProvider?(provider: {
    id: string;
    label: string;
    aliases?: string[];
    envVars?: string[];
    models?: Record<string, unknown>;
    auth: unknown[];
  }): void;
}

// ---------------------------------------------------------------------------
// Hook registration helpers
// ---------------------------------------------------------------------------

function tryOn(
  api: OpenClawPluginApi,
  hookName: string,
  handler: (...args: unknown[]) => unknown,
  label: string
): boolean {
  try {
    if (!api.on) {
      logger.debug(`[plugin] ${label}: api.on not available`);
      return false;
    }
    api.on(hookName, handler);
    logger.debug(`[plugin] ${label}: registered`);
    return true;
  } catch (err) {
    logger.warn(`[plugin] ${label}: api.on('${hookName}') threw`, { error: err });
    return false;
  }
}

function tryRegisterCommand(
  api: OpenClawPluginApi,
  command: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: unknown) => unknown;
  },
  label: string
): boolean {
  try {
    if (!api.registerCommand) {
      logger.debug(`[plugin] ${label}: api.registerCommand not available`);
      return false;
    }
    api.registerCommand(command);
    logger.debug(`[plugin] ${label}: registered command !${command.name}`);
    return true;
  } catch (err) {
    logger.warn(`[plugin] ${label}: api.registerCommand threw`, { error: err });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Module-level singletons — persist across register() calls so that
// middleware state (session buffers, pending compactions, proxy server,
// etc.) is preserved when OpenClaw hot-reloads and calls register() again
// within the same process.
// ---------------------------------------------------------------------------

let _hitl: InstanceType<typeof HitlMiddleware> | null = null;
let _contextEditing: InstanceType<typeof ContextEditingMiddleware> | null = null;
let _modelRouting: InstanceType<typeof ModelRoutingMiddleware> | null = null;
let _guardrail: InstanceType<typeof GuardrailMiddleware> | null = null;
let _piiSanitizer: InstanceType<typeof PiiSanitizerMiddleware> | null = null;
let _toolCallLimit: InstanceType<typeof ToolCallLimitMiddleware> | null = null;
let _registerCount = 0;

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export default {
  id: 'sapience-ai-suite',
  name: 'Sapience AI Suite',
  manifest: SapienceMiddlewareManifest,

  register(api: OpenClawPluginApi): void {
    // Hooks MUST be re-registered on every register() call.  OpenClaw may
    // provide a different `api` object after a config-triggered hot-reload
    // and clears the old hook registry.  Middleware instances are created
    // once (module-level singletons) to preserve in-flight state.

    _registerCount++;
    const isFirstLoad = _registerCount === 1;
    if (isFirstLoad) {
      logger.info('Sapience AI Suite plugin loading...');
    } else {
      logger.debug(`Sapience AI Suite re-register (#${_registerCount})`);
    }

    // Capture the runtime reference so config-manager can use the gateway's
    // atomic loadConfig/writeConfigFile instead of raw file I/O.
    if (api.runtime) {
      setOpenClawRuntime(api.runtime);
    }

    // ===================================================================
    // Gateway lifecycle — drives /api/health (and therefore the dashboard
    // reconnect overlay). gateway_start fires only AFTER all sidecars are
    // ready, so the dashboard won't flash "connected" during the short
    // window where suite-server is up but the gateway itself is still
    // spinning up. gateway_stop fires before shutdown so the overlay
    // re-arms before the suite-server socket actually goes away.
    //
    // On hot-reload (re-register in the same process) the existing ready
    // state is preserved — only the hooks themselves flip it. For older
    // OpenClaw builds without these hooks, fall back to marking ready
    // immediately so the dashboard isn't stuck on the overlay.
    // ===================================================================
    {
      const gatewayStartRegistered = tryOn(
        api,
        'gateway_start',
        () => {
          setGatewayReady(true, 'gateway_start hook');
        },
        'gateway_start'
      );
      tryOn(
        api,
        'gateway_stop',
        (...args: unknown[]) => {
          const event = args[0] as { reason?: string } | undefined;
          setGatewayReady(false, event?.reason ? `gateway_stop: ${event.reason}` : 'gateway_stop');
        },
        'gateway_stop'
      );
      if (!gatewayStartRegistered) {
        setGatewayReady(true, 'gateway_start hook unavailable — legacy fallback');
      }
    }

    try {
      const pluginConfig = (api.config as any) || {};

      // Read middleware enabled/disabled state from the unified ConfigStore
      // (sapience-ai-suite.json). Falls back to legacy openclaw.json config
      // for pre-migration installations, then to built-in defaults.
      try {
        pluginConfig.middlewares = getPluginMiddlewaresConfigSync();
      } catch (err) {
        logger.debug('Failed to read middleware config from ConfigStore', { error: err });
      }

      const activeMiddlewares = pluginConfig.middlewares || {
        hitl: false,
        'context-editing': false,
        'model-routing': false,
        guardrail: false,
        'output-guardrail': false,
        'pii-sanitizer': false,
        'tool-call-limit': false,
      };

      // =================================================================
      // Suite Server — always start the dashboard/API server regardless
      // of which middlewares are enabled. Model-routing registers its
      // /v1/* proxy routes on this server when active.
      // =================================================================
      {
        // Suite server shares the routing-proxy port. Both used to read
        // `plugin_config['model-routing'].port` from openclaw.json; that
        // bootstrap setting now lives in the disk overlay
        // (`sapience-ai-suite.json[model_routing].port`) so MR's
        // `initialize({})` and these sync sites have a single source.
        const serverPort = ModelRoutingPolicyStore.loadSync().port ?? 9000;
        getSuiteServer(serverPort)
          .start()
          .catch((err) => {
            logger.error('[plugin] Suite server failed to start', { error: err });
          });
      }

      // =================================================================
      // HITL — always create the interceptor + register /approve and /deny
      // commands. The before_tool_call hook is registered in the composed
      // section below so that guardrail, PII, and limit checks run before
      // HITL. The Interceptor.pluginEnabled flag tracks the live plugin
      // setting and is refreshed by the onChange('hitl', …) watcher; the
      // composed hook gates its HITL branch on that flag. This lets
      // dashboard toggles take effect without a gateway restart.
      // =================================================================
      {
        if (!_hitl) {
          _hitl = new HitlMiddleware();
          // initialize() body is synchronous (PolicyStore.loadSync + new
          // Interceptor + log) — `this.interceptor` is set before this line
          // returns, so the subsequent setPluginEnabled call hits the live
          // Interceptor immediately. The .catch() is defensive only.
          _hitl.initialize({}).catch((err) => {
            logger.warn('[plugin] HITL init failed', { error: err });
          });
          _hitl.setPluginEnabled(activeMiddlewares.hitl === true);

          // Hot-reload: update policy and plugin-enabled flag when
          // sapience-ai-suite.json changes on disk. The file watcher fires on
          // ANY change to the store, including plugin_config.middlewares.hitl,
          // so dashboard toggles take effect on the next tool call without
          // a process restart.
          ConfigStore.onChange('hitl', () => {
            try {
              _hitl!.reloadPolicy();
              const storeData = ConfigStore.readSync();
              const hitlFlag = storeData?.plugin_config?.middlewares?.hitl === true;
              _hitl!.setPluginEnabled(hitlFlag);
              logger.info('[plugin] HITL policy hot-reloaded', { enabled: hitlFlag });
            } catch (err) {
              logger.warn('[plugin] HITL hot-reload failed', { error: err });
            }
          });
        }

        tryRegisterCommand(
          api,
          createApproveCommand() as Parameters<typeof tryRegisterCommand>[1],
          'approve-command'
        );
        tryRegisterCommand(
          api,
          createDenyCommand() as Parameters<typeof tryRegisterCommand>[1],
          'deny-command'
        );
      }
      if (isFirstLoad && activeMiddlewares.hitl !== true) {
        logger.info(
          'Sapience AI Suite: HITL middleware is currently disabled; hooks are attached but inert until enabled.'
        );
      }

      // =================================================================
      // Context Editing — always create, initialize, and register hooks.
      // Each hook method gates on this.enabled, which is kept in sync with
      // plugin_config.middlewares['context-editing'] by reloadConfig() on
      // every sapience-ai-suite.json change. This lets dashboard toggles
      // take effect without a gateway restart.
      // =================================================================
      {
        // Prime the plugin-enabled cache and subscribe to refreshes — same
        // pattern as guardrail/PII/TCL stores. The class methods themselves
        // are dumb delegators; gating happens here in the wrappers below so
        // dashboard toggles take effect without a gateway restart.
        ContextEditingPolicyStore.refreshCache();
        if (!_contextEditing) {
          _contextEditing = new ContextEditingMiddleware();

          ConfigStore.onChange('context_editing', () => {
            try {
              ContextEditingPolicyStore.refreshCache();
              _contextEditing!.reloadConfig();
            } catch (err) {
              logger.warn('[plugin] Context Editing hot-reload failed', { error: err });
            }
          });
        }

        // Re-initialize on every call to pick up the latest pluginApi
        // reference (needed for ICC LLM calls). Fire-and-forget: register()
        // MUST be synchronous. `pluginApi` is the only field the plugin needs
        // to inject — operational config (triggerMode, thresholds, icc, pruning)
        // comes from `DEFAULT_CONTEXT_EDITING_CONFIG` overlaid with the disk
        // overlay (`context_editing.configOverrides`) inside `initialize()`.
        // The legacy `pluginConfig['context-editing']` spread was a no-op (no
        // code path ever wrote to it) — same migration as MR.
        _contextEditing.initialize({ pluginApi: api }).catch((err) => {
          logger.error('[plugin] Context Editing init failed — middleware will be inert', {
            error: err,
          });
        });

        // Capture in local const for the closures below
        const contextEditing = _contextEditing;

        // --- Hook registration MUST be synchronous (same tick as register()) ---
        // The OpenClaw gateway closes the registration window when register() returns.

        // OpenClaw dispatches `(event, ctx)`. The Middleware interface's
        // lifecycle methods take one merged context object, so we spread
        // both into a single argument at the boundary.
        const mergeCtx = (event: unknown, hookCtx: unknown) => ({
          ...((event ?? {}) as Record<string, unknown>),
          ...((hookCtx ?? {}) as Record<string, unknown>),
        });

        tryOn(
          api,
          'before_agent_start',
          (...args: unknown[]) => {
            if (!ContextEditingPolicyStore.isPluginEnabled()) return;
            diag('>>> before_agent_start HOOK DISPATCHED (context-editing)', {
              argCount: args.length,
            });
            return contextEditing.beforeAgentStart(mergeCtx(args[0], args[1]));
          },
          'context-editing:before_agent_start'
        );

        tryOn(
          api,
          'before_prompt_build',
          (...args: unknown[]) => {
            if (!ContextEditingPolicyStore.isPluginEnabled()) return;
            diag('>>> before_prompt_build HOOK DISPATCHED', {
              argCount: args.length,
              arg0Keys:
                args[0] && typeof args[0] === 'object' ? Object.keys(args[0] as object) : [],
              arg1Keys:
                args[1] && typeof args[1] === 'object' ? Object.keys(args[1] as object) : [],
            });
            return contextEditing.beforePromptBuild(mergeCtx(args[0], args[1]));
          },
          'context-editing:before_prompt_build'
        );

        tryOn(
          api,
          'agent_end',
          (...args: unknown[]) => {
            if (!ContextEditingPolicyStore.isPluginEnabled()) return;
            diag('>>> agent_end HOOK DISPATCHED', { argCount: args.length });
            return contextEditing.agentEnd(mergeCtx(args[0], args[1]));
          },
          'context-editing:agent_end'
        );

        tryOn(
          api,
          'llm_output',
          (...args: unknown[]) => {
            if (!ContextEditingPolicyStore.isPluginEnabled()) return;
            diag('>>> llm_output HOOK DISPATCHED', { argCount: args.length });
            return contextEditing.llmOutput(mergeCtx(args[0], args[1]));
          },
          'context-editing:llm_output'
        );
      }
      if (isFirstLoad && activeMiddlewares['context-editing'] !== true) {
        logger.info(
          'Sapience AI Suite: Context Editing is currently disabled; hooks are attached but inert until enabled.'
        );
      }

      // =================================================================
      // Model Routing — FULLY GUARDED: create, initialize, and register
      // provider exactly once.  The proxy binds a port and cannot safely
      // restart; registerProvider() should not duplicate entries.
      // =================================================================
      if (activeMiddlewares['model-routing'] === true) {
        if (!_modelRouting) {
          _modelRouting = new ModelRoutingMiddleware();
          // Port reads from the disk overlay so it stays in sync with what
          // MR's own `buildConfig` will resolve inside `initialize({})`.
          // Falls back to 9000 (matches `DEFAULT_MODEL_ROUTING_CONFIG.port`).
          const routerPort = ModelRoutingPolicyStore.loadSync().port ?? 9000;

          // ── SYNC: Register as an OpenClaw provider ──────────────────────
          const modelList = buildRouterModelList();
          const sapienceProvider = buildSapienceRouterProvider(routerPort, modelList);

          if (api.registerProvider) {
            try {
              api.registerProvider(sapienceProvider as any);
              logger.info(
                `[plugin] Registered sai-router provider (port ${routerPort}, ${modelList.length} models)`
              );
            } catch (err) {
              logger.warn(
                '[plugin] registerProvider failed — OpenClaw will not route through proxy',
                { error: err }
              );
            }
          } else {
            logger.warn(
              '[plugin] api.registerProvider not available — OpenClaw may not route through proxy'
            );
          }

          // ── SYNC: Inject runtime provider config ────────────────────────
          try {
            const cfg = (api.config || {}) as Record<string, any>;
            if (!cfg.models) cfg.models = { providers: {} };
            if (!cfg.models.providers) cfg.models.providers = {};
            cfg.models.providers['sai-router'] = {
              baseUrl: `http://127.0.0.1:${routerPort}/v1`,
              api: 'openai-completions',
              apiKey: 'sapience-proxy-handles-routing',
              models: modelList,
            };
          } catch (err) {
            logger.debug('[plugin] Could not inject provider config into api.config', {
              error: err,
            });
          }

          // NOTE: openclaw.json injection (provider config + allowlist) is done
          // during `sai init`, not here. Writing to openclaw.json during
          // register() would trigger a full gateway process restart (plugins.*
          // changes always cause restart via config-reload-plan), creating an
          // infinite restart loop.

          // ── ASYNC: Start proxy and initialize middleware ─────────────────
          // Empty inline config: bootstrap fields (port, responseCache,
          // costAlerts) now come from the disk overlay via MR's `buildConfig`,
          // matching the HITL/Guardrail/PII/TCL pattern. `enabled: true` is
          // already the default when omitted; `pluginApi` was dead code (MR
          // doesn't consume it).
          _modelRouting.initialize({}).catch((err) => {
            logger.error('[plugin] Model Routing init failed — middleware will be inert', {
              error: err,
            });
          });
        }
      } else if (isFirstLoad) {
        logger.info('Sapience AI Suite: Model Routing middleware is disabled by config.');
      }

      // =================================================================
      // Guardrail — prime the config cache, subscribe to changes, and
      // register lifecycle hooks through the GuardrailMiddleware singleton.
      // Plugin runtime and external programmatic consumers share the same
      // class surface (mirroring HITL's Interceptor pattern). Gating lives
      // in the wrapper closures so dashboard toggles take effect without a
      // gateway restart.
      // =================================================================
      {
        GuardrailConfigStore.refreshCache();
        ConfigStore.onChange('guardrail', () => {
          try {
            GuardrailConfigStore.refreshCache();
            // Re-merge per-instance config so the class's hot-path reads
            // (executeGuardrailScan / writeScannerHandler via resolveConfig)
            // see the new disk values. updateConfig() patches survive for
            // fields the disk doesn't set (matches MR semantics).
            _guardrail?.reloadConfig();
            logger.info('[plugin] Guardrail config hot-reloaded');
          } catch (err) {
            logger.warn('[plugin] Guardrail hot-reload failed', { error: err });
          }
        });

        if (!_guardrail) {
          _guardrail = new GuardrailMiddleware();
          // initialize() is idempotent and only warms the cache; safe to
          // fire-and-forget.
          _guardrail.initialize({}).catch((err) => {
            logger.debug('[plugin] Guardrail init failed (non-fatal)', { error: err });
          });
        }
        const guardrail = _guardrail;

        tryOn(
          api,
          'before_agent_start',
          (...args: unknown[]) => {
            if (!GuardrailConfigStore.isPluginEnabled()) return {};
            const event = (args[0] ?? {}) as Record<string, unknown>;
            const hookCtx = (args[1] ?? {}) as Record<string, unknown>;
            return guardrail.beforeAgentStart({ ...event, ...hookCtx });
          },
          'guardrail:before_agent_start'
        );

        tryOn(
          api,
          'before_message_write',
          (...args: unknown[]) => {
            if (!GuardrailConfigStore.isPluginEnabled()) return undefined;
            const event = (args[0] ?? {}) as Record<string, unknown>;
            const hookCtx = (args[1] ?? {}) as Record<string, unknown>;
            return guardrail.beforeMessageWrite({ ...event, ...hookCtx });
          },
          'guardrail:before_message_write'
        );
      }
      if (isFirstLoad && activeMiddlewares['guardrail'] !== true) {
        logger.info(
          'Sapience AI Suite: Guardrail is currently disabled; hooks are attached but inert until enabled.'
        );
      }

      // =================================================================
      // Output Guardrail — metadata scrubber (before_message_write)
      // Fires after the guardrail write scanner on the same hook.
      // =================================================================
      if (activeMiddlewares['output-guardrail'] === true) {
        tryOn(
          api,
          'before_message_write',
          createOutputGuardrailHook() as (...args: unknown[]) => unknown,
          'output-guardrail:before_message_write'
        );
      } else if (isFirstLoad) {
        logger.info('Sapience AI Suite: Output Guardrail middleware is disabled by config.');
      }

      // =================================================================
      // PII Sanitizer — construct the middleware singleton, prime the
      // plugin-enabled cache, and subscribe to changes. Plugin runtime and
      // external programmatic consumers share the same class surface
      // (mirroring the HITL / guardrail pattern). Gating lives in the
      // composed tool-call hook so dashboard toggles take effect without a
      // gateway restart.
      // =================================================================
      {
        DlpStore.refreshCache();
        if (!_piiSanitizer) {
          _piiSanitizer = new PiiSanitizerMiddleware();
          // initialize() loads the DLP policy from disk; fire-and-forget.
          _piiSanitizer.initialize({}).catch((err) => {
            logger.debug('[plugin] PII Sanitizer init failed (non-fatal)', { error: err });
          });
        }
        const piiSanitizer = _piiSanitizer;

        ConfigStore.onChange('pii_sanitizer', () => {
          try {
            DlpStore.refreshCache();
          } catch (err) {
            logger.warn('[plugin] PII Sanitizer plugin-flag refresh failed', { error: err });
          }
          try {
            piiSanitizer.reloadPolicy();
            logger.info('[plugin] PII Sanitizer policy hot-reloaded');
          } catch (err) {
            logger.warn('[plugin] PII Sanitizer hot-reload failed', { error: err });
          }
        });
      }
      if (isFirstLoad && activeMiddlewares['pii-sanitizer'] !== true) {
        logger.info(
          'Sapience AI Suite: PII Sanitizer is currently disabled; hooks are attached but inert until enabled.'
        );
      }

      // =================================================================
      // Tool Call Limit — always prime cached policy + plugin-enabled flag
      // and subscribe to changes. LimitPolicyStore.getCached() is zero-I/O
      // after first call. The composed tool-call hook gates on
      // LimitPolicyStore.isPluginEnabled() so dashboard toggles take effect
      // without a gateway restart.
      // =================================================================
      {
        LimitPolicyStore.refreshCache();
        if (!_toolCallLimit) {
          _toolCallLimit = new ToolCallLimitMiddleware();
          // initialize() loads persisted tracker state; fire-and-forget.
          _toolCallLimit.initialize().catch((err) => {
            logger.debug('[plugin] Tool Call Limit init failed (non-fatal)', { error: err });
          });
        }
        ConfigStore.onChange('tool_call_limit', () => {
          try {
            LimitPolicyStore.refreshCache();
            // Re-merge per-instance policy so the class's beforeToolCall
            // sees the new disk values via resolvePolicy(). updateConfig()
            // patches survive for fields the disk doesn't set.
            _toolCallLimit?.reloadConfig();
            logger.info('[plugin] Tool Call Limit policy hot-reloaded');
          } catch (err) {
            logger.warn('[plugin] Tool Call Limit hot-reload failed', { error: err });
          }
        });
      }
      if (isFirstLoad && activeMiddlewares['tool-call-limit'] !== true) {
        logger.info(
          'Sapience AI Suite: Tool Call Limit is currently disabled; hooks are attached but inert until enabled.'
        );
      }

      // =================================================================
      // Composed before_tool_call — layer guardrail, PII, limits on top
      // of the HITL hook. Short-circuits on first block. Always registered
      // because every gated middleware uses the eager-register pattern now.
      // Each branch inside reads a live plugin-enabled flag so a disabled
      // middleware bails cheaply and a toggle-on takes effect immediately
      // without a gateway restart.
      // =================================================================
      {
        const hitlToolHook = _hitl?.buildToolCallHook() ?? null;

        const composedToolHook = async (event: any, ctx: any) => {
          // 1. Guardrail parameter scan (live gate — always-registered)
          if (GuardrailConfigStore.isPluginEnabled() && _guardrail) {
            try {
              const mwResult = await _guardrail.beforeToolCall({
                toolName: event.toolName || event.tool || '',
                moduleName: event.moduleName || '',
                methodName: event.methodName || '',
                params: event.params || event.input || {},
                sessionKey: ctx?.sessionKey,
                agentId: ctx?.agentId,
                metadata: event.metadata ?? {},
              });
              if (mwResult.block) {
                return { block: true, blockReason: mwResult.reason };
              }
              // Escalate → inject forceAsk metadata for HITL. The escalate
              // signal is now a first-class MiddlewareResult field.
              if (mwResult.escalate) {
                if (!event.metadata) event.metadata = {};
                event.metadata.forceAsk = true;
                event.metadata.guardrailReason = mwResult.escalateReason;
              }
            } catch (err) {
              logger.warn('[plugin] Guardrail scan error — fail-open', { error: err });
            }
          }

          // 2. PII DLP scan (live gate — always-registered)
          if (DlpStore.isPluginEnabled() && _piiSanitizer) {
            try {
              const mwResult = await _piiSanitizer.beforeToolCall({
                toolName: event.toolName || event.tool || '',
                moduleName: event.moduleName || '',
                methodName: event.methodName || '',
                params: event.params || event.input || {},
                sessionKey: ctx?.sessionKey,
                agentId: ctx?.agentId,
                metadata: event.metadata ?? {},
              });
              // Redacted params flow to downstream middlewares and the tool.
              if (mwResult.modifiedParams) {
                event.params = mwResult.modifiedParams;
              }
              if (mwResult.block) {
                return { block: true, blockReason: mwResult.reason };
              }
              // Escalate → inject forceAsk metadata for HITL (same channel
              // guardrail uses). ESCALATE-only detections no longer hard-block.
              if (mwResult.escalate) {
                if (!event.metadata) event.metadata = {};
                event.metadata.forceAsk = true;
                event.metadata.piiReason = mwResult.escalateReason;
              }
            } catch (err) {
              logger.warn('[plugin] PII scan error — fail-open', { error: err });
            }
          }

          // 3. Tool call limit check (live gate — always-registered)
          if (LimitPolicyStore.isPluginEnabled() && _toolCallLimit) {
            try {
              const toolNameForLimit = event.toolName || event.tool || '';
              // Resolve flat OpenClaw tool names (e.g. "write") to module/method
              // using the same mapping HITL uses, with a dot-split fallback.
              const { getToolMapping } = await import('../middlewares/hitl/tool-interceptor.js');
              const toolMap = getToolMapping();
              const mapped = toolMap[toolNameForLimit.toLowerCase()];
              const [modFromName = '', methodFromName = ''] = toolNameForLimit.split('.');
              const resolvedModule = event.moduleName || mapped?.module || modFromName;
              const resolvedMethod = event.methodName || mapped?.method || methodFromName;
              const mwResult = await _toolCallLimit.beforeToolCall({
                toolName: toolNameForLimit,
                moduleName: resolvedModule,
                methodName: resolvedMethod,
                params: event.params || event.input || {},
                sessionKey: ctx?.sessionKey,
                metadata: {
                  sessionKey: ctx?.sessionKey,
                  requestId: ctx?.requestId,
                },
              });
              if (mwResult.block) {
                return { block: true, blockReason: mwResult.reason };
              }
              // Soft-limit warnings flow through metadata.softLimitTriggered
              // (TCL-specific telemetry, not an HITL escalation).
            } catch (err) {
              logger.warn('[plugin] Limit check error — fail-open', { error: err });
            }
          }

          // 4. HITL evaluation (live gate — always-registered)
          // _hitl.isPluginEnabled() is the live plugin-level flag, refreshed
          // by the onChange('hitl') callback above. Without this gate HITL
          // would keep prompting after a dashboard disable, because OpenClaw
          // doesn't deregister the already-attached hook.
          if (hitlToolHook && _hitl?.isPluginEnabled()) {
            return hitlToolHook(event, ctx);
          }

          return undefined;
        };

        tryOn(
          api,
          'before_tool_call',
          composedToolHook as (...args: unknown[]) => unknown,
          'before_tool_call'
        );
      }

      if (isFirstLoad) {
        logger.info('Sapience AI Suite: registration complete');
      } else {
        logger.debug('Sapience AI Suite: re-registration complete');
      }
    } catch (error) {
      logger.error('Failed to initialize Sapience AI Suite plugin', { error });
      throw error;
    }
  },
};
