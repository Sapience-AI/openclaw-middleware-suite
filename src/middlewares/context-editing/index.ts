/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Context Editing Middleware — Main Entry Point
 *
 * Single-hook design (openclaw 2026.4.11+): every observable behavior
 * lives in `beforeModelResolve`. The hook fires once per turn, BEFORE
 * the gateway's SessionManager opens the session JSONL. CE walks the
 * JSONL via its own SessionManager.open(), evaluates adaptive triggers,
 * sums each persisted assistant message's `input + output` usage into
 * the per-session counter (the pull-based replacement for the now-
 * unregistered `llm_output` push), and runs compaction inline when the
 * threshold is met — appending the compaction entry via
 * `appendCompaction()`. SM_A hasn't opened yet, so SM_B can append
 * without forking the DAG. When the hook returns, the gateway opens
 * SM_A fresh, picks up the compaction entry, and the current turn's
 * LLM call sees compacted history.
 *
 * Three previously-implemented lifecycle methods were removed:
 *   - `beforeAgentStart` (deprecated upstream; replaced by
 *     `beforeModelResolve`)
 *   - `agentEnd` and `llm_output` (conversation-gated for non-bundled
 *     plugins on 2026.4.27+ — silently dropped at registration)
 *   - `beforePromptBuild`, `beforeToolCall`, and `afterToolCall` (no
 *     longer registered as OpenClaw hooks; the latter two were also
 *     unreachable in practice, and `afterToolCall`'s
 *     `recordToolOutput` accumulator double-counted with the
 *     JSONL-walk's text-based estimate).
 *
 * The class still implements the `Middleware` interface — those slots
 * are all optional, and `MiddlewareRegistry` skips middlewares that
 * don't expose tool-call hooks.
 */

import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';
import { Middleware, ModelResolveContext, ModelResolveResult } from '../../types.js';
import { logger } from '../../shared/Logger.js';
import { getOpenclawHome, getOpenclawDir } from '../../shared/env.js';
import { isSessionStartupMessage } from '../../shared/session-detection.js';
import { stripOpenClawEnvelope } from '../../shared/openclaw-envelope.js';
import { TriggerEvaluator } from './TriggerEvaluator.js';
import { ContextCurator } from './ContextCurator.js';
import { SessionAdapter } from './SessionAdapter.js';
import { ContextEditingStats } from './storage/ContextEditingStats.js';
import { CompactionAuditLog } from './storage/CompactionAuditLog.js';
import { ConfigStore } from '../../shared/storage/ConfigStore.js';
import { DEFAULT_CONTEXT_EDITING_CONFIG, ContextEditingConfig } from './config.js';
import { CompactionResult } from './types.js';
import { diag } from './diagnostic.js';

const MIDDLEWARE_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// pi-coding-agent's SessionManager — structural types describing the
// surface CE consumes. Used by `loadSessionManagerClass()` (called from
// `beforeModelResolve` for the JSONL-pull path) and `requestCompaction`
// (called inline from the same hook). Hoisted to module scope so both
// sites can name the class type without re-declaring it.
// ---------------------------------------------------------------------------
type SessionEntry = {
  type: string;
  id: string;
  parentId: string | null;
  [k: string]: unknown;
};
type SessionHeader = { type: 'session'; id: string; version: number; [k: string]: unknown };
type SessionInstance = {
  buildSessionContext(): { messages: unknown[] };
  getLeafId(): string | null;
  getLeafEntry(): SessionEntry | undefined;
  getHeader(): SessionHeader | null;
  getEntries(): SessionEntry[];
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean
  ): string;
};
type SessionManagerLike = {
  open(file: string): SessionInstance;
};

export class ContextEditingMiddleware implements Middleware {
  readonly name = 'context_editing';
  readonly version = MIDDLEWARE_VERSION;
  private config: ContextEditingConfig = DEFAULT_CONTEXT_EDITING_CONFIG;
  private triggerEvaluator = new TriggerEvaluator();
  private curator = new ContextCurator();
  private sessionAdapter: SessionAdapter | null = null;
  private store = new ContextEditingStats();

  /** Reference to the OpenClaw plugin API — used for LLM calls in ICC extraction */
  private pluginApi: unknown = null;

  /**
   * Sessions currently being compacted by requestCompaction().
   * Prevents recursive trigger evaluation when the compaction agent's
   * own before_model_resolve hook fires back into our middleware.
   */
  private compactingSessionIds = new Set<string>();

  /**
   * Sessions that have received at least one real user message (after
   * filtering out startup and tool_result messages). The pull-based token
   * accumulator (in `beforeModelResolve`) only writes a per-session total
   * for sessions in this set, so the greeting / tool-call exchanges that
   * precede real conversation don't inflate the `tokensSaved` baseline.
   */
  private sessionsWithRealUserMessages = new Set<string>();

