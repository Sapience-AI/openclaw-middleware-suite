/**
 * Context Editing Middleware — Main Entry Point
 *
 * Implements the Middleware interface for pipeline integration, plus additional
 * methods for plugin-level hooks (before_agent_start, before_prompt_build,
 * agent_end, llm_output).
 *
 * Two-phase compaction design:
 *  - `onAgentEnd` (fire-and-forget) evaluates adaptive triggers using the
 *    complete message set (including the current turn's response) and
 *    schedules compaction for the next turn's before_agent_start.
 *  - `onBeforeAgentStart` (awaited, runs BEFORE SessionManager opens the
 *    JSONL) executes the scheduled compaction.  Because no SM exists yet,
 *    our SessionManager.open can safely access the JSONL — no DAG fork.
 *    The next turn's user message lands AFTER the compaction summary.
 *  - `onBeforePromptBuild` syncs session stats (no trigger evaluation or
 *    compaction here).
 *  - `onLlmOutput` records per-turn assistant token usage for savings.
 */

import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { Middleware, MiddlewareContext, MiddlewareResult } from '../../types.js';
import { logger } from '../../shared/Logger.js';
import { getOpenclawHome, getOpenclawDir } from '../../shared/env.js';
import { TriggerEvaluator } from './TriggerEvaluator.js';
import { ContextCurator } from './ContextCurator.js';
import { SessionAdapter } from './SessionAdapter.js';
import { ContextEditingStore } from './storage/ContextEditingStore.js';
import { CompactionAuditLog } from './storage/CompactionAuditLog.js';
import { ConfigStore } from '../../shared/storage/ConfigStore.js';
import { DEFAULT_CONTEXT_EDITING_CONFIG, ContextEditingConfig } from './config.js';
import { CompactionResult } from './types.js';
import { diag } from './diagnostic.js';

const MIDDLEWARE_VERSION = '1.0.0';

export class ContextEditingMiddleware implements Middleware {
  readonly name = 'context_editing';
  readonly version = MIDDLEWARE_VERSION;

  private enabled = true;
  private config: ContextEditingConfig = DEFAULT_CONTEXT_EDITING_CONFIG;
  private triggerEvaluator = new TriggerEvaluator();
  private curator = new ContextCurator();
  private sessionAdapter: SessionAdapter | null = null;
  private store = new ContextEditingStore();

  /** Reference to the OpenClaw plugin API — used for LLM calls in ICC extraction */
  private pluginApi: unknown = null;

  /** Most recent compaction result per session for middleware-triggered compaction. */
  private pendingCompactions = new Map<string, CompactionResult>();

  /**
   * Compaction requests to execute in the before_agent_start hook of the
   * NEXT turn.  Populated by agent_end (fire-and-forget) when the trigger
   * fires, consumed by onBeforeAgentStart (awaited, runs BEFORE the
   * SessionManager opens the JSONL).  This two-phase approach avoids:
   *  1. DAG forking — no concurrent SessionManager access
   *  2. Message loss — the triggering turn's messages are already in the
   *     JSONL when compaction runs, and the next turn's user message
   *     lands AFTER the compaction summary
   */
  private beforeAgentStartCompactions = new Map<
    string,
    {
      hookCtx: Record<string, unknown>;
      iccResult: CompactionResult;
      iccInputTranscript: string;
    }
  >();

  /**
   * Sessions currently being compacted by requestCompaction().
   * Prevents recursive trigger evaluation when the compaction agent's
   * own before_prompt_build hook fires back into our middleware.
   */
  private compactingSessionIds = new Set<string>();

  /**
   * Sessions that have received at least one real user message (after
   * filtering out startup and tool_result messages). onLlmOutput only
   * accumulates assistant output tokens for sessions in this set so
   * that the greeting and tool-call responses don't inflate savings.
   */
  private sessionsWithRealUserMessages = new Set<string>();

