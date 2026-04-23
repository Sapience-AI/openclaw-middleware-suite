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

import { Interceptor } from '../middlewares/hitl/Interceptor.js';
import { PolicyStore } from '../middlewares/hitl/storage/PolicyStore.js';
import { logger } from '../shared/Logger.js';
import { createToolCallHook } from '../middlewares/hitl/tool-interceptor.js';
import {
  createApproveCommand,
  createDenyCommand,
} from '../middlewares/hitl/approval/approval-commands.js';
import { ContextEditingMiddleware } from '../middlewares/context-editing/index.js';
import { ModelRoutingMiddleware } from '../middlewares/model-routing/index.js';
import { diag } from '../middlewares/context-editing/diagnostic.js';
import {
  buildRouterModelList,
  buildSapienceRouterProvider,
} from '../middlewares/model-routing/router-provider.js';
import { createWriteScannerHook } from '../middlewares/guardrail/GuardrailWriteScannerHook.js';
import { createOutputGuardrailHook } from '../middlewares/guardrail/OutputGuardrailHook.js';
import { createPromptGuardHook } from '../middlewares/guardrail/PromptGuardHook.js';
import { createModerationGuardHook } from '../middlewares/guardrail/ModerationGuardHook.js';
import { ConfigStore as GuardrailConfigStore } from '../middlewares/guardrail/storage/ConfigStore.js';
import { LimitPolicyStore } from '../middlewares/tool-call-limit/storage/LimitPolicyStore.js';
// Guardrail, PII, and Limit hooks are imported lazily inside the composed
// before_tool_call closure.  Their module-level singletons call .initialize()
// on import, which auto-creates default configs in sapience-ai-suite.json —
// importing them eagerly would pollute the store even when the middleware is
// disabled.  Dynamic import() is used so the modules are only loaded when at
// least one of the three middlewares is actually enabled.
//
// Lazy-loaded references — populated once inside the composed hook on first call.
let _executeGuardrailScan:
  | typeof import('../middlewares/guardrail/GuardrailInterceptorHook.js').executeGuardrailScan
  | null = null;
let _executePiiScan:
  | typeof import('../middlewares/pii-sanitizer/PiiSanitizerHook.js').executePiiScan
  | null = null;
let _executeLimitCheck:
  | typeof import('../middlewares/tool-call-limit/ToolCallLimitHook.js').executeLimitCheck
  | null = null;
// Lazy-loaded PII sanitizer singleton — needed for hot-reload via onChange.
// Set when the PII module is first dynamically imported inside the composed hook.
let _piiSanitizerInstance: { reloadPolicy(): void } | null = null;
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { getPluginMiddlewaresConfigSync, setOpenClawRuntime } from './config-manager.js';
import { getSuiteServer } from '../shared/server/suite-server.js';
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