  async initialize(config: Record<string, unknown>): Promise<void> {
    // The class is a dumb delegator — it always runs when called. Plugin
    // runtime gating lives upstream in plugin/index.ts wrappers via
    // ContextEditingPolicyStore.isPluginEnabled(); external programmatic
    // users disable by simply not invoking the lifecycle methods.
    this.store.load();
    const overrides = this.store.getConfigOverrides();

    // Merge provided config with defaults and any overrides.
    // Deep-merge nested objects (pruning, compaction) so overrides
    // don't wipe keys set by openclaw.json or defaults.
    const baseConfig = {
      ...DEFAULT_CONTEXT_EDITING_CONFIG,
      ...config,
    } as ContextEditingConfig;
    this.config = {
      ...baseConfig,
      ...overrides,
      icc: { ...baseConfig.icc, ...overrides.icc },
      pruning: { ...baseConfig.pruning, ...overrides.pruning },
      compaction: { ...baseConfig.compaction, ...overrides.compaction },
    } as ContextEditingConfig;

    // Create session adapter from plugin API if available
    if (config.pluginApi) {
      this.pluginApi = config.pluginApi;
      this.sessionAdapter = new SessionAdapter(config.pluginApi);
    }

    diag('INITIALIZE complete', {
      hasSessionAdapter: !!this.sessionAdapter,
      hasPluginApi: !!config.pluginApi,
      triggerMode: this.config.triggerMode,
      tokenThreshold: this.config.tokenThreshold,
      messageThreshold: this.config.messageThreshold,
      pruning: this.config.pruning,
      compaction: this.config.compaction,
      configKeys: Object.keys(config),
      overrideKeys: Object.keys(overrides),
    });

    logger.info('[ContextEditingMiddleware] Initialized', {
      triggerMode: this.config.triggerMode,
      tokenThreshold: this.config.tokenThreshold,
      messageThreshold: this.config.messageThreshold,
    });
  }

  /**
   * Hot-reload config overrides from the store without a full re-initialize.
   * Preserves pluginApi, session adapter, and in-flight compaction state.
   * Called by ConfigStore.onChange when sapience-ai-suite.json changes.
   */
  reloadConfig(): void {
    this.store.load();
    const overrides = this.store.getConfigOverrides();
    this.config = {
      ...this.config,
      ...overrides,
      // Deep-merge nested objects so overrides don't wipe existing keys
      icc: { ...this.config.icc, ...overrides.icc },
      pruning: { ...this.config.pruning, ...overrides.pruning },
      compaction: { ...this.config.compaction, ...overrides.compaction },
    } as ContextEditingConfig;

    logger.info('[ContextEditingMiddleware] Config hot-reloaded', {
      triggerMode: this.config.triggerMode,
      tokenThreshold: this.config.tokenThreshold,
      messageThreshold: this.config.messageThreshold,
      pruning: this.config.pruning,
      compaction: this.config.compaction,
    });
  }

  /**
   * In-process patch — bypasses disk. Shallow-merges `partial` into the
   * current in-memory config; sibling top-level fields (`triggerMode`,
   * `tokenThreshold`, etc.) are preserved. The three nested sub-trees
   * (`icc`, `pruning`, `compaction`) are **deep-merged** to match CE's
   * existing `initialize()` / `reloadConfig()` convention — passing
   * `{ icc: { messagesKeptBeforeCompaction: 5 } }` keeps the rest of `icc`
   * intact instead of wiping `customPrompt`, `customSchema`, etc.
   *
   *   ce.updateConfig({ triggerMode: 'token' });
   *   ce.updateConfig({ icc: { messagesKeptBeforeCompaction: 5 } });
   *
   * For disk-backed updates that survive process restarts (and propagate to
   * other plugin instances watching the same file), use
   * `ContextEditingPolicyStore.update()` + `ce.reloadConfig()` instead.
   *
   * Throws if called before `initialize()`.
   */
  updateConfig(partial: Partial<ContextEditingConfig>): void {
    if (!this.config) {
      throw new Error('ContextEditingMiddleware.updateConfig: call initialize() first');
    }
    this.config = {
      ...this.config,
      ...partial,
      // Deep-merge the three known sub-trees so callers don't have to
      // re-specify every field of `icc` / `pruning` / `compaction` just to
      // tweak one. Matches the same semantics initialize() and reloadConfig()
      // use for these fields.
      icc: { ...this.config.icc, ...(partial.icc ?? {}) },
      pruning: { ...this.config.pruning, ...(partial.pruning ?? {}) },
      compaction: { ...this.config.compaction, ...(partial.compaction ?? {}) },
    } as ContextEditingConfig;

    logger.debug('[ContextEditingMiddleware] In-process config updated', {
      keys: Object.keys(partial),
    });
  }

  getStatus(): { enabled: boolean; stats?: Record<string, unknown> } {
    // The plugin-level on/off check lives upstream in plugin/index.ts via
    // ContextEditingPolicyStore.isPluginEnabled(). Once this middleware is
    // initialized, it is always considered active by the Middleware-interface
    // contract — disable in your own pipeline by not calling its methods.
    return {
      enabled: true,
      stats: this.store.getStats(),
    };
  }

  async shutdown(): Promise<void> {
    // Persist stats only when the plugin-level flag is still on. When the
    // dashboard disables the middleware it also runs cleanupMiddleware(),
    // which deletes the store key — saving here would re-create it.
    const pluginData = ConfigStore.readSync();
    if (pluginData?.plugin_config?.middlewares?.['context-editing'] !== false) {
      this.store.save();
    }
    logger.info('[ContextEditingMiddleware] Shutting down');
  }

  // --- Plugin-Level Hook Handlers (registered in plugin/index.ts) ---

