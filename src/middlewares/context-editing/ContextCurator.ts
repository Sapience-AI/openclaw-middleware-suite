/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Context Editing Middleware — Intelligent Context Curation (ICC) Engine
 *
 * Uses a single LLM call via the OpenClaw plugin API to extract entities,
 * detect conflicts, and identify priority segments from the conversation.
 * Falls back to regex-based extraction when the plugin API is unavailable
 * (e.g., in tests or offline mode).
 *
 * Three pillars:
 *  1. Weighted Importance — classifies conversation segments by priority
 *  2. Conflict Resolution — detects instruction overrides
 *  3. Entity Preservation — extracts and locks technical specifics
 */

import {
  ContextEditingConfig,
  DEFAULT_ICC_SYSTEM_PROMPT,
  DEFAULT_ICC_SCHEMA_JSON,
} from './config.js';
import {
  EntityLock,
  EntityType,
  ConflictResolution,
  CompactionResult,
  CompactionTrigger,
} from './types.js';
import { logger } from '../../shared/Logger.js';
import { ICC_EXTRACTION_MARKER } from '../../shared/icc-detection.js';
import { diag } from './diagnostic.js';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';

// ---------------------------------------------------------------------------
// LLM extraction types
// ---------------------------------------------------------------------------

/** Minimal interface for the plugin API — avoids importing OpenClaw types directly */
interface PluginApiForLLM {
  runtime: {
    agent: {
      runEmbeddedPiAgent: (params: Record<string, unknown>) => Promise<{
        payloads?: Array<{ text?: string; isError?: boolean; isReasoning?: boolean }>;
        meta?: Record<string, unknown>;
      }>;
    };
  };
  config?: Record<string, unknown>;
}

/** Shape of the LLM JSON response */
interface LLMExtractionResult {
  entities: Array<{ name: string; type: string; value: string }>;
  conflicts: Array<{ original: string; override: string; resolved: string }>;
  priorities: string[];
}

// ---------------------------------------------------------------------------
// Valid entity types for LLM output validation
// ---------------------------------------------------------------------------

const VALID_ENTITY_TYPES: Set<string> = new Set<string>([
  'api_endpoint',
  'variable_name',
  'file_path',
  'constant',
  'model_name',
  'code_identifier',
]);

// ---------------------------------------------------------------------------
// Regex patterns for entity extraction (fallback)
// ---------------------------------------------------------------------------

/** Patterns to exclude from entity extraction (prevents system prompts/workspace paths from leaking) */
const EXCLUDED_ENTITY_PATTERNS: RegExp[] = [
  /\.openclaw\b/i, // OpenClaw workspace/config paths
  /\b(?:SOUL|USER|IDENTITY|MEMORY|AGENTS|CLAUDE|TOOLS|HEARTBEAT|BOOTSTRAP)\.md\b/i,
  /^\/dev\/null$/, // Device paths
  /\/sessions\/[a-f0-9-]+\.jsonl$/i, // Session file paths
  /\/\.openclaw\/workspace\//i, // Workspace directory paths
  /\/\.openclaw\/agents\//i, // Agent directory paths
];