/** Subset of the OpenClaw plugin runtime used by Sapience Middleware. */
export interface OpenClawRuntime {
  config: {
    /** Returns the current OpenClaw config (process-global cached snapshot). */
    loadConfig(): Record<string, unknown>;
    /**
     * Atomically write the full config to disk.
     * Handles backup rotation, schema validation, env-var restoration,
     * and notifies gateway write-listeners.
     */
    writeConfigFile(
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

let _interceptor: InstanceType<typeof Interceptor> | null = null;
let _contextEditing: InstanceType<typeof ContextEditingMiddleware> | null = null;
let _modelRouting: InstanceType<typeof ModelRoutingMiddleware> | null = null;
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
        const mrPluginCfg = (pluginConfig['model-routing'] as Record<string, unknown>) || {};
        const serverPort = typeof mrPluginCfg.port === 'number' ? mrPluginCfg.port : 9000;
        getSuiteServer(serverPort)
          .start()
          .catch((err) => {
            logger.error('[plugin] Suite server failed to start', { error: err });
          });
      }

      // =================================================================
      // HITL — create interceptor once, register commands on every call.
      // The before_tool_call hook is registered in the composed section
      // below so that guardrail, PII, and limit checks run before HITL.
      // =================================================================
      if (activeMiddlewares.hitl === true) {
        if (!_interceptor) {
          const policy = PolicyStore.loadSync();
          logger.info('Security policy loaded', {
            defaultAction: policy.defaultAction,
            moduleCount: Object.keys(policy.modules).length,
          });
          _interceptor = new Interceptor(policy);

          // Hot-reload: update policy when sapience-ai-suite.json changes on disk
          ConfigStore.onChange('hitl', () => {
            try {
              const freshPolicy = PolicyStore.loadSync();
              _interceptor!.setPolicy(freshPolicy);
              logger.info('[plugin] HITL policy hot-reloaded');
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
      } else if (isFirstLoad) {
        logger.info('Sapience AI Suite: HITL middleware is disabled by config.');
      }

      // =================================================================
      // Context Editing — create once, re-initialize + re-register hooks
      // =================================================================
      if (activeMiddlewares['context-editing'] === true) {
        if (!_contextEditing) {
          _contextEditing = new ContextEditingMiddleware();

          // Hot-reload: re-read config overrides when sapience-ai-suite.json changes
          ConfigStore.onChange('context_editing', () => {
            try {
              _contextEditing!.reloadConfig();
            } catch (err) {
              logger.warn('[plugin] Context Editing hot-reload failed', { error: err });
            }
          });
        }

        const cePluginConfig = (pluginConfig['context-editing'] as Record<string, unknown>) || {};

        // Re-initialize on every call to pick up the latest pluginApi
        // reference (needed for ICC LLM calls).
        // Fire-and-forget: register() MUST be synchronous.
        _contextEditing
          .initialize({
            enabled: true,
            ...cePluginConfig,
            pluginApi: api,
          })
          .catch((err) => {
            logger.error('[plugin] Context Editing init failed — middleware will be inert', {
              error: err,
            });
          });

        // Capture in local const for the closures below
        const contextEditing = _contextEditing;

        // --- Hook registration MUST be synchronous (same tick as register()) ---
        // The OpenClaw gateway closes the registration window when register() returns.

        tryOn(
          api,
          'before_agent_start',
          (...args: unknown[]) => {
            diag('>>> before_agent_start HOOK DISPATCHED (context-editing)', {
              argCount: args.length,
            });
            return contextEditing.onBeforeAgentStart(args[0], args[1]);
          },
          'context-editing:before_agent_start'
        );

        tryOn(
          api,
          'before_prompt_build',
          (...args: unknown[]) => {
            diag('>>> before_prompt_build HOOK DISPATCHED', {
              argCount: args.length,
              arg0Keys:
                args[0] && typeof args[0] === 'object' ? Object.keys(args[0] as object) : [],
              arg1Keys:
                args[1] && typeof args[1] === 'object' ? Object.keys(args[1] as object) : [],
            });
            return contextEditing.onBeforePromptBuild(args[0], args[1]);
          },
          'context-editing:before_prompt_build'
        );

        tryOn(
          api,
          'agent_end',
          (...args: unknown[]) => {
            diag('>>> agent_end HOOK DISPATCHED', { argCount: args.length });
            return contextEditing.onAgentEnd(args[0], args[1]);
          },
          'context-editing:agent_end'
        );

        tryOn(
          api,
          'llm_output',
          (...args: unknown[]) => {
            diag('>>> llm_output HOOK DISPATCHED', { argCount: args.length });
            return contextEditing.onLlmOutput(args[0], args[1]);
          },
          'context-editing:llm_output'
        );
      } else if (isFirstLoad) {
        logger.info('Sapience AI Suite: Context Editing middleware is disabled by config.');
      }

      // =================================================================
      // Model Routing — FULLY GUARDED: create, initialize, and register
      // provider exactly once.  The proxy binds a port and cannot safely
      // restart; registerProvider() should not duplicate entries.
      // =================================================================
      if (activeMiddlewares['model-routing'] === true) {
        if (!_modelRouting) {
          _modelRouting = new ModelRoutingMiddleware();
          const mrPluginConfig = (pluginConfig['model-routing'] as Record<string, unknown>) || {};
          const routerPort = typeof mrPluginConfig.port === 'number' ? mrPluginConfig.port : 9000;

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
          _modelRouting
            .initialize({
              enabled: true,
              ...mrPluginConfig,
              pluginApi: api,
            })
            .catch((err) => {
              logger.error('[plugin] Model Routing init failed — middleware will be inert', {
                error: err,
              });
            });
        }
      } else if (isFirstLoad) {
        logger.info('Sapience AI Suite: Model Routing middleware is disabled by config.');
      }

      // =================================================================
      // Guardrail — prompt guard (before_agent_start) + write scanner
      // (before_message_write) + tool parameter scanner (before_tool_call)
      // =================================================================
      if (activeMiddlewares['guardrail'] === true) {
        // Prime the in-memory config cache and subscribe to file changes.
        // All guardrail hooks use getCached() (zero disk I/O) instead of
        // loadSync(). The cache is refreshed automatically when the
        // dashboard or CLI saves config changes.
        GuardrailConfigStore.refreshCache();
        ConfigStore.onChange('guardrail', () => {
          try {
            GuardrailConfigStore.refreshCache();
            logger.info('[plugin] Guardrail config hot-reloaded');
          } catch (err) {
            logger.warn('[plugin] Guardrail hot-reload failed', { error: err });
          }
        });

        tryOn(
          api,
          'before_agent_start',
          createPromptGuardHook() as (...args: unknown[]) => unknown,
          'guardrail:before_agent_start'
        );

        tryOn(
          api,
          'before_agent_start',
          createModerationGuardHook() as (...args: unknown[]) => unknown,
          'guardrail:moderation-guard'
        );

        tryOn(
          api,
          'before_message_write',
          createWriteScannerHook() as (...args: unknown[]) => unknown,
          'guardrail:before_message_write'
        );
      } else if (isFirstLoad) {
        logger.info('Sapience AI Suite: Guardrail middleware is disabled by config.');
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
      // PII Sanitizer — hot-reload watcher (lazily loaded, so register
      // onChange here; the callback only fires if module is loaded).
      // =================================================================
      if (activeMiddlewares['pii-sanitizer'] === true) {
        ConfigStore.onChange('pii_sanitizer', () => {
          if (_piiSanitizerInstance) {
            try {
              _piiSanitizerInstance.reloadPolicy();
              logger.info('[plugin] PII Sanitizer policy hot-reloaded');
            } catch (err) {
              logger.warn('[plugin] PII Sanitizer hot-reload failed', { error: err });
            }
          }
          // Not loaded yet — first dynamic import will pick up current config
        });
      }

      // =================================================================
      // Tool Call Limit — prime cached policy and subscribe to changes.
      // LimitPolicyStore.getCached() is zero-I/O after first call.
      // =================================================================
      if (activeMiddlewares['tool-call-limit'] === true) {
        LimitPolicyStore.refreshCache();
        ConfigStore.onChange('tool_call_limit', () => {
          try {
            LimitPolicyStore.refreshCache();
            logger.info('[plugin] Tool Call Limit policy hot-reloaded');
          } catch (err) {
            logger.warn('[plugin] Tool Call Limit hot-reload failed', { error: err });
          }
        });
      }

      // =================================================================
      // Composed before_tool_call — layer guardrail, PII, limits on top
      // of the HITL hook. Short-circuits on first block.
      // Registers whenever HITL OR any of the new middlewares is active.
      // =================================================================
      {
        const needsToolHook =
          activeMiddlewares.hitl === true ||
          activeMiddlewares['guardrail'] === true ||
          activeMiddlewares['pii-sanitizer'] === true ||
          activeMiddlewares['tool-call-limit'] === true;

        if (needsToolHook) {
          const hitlToolHook = _interceptor ? createToolCallHook(_interceptor) : null;

          const composedToolHook = async (event: any, ctx: any) => {
            // 1. Guardrail parameter scan (if enabled)
            if (activeMiddlewares['guardrail'] === true) {
              try {
                if (!_executeGuardrailScan) {
                  const mod = await import('../middlewares/guardrail/GuardrailInterceptorHook.js');
                  _executeGuardrailScan = mod.executeGuardrailScan;
                }
                const guardrailResult = _executeGuardrailScan(
                  event.toolName || event.tool || '',
                  event.moduleName || '',
                  event.methodName || '',
                  event.params || event.input || {},
                  ctx?.sessionKey,
                  ctx?.agentId
                );
                if (guardrailResult.block) {
                  return { block: true, blockReason: guardrailResult.reason };
                }
                // Escalate → inject forceAsk metadata for HITL
                if (guardrailResult.escalate) {
                  if (!event.metadata) event.metadata = {};
                  event.metadata.forceAsk = true;
                  event.metadata.guardrailReason = guardrailResult.reason;
                }
              } catch (err) {
                logger.warn('[plugin] Guardrail scan error — fail-open', { error: err });
              }
            }

            // 2. PII DLP scan (if enabled)
            if (activeMiddlewares['pii-sanitizer'] === true) {
              try {
                if (!_executePiiScan) {
                  const mod = await import('../middlewares/pii-sanitizer/PiiSanitizerHook.js');
                  _executePiiScan = mod.executePiiScan;
                  _piiSanitizerInstance = mod.piiSanitizer;
                }
                const piiResult = await _executePiiScan(
                  event.toolName || event.tool || '',
                  event.moduleName || '',
                  event.methodName || '',
                  event.params || event.input || {},
                  ctx?.sessionKey,
                  ctx?.agentId
                );
                if (piiResult && piiResult.block) {
                  return { block: true, blockReason: piiResult.reason };
                }
                if (piiResult && piiResult.modified) {
                  event.params = piiResult.params;
                }
              } catch (err) {
                logger.warn('[plugin] PII scan error — fail-open', { error: err });
              }
            }

            // 3. Tool call limit check (if enabled)
            if (activeMiddlewares['tool-call-limit'] === true) {
              try {
                if (!_executeLimitCheck) {
                  const mod = await import('../middlewares/tool-call-limit/ToolCallLimitHook.js');
                  _executeLimitCheck = mod.executeLimitCheck;
                }
                const toolNameForLimit = event.toolName || event.tool || '';
                // Resolve flat OpenClaw tool names (e.g. "write") to module/method
                // using the same mapping HITL uses, with a dot-split fallback.
                const { getToolMapping } = await import('../middlewares/hitl/tool-interceptor.js');
                const toolMap = getToolMapping();
                const mapped = toolMap[toolNameForLimit.toLowerCase()];
                const [modFromName = '', methodFromName = ''] = toolNameForLimit.split('.');
                const resolvedModule = event.moduleName || mapped?.module || modFromName;
                const resolvedMethod = event.methodName || mapped?.method || methodFromName;
                const limitResult = await _executeLimitCheck(
                  toolNameForLimit,
                  resolvedModule,
                  resolvedMethod,
                  event.params || event.input || {},
                  ctx?.sessionKey,
                  ctx?.requestId
                );
                if (limitResult && limitResult.block) {
                  return { block: true, blockReason: limitResult.reason };
                }
              } catch (err) {
                logger.warn('[plugin] Limit check error — fail-open', { error: err });
              }
            }

            // 4. HITL evaluation (if enabled)
            if (hitlToolHook) {
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