  /**
   * Load-bearing hook on openclaw 2026.4.27+ where `agent_end` and
   * `llm_output` are conversation-gated and silently dropped for non-
   * bundled plugins. `before_model_resolve` is ungated, non-deprecated,
   * and — crucially — fires BEFORE the gateway's SessionManager (SM_A)
   * opens the session JSONL ([run.ts:449](openclaw runs `resolveHookModelSelection`
   * before `attempt.ts:1268` opens SM_A)). That's the only safe window
   * where we can open our own SM_B and append a compaction entry without
   * concurrent-SM-on-same-file (DAG fork).
   *
   * This single hook replaces the previous three-hook pipeline:
   *   - `agent_end` of msg N        → trigger eval + ICC extraction
   *   - schedule for next turn      → `beforeAgentStartCompactions` map
   *   - `before_agent_start` of msg N+1 → consume schedule, run compaction
   *
   * On openclaw <= 2026.4.23 (where the legacy hooks weren't gated yet)
   * this same hook fires too — `before_model_resolve` has been around
   * since at least 2026.2.22 and the dispatch site is unchanged across
   * the supported peerDep range. So a single registration works on
   * every supported version.
   *
   * Per-turn assistant token tracking (formerly via `llm_output`) is
   * also pulled here: we walk the JSONL entries and sum each assistant
   * message's `input + output` usage into the store's per-session
   * accumulator. `consumeAccumulatedUsage()` reads it at compaction
   * time for the UI-aligned `tokensSaved` metric — same precision as
   * the previous push-based path.
   */
  async beforeModelResolve(context: ModelResolveContext): Promise<ModelResolveResult | void> {
    try {
      const sessionKey = context.sessionKey;
      if (!sessionKey) return;

      // Recursion guard — when `requestCompaction` spins up the compaction
      // agent's own LLM run, that run's `before_model_resolve` re-enters
      // here. Bail to avoid scheduling another compaction inside the one
      // we just started.
      if (this.compactingSessionIds.has(sessionKey)) {
        diag('beforeModelResolve: skipping — session is mid-compaction', { sessionKey });
        return;
      }

      const sessionId = (context.sessionId as string) || undefined;
      const agentId = (context.agentId as string) || 'main';
      if (!sessionId) {
        diag('beforeModelResolve: skipping — no sessionId in ctx', { sessionKey });
        return;
      }

      // Resolve the session JSONL file path. Same path the gateway will
      // open as SM_A in a few hundred microseconds — but our SM_B is
      // closed before SM_A opens, so they never overlap.
      const path = await import('path');
      const fs = await import('fs');
      const os = await import('os');
      const openclawHome =
        getOpenclawHome() || getOpenclawDir() || path.join(os.homedir(), '.openclaw');
      const sessionFile = path.join(
        openclawHome,
        'agents',
        agentId,
        'sessions',
        `${sessionId}.jsonl`
      );

      if (!fs.existsSync(sessionFile)) {
        // First-ever turn for this session — no transcript on disk yet,
        // nothing to count, nothing to compact.
        diag('beforeModelResolve: session file not found (first turn)', {
          sessionKey,
          sessionFile,
        });
        return;
      }

      // Lazy-load pi-coding-agent's SessionManager class. Same resolution
      // logic as `requestCompaction()` — anchored to OpenClaw's process
      // entry point (`process.argv[1]`) so we find the version actually
      // running, not whatever might be in our own node_modules.
      const SessionManagerClass = await this.loadSessionManagerClass();
      if (!SessionManagerClass) {
        diag('beforeModelResolve: SessionManager class unavailable — skipping', {
          sessionKey,
        });
        return;
      }

      const sm = SessionManagerClass.open(sessionFile);
      const messages = sm.buildSessionContext().messages;
      const entries = sm.getEntries();

      diag('beforeModelResolve ENTERED', {
        sessionKey,
        sessionId,
        rawMessageCount: messages.length,
        entryCount: entries.length,
      });

      // ── Filter conversation messages (drop startup, tool_result-as-user,
      // already-compacted prefix). Same helper agent_end used.
      const conversationMessages = this.filterMessagesForICC(messages);
      let userMessageCount = 0;
      for (const msg of conversationMessages) {
        if ((msg as Record<string, unknown>).role === 'user') userMessageCount++;
      }

      if (userMessageCount >= 1) {
        this.sessionsWithRealUserMessages.add(sessionKey);
      }

      // ── Pull-based assistant token tracking (replaces llm_output push).
      // Walk every persisted assistant message in the JSONL and sum its
      // `input + output` usage. The pull model overwrites the per-session
      // counter each turn (rather than incrementing) because we're reading
      // the full transcript, not a per-turn delta. `consumeAccumulatedUsage`
      // at compaction time still reads + resets the counter as before.
      if (this.sessionsWithRealUserMessages.has(sessionKey)) {
        const totalAssistantUsage = this.computeAssistantUsageFromEntries(entries);
        if (totalAssistantUsage > 0) {
          this.store.setAccumulatedUsage(sessionKey, totalAssistantUsage);
        }
      }

      // ── Adaptive trigger evaluation. Same TriggerEvaluator math agent_end
      // ran; the only difference is the source (filtered messages from
      // SM_B vs. context.messages from agent_end's event arg).
      const estimatedTokens = this.estimateTokens(
        conversationMessages
          .map((m) => this.extractCleanedTextForICC(m as Record<string, unknown>))
          .join(' ')
      );
      this.triggerEvaluator.syncSessionStats(sessionKey, userMessageCount, estimatedTokens);

      const buffer = this.triggerEvaluator.getSessionBuffer(sessionKey);
      const stats = { messageCount: buffer.messageCount, tokenCount: buffer.estimatedTokens };
      diag('beforeModelResolve: session stats', {
        sessionKey,
        userMessageCount: stats.messageCount,
        userMessageDelta: stats.messageCount - buffer.baselineMessageCount,
        tokenCount: stats.tokenCount,
        tokenDelta: stats.tokenCount - buffer.baselineTokens,
      });

      const trigger = this.triggerEvaluator.shouldCompact(sessionKey, stats, this.config);
      diag('beforeModelResolve: trigger evaluation', {
        trigger: trigger || '(null - no trigger)',
        configTriggerMode: this.config.triggerMode,
        configMessageThreshold: this.config.messageThreshold,
        configTokenThreshold: this.config.tokenThreshold,
      });

      if (!trigger) return;

      logger.info('[ContextEditingMiddleware] Trigger threshold met — running ICC pipeline', {
        sessionKey,
        trigger,
        stats,
      });

      // Build transcripts for ICC extraction (same shape agent_end used).
      const transcript = conversationMessages
        .map((m) => this.extractTextFromMessage(m as Record<string, unknown>))
        .join('\n\n');

      const iccInputTranscript = conversationMessages
        .map((msg) => {
          const m = msg as Record<string, unknown>;
          const role = String(m.role || '');
          const text = this.extractCleanedTextForICC(m).trim();
          if (!text) return '';
          return `${role}:\n${text}`;
        })
        .filter(Boolean)
        .join('\n\n');

      diag('beforeModelResolve: filtered messages for ICC', {
        totalMessages: messages.length,
        conversationMessages: conversationMessages.length,
        filtered: messages.length - conversationMessages.length,
      });

      // Run ICC extraction (LLM call to the compaction model).
      const iccResult = await this.curator.curate(
        transcript,
        this.config.icc,
        trigger,
        this.pluginApi
      );

      diag('beforeModelResolve: ICC pipeline complete — running compaction inline', {
        sessionKey,
        entityCount: iccResult.extractedEntities.length,
        conflictCount: iccResult.resolvedConflicts.length,
        priorityCount: iccResult.prioritySegments.length,
      });

      // Run compaction synchronously — pre-SM_A, so it's safe to open SM_B
      // and append. When this hook returns, the gateway opens SM_A fresh,
      // reads the just-written compaction entry, and the current turn's
      // LLM call sees compacted history (matches the 4.11 agent_end →
      // before_agent_start two-hop in a single hop).
      await this.requestCompaction(
        sessionKey,
        context as Record<string, unknown>,
        iccResult,
        iccInputTranscript
      );
    } catch (err) {
      logger.error('[ContextEditingMiddleware] beforeModelResolve error', { error: err });
    }
  }

