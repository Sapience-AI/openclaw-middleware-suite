/**
 * Guardrail Interceptor — Tool Call Parameter Scanner
 *
 * Scans tool call parameters for security threats using the GuardrailScanner engine.
 * Wired into the before_tool_call hook alongside the existing PII/DLP scan.
 *
 * Decision logic:
 *   BLOCK detections  → hard reject (return block: true)
 *   WARN  detections  → escalate to HITL (forceAsk)
 *   LOG   detections  → log only, allow through
 *
 * Respects dryRunMode: when enabled, never blocks — only logs.
 * Fail-open: scanner or config errors never block tool calls.
 */

import { GuardrailScanner, ConfigStore, GuardrailDetection, GuardrailConfig } from './index.js';
import { logger } from '../../shared/Logger.js';
import { DecisionLog } from './storage/DecisionLog.js';
import { checkSensitivePath, DEFAULT_SENSITIVE_PATH_CONFIG } from './guards/sensitive-paths.js';
import { checkEgressControl, DEFAULT_EGRESS_CONFIG } from './guards/egress-control.js';
import {
  checkDestructiveCommand,
  DEFAULT_DESTRUCTIVE_CONFIG,
} from './guards/destructive-commands.js';
import * as fs from 'fs';
import * as path from 'path';

// ── Result type ──────────────────────────────────────────────────

export interface GuardrailScanResult {
  block: boolean;
  escalate: boolean;
  reason?: string;
  detections: GuardrailDetection[];
}

// ── Scanner factory (uses in-memory cached config — zero disk I/O) ──

let cachedConfig: GuardrailConfig | null = null;

function getScanner(): { scanner: GuardrailScanner; config: GuardrailConfig } | null {
  try {
    cachedConfig = ConfigStore.getCached();
    return { scanner: new GuardrailScanner(cachedConfig), config: cachedConfig };
  } catch (err) {
    logger.warn('[guardrail-interceptor] Failed to load config — fail-open, skipping scan', {
      error: err,
    });
    return null;
  }
}

// ── Text extraction from tool params ─────────────────────────────

/**
 * Extract scannable text from tool call parameters.
 * Concatenates all string-valued params into a single block for scanning.
 * For shell tools, prioritizes the `command` param.
 */
function extractScannableText(_toolName: string, params: Record<string, unknown>): string {
  const parts: string[] = [];

  // For shell/bash tools, the command param is the primary target
  const shellKeys = ['command', 'cmd', 'script', 'bash', 'shell'];
  for (const key of shellKeys) {
    if (typeof params[key] === 'string') {
      parts.push(params[key] as string);
    }
  }

  // For file tools, scan path + content
  const fileKeys = ['file_path', 'path', 'filename', 'content', 'text', 'body'];
  for (const key of fileKeys) {
    if (typeof params[key] === 'string') {
      parts.push(params[key] as string);
    }
  }

  // For URL/network tools
  const urlKeys = ['url', 'uri', 'endpoint', 'href'];
  for (const key of urlKeys) {
    if (typeof params[key] === 'string') {
      parts.push(params[key] as string);
    }
  }

  // Fallback: scan any remaining string params we haven't already captured
  const captured = new Set([...shellKeys, ...fileKeys, ...urlKeys]);
  for (const [key, value] of Object.entries(params)) {
    if (!captured.has(key) && typeof value === 'string' && value.length > 0) {
      parts.push(value);
    }
  }

  return parts.join('\n');
}

// ── Generic pre-read file content scanning ──────────────────────

/**
 * Known parameter names that typically hold file paths.
 * Checked in order — first match that resolves to an existing file wins.
 */
const FILE_PATH_KEYS = [
  'path',
  'file_path',
  'filePath',
  'filename',
  'file',
  'src',
  'source',
  'input',
  'inputPath',
  'input_path',
  'target',
  'targetPath',
  'target_path',
  'location',
  'filepath',
];

/**
 * Known parameter names that hold shell commands.
 */
const SHELL_CMD_KEYS = ['command', 'cmd', 'script', 'bash', 'shell', 'exec'];

/**
 * Shell commands that read file content and pass it to stdout.
 * We extract the file path argument from these commands to pre-read scan.
 */
