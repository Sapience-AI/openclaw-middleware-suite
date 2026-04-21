/**
 * Sapience Middleware Tool Interceptor
 * Hook-based interception for OpenClaw's before_tool_call event
 */

import { Interceptor } from './Interceptor.js';
import { logger } from '../../shared/Logger.js';
import { detectBrowserChallenge } from './scoring/BrowserChallengeDetector.js';
import {
  scoreIrreversibility,
  IrreversibilityAssessment,
} from './scoring/IrreversibilityScorer.js';
import { MemoryRiskForecaster, MemoryRiskAssessment } from './scoring/MemoryRiskForecaster.js';
import { trustRateLimiter } from './approval/TrustRateLimiter.js';
import { InterventionMetadata } from '../../types.js';
import { BrowserSessionStore } from './storage/BrowserSessionStore.js';
import {
  classifyDestructiveAction,
  DestructiveClassification,
  hashArgs,
} from './scoring/DestructiveClassifier.js';
import { DecisionLog } from './storage/DecisionLog.js';
import { DEFAULT_POLICY } from './config.js';
import { SystemThresholds } from '../../types.js';

/**
 * Mapping from flat OpenClaw tool names to Sapience Middleware module/method pairs.
 */
const TOOL_TO_MODULE: Record<string, { module: string; method: string }> = {
  // FileSystem
  read: { module: 'FileSystem', method: 'read' },
  write: { module: 'FileSystem', method: 'write' },
  edit: { module: 'FileSystem', method: 'write' },
  glob: { module: 'FileSystem', method: 'list' },
  // Shell
  bash: { module: 'Shell', method: 'bash' },
  exec: { module: 'Shell', method: 'exec' },
  // Browser — generic / short names
  browser: { module: 'Browser', method: 'navigate' },
  navigate: { module: 'Browser', method: 'navigate' },
  screenshot: { module: 'Browser', method: 'screenshot' },
  click: { module: 'Browser', method: 'click' },
  type: { module: 'Browser', method: 'type' },
  evaluate: { module: 'Browser', method: 'evaluate' },
  // Browser — MCP Playwright tool names
  mcp__plugin_playwright_playwright__browser_navigate: { module: 'Browser', method: 'navigate' },
  mcp__plugin_playwright_playwright__browser_navigate_back: {
    module: 'Browser',
    method: 'navigate',
  },
  mcp__plugin_playwright_playwright__browser_close: { module: 'Browser', method: 'navigate' },
  mcp__plugin_playwright_playwright__browser_tabs: { module: 'Browser', method: 'navigate' },
  mcp__plugin_playwright_playwright__browser_resize: { module: 'Browser', method: 'navigate' },
  mcp__plugin_playwright_playwright__browser_wait_for: { module: 'Browser', method: 'navigate' },
  mcp__plugin_playwright_playwright__browser_install: { module: 'Browser', method: 'navigate' },
  mcp__plugin_playwright_playwright__browser_click: { module: 'Browser', method: 'click' },
  mcp__plugin_playwright_playwright__browser_drag: { module: 'Browser', method: 'click' },
  mcp__plugin_playwright_playwright__browser_hover: { module: 'Browser', method: 'click' },
  mcp__plugin_playwright_playwright__browser_handle_dialog: { module: 'Browser', method: 'click' },
  mcp__plugin_playwright_playwright__browser_type: { module: 'Browser', method: 'type' },
  mcp__plugin_playwright_playwright__browser_fill_form: { module: 'Browser', method: 'type' },
  mcp__plugin_playwright_playwright__browser_press_key: { module: 'Browser', method: 'type' },
  mcp__plugin_playwright_playwright__browser_select_option: { module: 'Browser', method: 'type' },
  mcp__plugin_playwright_playwright__browser_file_upload: { module: 'Browser', method: 'type' },
  mcp__plugin_playwright_playwright__browser_take_screenshot: {
    module: 'Browser',
    method: 'screenshot',
  },
  mcp__plugin_playwright_playwright__browser_snapshot: { module: 'Browser', method: 'screenshot' },
  mcp__plugin_playwright_playwright__browser_console_messages: {
    module: 'Browser',
    method: 'screenshot',
  },
  mcp__plugin_playwright_playwright__browser_network_requests: {
    module: 'Browser',
    method: 'screenshot',
  },
  mcp__plugin_playwright_playwright__browser_evaluate: { module: 'Browser', method: 'evaluate' },
  mcp__plugin_playwright_playwright__browser_run_code: { module: 'Browser', method: 'evaluate' },
  // Network
  fetch: { module: 'Network', method: 'fetch' },
  request: { module: 'Network', method: 'request' },
  webhook: { module: 'Network', method: 'webhook' },
  download: { module: 'Network', method: 'download' },
  // Gateway
  list_sessions: { module: 'Gateway', method: 'listSessions' },
  list_nodes: { module: 'Gateway', method: 'listNodes' },
  send_message: { module: 'Gateway', method: 'sendMessage' },
  session_status: { module: 'Gateway', method: 'listSessions' },
  // Gmail-style names used in demos/integrations
  'gmail.deletemessages': { module: 'Gmail', method: 'deleteMessages' },
  'gmail.emptytrash': { module: 'Gmail', method: 'emptyTrash' },
  'gmail.deletelabel': { module: 'Gmail', method: 'deleteLabel' },
  // Gmail — Google Workspace MCP (dru-ca/google-workspace-mcp)
  'gmail.search': { module: 'Gmail', method: 'list' },
  'gmail.get': { module: 'Gmail', method: 'read' },
  'gmail.send': { module: 'Gmail', method: 'send' },
  'gmail.createdraft': { module: 'Gmail', method: 'draft' },
  'gmail.senddraft': { module: 'Gmail', method: 'send' },
  'gmail.modify': { module: 'Gmail', method: 'write' },
  'gmail.listlabels': { module: 'Gmail', method: 'list' },
  'gmail.downloadattachment': { module: 'Gmail', method: 'download' },
  // Gmail — Google Workspace MCP (prefixed form)
  mcp__google_workspace__gmail_search: { module: 'Gmail', method: 'list' },
  mcp__google_workspace__gmail_get: { module: 'Gmail', method: 'read' },
  mcp__google_workspace__gmail_send: { module: 'Gmail', method: 'send' },
  mcp__google_workspace__gmail_createdraft: { module: 'Gmail', method: 'draft' },
  mcp__google_workspace__gmail_senddraft: { module: 'Gmail', method: 'send' },
  mcp__google_workspace__gmail_modify: { module: 'Gmail', method: 'write' },
  mcp__google_workspace__gmail_listlabels: { module: 'Gmail', method: 'list' },
  mcp__google_workspace__gmail_downloadattachment: { module: 'Gmail', method: 'download' },
  // Google Drive
  'gdrive.list': { module: 'GoogleDrive', method: 'list' },
  'gdrive.read': { module: 'GoogleDrive', method: 'read' },
  'gdrive.upload': { module: 'GoogleDrive', method: 'upload' },
  'gdrive.download': { module: 'GoogleDrive', method: 'download' },
  'gdrive.delete': { module: 'GoogleDrive', method: 'delete' },
  'gdrive.share': { module: 'GoogleDrive', method: 'share' },
  'gdrive.move': { module: 'GoogleDrive', method: 'move' },
  'gdrive.rename': { module: 'GoogleDrive', method: 'write' },
  // Google Drive — MCP-style long names
  google_drive_list: { module: 'GoogleDrive', method: 'list' },
  google_drive_read: { module: 'GoogleDrive', method: 'read' },
  google_drive_upload: { module: 'GoogleDrive', method: 'upload' },
  google_drive_download: { module: 'GoogleDrive', method: 'download' },
  google_drive_delete: { module: 'GoogleDrive', method: 'delete' },
  google_drive_share: { module: 'GoogleDrive', method: 'share' },
  google_drive_move: { module: 'GoogleDrive', method: 'move' },
  google_drive_rename: { module: 'GoogleDrive', method: 'write' },
  // Google Drive — Google Workspace MCP (dru-ca/google-workspace-mcp)
  'drive.search': { module: 'GoogleDrive', method: 'list' },
  'drive.downloadfile': { module: 'GoogleDrive', method: 'download' },
  'drive.findfolder': { module: 'GoogleDrive', method: 'list' },
  // Google Drive — Google Workspace MCP (prefixed form)
  mcp__google_workspace__drive_search: { module: 'GoogleDrive', method: 'list' },
  mcp__google_workspace__drive_downloadfile: { module: 'GoogleDrive', method: 'download' },
  mcp__google_workspace__drive_findfolder: { module: 'GoogleDrive', method: 'list' },
  // Google Docs move (relocates Drive files)
  'docs.move': { module: 'GoogleDrive', method: 'move' },
  mcp__google_workspace__docs_move: { module: 'GoogleDrive', method: 'move' },
  // Memory
  memory_search: { module: 'Memory', method: 'search' },
  memory_add: { module: 'Memory', method: 'add' },
  memory_delete: { module: 'Memory', method: 'delete' },
  // Process
  process_list: { module: 'Process', method: 'list' },
  process_poll: { module: 'Process', method: 'poll' },
  process_log: { module: 'Process', method: 'log' },
  process_write: { module: 'Process', method: 'write' },
  process_kill: { module: 'Process', method: 'kill' },
  process_clear: { module: 'Process', method: 'clear' },
  process_remove: { module: 'Process', method: 'remove' },
};