  /**
   * Sum `input + output` usage on every persisted assistant message in
   * the JSONL entry list. Replaces the `llm_output` push-based path on
   * openclaw 2026.4.27+ (where that hook is conversation-gated). Each
   * entry's `message.usage` is the same provider-reported usage object
   * that `llm_output` would have pushed to us per turn — so precision
   * matches `'assistant-output-accumulated'`, not the
   * `'fallback-estimate'` path.
   */
  private computeAssistantUsageFromEntries(entries: unknown[]): number {
    let total = 0;
    for (const raw of entries) {
      const entry = raw as Record<string, unknown> | null;
      if (!entry || typeof entry !== 'object') continue;
      if (entry.type !== 'message') continue;
      const message = entry.message as
        | { role?: string; usage?: Record<string, unknown> }
        | undefined;
      if (!message || message.role !== 'assistant') continue;
      const usage = message.usage;
      if (!usage || typeof usage !== 'object') continue;
      // Provider-reported usage uses `input`/`output` (pi-ai normalized
      // shape) — sum both. cacheRead/cacheWrite are intentionally excluded
      // (full request cost vs. compaction-eligible tokens; the previous
      // push-based path drew the same line).
      const input = typeof usage.input === 'number' ? usage.input : 0;
      const output = typeof usage.output === 'number' ? usage.output : 0;
      total += input + output;
    }
    return total;
  }

