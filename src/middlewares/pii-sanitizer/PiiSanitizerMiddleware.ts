/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import fs from 'fs';
import path from 'path';
import {
  Middleware,
  MiddlewareContext,
  MiddlewareResult,
  DlpDetection,
  DlpPolicy,
} from './types.js';
import { logger } from '../../shared/Logger.js';
import { DEFAULT_DLP_POLICY } from './storage/DlpStore.js';
import { ConfigStore } from '../../shared/storage/ConfigStore.js';
import { STORE_KEY_PII_SANITIZER } from '../../shared/storage/paths.js';
import { PolicyEngine } from './PolicyEngine.js';
import { ScannerEngine } from './ScannerEngine.js';
import { ShellParser } from './ShellParser.js';

export class PiiSanitizerMiddleware implements Middleware {
  readonly name = 'pii-sanitizer';
  readonly version = '1.0.0';

  /**
   * In-memory current policy. Tracks `updateConfig()` patches across reloads
   * (matching MR's reloadConfig semantics — disk-set fields shadow
   * in-process patches, but fields the disk doesn't set are preserved).
   */
  private policy: DlpPolicy | null = null;
  private policyEngine?: PolicyEngine;
  private shellParser = new ShellParser();

  /**
   * Build the merged policy from defaults + base + inline + disk overlay.
   * Precedence: `DEFAULT_DLP_POLICY < base < inline < disk-overlay`.
   *
   * The "disk overlay" is the raw `pii_sanitizer` sub-tree from
   * `sapience-ai-suite.json` — empty (`{}`) when the file is absent or the
   * key is unset, so a hermetic embedded consumer with no disk file gets
   * `defaults < inline` (inline applies fully); a consumer running alongside
   * the plugin gets `defaults < inline < disk` (disk shadows inline —
   * escape hatch: `updateConfig()`).
   */
  private async mergePolicy(
    inline: Partial<DlpPolicy>,
    base: Partial<DlpPolicy> = DEFAULT_DLP_POLICY
  ): Promise<DlpPolicy> {
    const store = await ConfigStore.read();
    const raw = store[STORE_KEY_PII_SANITIZER];
    const diskOverlay =
      raw && typeof raw === 'object' && Object.keys(raw).length > 0
        ? (raw as Partial<DlpPolicy>)
        : {};
    return {
      ...DEFAULT_DLP_POLICY,
      ...base,
      ...inline,
      ...diskOverlay,
    } as DlpPolicy;
  }

  /**
   * Sync variant of mergePolicy — used by reloadPolicy() (invoked from the
   * ConfigStore watcher) and by the lazy ensurePolicyEngine() fallback.
   */
  private mergePolicySync(
    inline: Partial<DlpPolicy>,
    base: Partial<DlpPolicy> = DEFAULT_DLP_POLICY
  ): DlpPolicy {
    const store = ConfigStore.readSync();
    const raw = store[STORE_KEY_PII_SANITIZER];
    const diskOverlay =
      raw && typeof raw === 'object' && Object.keys(raw).length > 0
        ? (raw as Partial<DlpPolicy>)
        : {};
    return {
      ...DEFAULT_DLP_POLICY,
      ...base,
      ...inline,
      ...diskOverlay,
    } as DlpPolicy;
  }

  /**
   * Initialize the middleware. Accepts an optional inline `DlpPolicy`
   * partial — fields you set here apply on top of `DEFAULT_DLP_POLICY` but
   * below the disk overlay (`sapience-ai-suite.json[pii_sanitizer]`). Pass
   * `{}` (or omit) to fall back to defaults + disk.
   */
  async initialize(config: Record<string, unknown> = {}): Promise<void> {
    const inline = config as Partial<DlpPolicy>;
    this.policy = await this.mergePolicy(inline);
    this.policyEngine = new PolicyEngine(this.policy);
    logger.debug('[PiiSanitizer] Initialized', {
      dryRunMode: this.policy.dryRunMode,
      ruleCount: this.policy.globalRules.length,
      toolCount: Object.keys(this.policy.toolPolicies).length,
    });
  }