const memoryForecaster = new MemoryRiskForecaster();

// ---------------------------------------------------------------------------
// Google Drive shell + network heuristics
// ---------------------------------------------------------------------------

const DRIVE_SUBCOMMAND_MAP: Record<string, string> = {
  search: 'list',
  list: 'list',
  ls: 'list',
  find: 'list',
  download: 'download',
  pull: 'download',
  export: 'download',
  cat: 'read',
  upload: 'upload',
  push: 'upload',
  import: 'upload',
  delete: 'delete',
  rm: 'delete',
  remove: 'delete',
  trash: 'delete',
  share: 'share',
  move: 'move',
  mv: 'move',
  copy: 'upload',
  cp: 'upload',
  rename: 'write',
  sync: 'upload',
};

/**
 * Detect whether a shell command targets Google Drive (gdrive, rclone, or gog)
 * and parse the subcommand to determine the correct GoogleDrive method.
 * Returns the method string, or undefined if the command is not Drive-related.
 */
function detectDriveShellMethod(command: string): string | undefined {
  const lower = command.toLowerCase();

  // Also catch Maton gateway URLs in shell scripts (curl/python/wget)
  if (lower.includes('gateway.maton.ai/google-drive')) {
    return detectDriveApiMethod(lower);
  }

  // Match: gog drive <subcommand>, gdrive <subcommand>, rclone <subcommand>
  const gogMatch = /\bgog\s+drive\s+(\w+)/i.exec(command);
  if (gogMatch) {
    return DRIVE_SUBCOMMAND_MAP[gogMatch[1].toLowerCase()] ?? 'list';
  }

  const gdriveMatch = /\bgdrive\s+(\w+)/i.exec(command);
  if (gdriveMatch) {
    return DRIVE_SUBCOMMAND_MAP[gdriveMatch[1].toLowerCase()] ?? 'list';
  }

  const rcloneMatch = /\brclone\s+(\w+)/i.exec(command);
  if (rcloneMatch) {
    return DRIVE_SUBCOMMAND_MAP[rcloneMatch[1].toLowerCase()] ?? 'list';
  }

  return undefined;
}