  /**
   * Lazy-load (and cache) pi-coding-agent's `SessionManager` class.
   * Resolves from the OpenClaw host process's entry point, not our own
   * node_modules — this keeps us bound to whichever version is actually
   * running. `requestCompaction` uses the same loader; we call it here
   * so `beforeModelResolve` doesn't have to duplicate the resolution
   * logic.
   */
  private cachedSessionManagerClass: SessionManagerLike | null = null;
  private async loadSessionManagerClass(): Promise<SessionManagerLike | null> {
    if (this.cachedSessionManagerClass) return this.cachedSessionManagerClass;
    try {
      const path = await import('path');
      const fs = await import('fs');

      // Anchor candidates for createRequire. We try both the raw
      // `process.argv[1]` AND its realpath:
      //
      //  - On pnpm installs (e.g. `~/.local/share/pnpm/global/N/node_modules/
      //    openclaw/dist/index.js`), `process.argv[1]` is the public symlink
      //    path. Node walks parent node_modules from there, but pnpm's
      //    hoisted openclaw deps live under `.pnpm/openclaw@<ver>_<peer>/
      //    node_modules/` — those parent dirs aren't in the symlink chain
      //    and are skipped by the standard resolver.
      //  - The realpath of `process.argv[1]` lands inside `.pnpm/openclaw@.../
      //    node_modules/openclaw/dist/`, and from there `resolve.paths`
      //    finds the sibling `@mariozechner/pi-coding-agent` symlink that
      //    pnpm placed in the same `.pnpm/openclaw@.../node_modules/` dir.
      //
      // OpenClaw 2026.5.x changed the pnpm path shape (added a peer-dep
      // suffix on the openclaw .pnpm folder) and the symlink-only anchor
      // stopped resolving sibling deps; including the realpath fixes that
      // without breaking npm/yarn flat-layout installs (where realpath ==
      // raw path, so the second attempt is a no-op).
      const rawAnchor = process.argv[1];
      const anchors = new Set<string>();
      if (rawAnchor) {
        anchors.add(rawAnchor);
        try {
          const real = fs.realpathSync(rawAnchor);
          if (real) anchors.add(real);
        } catch {
          /* realpath may fail on missing/permissioned anchors; ignore */
        }
      }

      for (const anchor of anchors) {
        try {
          const hostRequire = createRequire(anchor);
          const searchPaths = hostRequire.resolve.paths('@mariozechner/pi-coding-agent');
          if (!searchPaths) continue;

          const entryPath = searchPaths
            .map((dir: string) =>
              path.join(dir, '@mariozechner', 'pi-coding-agent', 'dist', 'index.js')
            )
            .find((p: string) => fs.existsSync(p));
          if (!entryPath) continue;

          const mod = await import(pathToFileURL(entryPath).href);
          if (mod?.SessionManager?.open) {
            this.cachedSessionManagerClass = mod.SessionManager as SessionManagerLike;
            return this.cachedSessionManagerClass;
          }
        } catch {
          continue;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  // --- Accessors for CLI commands ---

  /** Get the store instance (for CLI stats/entities/reset commands) */
  getStore(): ContextEditingStats {
    return this.store;
  }

  /** Get the current configuration */
  getConfig(): ContextEditingConfig {
    return this.config;
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  private estimateTokens(result: unknown): number {
    const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
    return Math.ceil(text.split(/\s+/).length * 1.3);
  }

  /**
   * Extracts text content from a message, explicitly dropping 'thinking', 'toolUse', etc.
   */
  private extractTextFromMessage(message: unknown): string {
    const m = message as { role?: string; content?: unknown; summary?: string };
    if (!m) return '';
    // Compaction summary messages use 'summary' instead of 'content'
    if (!m.content && typeof m.summary === 'string') return m.summary;
    if (!m.content) return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return (
        m.content
          // Only keep 'text' blocks. This explicitly drops 'thinking', 'toolUse', etc.
          .filter((block) => block && typeof block === 'object' && block.type === 'text')
          .map((block) => block.text || '')
          .join('\n')
      );
    }
    return '';
  }

  /**
   * Dedicated normalization helper for user text used only by ICC and audit.
   * Cleans the control-ui transport envelope so the middleware analyzes only
   * real user content.
   *
   * Delegates to the shared `stripOpenClawEnvelope` utility so the timestamp
   * regex and the inbound-meta sentinel list stay in lock-step with what
   * Model Routing's scorer also strips. The shared utility covers all six
   * sentinel headers OpenClaw emits (Sender, Conversation info, Thread
   * starter, Replied message, Forwarded message context, Chat history) —
   * a strict superset of the two patterns this method previously handled
   * inline.
   */
  private extractCleanedTextForICC(message: Record<string, unknown>): string {
    const raw = this.extractTextFromMessage(message);
    return stripOpenClawEnvelope(raw);
  }

  // ---------------------------------------------------------------------------
  // Workspace / System File Filtering
  // ---------------------------------------------------------------------------

  /**
   * Bootstrap/workspace filenames that OpenClaw loads at session start.
   * These are normally in the system prompt, but the agent may also Read them
   * via tool_use/tool_result pairs — those pairs should be excluded from ICC.
   */
  private static readonly WORKSPACE_FILE_PATTERNS: RegExp[] = [
    // Exact bootstrap file names (case-insensitive)
    /\b(?:AGENTS|SOUL|CLAUDE|TOOLS|IDENTITY|USER|HEARTBEAT|BOOTSTRAP|MEMORY)\.md\b/i,
    // OpenClaw config/workspace dot-files
    /\.openclaw(?:rc|\.json|\.ya?ml)?$/i,
    // Common system prompt / instruction files
    /\b(?:system[_-]?prompt|instructions|SYSTEM)\.(?:md|txt)\b/i,
    // Any path under the openclaw workspace directory
    /\/workspace\//i,
    /\.openclaw\/workspace\//i,
    // Memory directory files
    /\/memory\/[\w.-]+\.md$/i,
  ];

  /**
   * Filter messages to exclude workspace/system content from the ICC pipeline.
   *
   * Removes:
   *  1. compactionSummary messages (role = "compactionSummary")
   *  2. tool_use/tool_result pairs where the tool reads a known workspace file
   *     (Read tool with file_path matching bootstrap patterns)
   *  3. system role messages if any are present
   */
  private filterMessagesForICC(rawMessages: unknown[]): unknown[] {
    // Single pass: skip the startup sequence and any already-compacted
    // messages before the last compaction summary.
    let startIndex = 0;
    let lastCompactionSummaryIndex = -1;
    for (let i = 0; i < rawMessages.length; i++) {
      const m = rawMessages[i] as Record<string, unknown>;
      if (m.role === 'user' && isSessionStartupMessage(this.extractTextFromMessage(m))) {
        let j = i + 1;
        while (
          j < rawMessages.length &&
          (rawMessages[j] as Record<string, unknown>).role !== 'user'
        ) {
          j++;
        }
        startIndex = j;
        i = j - 1;
      }
      if (m.role === 'compactionSummary') {
        lastCompactionSummaryIndex = i;
      }
    }
    if (lastCompactionSummaryIndex >= startIndex) {
      // Mirror the requestCompaction boundary: when messagesKeptBeforeCompaction
      // > 0, walk back N user messages from the compaction summary so the
      // next ICC pass sees the same messages that survived in the JSONL.
      const keepN = Math.max(0, this.config.icc?.messagesKeptBeforeCompaction ?? 0);
      let snapTo = lastCompactionSummaryIndex;
      if (keepN > 0) {
        let seen = 0;
        for (let i = lastCompactionSummaryIndex - 1; i >= startIndex; i--) {
          const m = rawMessages[i] as Record<string, unknown>;
          if (m.role !== 'user') continue;
          seen++;
          if (seen === keepN) {
            snapTo = i;
            break;
          }
        }
      }
      startIndex = snapTo;
    }
    const messages = rawMessages.slice(startIndex);

    // First pass: collect tool_use IDs that read workspace files
    const workspaceToolUseIds = new Set<string>();

    for (const msg of messages) {
      const m = msg as Record<string, unknown>;

      // Check message-level content array for tool_use entries
      const content = m.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (this.isWorkspaceFileToolUse(b)) {
            const id = (b.id || b.tool_use_id || b.toolUseId) as string;
            if (id) workspaceToolUseIds.add(id);
          }
        }
      }

      // Check top-level tool_use (some message formats use flat structure)
      if (this.isWorkspaceFileToolUse(m)) {
        const id = (m.id || m.tool_use_id || m.toolUseId) as string;
        if (id) workspaceToolUseIds.add(id);
      }
    }

    // Second pass: filter out excluded messages
    return messages.filter((msg) => {
      const m = msg as Record<string, unknown>;
      const textContent = this.extractTextFromMessage(m).trim();

      // Include compaction summaries — the ICC needs to see previous entities,
      // conflicts, and priorities so it can carry them forward across compaction
      // boundaries.  Without this, the second compaction loses all context from
      // the first compaction's ICC extraction.

      // Filter: system messages
      if (m.role === 'system') return false;

      // Filter: tool results containing workspace boilerplate text
      const role = String(m.role || '').toLowerCase();
      if (role === 'toolresult') {
        if (
          /^# \b(?:AGENTS|SOUL|CLAUDE|TOOLS|IDENTITY|USER|HEARTBEAT|BOOTSTRAP|MEMORY)\.md\b - /i.test(
            textContent
          )
        ) {
          return false;
        }
      }

      // Filter: tool results that correspond to workspace file reads
      if (workspaceToolUseIds.size > 0) {
        // Check content array for tool_result blocks
        const content = m.content;
        if (Array.isArray(content)) {
          const hasWorkspaceResult = content.some((block) => {
            const b = block as Record<string, unknown>;
            const type = String(b.type || '')
              .toLowerCase()
              .replace(/[_-]/g, '');
            const refId = (b.tool_use_id || b.toolUseId) as string;
            return type === 'toolresult' && refId && workspaceToolUseIds.has(refId);
          });
          if (hasWorkspaceResult) return false;
        }

        // Check top-level tool result
        const role = String(m.role || '').toLowerCase();
        const topRefId = (m.toolCallId || m.tool_use_id || m.toolUseId) as string;
        if (role === 'toolresult' && topRefId && workspaceToolUseIds.has(topRefId)) {
          return false;
        }
      }

      // Filter: tool_use messages that read workspace files (remove the request too)
      const content = m.content;
      if (Array.isArray(content)) {
        const allBlocksAreWorkspaceReads =
          content.length > 0 &&
          content.every((block) => {
            const b = block as Record<string, unknown>;
            return this.isWorkspaceFileToolUse(b) || String(b.type || '') === 'text';
          }) &&
          content.some((block) => this.isWorkspaceFileToolUse(block as Record<string, unknown>));
        if (allBlocksAreWorkspaceReads) return false;
      }
      if (this.isWorkspaceFileToolUse(m)) return false;

      return true;
    });
  }

  /**
   * Check if a message block is a tool_use that reads a known workspace file.
   */
  private isWorkspaceFileToolUse(block: Record<string, unknown>): boolean {
    const type = String(block.type || '')
      .toLowerCase()
      .replace(/[_-]/g, '');
    if (type !== 'tooluse' && type !== 'toolcall') return false;

    const toolName = String(block.name || block.tool || '').toLowerCase();
    if (toolName !== 'read' && toolName !== 'read_file' && toolName !== 'readfile') return false;

    // Extract file path from input/args/arguments
    const input = (block.input || block.args || block.arguments || {}) as Record<string, unknown>;
    const filePath = String(input.file_path || input.filePath || input.path || input.file || '');

    if (!filePath) return false;

    return ContextEditingMiddleware.WORKSPACE_FILE_PATTERNS.some((pattern) =>
      pattern.test(filePath)
    );
  }

  // ---------------------------------------------------------------------------
  // Compaction Triggering
  // ---------------------------------------------------------------------------

  /**
   * Write a compaction entry to the session JSONL using pi-coding-agent's
   * SessionManager, with the ICC extraction result as the summary.
   *
   * Bypasses pi-coding-agent's compaction pipeline (findCutPoint /
   * generateSummary) entirely — the middleware produces its own summary
   * via buildICCSection, then appends + hardens the boundary so
   * buildSessionContext() drops all prior messages.
   *
   * Session file resolution order:
   *   1. hookCtx.sessionFile (if the gateway ever exposes it)
   *   2. OPENCLAW_HOME env var + well-known layout
   *   3. ~/.openclaw fallback
   *
   * Called from onBeforeAgentStart — before OpenClaw's own SessionManager
   * opens the JSONL, so no DAG fork risk.
   *
   * Marks the session in compactingSessionIds to prevent recursive
   * trigger evaluation.
   */
  private async requestCompaction(
    sessionKey: string,
    hookCtx: Record<string, unknown>,
    iccResult: CompactionResult,
    iccInputTranscript?: string
  ): Promise<void> {
    const sessionId = hookCtx.sessionId as string | undefined;
    if (!sessionId) {
      logger.warn(
        '[ContextEditingMiddleware] Cannot request compaction — no sessionId in hook context',
        {
          sessionKey,
        }
      );
      return;
    }

    const agentId = (hookCtx.agentId as string) || 'main';

    // --- Recursion guard (Issue 3) ---
    this.compactingSessionIds.add(sessionKey);

    try {
      // --- Session file resolution (Issue 2) ---
      const path = await import('path');
      const fs = await import('fs');

      let sessionFile: string | undefined;

      // 1. hookCtx.sessionFile (future-proofing — not in PluginHookAgentContext today)
      if (typeof hookCtx.sessionFile === 'string' && hookCtx.sessionFile) {
        sessionFile = hookCtx.sessionFile;
      }

      // 2. Construct from OPENCLAW_HOME env var or ~/.openclaw fallback
      if (!sessionFile) {
        const os = await import('os');
        const openclawHome =
          getOpenclawHome() || getOpenclawDir() || path.join(os.homedir(), '.openclaw');
        sessionFile = path.join(openclawHome, 'agents', agentId, 'sessions', `${sessionId}.jsonl`);
      }

      // Verify the transcript exists.
      if (!fs.existsSync(sessionFile)) {
        logger.warn('[ContextEditingMiddleware] Session file not found — skipping compaction', {
          sessionKey,
          sessionId,
          sessionFile,
        });
        return;
      }

      diag('requestCompaction: resolved session file', {
        sessionKey,
        sessionId,
        sessionFile,
      });

      // Build compaction summary directly from ICC extraction result.
      // This bypasses pi-coding-agent's compaction pipeline entirely —
      // no keepRecentTokens / findCutPoint / safeguard chain needed.
      const summary = this.buildICCSection(iccResult);

      // The rendered summary is the single source of truth — mirror it into
      // the result so the audit log, CLI, and dashboard all show exactly
      // what the agent saw after compaction.
      iccResult.iccInstruction = summary;
      iccResult.instructionHash = createHash('sha256').update(summary).digest('hex').slice(0, 16);

      diag('requestCompaction: ICC summary built', {
        sessionKey,
        summaryLength: summary.length,
        entityCount: iccResult.extractedEntities.length,
        conflictCount: iccResult.resolvedConflicts.length,
        priorityCount: iccResult.prioritySegments.length,
      });

      // Resolve pi-coding-agent's SessionManager class via the shared
      // `loadSessionManagerClass()` helper (also used by
      // `beforeModelResolve`). The helper caches the resolved class on
      // first use, so subsequent calls are essentially free.
      const SessionManagerClass = await this.loadSessionManagerClass();
      if (!SessionManagerClass) {
        diag('requestCompaction: SessionManager not available', {
          argv1: process.argv[1],
        });
        logger.warn(
          '[ContextEditingMiddleware] SessionManager not available — could not resolve @mariozechner/pi-coding-agent'
        );
        return;
      }

      // Open the session file, estimate tokens, and get the current leaf
      const sm = SessionManagerClass.open(sessionFile);
      const sessionMessages = sm.buildSessionContext().messages;
      const tokensBefore = this.estimateTokens(
        sessionMessages.map((m: unknown) => JSON.stringify(m)).join('')
      );
      const leafId = sm.getLeafId();

      if (!leafId) {
        logger.warn('[ContextEditingMiddleware] Cannot compact — session has no leaf entry', {
          sessionKey,
          sessionFile,
        });
        return;
      }

      diag('requestCompaction: appending compaction via SessionManager', {
        sessionKey,
        tokensBefore,
        leafId,
        messageCount: sessionMessages.length,
      });

      // Append the compaction entry to the session JSONL.
      // firstKeptEntryId is set to leafId as a placeholder — hardened below.
      const compactionEntryId = sm.appendCompaction(
        summary,
        leafId,
        tokensBefore,
        { readFiles: [], modifiedFiles: [] },
        false
      );

      // Harden boundary: rewrite firstKeptEntryId. Default behavior sets it
      // to the compaction entry's own id (drop everything prior). When
      // icc.messagesKeptBeforeCompaction > 0, instead point it at the Nth-
      // most-recent user message entry so those turns survive compaction.
      let firstKeptEntryId = compactionEntryId;
      {
        const refreshedSm = SessionManagerClass.open(sessionFile);
        const header = refreshedSm.getHeader();
        const entries = refreshedSm.getEntries();
        let hardened = false;

        const keepN = Math.max(0, this.config.icc.messagesKeptBeforeCompaction ?? 0);
        if (keepN > 0) {
          // Find compaction entry index, then walk backwards counting user messages.
          const compactionIdx = entries.findIndex(
            (e) => e.type === 'compaction' && e.id === compactionEntryId
          );
          if (compactionIdx > 0) {
            let seen = 0;
            for (let i = compactionIdx - 1; i >= 0; i--) {
              const e = entries[i] as Record<string, unknown>;
              if (e.type !== 'message') continue;
              const msg = e.message as { role?: string } | undefined;
              if (msg?.role !== 'user') continue;
              seen++;
              if (seen === keepN) {
                firstKeptEntryId = String(e.id);
                break;
              }
            }
          }
          diag('requestCompaction: messagesKeptBeforeCompaction applied', {
            sessionKey,
            keepN,
            resolvedFirstKeptEntryId: firstKeptEntryId,
            fellBack: firstKeptEntryId === compactionEntryId,
          });
        }

        if (header) {
          const rewrittenEntries = entries.map((entry) => {
            if (entry.type !== 'compaction' || entry.id !== compactionEntryId) {
              return entry;
            }
            hardened = true;
            return { ...entry, firstKeptEntryId };
          });

          if (hardened) {
            const content =
              [JSON.stringify(header), ...rewrittenEntries.map((e) => JSON.stringify(e))].join(
                '\n'
              ) + '\n';
            const tmpFile = `${sessionFile}.compaction-tmp`;
            fs.writeFileSync(tmpFile, content, 'utf8');
            fs.renameSync(tmpFile, sessionFile);
          }
        }

        diag('requestCompaction: boundary hardened', {
          sessionKey,
          compactionEntryId,
          firstKeptEntryId,
          hardened,
        });
      }

      // Compaction succeeded — compute savings and write audit log
      const tokensAfter = this.estimateTokens(summary);

      // The next request that reaches the Model Routing proxy will see a new
      // first user message and derive a new MR session ID — by design.
      // Pinned tier, momentum, and three-strike state reset at this boundary;
      // see handler.ts `extractSessionId` for the full rationale. Flag is
      // surfaced here so operators investigating mid-conversation tier flips
      // can grep for `routingSessionWillReanchor` and correlate timestamps.
      logger.info('[ContextEditingMiddleware] Compaction completed successfully', {
        sessionKey,
        tokensBefore,
        tokensAfter,
        firstKeptEntryId,
        routingSessionWillReanchor: true,
      });

      let tokensSaved = 0;
      let tokensSavedSource: 'assistant-output-accumulated' | 'fallback-estimate' =
        'fallback-estimate';

      // Try UI-aligned savings: consume ALL accumulated assistant usage
      const uiAligned = this.store.consumeAccumulatedUsage(sessionKey);
      if (uiAligned !== null) {
        // Subtract the actual compaction summary that now lives in context.
        const summaryTokens = this.estimateTokens(summary);
        tokensSaved = Math.max(0, uiAligned - summaryTokens);
        tokensSavedSource = 'assistant-output-accumulated';
      }

      // Fallback: use token counts from buffer estimate
      if (tokensSaved === 0 && tokensSavedSource === 'fallback-estimate') {
        const tokensBeforeEstimate =
          tokensBefore ?? this.triggerEvaluator.getSessionBuffer(sessionKey).estimatedTokens;
        const tokensAfterEstimate = tokensAfter ?? Math.floor(tokensBeforeEstimate * 0.4);
        tokensSaved = Math.max(0, tokensBeforeEstimate - tokensAfterEstimate);
      }

      // Record compaction in store (entity counts, timestamp, etc.)
      this.store.recordCompaction(sessionKey, iccResult);

      // Store savings in session history
      const history = this.store.getSessionHistory(sessionKey);
      if (history) {
        const cumulativeTokensSaved = (history.cumulativeTokensSaved ?? 0) + tokensSaved;
        history.lastTokensSaved = tokensSaved;
        history.cumulativeTokensSaved = cumulativeTokensSaved;
        history.lastTokensBeforeEstimate = tokensBefore;
        history.lastTokensAfterEstimate = tokensAfter;
        history.lastSavingsSource = tokensSavedSource;
        this.store.save();
      }

      // Write savings to audit log
      CompactionAuditLog.append({
        timestamp: new Date().toISOString(),
        sessionKey,
        trigger: iccResult.trigger,
        instructionHash: iccResult.instructionHash,
        iccInstruction: iccResult.iccInstruction,
        iccInputTranscript,
        extractedEntities: iccResult.extractedEntities,
        resolvedConflicts: iccResult.resolvedConflicts,
        prioritySegments: iccResult.prioritySegments,
        entitiesPreserved: iccResult.extractedEntities.length,
        tokensSaved,
        tokensSavedSource,
        tokensBeforeEstimate: tokensBefore,
        tokensAfterEstimate: tokensAfter,
        firstKeptEntryId,
      }).catch((err) => {
        logger.warn('[ContextEditingMiddleware] Failed to write savings audit log', { error: err });
      });

      diag('requestCompaction: compaction result', {
        sessionKey,
        ok: true,
        compacted: true,
        tokensBefore,
        tokensAfter,
        firstKeptEntryId,
        tokensSaved,
        tokensSavedSource,
      });

      // Always reset trigger state after a compaction attempt, regardless
      // of outcome. The legacy `pendingCompactions` /
      // `beforeAgentStartCompactions` maps used by the agent_end →
      // before_agent_start scheduling pattern are gone — the new flow runs
      // compaction inline within `before_model_resolve`, so there's
      // nothing to drain here.
      this.triggerEvaluator.resetSession(sessionKey);
    } catch (err) {
      logger.error('[ContextEditingMiddleware] requestCompaction error', { error: err });
    } finally {
      // Always clear the recursion guard
      this.compactingSessionIds.delete(sessionKey);
    }
  }

  /**
   * Build the full ICC section used as the compaction summary.
   * Includes all three pillars: priority preservation, conflict resolutions, and entity locks.
   */
  private buildICCSection(result: CompactionResult): string {
    const lines: string[] = [];

    lines.push('# Compaction Summary (from previous conversations)');
    lines.push('');

    // Custom-prompt mode: render whatever sections the user's schema produced.
    if (result.dynamicSections) {
      for (const [key, items] of Object.entries(result.dynamicSections)) {
        if (!Array.isArray(items) || items.length === 0) continue;
        lines.push(`### ${key}`);
        for (const item of items) {
          const rendered = typeof item === 'string' ? item : JSON.stringify(item);
          lines.push(`- ${rendered}`);
        }
        lines.push('');
      }
      return lines.join('\n');
    }

    // Priority preservation
    if (result.prioritySegments.length > 0) {
      lines.push('### Goal/Priority Segments');
      for (const segment of result.prioritySegments) {
        lines.push(`- ${segment}`);
      }
      lines.push('');
    }

    // Conflict resolutions
    if (result.resolvedConflicts.length > 0) {
      lines.push('### Resolved Conflicts');
      for (const conflict of result.resolvedConflicts) {
        lines.push(`- ${conflict.original} → ${conflict.resolved}`);
      }
      lines.push('');
    }

    // Entity locks
    if (result.extractedEntities.length > 0) {
      lines.push('### Entity Locks');
      for (const entity of result.extractedEntities) {
        lines.push(`- [${entity.type}] ${entity.name}: \`${entity.value}\``);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