const FILE_READ_COMMANDS = [
  'cat',
  'type', // cat file.txt, type file.txt (Windows)
  'head',
  'tail', // head -n 10 file.txt
  'less',
  'more', // pagers
  'bat',
  'batcat', // modern cat alternatives
  'tac',
  'rev', // reverse cat
  'nl', // numbered lines
  'strings', // extract strings from binary
  'source', // bash source
  'Get-Content',
  'gc', // PowerShell
];

/**
 * Extract file paths from a shell command string.
 *
 * Uses THREE strategies (from specific to generic):
 *   1. Known read commands (cat, type, head, Get-Content, etc.)
 *   2. Input redirection (< file.txt)
 *   3. Generic: ANY quoted or unquoted string that resolves to an existing file
 *
 * Strategy 3 is the catch-all — even if the agent uses python, node, powershell,
 * or any creative approach, if a file path appears in the command string and
 * that file exists on disk, we'll pre-read and scan it.
 */
function extractFilePathsFromShellCommand(command: string): string[] {
  const paths: string[] = [];
  if (!command || command.length === 0) return paths;

  const cmd = command.trim();

  logger.debug(`[guardrail-interceptor] Shell command to parse: "${cmd.slice(0, 200)}"`);

  // Strategy 1: Known file-reading commands
  for (const readCmd of FILE_READ_COMMANDS) {
    const escapedCmd = readCmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `(?:^|[;&|]\\s*|\\|\\s*)${escapedCmd}\\s+` +
        `(?:-[a-zA-Z0-9]+\\s+)*` +
        `(?:"([^"]+)"|'([^']+)'|([^\\s;&|><]+))`,
      'gi'
    );

    let match;
    while ((match = pattern.exec(cmd)) !== null) {
      const filePath = match[1] || match[2] || match[3];
      if (filePath && !filePath.startsWith('-')) {
        paths.push(filePath);
      }
    }
  }

  // Strategy 2: Input redirection (< file.txt)
  const redirectPattern = /<\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|><]+))/g;
  let redirectMatch;
  while ((redirectMatch = redirectPattern.exec(cmd)) !== null) {
    const filePath = redirectMatch[1] || redirectMatch[2] || redirectMatch[3];
    if (filePath && !filePath.startsWith('-')) {
      paths.push(filePath);
    }
  }

  // Strategy 3 (GENERIC CATCH-ALL): Extract any quoted strings or path-like
  // tokens from the command, then check if they exist as files on disk.
  // This catches: python -c "open('file').read()", powershell [IO.File]::ReadAllText('file'),
  // node -e "fs.readFileSync('file')", or any other creative approach.

  // Extract double-quoted strings
  const doubleQuoted = cmd.matchAll(/"([^"]{3,})"/g);
  for (const m of doubleQuoted) {
    const candidate = m[1].trim();
    if (candidate && !paths.includes(candidate)) {
      // Must look like a file path (has extension or path separator)
      if (/[/\\]/.test(candidate) || /\.\w{1,10}$/.test(candidate)) {
        paths.push(candidate);
      }
    }
  }

  // Extract single-quoted strings
  const singleQuoted = cmd.matchAll(/'([^']{3,})'/g);
  for (const m of singleQuoted) {
    const candidate = m[1].trim();
    if (candidate && !paths.includes(candidate)) {
      if (/[/\\]/.test(candidate) || /\.\w{1,10}$/.test(candidate)) {
        paths.push(candidate);
      }
    }
  }

  // Extract unquoted path-like tokens (contains \ or / and a file extension)
  const pathTokens = cmd.matchAll(
    /(?:^|\s|[(,=])([a-zA-Z]:[/\\][^\s"'(),;|><]+|\/[^\s"'(),;|><]{3,})/g
  );
  for (const m of pathTokens) {
    const candidate = m[1].trim();
    if (candidate && !paths.includes(candidate)) {
      paths.push(candidate);
    }
  }

  const deduplicated = [...new Set(paths)];
  if (deduplicated.length > 0) {
    logger.debug(
      `[guardrail-interceptor] Extracted ${deduplicated.length} file path(s) from shell command: ${deduplicated.join(', ')}`
    );
  }

  return deduplicated;
}

/**
 * Extract file path candidates from tool params.
 * Checks direct file path params AND parses shell commands for file read operations.
 *
 * This is the primary defense layer since message_sending is not wired
 * in OpenClaw 2026.3.13. Covers:
 *   - Direct file path params (path, file_path, etc.)
 *   - Shell commands that read files (cat, type, head, tail, etc.)
 *   - Heuristic path detection in other string params
 */
function extractFilePaths(params: Record<string, unknown>): string[] {
  const paths: string[] = [];

  // Check known file path keys first
  for (const key of FILE_PATH_KEYS) {
    const val = params[key];
    if (typeof val === 'string' && val.length > 0 && val.length < 1024) {
      paths.push(val);
    }
  }

  // Parse shell commands to extract file paths from read operations
  for (const key of SHELL_CMD_KEYS) {
    const val = params[key];
    if (typeof val === 'string' && val.length > 0) {
      const shellPaths = extractFilePathsFromShellCommand(val);
      paths.push(...shellPaths);
    }
  }

  // Also check any remaining string params that look like file paths
  // (contain path separators or file extensions)
  const checked = new Set([...FILE_PATH_KEYS, ...SHELL_CMD_KEYS]);
  for (const [key, val] of Object.entries(params)) {
    if (checked.has(key)) continue;
    if (typeof val !== 'string' || val.length === 0 || val.length > 1024) continue;
    // Heuristic: looks like a file path if it has separators or a dotted extension
    if (/[/\\]/.test(val) || /\.\w{1,10}$/.test(val)) {
      paths.push(val);
    }
  }

  return [...new Set(paths)]; // deduplicate
}

/**
 * Generic pre-read scanner: extracts file paths from ANY tool's params,
 * reads the file content, and scans it BEFORE the tool executes.
 * This prevents malicious file content from ever reaching the LLM's context.
 *
 * Works with FileSystem.read, MCP tools, custom tools — anything that
 * accepts a file path parameter.
 */
function preReadAndScan(
  toolName: string,
  params: Record<string, unknown>,
  scanner: GuardrailScanner,
  config: GuardrailConfig
): GuardrailScanResult | null {
  const filePaths = extractFilePaths(params);
  if (filePaths.length === 0) return null;

  for (const filePath of filePaths) {
    let resolvedPath: string;
    let content: string;

    try {
      resolvedPath = path.resolve(filePath);

      // Resolve symlinks to their real target — prevents symlink bypass
      // where attacker creates link.txt → ~/.ssh/id_rsa
      try {
        resolvedPath = fs.realpathSync(resolvedPath);
      } catch {
        // realpathSync fails if target doesn't exist — use original
      }

      const stat = fs.statSync(resolvedPath);

      // Skip directories only — allow regular files AND symlinks (already resolved above)
      if (stat.isDirectory()) continue;

      // Skip files > 1MB to avoid memory pressure
      if (stat.size > 1_048_576) {
        logger.debug(
          `[guardrail-interceptor] Skipping pre-read of large file (${stat.size} bytes): ${resolvedPath}`
        );
        continue;
      }

      // Skip likely binary files (images, archives, executables, etc.)
      const ext = path.extname(resolvedPath).toLowerCase();
      const BINARY_EXTS = new Set([
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.bmp',
        '.ico',
        '.webp',
        '.svg',
        '.zip',
        '.gz',
        '.tar',
        '.7z',
        '.rar',
        '.bz2',
        '.exe',
        '.dll',
        '.so',
        '.dylib',
        '.bin',
        '.pdf',
        '.doc',
        '.docx',
        '.xls',
        '.xlsx',
        '.ppt',
        '.pptx',
        '.mp3',
        '.mp4',
        '.avi',
        '.mov',
        '.wav',
        '.flac',
        '.woff',
        '.woff2',
        '.ttf',
        '.otf',
        '.eot',
      ]);
      if (BINARY_EXTS.has(ext)) continue;

      content = fs.readFileSync(resolvedPath, 'utf-8');
    } catch {
      // File doesn't exist, access denied, etc. — skip, let the tool handle it
      continue;
    }

    if (!content || content.length === 0) continue;

    const detections = scanner.scan(content);
    if (detections.length === 0) continue;

    const blockDetections = detections.filter((d) => d.action === 'BLOCK');
    const warnDetections = detections.filter((d) => d.action === 'WARN');
    const hasBlock = blockDetections.length > 0;
    const hasWarn = warnDetections.length > 0;

    if (!hasBlock && !hasWarn) continue; // LOG-only detections — don't block pre-reads

    const topDetections = [...blockDetections, ...warnDetections].slice(0, 3);
    const reason = topDetections
      .map((d) => `${d.category}:${d.ruleName} [${d.severity}]`)
      .join(', ');

    const severities = [...new Set(detections.map((d) => d.severity))].join('/');
    const basename = path.basename(resolvedPath!);
    const actionLabel = config.dryRunMode
      ? 'DRY-RUN'
      : hasBlock
        ? 'PRE-READ BLOCK'
        : 'PRE-READ ESCALATE';

    logger.info(
      `[guardrail-interceptor] ${actionLabel} | tool=${toolName} | file=${basename} | severity=[${severities}] | detections=${detections.length}`,
      {
        detections: detections.slice(0, 5).map((d) => `${d.category}:${d.ruleName}`),
        filePath: resolvedPath!,
      }
    );

    if (config.dryRunMode) return null;

    if (hasBlock) {
      return {
        block: true,
        escalate: false,
        reason: `Guardrail blocked ${toolName}('${basename}'): file content contains [${reason}]`,
        detections,
      };
    }

    if (hasWarn) {
      return {
        block: false,
        escalate: true,
        reason: `Guardrail warning on ${toolName}('${basename}'): file content contains [${reason}]`,
        detections,
      };
    }
  }

  return null;
}

// ── Shell indirection detection ─────────────────────────────────

interface ShellIndirection {
  type: string;
  snippet: string;
  description: string;
}

/**
 * Detect shell indirection patterns that could bypass L2 guards.
 * These construct commands at runtime, evading static string analysis:
 *   - Variable expansion: $VAR, ${VAR}
 *   - Command substitution: $(cmd), `cmd`
 *   - eval/exec: eval "...", exec "..."
 *   - Indirect invocation: bash -c "...", sh -c "..."
 *
 * Returns the first match, or null if clean.
 */
function detectShellIndirection(command: string): ShellIndirection | null {
  if (!command || command.length === 0) return null;

  // eval / exec — wraps an arbitrary command string
  const evalMatch = command.match(/\b(eval|exec)\s+["'$]/i);
  if (evalMatch) {
    return {
      type: 'eval',
      snippet: evalMatch[0].slice(0, 40),
      description: `"${evalMatch[1]}" wraps an arbitrary command — guards cannot inspect the inner command`,
    };
  }

  // Indirect shell invocation: bash -c "...", sh -c "...", cmd /c "..."
  const shellInvokeMatch = command.match(/\b(bash|sh|zsh|dash|ksh|cmd)\s+(?:-c|\/c)\s+["']/i);
  if (shellInvokeMatch) {
    return {
      type: 'shell-invoke',
      snippet: shellInvokeMatch[0].slice(0, 40),
      description: `"${shellInvokeMatch[1]} -c" launches a sub-shell — guards cannot inspect the inner command`,
    };
  }

  // Command substitution: $(cmd) — but allow simple $() in prompt-like text
  // Only flag if it contains shell-dangerous commands inside
  const cmdSubMatch = command.match(/\$\(([^)]{4,})\)/);
  if (cmdSubMatch) {
    const inner = cmdSubMatch[1];
    // Only flag if the inner command looks dangerous (contains network, file, or destructive ops)
    if (/\b(curl|wget|nc|cat|rm|dd|scp|rsync|python|node|ruby|eval)\b/i.test(inner)) {
      return {
        type: 'command-substitution',
        snippet: cmdSubMatch[0].slice(0, 60),
        description: 'command substitution $(...) constructs commands at runtime',
      };
    }
  }

  // Backtick substitution with dangerous commands
  const backtickMatch = command.match(/`([^`]{4,})`/);
  if (backtickMatch) {
    const inner = backtickMatch[1];
    if (/\b(curl|wget|nc|cat|rm|dd|scp|rsync|python|node|ruby|eval)\b/i.test(inner)) {
      return {
        type: 'backtick-substitution',
        snippet: backtickMatch[0].slice(0, 60),
        description: 'backtick substitution constructs commands at runtime',
      };
    }
  }

  // Variable expansion referencing sensitive paths/commands
  // Only flag $VAR patterns that look like they reference file paths or commands
  // (not simple $HOME or $USER which are benign)
  const sensitiveVarMatch = command.match(/\$\{?([A-Z_]+)\}?/g);
  if (sensitiveVarMatch) {
    const dangerousVars = sensitiveVarMatch.filter((v) => {
      const name = v.replace(/[${}]/g, '');
      return /^(CMD|COMMAND|EXEC|SCRIPT|FILE|PATH_TO|SECRET|KEY|TOKEN|CRED|PASS|TARGET|PAYLOAD|URL|HOST|ENDPOINT)/i.test(
        name
      );
    });
    if (dangerousVars.length > 0) {
      return {
        type: 'variable-expansion',
        snippet: dangerousVars.slice(0, 3).join(', '),
        description: `shell variable(s) ${dangerousVars[0]} may hide sensitive paths or commands`,
      };
    }
  }

  return null;
}

// ── Main scan function ───────────────────────────────────────────

/**
 * Execute guardrail scanning on tool call parameters.
 * For FileSystem.read(), also pre-reads the file content to scan BEFORE execution.
 *
 * @returns GuardrailScanResult with block/escalate decisions and detections.
 *          Fail-open: returns { block: false, escalate: false } on any error.
 */
export function executeGuardrailScan(
  toolName: string,
  moduleName: string,
  methodName: string,
  params: Record<string, unknown>,
  sessionKey?: string,
  agentId?: string
): GuardrailScanResult {
  const emptyResult: GuardrailScanResult = { block: false, escalate: false, detections: [] };

  try {
    const loaded = getScanner();
    if (!loaded) return emptyResult;

    const { scanner, config } = loaded;

    if (!config.enabled) return emptyResult;

    // ── L2 Guard 1: Sensitive Path Blocklist ─────────────────────
    // Check ALL file paths in params against the sensitive path blocklist.
    // Runs BEFORE pre-read — blocks before the file is even opened.
    const sensPathConfig = config.sensitivePaths ?? DEFAULT_SENSITIVE_PATH_CONFIG;
    const filePaths = extractFilePaths(params);
    for (const fp of filePaths) {
      const sensResult = checkSensitivePath(fp, sensPathConfig, config.dryRunMode);
      if (sensResult.blocked) {
        void DecisionLog.append({
          timestamp: new Date().toISOString(),
          module: moduleName,
          method: methodName,
          args: [{ toolName, filePath: fp }],
          decision: 'BLOCKED',
          decisionTime: 0,
          reason: `guard:sensitive-path: ${sensResult.reason}`,
          eventType: 'tool_blocked',
          tool: toolName,
          severity: 'HIGH',
          agentId,
          sessionKey,
        });
        return {
          block: true,
          escalate: false,
          reason: sensResult.reason!,
          detections: [],
        };
      }
    }

    // ── L2 Guard 2: Network Egress Control ───────────────────────
    // Check shell commands for network operations — block data exfil.
    const egressConfig = config.egressControl ?? DEFAULT_EGRESS_CONFIG;
    for (const key of SHELL_CMD_KEYS) {
      const val = params[key];
      if (typeof val !== 'string' || val.length === 0) continue;
      const egressResult = checkEgressControl(val, egressConfig, config.dryRunMode);
      if (egressResult.blocked) {
        void DecisionLog.append({
          timestamp: new Date().toISOString(),
          module: moduleName,
          method: methodName,
          args: [{ toolName, command: (val as string).slice(0, 200) }],
          decision: 'BLOCKED',
          decisionTime: 0,
          reason: `guard:egress: ${egressResult.reason}`,
          eventType: 'tool_blocked',
          tool: toolName,
          severity:
            egressResult.ruleTriggered === 'data-sending' ? ('CATASTROPHIC' as any) : 'HIGH',
          agentId,
          sessionKey,
        });
        return {
          block: true,
          escalate: false,
          reason: egressResult.reason!,
          detections: [],
        };
      }
    }

    // ── L2 Guard 3: Destructive Command Blocker ──────────────────
    // Block dangerous shell commands that cause irreversible damage.
    const destructiveConfig = config.destructiveCommands ?? DEFAULT_DESTRUCTIVE_CONFIG;
    for (const key of SHELL_CMD_KEYS) {
      const val = params[key];
      if (typeof val !== 'string' || val.length === 0) continue;
      const destructiveResult = checkDestructiveCommand(val, destructiveConfig, config.dryRunMode);
      if (destructiveResult.blocked) {
        void DecisionLog.append({
          timestamp: new Date().toISOString(),
          module: moduleName,
          method: methodName,
          args: [{ toolName, command: (val as string).slice(0, 200) }],
          decision: 'BLOCKED',
          decisionTime: 0,
          reason: `guard:destructive: ${destructiveResult.reason}`,
          eventType: 'tool_blocked',
          tool: toolName,
          severity: (destructiveResult.severity === 'CRITICAL'
            ? 'CATASTROPHIC'
            : destructiveResult.severity) as 'HIGH' | 'CATASTROPHIC' | undefined,
          agentId,
          sessionKey,
        });
        return {
          block: true,
          escalate: false,
          reason: destructiveResult.reason!,
          detections: [],
        };
      }
    }

    // ── L2 Guard 4: Shell Indirection Detection ───────────────────
    // Detect shell variable expansion, eval, command substitution that
    // could bypass guards by constructing dangerous commands at runtime.
    // These are ESCALATED (not blocked) since they may be legitimate.
    for (const key of SHELL_CMD_KEYS) {
      const val = params[key];
      if (typeof val !== 'string' || val.length === 0) continue;
      const indirection = detectShellIndirection(val);
      if (indirection) {
        logger.info(
          `[guardrail-interceptor] SHELL INDIRECTION | tool=${toolName} | type=${indirection.type} | snippet="${indirection.snippet}"`
        );
        if (!config.dryRunMode) {
          return {
            block: false,
            escalate: true,
            reason: `Shell indirection detected (${indirection.type}): command uses ${indirection.description} which may bypass security guards. Requires human approval.`,
            detections: [],
          };
        }
      }
    }

    // ── Pre-read scan: reads file content for ANY tool with file path params ──
    const preReadResult = preReadAndScan(toolName, params, scanner, config);
    if (preReadResult) return preReadResult;

    const text = extractScannableText(toolName, params);
    if (!text) return emptyResult;

    const detections = scanner.scan(text);
    if (detections.length === 0) return emptyResult;

    // Classify detections by action
    const blockDetections = detections.filter((d) => d.action === 'BLOCK');
    const warnDetections = detections.filter((d) => d.action === 'WARN');

    const hasBlock = blockDetections.length > 0;
    const hasWarn = warnDetections.length > 0;

    // Build reason string from top detections
    const topDetections = [...blockDetections, ...warnDetections].slice(0, 3);
    const reason = topDetections
      .map((d) => `${d.category}:${d.ruleName} [${d.severity}]`)
      .join(', ');

    // Log all detections
    const severities = [...new Set(detections.map((d) => d.severity))].join('/');
    const actionLabel = config.dryRunMode
      ? 'DRY-RUN'
      : hasBlock
        ? 'BLOCK'
        : hasWarn
          ? 'ESCALATE'
          : 'LOG';
    logger.info(
      `[guardrail-interceptor] ${actionLabel} | tool=${toolName} (${moduleName}.${methodName}) | severity=[${severities}] | detections=${detections.length}`,
      {
        detections: detections.slice(0, 5).map((d) => `${d.category}:${d.ruleName}`),
        sessionKey,
        agentId,
      }
    );

    // Audit log
    void DecisionLog.append({
      timestamp: new Date().toISOString(),
      module: moduleName,
      method: methodName,
      args: [{ toolName, paramKeys: Object.keys(params) }],
      decision: hasBlock && !config.dryRunMode ? 'BLOCKED' : hasWarn ? 'BLOCKED' : 'ALLOWED',
      decisionTime: 0,
      reason: `guardrail: ${reason}`,
      eventType: hasBlock ? 'tool_blocked' : 'destructive_detected',
      tool: toolName,
      severity: topDetections[0]?.severity as 'LOW' | 'HIGH' | 'CATASTROPHIC' | undefined,
      agentId,
      sessionKey,
    });

    // Dry-run mode: never block, only log
    if (config.dryRunMode) {
      return { block: false, escalate: false, reason, detections };
    }

    // Live mode: enforce
    if (hasBlock) {
      return {
        block: true,
        escalate: false,
        reason: `Guardrail blocked: ${reason}`,
        detections,
      };
    }

    if (hasWarn) {
      return {
        block: false,
        escalate: true,
        reason: `Guardrail warning: ${reason}`,
        detections,
      };
    }

    // LOG-only detections: allow through
    return { block: false, escalate: false, reason, detections };
  } catch (err) {
    // Fail-open: never block on scanner errors
    logger.warn('[guardrail-interceptor] Scan error — fail-open, allowing tool call', {
      error: err,
    });
    return emptyResult;
  }
}