/**
 * Infer the GoogleDrive method from a Maton API Gateway URL path.
 * Example: gateway.maton.ai/google-drive/drive/v3/files/xyz → delete if DELETE method, list otherwise.
 * Falls back to 'list' when the path doesn't reveal intent.
 */
function detectDriveApiMethod(url: string): string {
  if (/\bdelete\b/i.test(url)) return 'delete';
  if (/\bupload\b/i.test(url)) return 'upload';
  if (/\bpermissions\b/i.test(url)) return 'share';
  if (/\bcopy\b/i.test(url)) return 'upload';
  if (/\bexport\b/i.test(url)) return 'download';
  return 'list';
}

/**
 * Detect whether a shell command targets Gmail (gog gmail)
 * and parse the subcommand to determine the correct Gmail method.
 */
function detectGmailShellMethod(command: string): string | undefined {
  const lower = command.toLowerCase();

  // Also catch Maton gateway URLs in shell scripts
  if (lower.includes('gateway.maton.ai/google-mail')) {
    return detectGmailApiMethod(lower);
  }

  // Match: gog gmail <subcommand>
  const gogMatch = /\bgog\s+gmail\s+(\w+)/i.exec(command);
  if (gogMatch) {
    const sub = gogMatch[1].toLowerCase();
    if (sub === 'send') return 'send';
    return 'list'; // fallback for search, etc.
  }

  return undefined;
}