  private ensurePolicyEngine(): PolicyEngine {
    if (!this.policyEngine) {
      // Synchronous fallback when beforeToolCall fires before initialize()
      // — mirrors the legacy DlpStore.loadSync() path.
      this.policy = this.mergePolicySync({});
      this.policyEngine = new PolicyEngine(this.policy);
    }
    return this.policyEngine;
  }

  /**
   * In-process patch — bypasses disk. Shallow-merges `partial` into the
   * current in-memory policy and rebuilds the `PolicyEngine`. Sibling
   * fields are preserved.
   *
   *   pii.updateConfig({ dryRunMode: true });
   *
   * For disk-backed updates that survive process restarts, use
   * `DlpStore.update()` + `reloadPolicy()` instead.
   *
   * Throws if called before `initialize()`.
   */
  updateConfig(partial: Partial<DlpPolicy>): void {
    if (!this.policy) {
      throw new Error('PiiSanitizerMiddleware.updateConfig: call initialize() first');
    }
    this.policy = { ...this.policy, ...partial } as DlpPolicy;
    this.policyEngine = new PolicyEngine(this.policy);
    logger.debug('[PiiSanitizer] In-process config updated', {
      keys: Object.keys(partial),
    });
  }

  /**
   * Hot-reload the DLP policy from disk (called by `ConfigStore.onChange`
   * and by programmatic consumers after `DlpStore.save()`/`update()`).
   * Re-reads `sapience-ai-suite.json[pii_sanitizer]` and re-merges over the
   * current in-memory policy — `updateConfig()` patches survive for fields
   * the disk doesn't set. Disk-set fields shadow in-process patches
   * (matching `ModelRoutingMiddleware.reloadConfig()` semantics).
   */
  reloadPolicy(): void {
    const base = this.policy ?? DEFAULT_DLP_POLICY;
    this.policy = this.mergePolicySync({}, base);
    this.policyEngine = new PolicyEngine(this.policy);
    logger.debug('[PiiSanitizer] Policy hot-reloaded');
  }

  /**
   * Recursively traverses an object to find and scan all nested strings.
   * Modifies the object in-place (or a clone if provided initially) with redacted strings.
   */
  private deepScanAndRedact(
    node: unknown,
    fieldPolicy: string,
    moduleName: string,
    scanner: ScannerEngine,
    engine: PolicyEngine,
    state: {
      blocks: number;
      escalates: number;
      anyRedactions: boolean;
      allDetections: DlpDetection[];
    },
    seen: Set<unknown> = new Set()
  ): unknown {
    if (typeof node === 'string') {
      let textsToScan: string[] = [node];
      if (moduleName === 'Shell' && fieldPolicy === 'SCALABLE') {
        textsToScan = this.shellParser.extractLiterals(node);
      }

      const fieldDetections: DlpDetection[] = [];
      for (const text of textsToScan) {
        const detections = scanner.scan(text);
        fieldDetections.push(...detections);
        state.allDetections.push(...detections);
      }

      if (fieldDetections.length > 0) {
        for (const det of fieldDetections) {
          if (det.action === 'BLOCK') state.blocks++;
          if (det.action === 'ESCALATE') state.escalates++;
        }

        // Always redact for safety, even if we also flag for BLOCK/ESCALATE
        const fullStringDetections = scanner.scan(node);
        const redacted = scanner.redact(node, fullStringDetections);
        if (redacted !== node) {
          state.anyRedactions = true;
          return redacted;
        }
      }
      return node;
    }

    if (node !== null && typeof node === 'object') {
      if (seen.has(node)) return node;
      seen.add(node);
    }

    if (Array.isArray(node)) {
      // Create a shallow copy of the array if we need to modify it
      const newArray = [...node];
      for (let i = 0; i < newArray.length; i++) {
        newArray[i] = this.deepScanAndRedact(
          newArray[i],
          fieldPolicy,
          moduleName,
          scanner,
          engine,
          state,
          seen
        );
      }
      return newArray;
    }

    if (node !== null && typeof node === 'object') {
      const newObj = { ...(node as object) } as Record<string, unknown>;
      for (const [key, value] of Object.entries(node)) {
        newObj[key] = this.deepScanAndRedact(
          value,
          fieldPolicy,
          moduleName,
          scanner,
          engine,
          state,
          seen
        );
      }
      return newObj;
    }

    return node;
  }