  /**
   * Tracks the main agent's runId for each session so that onLlmOutput
   * can distinguish the main agent's late-arriving llm_output (which
   * should still be accumulated) from the compaction agent's llm_output
   * (which should be skipped).
   *
   * OpenClaw dispatches llm_output fire-and-forget (no await) in
   * attempt.ts, so it can arrive AFTER agent_end has already added the
   * session to compactingSessionIds.  Without this runId check, the
   * main agent's final turn tokens are lost, producing tokensSaved: 0.
   */
  private mainAgentRunIds = new Map<string, string>();

  async initialize(config: Record<string, unknown>): Promise<void> {
    this.enabled = config.enabled !== false;
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
      enabled: this.enabled,
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

  // --- Standard Middleware Pipeline Hooks ---

  async beforeToolCall(_context: MiddlewareContext): Promise<MiddlewareResult> {
    if (!this.enabled) return { block: false };
    // Pass-through — trigger evaluation is done in onAgentEnd
    return { block: false };
  }

  async afterToolCall(context: MiddlewareContext, result: unknown): Promise<void> {
    try {
      if (!this.enabled || !context.sessionKey) return;
      // Estimate tokens from tool result to refine session buffer
      const estimatedTokens = this.estimateTokens(result);
      this.triggerEvaluator.recordToolOutput(context.sessionKey, estimatedTokens);
    } catch (err) {
      logger.warn('[ContextEditingMiddleware] afterToolCall error (suppressed)', { error: err });
    }
  }

  getStatus(): { enabled: boolean; stats?: Record<string, unknown> } {
    return {
      enabled: this.enabled,
      stats: this.store.getStats(),
    };
  }

  async shutdown(): Promise<void> {
    // Only persist state if middleware is still enabled.
    // When disabling via dashboard, cleanupMiddleware() deletes the store key —
    // saving here would re-create it.
    const pluginData = ConfigStore.readSync();
    if (pluginData?.plugin_config?.middlewares?.['context-editing'] !== false) {
      this.store.save();
    }
    logger.info('[ContextEditingMiddleware] Shutting down');
  }

  // --- Plugin-Level Hook Handlers (registered in plugin/index.ts) ---

  /**
   * Called by the before_prompt_build lifecycle hook on EVERY agent turn.
   * Responsible for:
   *  1) Syncing session stats (message count, token estimate)
   *  2) ICC prompt injection — returns { appendSystemContext } to inject entity
   *     locks and conflict resolution directives into the system prompt.
   *
   * NOTE: Trigger evaluation has moved to onAgentEnd, which sees ALL messages
   * (including the current turn's response).  Compaction execution has moved
   * to onBeforeAgentStart, which runs before the SessionManager opens the
   * JSONL (no DAG fork risk).
   *
   * Hook signature: handler(event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext)
   *   event (arg0) = { prompt, messages[] }
   *   ctx   (arg1) = { runId?, agentId?, sessionKey?, sessionId?, workspaceDir?, ... }
   *
   * Returns: { appendSystemContext?: string } — merged into the system prompt.
   */
  async onBeforePromptBuild(
    event: unknown,
    hookCtx: unknown
  ): Promise<{ appendSystemContext?: string } | void> {
    if (!this.enabled) return;

    try {
      const ctxObj = hookCtx as Record<string, unknown>;
      const eventObj = event as { prompt?: string; messages?: unknown[] };
      const sessionKey = ctxObj?.sessionKey as string | undefined;

      diag('onBeforePromptBuild ENTERED', {
        sessionKey: sessionKey || '(missing)',
        rawMessageCount: eventObj?.messages?.length,
        hasPrompt: !!eventObj?.prompt,
      });

      if (!sessionKey) return;

      // Track the main agent's runId so onLlmOutput can distinguish
      // the main agent's late-arriving output from the compaction
      // agent's output (both share the same sessionKey).
      const runId = ctxObj?.runId as string | undefined;
      if (runId) {
        this.mainAgentRunIds.set(sessionKey, runId);
      }

      // --- Recursion Guard (Issue 3) ---
      // If this session is currently being compacted by our own
      // requestCompaction(), skip trigger evaluation entirely so we
      // don't re-trigger a compaction loop.
      if (this.compactingSessionIds.has(sessionKey)) {
        diag('onBeforePromptBuild: skipping — session is mid-compaction', { sessionKey });
        return;
      }

      // --- Adaptive Trigger Evaluation ---
      if (eventObj?.messages) {
        // Filter FIRST, then count — raw messages[] includes the startup
        // sequence and tool_result messages (role='user' in Anthropic API
        // format) which inflate the count and fire the trigger too early.
        const conversationMessagesForCount = this.filterMessagesForICC(eventObj.messages);
        let userMessageCount = 0;
        for (const msg of conversationMessagesForCount) {
          if ((msg as Record<string, unknown>).role === 'user') userMessageCount++;
        }

        // Mark the session as having real user messages so that onLlmOutput
        // starts accumulating tokens. This ensures we skip the greeting and
        // tool-call assistant responses that precede real conversation.
        if (userMessageCount >= 1) {
          this.sessionsWithRealUserMessages.add(sessionKey);
        }

        // Estimate tokens from clean conversation text only — not raw JSON.
        // JSON.stringify(eventObj.messages) would include IDs, timestamps,
        // thinking blocks, and JSON punctuation, artificially inflating the count.
        const estimatedTokens = this.estimateTokens(
          conversationMessagesForCount
            .map((m) => this.extractCleanedTextForICC(m as Record<string, unknown>))
            .join(' ')
        );
        this.triggerEvaluator.syncSessionStats(sessionKey, userMessageCount, estimatedTokens);

        const buffer = this.triggerEvaluator.getSessionBuffer(sessionKey);
        const stats = { messageCount: buffer.messageCount, tokenCount: buffer.estimatedTokens };
        diag('onBeforePromptBuild: session stats', {
          sessionKey,
          userMessageCount: stats.messageCount,
          userMessageDelta: stats.messageCount - buffer.baselineMessageCount,
          tokenCount: stats.tokenCount,
          tokenDelta: stats.tokenCount - buffer.baselineTokens,
        });

        // Trigger evaluation has moved to onAgentEnd — it sees ALL
        // messages (including the current turn's response) and schedules
        // compaction for the next turn's before_agent_start, which runs
        // BEFORE the SessionManager opens the JSONL (no DAG fork risk).
      }

      // --- ICC Prompt Injection --- [DISABLED: testing compaction summary without ICC]
      // Reuse the ICC result generated for the pending middleware-triggered compaction.
      // const pending = this.pendingCompactions.get(sessionKey);
      // if (pending && pending.extractedEntities.length > 0) {
      //   const iccSection = this.buildICCSection(pending);
      //   diag('onBeforePromptBuild: injecting ICC into system prompt', {
      //     sessionKey,
      //     entityCount: pending.extractedEntities.length,
      //     sectionLength: iccSection.length,
      //   });
      //
      //   logger.info('[ContextEditingMiddleware] Injecting ICC directives via appendSystemContext', {
      //     sessionKey,
      //     entityCount: pending.extractedEntities.length,
      //     trigger: pending.trigger,
      //   });
      //
      //   return { appendSystemContext: iccSection };
      // }
    } catch (err) {
      logger.error('[ContextEditingMiddleware] onBeforePromptBuild error', { error: err });
    }
  }

  /**
   * Called by the before_agent_start hook at the START of each turn,
   * BEFORE the SessionManager opens the JSONL file.  This is the safe
   * window to run compaction — no SM_A exists yet, so
   * delegateCompactionToRuntime can open its own SM without forking the
   * DAG.  The hook is AWAITED by OpenClaw, so compaction completes
   * before the turn proceeds.
   *
   * Hook signature: handler(event: PluginHookBeforeAgentStartEvent, ctx: PluginHookAgentContext)
   *   event (arg0) = { prompt }
   *   ctx   (arg1) = { runId?, agentId?, sessionKey?, sessionId?, workspaceDir?, ... }
   */
  async onBeforeAgentStart(_event: unknown, hookCtx: unknown): Promise<void> {
    if (!this.enabled) return;

    try {
      const ctxObj = hookCtx as Record<string, unknown>;
      const sessionKey = ctxObj?.sessionKey as string | undefined;

      diag('onBeforeAgentStart ENTERED', {
        sessionKey: sessionKey || '(missing)',
        hasPendingCompaction: sessionKey ? this.beforeAgentStartCompactions.has(sessionKey) : false,
      });

      if (!sessionKey) return;

      const scheduled = this.beforeAgentStartCompactions.get(sessionKey);
      if (!scheduled) {
        diag('onBeforeAgentStart: no compaction scheduled for this session', { sessionKey });
        return;
      }

      this.beforeAgentStartCompactions.delete(sessionKey);

      diag('onBeforeAgentStart: executing scheduled compaction (pre-SM)', { sessionKey });

      try {
        await this.requestCompaction(
          sessionKey,
          scheduled.hookCtx,
          scheduled.iccResult,
          scheduled.iccInputTranscript
        );
      } catch (err) {
        logger.error('[ContextEditingMiddleware] before_agent_start compaction failed', {
          sessionKey,
          error: err,
        });
      }

      // Clear pending ICC so it doesn't leak into the new turn
      this.pendingCompactions.delete(sessionKey);
    } catch (err) {
      logger.error('[ContextEditingMiddleware] onBeforeAgentStart error', { error: err });
    }
  }

  /**
   * Called by the agent_end lifecycle hook AFTER the LLM response has been
   * persisted to the JSONL file.  Evaluates adaptive triggers using the
   * complete message set (including the current turn's response) and
   * schedules compaction for the NEXT turn's before_agent_start hook.
   *
   * This is fire-and-forget — OpenClaw does not await agent_end.
   *
   * Hook signature: handler(event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext)
   *   event (arg0) = { messages[], success, error?, durationMs? }
   *   ctx   (arg1) = { runId?, agentId?, sessionKey?, sessionId?, workspaceDir?, ... }
   */
  async onAgentEnd(event: unknown, hookCtx: unknown): Promise<void> {
    if (!this.enabled) return;

    try {
      const ctxObj = hookCtx as Record<string, unknown>;
      const eventObj = event as { messages?: unknown[]; success?: boolean; durationMs?: number };
      const sessionKey = ctxObj?.sessionKey as string | undefined;

      diag('onAgentEnd ENTERED', {
        sessionKey: sessionKey || '(missing)',
        messageCount: eventObj?.messages?.length,
        success: eventObj?.success,
        durationMs: eventObj?.durationMs,
      });

      if (!sessionKey) return;

      // --- Recursion Guard ---
      if (this.compactingSessionIds.has(sessionKey)) {
        diag('onAgentEnd: skipping — session is mid-compaction', { sessionKey });
        return;
      }

      // --- Adaptive Trigger Evaluation ---
      // Evaluate here instead of before_prompt_build so the trigger sees
      // ALL messages including the current turn's response.  If it fires,
      // schedule compaction for the next turn's before_agent_start (which
      // runs before SM_A opens — no DAG fork).
      if (eventObj?.messages) {
        const conversationMessages = this.filterMessagesForICC(eventObj.messages);
        let userMessageCount = 0;
        for (const msg of conversationMessages) {
          if ((msg as Record<string, unknown>).role === 'user') userMessageCount++;
        }

        if (userMessageCount >= 1) {
          this.sessionsWithRealUserMessages.add(sessionKey);
        }

        const estimatedTokens = this.estimateTokens(
          conversationMessages
            .map((m) => this.extractCleanedTextForICC(m as Record<string, unknown>))
            .join(' ')
        );
        this.triggerEvaluator.syncSessionStats(sessionKey, userMessageCount, estimatedTokens);

        const buffer = this.triggerEvaluator.getSessionBuffer(sessionKey);
        const stats = { messageCount: buffer.messageCount, tokenCount: buffer.estimatedTokens };
        diag('onAgentEnd: session stats', {
          sessionKey,
          userMessageCount: stats.messageCount,
          userMessageDelta: stats.messageCount - buffer.baselineMessageCount,
          tokenCount: stats.tokenCount,
          tokenDelta: stats.tokenCount - buffer.baselineTokens,
        });

        const trigger = this.triggerEvaluator.shouldCompact(sessionKey, stats, this.config);
        diag('onAgentEnd: trigger evaluation', {
          trigger: trigger || '(null - no trigger)',
          configTriggerMode: this.config.triggerMode,
          configMessageThreshold: this.config.messageThreshold,
          configTokenThreshold: this.config.tokenThreshold,
        });

        if (
          trigger &&
          !this.pendingCompactions.has(sessionKey) &&
          !this.beforeAgentStartCompactions.has(sessionKey)
        ) {
          logger.info('[ContextEditingMiddleware] Trigger threshold met — running ICC pipeline', {
            sessionKey,
            trigger,
            stats,
          });

          const transcript = conversationMessages
            .map((m) => this.extractTextFromMessage(m))
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

          diag('onAgentEnd: filtered messages for ICC', {
            totalMessages: eventObj.messages.length,
            conversationMessages: conversationMessages.length,
            filtered: eventObj.messages.length - conversationMessages.length,
          });

          const iccResult = await this.curator.curate(
            transcript,
            this.config.icc,
            trigger,
            this.pluginApi
          );
          this.pendingCompactions.set(sessionKey, iccResult);

          diag('onAgentEnd: ICC pipeline complete — scheduling compaction for before_agent_start', {
            sessionKey,
            entityCount: iccResult.extractedEntities.length,
            conflictCount: iccResult.resolvedConflicts.length,
            priorityCount: iccResult.prioritySegments.length,
          });

          this.beforeAgentStartCompactions.set(sessionKey, {
            hookCtx: ctxObj as Record<string, unknown>,
            iccResult,
            iccInputTranscript,
          });
        }
      }
    } catch (err) {
      logger.error('[ContextEditingMiddleware] onAgentEnd error', { error: err });
    }
  }

  /**
   * Called by the llm_output hook to record exact per-turn assistant message usage.
   * This is used later to calculate UI-aligned token savings during compaction.
   */
  async onLlmOutput(event: unknown, hookCtx: unknown): Promise<void> {
    if (!this.enabled) return;
    try {
      const ctxObj = hookCtx as Record<string, unknown>;
      const sessionKey = ctxObj?.sessionKey as string | undefined;

      if (!sessionKey) return;

      // Skip the compaction agent's own LLM output — its tokens are not
      // part of the user conversation and should not inflate savings.
      // However, the main agent's llm_output may arrive LATE because
      // OpenClaw dispatches it fire-and-forget (no await in attempt.ts).
      // It can land after agent_end has already added the session to
      // compactingSessionIds.  We use the runId to distinguish:
      //   - same runId as the main agent → late main output, accumulate
      //   - different runId → compaction agent's output, skip
      if (this.compactingSessionIds.has(sessionKey)) {
        const eventRunId = ctxObj?.runId as string | undefined;
        const mainRunId = this.mainAgentRunIds.get(sessionKey);
        if (!mainRunId || mainRunId !== eventRunId) {
          diag('onLlmOutput: skipping — compaction agent output', {
            sessionKey,
            eventRunId,
            mainRunId,
          });
          return;
        }
        diag('onLlmOutput: accumulating late main-agent output during compaction', {
          sessionKey,
          runId: eventRunId,
        });
      }

      // Skip if no real user message has been seen yet — the greeting and
      // tool-call responses should not count toward token savings.
      if (!this.sessionsWithRealUserMessages.has(sessionKey)) {
        diag('onLlmOutput: skipping — no real user messages yet', { sessionKey });
        return;
      }

      // PluginHookLlmOutputEvent shape:
      //   usage?: { input?, output?, cacheRead?, cacheWrite?, total? }
      //   total = input + output + cacheRead + cacheWrite (full API call cost)
      //   We accumulate input + output only. cacheRead/cacheWrite and
      //   full usage.total remain excluded from the savings numerator.
      const eventObj = event as {
        usage?: { input?: number; output?: number; total?: number };
      };

      const inputTokens = eventObj?.usage?.input ?? 0;
      const outputTokens = eventObj?.usage?.output ?? 0;
      const inputPlusOutputTokens = inputTokens + outputTokens;
      if (!inputPlusOutputTokens) return;

      diag('onLlmOutput: recording assistant input+output usage', {
        sessionKey,
        input: inputTokens,
        output: outputTokens,
        inputPlusOutput: inputPlusOutputTokens,
        total: eventObj.usage?.total,
      });

      // Accumulate INPUT + OUTPUT only. This keeps the existing gate while
      // still excluding cache tokens and full request cost from savings.
      this.store.accumulateAssistantUsage(sessionKey, inputPlusOutputTokens);
    } catch (err) {
      logger.error('[ContextEditingMiddleware] onLlmOutput error', { error: err });
    }
  }

  // --- Accessors for CLI commands ---

  /** Get the store instance (for CLI stats/entities/reset commands) */
  getStore(): ContextEditingStore {
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
   */
  private extractCleanedTextForICC(message: Record<string, unknown>): string {
    let text = this.extractTextFromMessage(message);

    // Remove the `Sender (untrusted metadata):` block including optional
    // markdown code fences:  ```json\n{...}\n```
    const senderMetaRegex =
      /Sender \(untrusted metadata\):\s*(?:```json?\s*)?\{[\s\S]*?\}\s*(?:```\s*)?/;
    text = text.replace(senderMetaRegex, '').trim();

    // Remove leading `[Sat 2026-04-04 23:28 UTC]`-style timestamp envelopes
    const timestampRegex = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]\s*/;
    text = text.replace(timestampRegex, '').trim();

    return text;
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
      if (
        m.role === 'user' &&
        this.extractTextFromMessage(m)
          .trim()
          .startsWith('A new session was started via /new or /reset')
      ) {
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
      // (Previously filtered out: if (m.role === 'compactionSummary') return false;)

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

      diag('requestCompaction: ICC summary built', {
        sessionKey,
        summaryLength: summary.length,
        entityCount: iccResult.extractedEntities.length,
        conflictCount: iccResult.resolvedConflicts.length,
        priorityCount: iccResult.prioritySegments.length,
      });

      // Import SessionManager from pi-coding-agent (openclaw's dependency).
      // The package lives in OpenClaw's node_modules, not ours. Use
      // createRequire anchored to the host process entry point to resolve
      // the path, then native import() to load it (ESM-safe).
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
      let SessionManagerClass: SessionManagerLike | null = null;

      // Resolve from OpenClaw's process entry point. The package's exports
      // map has no CJS main, so require.resolve() fails — use resolve.paths()
      // to get the node_modules search dirs and locate the entry file directly.
      const anchors = [process.argv[1]].filter(Boolean);
      for (const anchor of anchors) {
        try {
          const hostRequire = createRequire(anchor);
          const searchPaths = hostRequire.resolve.paths('@mariozechner/pi-coding-agent');
          if (!searchPaths) continue;

          const entryPath = searchPaths
            .map((dir) => path.join(dir, '@mariozechner', 'pi-coding-agent', 'dist', 'index.js'))
            .find((p) => fs.existsSync(p));
          if (!entryPath) continue;

          const mod = await import(pathToFileURL(entryPath).href);
          diag('requestCompaction: pi-coding-agent resolved', {
            anchor,
            entryPath,
            hasSessionManager: !!mod?.SessionManager,
            hasOpen: !!mod?.SessionManager?.open,
            exportKeys: mod ? Object.keys(mod).slice(0, 15) : [],
          });
          if (mod?.SessionManager?.open) {
            SessionManagerClass = mod.SessionManager as SessionManagerLike;
            break;
          }
        } catch (resolveErr) {
          diag('requestCompaction: pi-coding-agent resolve failed', {
            anchor,
            error: resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
          });
          continue;
        }
      }

      if (!SessionManagerClass) {
        diag('requestCompaction: SessionManager not available', { anchors });
        logger.warn(
          '[ContextEditingMiddleware] SessionManager not available — could not resolve @mariozechner/pi-coding-agent',
          { anchors }
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

      logger.info('[ContextEditingMiddleware] Compaction completed successfully', {
        sessionKey,
        tokensBefore,
        tokensAfter,
        firstKeptEntryId,
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

      // Always reset state after a compaction attempt, regardless of outcome
      this.triggerEvaluator.resetSession(sessionKey);
      this.pendingCompactions.delete(sessionKey);
      this.beforeAgentStartCompactions.delete(sessionKey);
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
      lines.push('### Priority Preservation');
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