/**
 * Infer the Gmail method from a Maton API Gateway URL path.
 * Examples: gateway.maton.ai/google-mail/gmail/v1/users/me/messages/send
 */
function detectGmailApiMethod(url: string): string {
  if (/\/send/i.test(url)) return 'send';
  if (/\/drafts/i.test(url)) return 'draft';
  if (/\/trash/i.test(url)) return 'delete';
  if (/\/modify/i.test(url)) return 'write';
  return 'list'; // Default fallback for search/get
}

export interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
}

export interface ToolContext {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
}

export interface BeforeToolCallResult {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
}

export function createToolCallHook(
  interceptor: Interceptor
): (event: BeforeToolCallEvent, ctx: ToolContext) => Promise<BeforeToolCallResult | void> {
  return async (event, ctx): Promise<BeforeToolCallResult | void> => {
    const policy = interceptor.getPolicy();
    const thresholds = policy.systemThresholds ?? DEFAULT_POLICY.systemThresholds!;
    const { toolName } = event;

    try {
      let params = event.params;
      let shouldReturnParams = false;

      const lowerToolName = toolName.toLowerCase();
      let mapping = TOOL_TO_MODULE[lowerToolName];

      // Heuristic: The "process" tool uses an "action" parameter rather than
      // encoding the action in the tool name. Resolve it to the process.<action>
      // mapping so the correct Process module policy is applied.
      if (!mapping && lowerToolName === 'process' && typeof params.action === 'string') {
        const processKey = `process_${params.action.toLowerCase()}`;
        mapping = TOOL_TO_MODULE[processKey];
      }

      // Heuristic: If the agent uses a shell command for Google Drive or Gmail
      // route it to the respective security module so the correct policy applies.
      if (
        mapping?.module === 'Shell' ||
        lowerToolName === 'bash' ||
        lowerToolName === 'exec' ||
        lowerToolName === 'shell.bash' ||
        lowerToolName === 'shell.exec'
      ) {
        const command = (params.command || params.cmd || params.args || '').toString();
        const driveShellMethod = detectDriveShellMethod(command);
        if (driveShellMethod) {
          mapping = { module: 'GoogleDrive', method: driveShellMethod };
        } else {
          const gmailShellMethod = detectGmailShellMethod(command);
          if (gmailShellMethod) {
            mapping = { module: 'Gmail', method: gmailShellMethod };
          }
        }
      }

      // Heuristic: If the agent uses fetch/request to call the Maton API Gateway
      // route it to the respective security module.
      if (
        mapping?.module === 'Network' ||
        lowerToolName === 'fetch' ||
        lowerToolName === 'request'
      ) {
        const url = (params.url || params.src || '').toString().toLowerCase();
        if (url.includes('gateway.maton.ai/google-drive')) {
          mapping = { module: 'GoogleDrive', method: detectDriveApiMethod(url) };
        } else if (url.includes('gateway.maton.ai/google-mail')) {
          mapping = { module: 'Gmail', method: detectGmailApiMethod(url) };
        }
      }

      const moduleName = mapping?.module ?? 'Unknown';
      const methodName = mapping?.method ?? toolName;

      // Persistent browser-session management.
      if (moduleName === 'Browser') {
        const sessionId = BrowserSessionStore.buildSessionId(ctx.sessionKey, params);
        const injection = BrowserSessionStore.injectState(sessionId, params);
        params = injection.params;

        if (injection.injectedFields.length > 0) {
          shouldReturnParams = true;
          logger.info('Browser session state injected', {
            toolName,
            sessionId,
            injectedFields: injection.injectedFields,
          });
        }

        const capturedFields = BrowserSessionStore.captureState(sessionId, params);
        if (capturedFields.length > 0) {
          logger.info('Browser session state captured', {
            toolName,
            sessionId,
            capturedFields,
          });
        }
      }

      const irreversibility = scoreIrreversibility(moduleName, methodName, params);
      const destructiveClassification: DestructiveClassification | undefined =
        thresholds.destructiveGatingEnabled
          ? classifyDestructiveAction(toolName, params, {
              moduleName,
              methodName,
              bulkThreshold: thresholds.destructiveBulkThreshold,
            })
          : undefined;

      if (destructiveClassification?.isDestructive) {
        logInterceptEvent({
          eventType: 'destructive_detected',
          moduleName,
          methodName,
          toolName,
          params,
          severity: destructiveClassification.severity,
          reasons: destructiveClassification.reasons,
          bulkCount: destructiveClassification.bulkCount,
          target: destructiveClassification.target,
          argsHash: hashArgs(params),
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        });
      }

      const sessionKeyForMemory = ctx.sessionKey || `local:${ctx.agentId || 'default'}`;
      const memoryRisk = memoryForecaster.assess(
        sessionKeyForMemory,
        moduleName,
        methodName,
        params,
        irreversibility,
        thresholds.attackPauseThreshold
      );
      const intervention = buildInterventionMetadata(
        moduleName,
        methodName,
        toolName,
        params,
        irreversibility,
        memoryRisk,
        destructiveClassification?.isDestructive ? destructiveClassification : undefined,
        sessionKeyForMemory,
        thresholds
      );

      if (destructiveClassification?.isDestructive && intervention?.actionSummary) {
        logInterceptEvent({
          eventType: 'approval_requested',
          moduleName,
          methodName,
          toolName,
          params,
          severity: destructiveClassification.severity,
          reasons: destructiveClassification.reasons,
          bulkCount: destructiveClassification.bulkCount,
          target: destructiveClassification.target,
          summary: intervention.actionSummary,
          requireToken: undefined,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        });
      }

      try {
        await interceptor.evaluate(
          moduleName,
          methodName,
          [params],
          ctx.sessionKey,
          ctx.agentId,
          intervention
        );
        if (destructiveClassification?.isDestructive) {
          logInterceptEvent({
            eventType: 'tool_executed',
            moduleName,
            methodName,
            toolName,
            params,
            severity: destructiveClassification.severity,
            reasons: destructiveClassification.reasons,
            bulkCount: destructiveClassification.bulkCount,
            target: destructiveClassification.target,
            agentId: ctx.agentId,
            sessionKey: ctx.sessionKey,
          });
        }
        return shouldReturnParams ? { params } : {};
      } catch (err: unknown) {
        const reason =
          err instanceof Error
            ? err.message
            : `${moduleName}.${methodName}() blocked by Sapience Middleware policy`;
        logger.warn(`Blocking ${toolName}: ${reason}`);
        if (destructiveClassification?.isDestructive) {
          logInterceptEvent({
            eventType: 'tool_blocked',
            moduleName,
            methodName,
            toolName,
            params,
            severity: destructiveClassification.severity,
            reasons: destructiveClassification.reasons,
            bulkCount: destructiveClassification.bulkCount,
            target: destructiveClassification.target,
            summary: reason,
            agentId: ctx.agentId,
            sessionKey: ctx.sessionKey,
          });
        }
        return { block: true, blockReason: reason };
      }
    } catch (unexpectedErr: unknown) {
      // Outer fail-closed guard: any unhandled error in the hook (outside the inner
      // try/catch) must block the tool, not allow it. OpenClaw's hook runner is
      // fail-open — it catches hook exceptions and returns { blocked: false }.
      logger.error(`[tool-interceptor] Unexpected error — blocking ${toolName} (fail-closed)`, {
        error: unexpectedErr,
        toolName,
      });
      return {
        block: true,
        blockReason: `Sapience Middleware: unexpected hook error (fail-closed)`,
      };
    }
  };
}