  /**
   * Pre-reads a file from disk and scans its content for PII/secrets.
   */
  private async preReadAndScanFile(
    filePath: string,
    scanner: ScannerEngine,
    engine: PolicyEngine
  ): Promise<MiddlewareResult | null> {
    // Resolve to absolute path, handling both Windows and POSIX separators
    const resolvedPath = path.resolve(filePath);

    let content: string;
    // Open first, then fstat — atomic w.r.t. the file content. Eliminates
    // the TOCTOU race between statSync and readFileSync
    // (CodeQL js/file-system-race).
    let fd: number | undefined;
    try {
      fd = fs.openSync(resolvedPath, 'r');
      const stat = fs.fstatSync(fd);
      if (stat.size > 1_048_576) {
        logger.debug(
          `[PiiSanitizer] Skipping pre-read of large file (${stat.size} bytes): ${resolvedPath}`
        );
        return null;
      }
      const buf = Buffer.alloc(stat.size);
      fs.readSync(fd, buf, 0, stat.size, 0);
      content = buf.toString('utf-8');
    } catch (err) {
      // File doesn't exist yet, path is a glob, or access denied — let the tool handle it
      logger.debug(
        `[PiiSanitizer] Pre-read skipped for '${resolvedPath}': ${(err as Error).message}`
      );
      return null;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }

    const detections = scanner.scan(content);
    if (detections.length === 0) return null;

    const state = { blocks: 0, escalates: 0, anyRedactions: false, allDetections: detections };
    for (const det of detections) {
      if (det.action === 'BLOCK') state.blocks++;
      if (det.action === 'ESCALATE') state.escalates++;
    }

    if (engine.isDryRunMode()) {
      logger.warn(`[PiiSanitizer] (DRY RUN) Pre-read detected PII in file content`, {
        path: resolvedPath,
        detections,
      });
      return null;
    }

    if (state.blocks > 0 || state.escalates > 0) {
      const action = state.blocks > 0 ? 'BLOCK' : 'ESCALATE';
      const summary = Array.from(new Set(detections.map((d) => d.originalPattern))).join(', ');
      logger.warn(
        `[PiiSanitizer] Pre-read scan: ${action} on file content — rules matched: ${summary}`,
        {
          path: resolvedPath,
          detections,
        }
      );
      return {
        block: true,
        reason: `⛔ PII Engine blocked FileSystem.read('${path.basename(resolvedPath)}'): the file content contains sensitive data matching [${summary}]. Reading this file has been suppressed to prevent secret exposure.`,
        metadata: {
          piiIntercept: true,
          piiAction: action,
          piiEscalate: action === 'ESCALATE',
          piiBlock: action === 'BLOCK',
          piiDetections: detections,
          piiSource: 'pre_read_scan',
        },
      };
    }

    // REDACT-only detections: allow the read to proceed (content will be scanned/redacted if mapped, otherwise skipped)
    if (state.anyRedactions || detections.some((d) => d.action === 'REDACT')) {
      logger.info(`[PiiSanitizer] Pre-read scan: REDACT-only detections in file, allowing read`, {
        path: resolvedPath,
        count: detections.length,
      });
    }

    return null;
  }

