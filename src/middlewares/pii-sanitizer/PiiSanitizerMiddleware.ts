import fs from 'fs';
import path from 'path';
import { Middleware, MiddlewareContext, MiddlewareResult, DlpDetection } from './types.js';
import { logger } from '../../shared/Logger.js';
import { DlpStore } from './storage/DlpStore.js';
import { PolicyEngine } from './PolicyEngine.js';
import { ScannerEngine } from './ScannerEngine.js';
import { ShellParser } from './ShellParser.js';

export class PiiSanitizerMiddleware implements Middleware {
  readonly name = 'pii-sanitizer';
  readonly version = '1.0.0';

  private policyEngine?: PolicyEngine;
  private shellParser = new ShellParser();

  async initialize(_config: Record<string, unknown>): Promise<void> {
    const policy = await DlpStore.load();
    this.policyEngine = new PolicyEngine(policy);
    logger.debug(`[PiiSanitizer] Initialized`, { enabled: this.policyEngine.isEnabled() });
  }

  private ensurePolicyEngine(): PolicyEngine {
    if (!this.policyEngine) {
      this.policyEngine = new PolicyEngine(DlpStore.loadSync());
    }
    return this.policyEngine;
  }

  /**
   * Hot-reload the DLP policy from disk (called by ConfigStore.onChange).
   */
  reloadPolicy(): void {
    const policy = DlpStore.loadSync();
    this.policyEngine = new PolicyEngine(policy);
    logger.debug('[PiiSanitizer] Policy hot-reloaded', { enabled: this.policyEngine.isEnabled() });
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
    try {
      // Skip files > 1 MB to avoid memory pressure (likely not a secret file anyway)
      const stat = fs.statSync(resolvedPath);
      if (stat.size > 1_048_576) {
        logger.debug(
          `[PiiSanitizer] Skipping pre-read of large file (${stat.size} bytes): ${resolvedPath}`
        );
        return null;
      }
      content = fs.readFileSync(resolvedPath, 'utf-8');
    } catch (err) {
      // File doesn't exist yet, path is a glob, or access denied — let the tool handle it
      logger.debug(
        `[PiiSanitizer] Pre-read skipped for '${resolvedPath}': ${(err as Error).message}`
      );
      return null;
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
    if (!engine.isEnabled()) return { block: false };

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
      if (state.blocks > 0 || state.escalates > 0) {
        // Find highest severity action
        const action = state.blocks > 0 ? 'BLOCK' : 'ESCALATE';
        const summary = Array.from(new Set(state.allDetections.map((d) => d.originalPattern))).join(
          ', '
        );
        logger.warn(
          `[PiiSanitizer] ${action} triggered by: ${summary} (${state.allDetections.length} matches)`
        );

        // Return block true, and pass metadata for potential arbitrator
        return {
          block: true,
          reason: `⚠️ SECURITY ALERT: Potential PII Exposure Detected! The scanner found sensitive data matching rules: ${summary}. This may be a restricted secret (e.g. SSN or Key). Review carefully before approving.`,
          metadata: {
            piiIntercept: true,
            piiAction: action,
            piiEscalate: action === 'ESCALATE',
            piiBlock: action === 'BLOCK',
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
    return { enabled: this.policyEngine?.isEnabled() ?? false };
  }

  async shutdown(): Promise<void> {
    logger.info(`[PiiSanitizer] Shutting down`);
  }
}