function buildInterventionMetadata(
  moduleName: string,
  methodName: string,
  toolName: string,
  params: Record<string, unknown>,
  irreversibility: IrreversibilityAssessment,
  memoryRisk: MemoryRiskAssessment,
  destructive: DestructiveClassification | undefined,
  sessionKey: string,
  thresholds: SystemThresholds
): InterventionMetadata | undefined {
  const intervention: InterventionMetadata = {};

  if (destructive?.isDestructive) {
    intervention.forceAsk = true;
    intervention.requiresRespondToolApproval = true;
    intervention.destructiveSeverity = destructive.severity;
    intervention.destructiveReasons = destructive.reasons;
    intervention.destructiveBulkCount = destructive.bulkCount;
    intervention.destructiveTarget = destructive.target;

    if (destructive.severity === 'CATASTROPHIC') {
      intervention.requiresExplicitConfirmation = true;
    }

    intervention.actionSummary = buildDestructiveSummary(moduleName, methodName, destructive);
    intervention.interventionReason =
      'Pre-execution destructive action intercept triggered; explicit human authorization required.';
  }

  // Populate raw assessment metadata for audit logging
  intervention.irreversibilityScore = irreversibility.score;
  intervention.irreversibilityLevel = irreversibility.level;
  intervention.memoryRiskScore = memoryRisk.overallRisk;
  intervention.memoryRiskDrift = memoryRisk.driftScore;
  intervention.memoryRiskSalami = memoryRisk.salamiIndex;
  intervention.memoryRiskCommitment = memoryRisk.commitmentCreep;

  const challenge = detectBrowserChallenge(toolName, params);
  if (challenge.level === 'likely') {
    intervention.forceAsk = true;
    intervention.recommendScreenshotReview = true;
    intervention.overrideDescription = `Browser challenge likely (${challenge.kind}): ${challenge.reasons.join('; ')}`;
    intervention.interventionReason =
      'Detected CAPTCHA/Cloudflare/2FA-like browser state. Human intervention required.';
  } else if (challenge.level === 'possible') {
    intervention.forceAsk = true;
    intervention.recommendScreenshotReview = true;
    intervention.overrideDescription = `Possible browser challenge (${challenge.kind}): ${challenge.reasons.join('; ')}`;
    intervention.interventionReason =
      'Uncertain browser challenge state; run screenshot + vision review before approval.';
  }

  if (irreversibility.score >= thresholds.forceAskIrreversibilityThreshold) {
    intervention.forceAsk = true;
    const riskLine =
      `Irreversibility score ${irreversibility.score}/100 (${irreversibility.level}). ` +
      `${irreversibility.reasons.join('; ') || 'High-impact action pattern.'}`;

    intervention.overrideDescription = intervention.overrideDescription
      ? `${intervention.overrideDescription} ${riskLine}`
      : riskLine;
  }

  if (irreversibility.score >= thresholds.explicitConfirmIrreversibilityThreshold) {
    intervention.requiresExplicitConfirmation = true;
    if (!intervention.actionSummary) {
      intervention.actionSummary = irreversibility.summary;
    }
    intervention.interventionReason =
      'Irreversible action detected. Requires explicit token confirmation, not YES/NO.';
  }

  if (memoryRisk.shouldPause) {
    intervention.forceAsk = true;
    const topPaths = memoryRisk.simulatedPaths
      .map((path) => `${path.name} (${path.risk}/100)`)
      .join('; ');
    const memoryLine =
      `Memory risk forecast ${memoryRisk.overallRisk}/100 ` +
      `(drift ${memoryRisk.driftScore}, salami ${memoryRisk.salamiIndex}, commitment ${memoryRisk.commitmentCreep}).`;

    intervention.overrideDescription = intervention.overrideDescription
      ? `${intervention.overrideDescription} ${memoryLine}`
      : memoryLine;

    intervention.interventionReason = topPaths
      ? `Predicted N+1 danger paths: ${topPaths}.`
      : 'Memory drift indicates unsafe next-step trajectory.';

    if (!intervention.actionSummary) {
      intervention.actionSummary = memoryRisk.summary;
    }

    if (memoryRisk.overallRisk >= thresholds.explicitConfirmMemoryThreshold) {
      intervention.requiresExplicitConfirmation = true;
    }
  }

  // Cooldown escalation: tighten posture after repeated denials.
  const escalationState = trustRateLimiter.getState(
    sessionKey,
    thresholds.trustRateLimitLevel1,
    thresholds.trustRateLimitLevel2
  );
  if (escalationState.level >= 1) {
    intervention.forceAsk = true;
    intervention.cooldownLevel = escalationState.level;
    const cooldownLine =
      `Cooldown escalation level ${escalationState.level}: ` +
      `${escalationState.denialCount} denials in the last ${Math.round(escalationState.windowMs / 60_000)} minutes.`;
    intervention.interventionReason = intervention.interventionReason
      ? `${intervention.interventionReason} ${cooldownLine}`
      : cooldownLine;
  }
  if (escalationState.level >= 2) {
    intervention.requiresExplicitConfirmation = true;
    intervention.actionSummary = intervention.actionSummary || `${toolName}(...)`;
  }

  if (Object.keys(intervention).length === 0) {
    return undefined;
  }

  return intervention;
}