/** URLs: http(s)://... */
const URL_PATTERN = /https?:\/\/[^\s"'`<>)\]},]+/g;

/** File paths: /path/to/... or C:\..., D:\... */
const FILE_PATH_PATTERN = /(?:\/[\w.-]+){2,}|[A-Z]:\\(?:[\w.-]+\\?)+/g;

/** Environment variables: process.env.VAR, $VAR, ${VAR} */
const ENV_VAR_PATTERN = /(?:process\.env\.([A-Z_][A-Z0-9_]*)|(?<!\w)\$\{?([A-Z_][A-Z0-9_]*)\}?)/g;

/** Numeric constants in assignment context: = 3000, = 8080, PORT = ... */
const CONSTANT_PATTERN = /\b([A-Z_][A-Z0-9_]*)\s*[:=]\s*(\d{2,})\b/g;

/** Model identifiers: common provider/model patterns */
const MODEL_PATTERN = /\b(?:openrouter|anthropic|openai|google|meta|mistral)\/[\w./-]+\b/gi;

/** Network ports: port 8080, port is 3000 */
const PORT_PATTERN = /\b(?:port)\s+(?:is|should be|:|=|to)?\s*(\d{2,5})\b/gi;

// ---------------------------------------------------------------------------
// Conflict detection patterns (fallback)
// ---------------------------------------------------------------------------

const OVERRIDE_PATTERNS = [
  /instead of (?:using )?"?([^".,\n]+)"?,?\s*(?:use|we'll use|switch to|go with)\s+"?([^".,\n]+)"?/gi,
  /change\s+(?:the\s+)?([^\s]+)\s+(?:from\s+)?(\S+)\s+to\s+(\S+)/gi,
  /(?:actually|no[,.]?\s*(?:wait|actually))[,.]?\s*(?:use|set|change to)\s+(.+?)(?:\.|$)/gim,
  /(?:scratch that|disregard (?:the )?(?:previous|above|last))[.,]?\s*(.+?)(?:\.|$)/gim,
  /(\w+)\s+(?:is )?no longer\s+(\S+)[.,;]?\s*(?:(?:it'?s|now|use)\s+(\S+))?/gi,
  /(?:port|PORT)\s+(?:changed|updated|switched)\s+(?:from\s+)?(\d+)\s*(?:→|->|to)\s*(\d+)/gi,
];

// ---------------------------------------------------------------------------
// Priority detection patterns (fallback — task markers)
// ---------------------------------------------------------------------------

const TASK_MARKERS = [
  /\b(?:TODO|FIXME|HACK|XXX|NOTE)\b[:\s]*(.+)/gi,
  /\b(?:REQUIREMENT|OBJECTIVE|ACTION ITEM|GOAL)[:\s]*(.+)/gi,
  /\b(?:MUST|SHALL|REQUIRED)[:\s]+(.+)/gi,
];

const SYSTEM_INSTRUCTION_PATTERN = /^(?:system|instruction|directive|rule)[:\s]/im;

// ---------------------------------------------------------------------------
// LLM extraction prompt
// ---------------------------------------------------------------------------

const LLM_EXTRACTION_SYSTEM_PROMPT = DEFAULT_ICC_SYSTEM_PROMPT;

/**
 * Compose the final prompt sent to the LLM. Same injection pattern for both
 * the built-in and custom extraction paths: instructions first, then a
 * schema block, then the transcript. Keeps instructions and schema editable
 * as separate fields in the UI/CLI without the user having to stitch them
 * together inside a single textarea.
 */
function composeExtractionPrompt(
  instructions: string,
  schema: string,
  transcript: string,
  options: { includeMarker: boolean } = { includeMarker: false },
): string {
  // ICC_EXTRACTION_MARKER is a sentinel for Model Routing's scoring override:
  // when the call is going through MR (target provider = "sai-router"), the
  // marker tells MR to force SIMPLE tier instead of scoring the transcript
  // content. MR also strips the marker before forwarding upstream, so the
  // LLM never sees it.
  //
  // For non-MR targets (e.g., direct anthropic/openai), we omit the marker
  // entirely — it would just be unexplained noise in the LLM prompt that
  // could (rarely) confuse the model or get echoed back.
  const body = `${instructions}\n\nReturn ONLY valid JSON matching this schema (no markdown fences, no commentary):\n${schema}\n\nTRANSCRIPT:\n${transcript}`;
  return options.includeMarker ? `${ICC_EXTRACTION_MARKER}\n\n${body}` : body;
}

/** A single LLM target — provider/model pair, or empty for openclaw default. */
interface ExtractionTarget {
  provider?: string;
  model?: string;
}

/**
 * Resolve LLM targets for ICC extraction calls, in priority order.
 *
 *   1. `agents.defaults.compaction.model` — the user's explicit compaction
 *      model override (set via `sai context-editing model --set`, the
 *      init wizard, or the dashboard).
 *   2. `agents.defaults.model.primary` — the agent's primary chat model,
 *      used as a fallback when (1) is unset or fails at runtime.
 *
 * Honoring (1) lets the user route compaction through a cheaper / faster
 * model than chat. Falling back to (2) on failure means a misconfigured
 * compaction model (wrong id, bad API key, provider down) silently
 * downgrades to the primary model instead of degrading all the way to
 * regex extraction.
 *
 * Returns up to 2 targets, deduplicated. Targets without a `provider/model`
 * separator are emitted as `{}` so openclaw falls back to its own default
 * model resolution for that attempt.
 */
function resolveExtractionTargets(api: PluginApiForLLM): ExtractionTarget[] {
  const cfgAgents = (api.config as Record<string, unknown>)?.agents as
    | Record<string, unknown>
    | undefined;
  const cfgDefaults = cfgAgents?.defaults as Record<string, unknown> | undefined;
  const compactionModel = (cfgDefaults?.compaction as Record<string, unknown>)?.model as
    | string
    | undefined;
  const primaryModel = (cfgDefaults?.model as Record<string, unknown>)?.primary as
    | string
    | undefined;

  const seen = new Set<string>();
  const out: ExtractionTarget[] = [];
  for (const raw of [compactionModel, primaryModel]) {
    if (!raw) continue;
    const key = raw;
    if (seen.has(key)) continue;
    seen.add(key);
    if (raw.includes('/')) {
      const slashIdx = raw.indexOf('/');
      out.push({ provider: raw.slice(0, slashIdx), model: raw.slice(slashIdx + 1) });
    } else {
      // Malformed (no "provider/model" separator) — skip rather than emit
      // a half-resolved target. Openclaw will use its default model when
      // the entire targets list is empty.
    }
  }
  return out;
}

/** True iff the resolved provider routes through MR (sai-router/*). */
function targetUsesMR(target: ExtractionTarget): boolean {
  return target.provider === 'sai-router';
}

export class ContextCurator {
  /**
   * Main entry point: curate a transcript and produce a CompactionResult.
   * Uses LLM extraction when pluginApi is available, falls back to regex otherwise.
   */
  async curate(
    transcript: string,
    config: ContextEditingConfig['icc'],
    trigger: CompactionTrigger = 'manual',
    pluginApi?: unknown
  ): Promise<CompactionResult> {
    let entities: EntityLock[] = [];
    let conflicts: ConflictResolution[] = [];
    let prioritySegments: string[] = [];
    let dynamicSections: Record<string, unknown[]> | undefined;

    const api = pluginApi as PluginApiForLLM | undefined;
    const customEnabled =
      !!config.customPrompt?.enabled &&
      !!config.customPrompt?.instructions?.trim() &&
      !!config.customPrompt?.schema?.trim();

    // --- Custom prompt path: user-supplied instructions + schema ---------
    if (customEnabled) {
      if (!api?.runtime?.agent?.runEmbeddedPiAgent) {
        diag('curate: custom prompt enabled but no plugin API — skipping silently');
      } else {
        try {
          dynamicSections = await this.extractViaCustomPrompt(
            transcript,
            api,
            config.customPrompt.instructions,
            config.customPrompt.schema
          );
          diag('curate: custom prompt extraction succeeded', {
            sectionKeys: dynamicSections ? Object.keys(dynamicSections) : [],
          });
        } catch (err) {
          // Silent fail per spec — no regex fallback.
          diag('curate: custom prompt extraction failed (silent)', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {
        trigger,
        iccInstruction: '',
        extractedEntities: [],
        resolvedConflicts: [],
        prioritySegments: [],
        instructionHash: '',
        timestamp: new Date().toISOString(),
        dynamicSections,
      };
    }

    // --- Default path: built-in extraction -------------------------------
    if (api?.runtime?.agent?.runEmbeddedPiAgent) {
      try {
        const llmResult = await this.extractViaLLM(transcript, api);
        if (llmResult) {
          entities = config.entityPreservation ? llmResult.entities : [];
          conflicts = config.conflictResolution ? llmResult.conflicts : [];
          prioritySegments = config.weightedImportance ? llmResult.priorities : [];

          diag('curate: LLM extraction succeeded', {
            entityCount: entities.length,
            conflictCount: conflicts.length,
            priorityCount: prioritySegments.length,
          });
        }
      } catch (err) {
        logger.warn('[ContextCurator] LLM extraction failed, falling back to regex', {
          error: err,
        });
        diag('curate: LLM extraction failed, falling back to regex', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fallback: regex extraction if LLM didn't produce results
    if (entities.length === 0 && conflicts.length === 0 && prioritySegments.length === 0) {
      entities = config.entityPreservation ? this.extractEntities(transcript) : [];

      const messages = this.splitMessages(transcript);
      conflicts = config.conflictResolution ? this.detectConflicts(messages) : [];

      prioritySegments = config.weightedImportance ? this.extractPrioritySegments(transcript) : [];

      diag('curate: regex fallback used', {
        entityCount: entities.length,
        conflictCount: conflicts.length,
        priorityCount: prioritySegments.length,
      });
    }

    return {
      trigger,
      iccInstruction: '',
      extractedEntities: entities,
      resolvedConflicts: conflicts,
      prioritySegments,
      instructionHash: '',
      timestamp: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Custom prompt extraction (user-supplied instructions + schema)
  // ---------------------------------------------------------------------------

  /**
   * Run a single LLM call using the user's custom system instructions and
   * output schema. Returns a map of top-level schema keys to arrays — the
   * shape the user requested. No validation beyond "must be JSON object
   * with array values"; the user owns their schema.
   */
  private async extractViaCustomPrompt(
    transcript: string,
    api: PluginApiForLLM,
    instructions: string,
    schema: string
  ): Promise<Record<string, unknown[]>> {
    const runId = `icc-extract-custom-${Date.now()}`;
    const tmpDir = path.join(os.tmpdir(), `openclaw-icc-${runId}`);

    try {
      await fs.mkdir(tmpDir, { recursive: true });
      const sessionFile = path.join(tmpDir, 'session.jsonl');

      // Try each target in order: compaction.model first, then primary as
      // fallback. Marker is only included for sai-router/* targets so MR
      // can detect-and-strip it.
      const targets = resolveExtractionTargets(api);
      const attempts: ExtractionTarget[] = targets.length > 0 ? targets : [{}];
      let lastErr: unknown = new Error('No extraction targets resolved');

      for (let i = 0; i < attempts.length; i++) {
        const target = attempts[i];
        const isFallback = i > 0;
        try {
          const prompt = composeExtractionPrompt(instructions, schema, transcript, {
            includeMarker: targetUsesMR(target),
          });
          const result = await api.runtime.agent.runEmbeddedPiAgent({
            sessionId: runId,
            sessionFile,
            workspaceDir: os.tmpdir(),
            prompt,
            timeoutMs: 30_000,
            runId,
            disableTools: true,
            streamParams: { temperature: 0.2, maxTokens: 4000 },
            ...(target.provider ? { provider: target.provider } : {}),
            ...(target.model ? { model: target.model } : {}),
          });

          const text = (result.payloads ?? [])
            .filter((p) => !p.isError && !p.isReasoning && typeof p.text === 'string')
            .map((p) => p.text ?? '')
            .join('\n')
            .trim();

          if (!text) throw new Error('LLM returned empty response');

          const jsonText = this.stripCodeFences(text);
          const parsed = JSON.parse(jsonText);

          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Parsed output is not a JSON object');
          }

          // Coerce into Record<string, unknown[]> — only keep array-valued keys.
          const out: Record<string, unknown[]> = {};
          for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
            if (Array.isArray(val)) out[key] = val;
          }
          if (isFallback) {
            logger.info('[ContextCurator] custom-prompt extraction succeeded on fallback target', {
              fallbackProvider: target.provider,
              fallbackModel: target.model,
            });
          }
          return out;
        } catch (err) {
          lastErr = err;
          diag('extractViaCustomPrompt: target attempt failed', {
            attemptIndex: i,
            attemptProvider: target.provider,
            attemptModel: target.model,
            error: err instanceof Error ? err.message : String(err),
          });
          // Loop continues to the next target.
        }
      }
      throw lastErr;
    } finally {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  // ---------------------------------------------------------------------------
  // LLM-based extraction
  // ---------------------------------------------------------------------------

  /**
   * Extract entities, conflicts, and priorities via a single LLM call.
   * Returns null if the LLM response cannot be parsed.
   */
  private async extractViaLLM(
    transcript: string,
    api: PluginApiForLLM
  ): Promise<{
    entities: EntityLock[];
    conflicts: ConflictResolution[];
    priorities: string[];
  } | null> {
    const runId = `icc-extract-${Date.now()}`;
    const tmpDir = path.join(os.tmpdir(), `openclaw-icc-${runId}`);

    try {
      await fs.mkdir(tmpDir, { recursive: true });
      const sessionFile = path.join(tmpDir, 'session.jsonl');

      // Try each target in order: compaction.model first, then primary as
      // fallback. Marker is only included for sai-router/* targets so MR
      // can detect-and-strip it.
      //
      // Without explicit provider/model, OpenClaw defaults to openai/gpt-5.4
      // which requires an OpenAI API key the user may not have. The empty
      // sentinel `[{}]` triggers that default path only when no targets
      // resolved at all (unconfigured install).
      const targets = resolveExtractionTargets(api);
      const attempts: ExtractionTarget[] = targets.length > 0 ? targets : [{}];
      let lastErr: unknown = null;

      for (let i = 0; i < attempts.length; i++) {
        const target = attempts[i];
        const isFallback = i > 0;
        try {
          const prompt = composeExtractionPrompt(
            LLM_EXTRACTION_SYSTEM_PROMPT,
            DEFAULT_ICC_SCHEMA_JSON,
            transcript,
            { includeMarker: targetUsesMR(target) },
          );

          diag('extractViaLLM: calling runEmbeddedPiAgent', {
            transcriptLength: transcript.length,
            runId,
            attemptIndex: i,
            attemptProvider: target.provider,
            attemptModel: target.model,
            isFallback,
          });

          const result = await api.runtime.agent.runEmbeddedPiAgent({
            sessionId: runId,
            sessionFile,
            workspaceDir: os.tmpdir(),
            prompt,
            timeoutMs: 30_000,
            runId,
            disableTools: true,
            streamParams: { temperature: 0.2, maxTokens: 4000 },
            ...(target.provider ? { provider: target.provider } : {}),
            ...(target.model ? { model: target.model } : {}),
          });

          // Extract text from payloads — skip error/reasoning blocks
          const text = (result.payloads ?? [])
            .filter((p) => !p.isError && !p.isReasoning && typeof p.text === 'string')
            .map((p) => p.text ?? '')
            .join('\n')
            .trim();

          if (!text) {
            // Treat empty response as a transient failure on this target so
            // the next target gets a chance. Throwing routes through the
            // catch-and-continue branch below.
            throw new Error('LLM returned empty response');
          }

          // Strip code fences if the model wrapped the output
          const jsonText = this.stripCodeFences(text);

          diag('extractViaLLM: raw LLM output', {
            textLength: text.length,
            jsonTextLength: jsonText.length,
          });

          // Parse JSON — failure here is unlikely to be model-target-specific
          // (more often a malformed prompt or schema), so we surface null
          // immediately rather than retrying with the fallback target.
          let parsed: LLMExtractionResult;
          try {
            parsed = JSON.parse(jsonText);
          } catch (parseErr) {
            logger.warn('[ContextCurator] Failed to parse LLM JSON output', {
              error: parseErr,
              rawText: jsonText.slice(0, 200),
            });
            return null;
          }

          if (isFallback) {
            logger.info('[ContextCurator] LLM extraction succeeded on fallback target', {
              fallbackProvider: target.provider,
              fallbackModel: target.model,
            });
          }

          // Validate and map to our types
          return this.mapLLMResult(parsed);
        } catch (err) {
          lastErr = err;
          diag('extractViaLLM: target attempt failed', {
            attemptIndex: i,
            attemptProvider: target.provider,
            attemptModel: target.model,
            error: err instanceof Error ? err.message : String(err),
          });
          // Loop continues to the next target.
        }
      }
      // All targets exhausted — surface the last error so curate() falls
      // through to regex extraction.
      throw lastErr instanceof Error ? lastErr : new Error('All extraction targets failed');
    } finally {
      // Clean up temp directory
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  /**
   * Strip markdown code fences from LLM output.
   */
  private stripCodeFences(text: string): string {
    const trimmed = text.trim();
    const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (m) {
      return (m[1] ?? '').trim();
    }
    return trimmed;
  }

  /**
   * Validate and map the LLM JSON output to our internal types.
   * Preserves exact values from the LLM output — no format changes.
   */
  private mapLLMResult(
    raw: LLMExtractionResult
  ): { entities: EntityLock[]; conflicts: ConflictResolution[]; priorities: string[] } | null {
    if (!raw || typeof raw !== 'object') return null;

    // Map entities
    const entities: EntityLock[] = [];
    const seenEntities = new Set<string>();
    if (Array.isArray(raw.entities)) {
      for (const e of raw.entities) {
        if (!e || typeof e.name !== 'string' || typeof e.value !== 'string') continue;
        // Validate entity type — default to 'code_identifier' for unknown types
        const type: EntityType = VALID_ENTITY_TYPES.has(e.type)
          ? (e.type as EntityType)
          : 'code_identifier';
        const dedupeKey = `${type}:${e.value}`;
        if (seenEntities.has(dedupeKey)) continue;
        seenEntities.add(dedupeKey);
        entities.push({ name: e.name, type, value: e.value });
      }
    }

    // Map conflicts
    const conflicts: ConflictResolution[] = [];
    if (Array.isArray(raw.conflicts)) {
      for (const c of raw.conflicts) {
        if (!c || typeof c.original !== 'string' || typeof c.override !== 'string') continue;
        conflicts.push({
          original: c.original,
          override: c.override,
          resolved: typeof c.resolved === 'string' ? c.resolved : c.override,
        });
      }
    }

    // Map priorities
    const priorities: string[] = [];
    const seenPriorities = new Set<string>();
    if (Array.isArray(raw.priorities)) {
      for (const p of raw.priorities) {
        if (typeof p !== 'string' || !p.trim()) continue;
        const trimmed = p.trim();
        if (trimmed.length > 200) continue;
        const key = trimmed.toLowerCase();
        if (seenPriorities.has(key)) continue;
        seenPriorities.add(key);
        priorities.push(trimmed);
      }
    }

    return { entities, conflicts, priorities };
  }

  // ---------------------------------------------------------------------------
  // Regex-based extraction (fallback)
  // ---------------------------------------------------------------------------

  /**
   * Extract entities from text using regex patterns (fallback).
   * Deduplicates by value.
   */
  extractEntities(text: string): EntityLock[] {
    const entities: EntityLock[] = [];
    const seen = new Set<string>();

    const add = (name: string, type: EntityType, value: string): void => {
      const key = `${type}:${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        entities.push({ name, type, value });
      }
    };

    // URLs
    let match: RegExpExecArray | null;
    const urlRegex = new RegExp(URL_PATTERN.source, URL_PATTERN.flags);
    while ((match = urlRegex.exec(text)) !== null) {
      // Trim trailing punctuation that leaked into the match
      const url = match[0].replace(/[.,;:!?)]+$/, '');
      add(this.extractUrlName(url), 'api_endpoint', url);
    }

    // File paths
    const pathRegex = new RegExp(FILE_PATH_PATTERN.source, FILE_PATH_PATTERN.flags);
    while ((match = pathRegex.exec(text)) !== null) {
      const filePath = match[0];
      add(filePath.split(/[/\\]/).pop() || filePath, 'file_path', filePath);
    }

    // Environment variables
    const envRegex = new RegExp(ENV_VAR_PATTERN.source, ENV_VAR_PATTERN.flags);
    while ((match = envRegex.exec(text)) !== null) {
      const varName = match[1] || match[2];
      if (varName) {
        add(varName, 'variable_name', varName);
      }
    }

    // Constants
    const constRegex = new RegExp(CONSTANT_PATTERN.source, CONSTANT_PATTERN.flags);
    while ((match = constRegex.exec(text)) !== null) {
      const name = match[1];
      const value = match[2];
      add(name, 'constant', `${name}=${value}`);
    }

    // Model identifiers
    const modelRegex = new RegExp(MODEL_PATTERN.source, MODEL_PATTERN.flags);
    while ((match = modelRegex.exec(text)) !== null) {
      add(match[0], 'model_name', match[0]);
    }

    // Network ports
    const portRegex = new RegExp(PORT_PATTERN.source, PORT_PATTERN.flags);
    while ((match = portRegex.exec(text)) !== null) {
      add(`port_${match[1]}`, 'constant', match[1]); // using constant type for ports
    }

    // Filter out excluded patterns
    return entities.filter((entity) => {
      for (const pattern of EXCLUDED_ENTITY_PATTERNS) {
        if (pattern.test(entity.value) || pattern.test(entity.name)) {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Detect instruction overrides / conflicts in a sequence of messages (fallback).
   */
  detectConflicts(messages: string[]): ConflictResolution[] {
    const conflicts: ConflictResolution[] = [];

    const fullText = messages.join('\n');
    for (const pattern of OVERRIDE_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let m: RegExpExecArray | null;
      while ((m = regex.exec(fullText)) !== null) {
        if (m.length >= 3) {
          // Pattern: "instead of X use Y" or "change X from A to B"
          const original = (m[1] || '').trim();
          const override = (m[m.length - 1] || m[2] || '').trim();

          if (original && override && original !== override) {
            conflicts.push({
              original,
              override,
              resolved: override,
              lineRef: this.getLineNumber(fullText, m.index),
            });
          }
        } else if (m.length === 2) {
          // Pattern: "scratch that, <new instruction>"
          conflicts.push({
            original: '(previous instruction)',
            override: m[1].trim(),
            resolved: m[1].trim(),
            lineRef: this.getLineNumber(fullText, m.index),
          });
        }
      }
    }

    return conflicts;
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /** Extract priority segments (task markers & system instructions) */
  private extractPrioritySegments(text: string): string[] {
    const segments: string[] = [];
    const seen = new Set<string>();

    for (const pattern of TASK_MARKERS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const segment = match[1].trim();
        if (segment && !seen.has(segment.toLowerCase())) {
          // Skip segments that are too long (likely system prompt content)
          if (segment.length > 200) continue;
          // Skip segments containing JSON or structured data
          if (/[{}[\]]/.test(segment) || /"(?:role|content|type)"/.test(segment)) continue;
          // Skip session startup instructions
          if (/read.*(?:required|startup) files/i.test(segment)) continue;

          seen.add(segment.toLowerCase());
          segments.push(segment);
        }
      }
    }

    // Also grab lines that look like system instructions
    const lines = text.split('\n');
    for (const line of lines) {
      if (SYSTEM_INSTRUCTION_PATTERN.test(line)) {
        const trimmed = line.trim();
        if (trimmed && !seen.has(trimmed.toLowerCase())) {
          // Skip segments that are too long (likely system prompt content)
          if (trimmed.length > 200) continue;
          // Skip segments containing JSON or structured data
          if (/[{}[\]]/.test(trimmed) || /"(?:role|content|type)"/.test(trimmed)) continue;
          // Skip session startup instructions
          if (/read.*(?:required|startup) files/i.test(trimmed)) continue;

          seen.add(trimmed.toLowerCase());
          segments.push(trimmed);
        }
      }
    }

    return segments;
  }

  /** Split transcript into individual messages by common delimiters */
  private splitMessages(transcript: string): string[] {
    // Try to split by common message delimiters
    const messageBlocks = transcript.split(
      /(?:^|\n)(?:(?:Human|User|Assistant|System|Agent):\s?)/im
    );
    return messageBlocks.filter((block) => block.trim().length > 0);
  }

  /** Get line number from character index */
  private getLineNumber(text: string, charIndex: number): number {
    return text.slice(0, charIndex).split('\n').length;
  }

  /** Extract a human-readable name from a URL */
  private extractUrlName(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname + parsed.pathname;
    } catch {
      return url.slice(0, 40);
    }
  }
}