  async beforeToolCall(context: MiddlewareContext): Promise<MiddlewareResult> {
    const engine = this.ensurePolicyEngine();

    const toolPolicy = engine.getToolPolicy(context.moduleName, context.methodName);
    if (!toolPolicy) return { block: false }; // No DLP scanning for this tool

    const rules = engine.getRulesForTool(context.moduleName, context.methodName);
    const scanner = new ScannerEngine(rules);

    const state = {
      blocks: 0,
      escalates: 0,
      anyRedactions: false,
      allDetections: [] as DlpDetection[],
    };

    const modifiedParams = { ...context.params };

    for (const [key, value] of Object.entries(context.params)) {
      const fieldPolicy = toolPolicy.fields[key];
      if (!fieldPolicy || fieldPolicy === 'IGNORE') {
        logger.debug(`[PiiSanitizer] Skipping field ${key} (policy: ${fieldPolicy || 'NONE'})`);
        continue;
      }

      logger.debug(`[PiiSanitizer] Scanning field ${key} using policy ${fieldPolicy}`);

      const scrubbedValue = this.deepScanAndRedact(
        value,
        fieldPolicy,
        context.moduleName,
        scanner,
        engine,
        state
      );

      if (scrubbedValue !== value) {
        modifiedParams[key] = scrubbedValue;
      }
    }

    if (!engine.isDryRunMode()) {
      if (state.blocks > 0) {
        const summary = Array.from(new Set(state.allDetections.map((d) => d.originalPattern))).join(
          ', '
        );
        logger.warn(
          `[PiiSanitizer] BLOCK triggered by: ${summary} (${state.allDetections.length} matches)`
        );

        // Hard deny for BLOCK-severity DLP rules.
        return {
          block: true,
          reason: `⚠️ SECURITY ALERT: Potential PII Exposure Detected! The scanner found sensitive data matching rules: ${summary}. This may be a restricted secret (e.g. SSN or Key). Review carefully before approving.`,
          modifiedParams: state.anyRedactions ? modifiedParams : undefined,
          metadata: {
            piiIntercept: true,
            piiDetections: state.allDetections,
          },
        };
      }

      if (state.escalates > 0) {
        const summary = Array.from(new Set(state.allDetections.map((d) => d.originalPattern))).join(
          ', '
        );
        logger.warn(
          `[PiiSanitizer] ESCALATE triggered by: ${summary} (${state.allDetections.length} matches)`
        );

        // ESCALATE → let HITL force human approval. Surface via the
        // first-class MiddlewareResult.escalate channel so the orchestrator
        // has one consistent field to read across all middlewares.
        return {
          block: false,
          escalate: true,
          escalateReason: `PII Sanitizer flagged potential sensitive data: ${summary}`,
          modifiedParams: state.anyRedactions ? modifiedParams : undefined,
          metadata: {
            piiIntercept: true,
            piiDetections: state.allDetections,
          },
        };
      }

      if (state.anyRedactions) {
        logger.info(`[PiiSanitizer] Redacted outbound PII`, { detections: state.allDetections });
        return { block: false, modifiedParams };
      }
    }

    // ── Pre-read content scan for FileSystem.read ──────────────────────────────
    // OpenClaw 2026.3 has no working after_tool_call hook. To prevent raw secrets
    // from reaching the model, we read the target file here (before the tool
    // executes) and scan its content. If secrets are found, we block the call.
    if (context.moduleName === 'FileSystem' && context.methodName === 'read') {
      const filePath = (context.params.path ||
        context.params.file_path ||
        context.params.filename ||
        '') as string;
      if (filePath) {
        // Use global rules for the content scan
        const globalRules = engine.getGlobalRules();
        const contentScanner = new ScannerEngine(globalRules);
        const preReadResult = await this.preReadAndScanFile(filePath, contentScanner, engine);
        if (preReadResult) return preReadResult;
      }
    }

    if (state.allDetections.length > 0) {
      logger.debug(
        `[PiiSanitizer] Overall detections: ${state.allDetections.length}. Blocks: ${state.blocks}. Escalates: ${state.escalates}`
      );
    }

    return { block: false };
  }

  getStatus(): { enabled: boolean; stats?: Record<string, unknown> } {
    // The plugin-level on/off check lives upstream in the composed
    // tool-call hook (DlpStore.isPluginEnabled). Once this middleware is
    // initialized, it is always considered active by the Middleware
    // interface contract — per-rule enabled flags do the fine-grained gating.
    return { enabled: true };
  }

  async shutdown(): Promise<void> {
    logger.info(`[PiiSanitizer] Shutting down`);
  }
}