function buildDestructiveSummary(
  moduleName: string,
  methodName: string,
  classification: DestructiveClassification
): string {
  const lines = [
    `⚠ SAPIENCE MW INTERCEPT (${classification.severity})`,
    `Tool: ${moduleName}.${methodName}`,
  ];

  if (classification.target) {
    lines.push(`Target: ${classification.target}`);
  }
  if (classification.bulkCount !== undefined) {
    lines.push(`Bulk: ${classification.bulkCount.toLocaleString()} items`);
  }

  lines.push(`Reasons: ${classification.reasons.join(', ') || 'destructive_signal'}`);
  return lines.join('\n');
}

interface InterceptEventInput {
  eventType:
    | 'destructive_detected'
    | 'approval_requested'
    | 'approval_decision'
    | 'tool_executed'
    | 'tool_blocked';
  moduleName: string;
  methodName: string;
  toolName: string;
  params: Record<string, unknown>;
  severity?: 'HIGH' | 'CATASTROPHIC';
  reasons?: string[];
  bulkCount?: number;
  target?: string;
  argsHash?: string;
  summary?: string;
  requireToken?: string;
  approved?: boolean;
  decisionInput?: 'yes' | 'allow' | 'no' | 'confirm';
  confirmation?: string;
  agentId?: string;
  sessionKey?: string;
}

function logInterceptEvent(input: InterceptEventInput): void {
  const defaultDecisionByEvent: Record<
    InterceptEventInput['eventType'],
    'ALLOWED' | 'APPROVED' | 'REJECTED' | 'BLOCKED'
  > = {
    destructive_detected: 'BLOCKED',
    approval_requested: 'BLOCKED',
    approval_decision: input.approved ? 'APPROVED' : 'REJECTED',
    tool_executed: 'ALLOWED',
    tool_blocked: 'BLOCKED',
  };

  void DecisionLog.append({
    timestamp: new Date().toISOString(),
    module: input.moduleName,
    method: input.methodName,
    args: [input.params],
    decision: defaultDecisionByEvent[input.eventType],
    decisionTime: 0,
    reason: input.eventType,
    eventType: input.eventType,
    tool: input.toolName,
    severity: input.severity,
    reasons: input.reasons,
    bulkCount: input.bulkCount,
    target: input.target,
    argsHash: input.argsHash,
    summary: input.summary,
    requireToken: input.requireToken,
    approved: input.approved,
    decisionInput: input.decisionInput,
    confirmation: input.confirmation,
    agentId: input.agentId,
    sessionKey: input.sessionKey,
  });
}

export function getToolMapping(): Record<string, { module: string; method: string }> {
  return { ...TOOL_TO_MODULE };
}

export function getProtectedModules(): string[] {
  const modules = new Set<string>();
  for (const entry of Object.values(TOOL_TO_MODULE)) {
    modules.add(entry.module);
  }
  return Array.from(modules);
}
