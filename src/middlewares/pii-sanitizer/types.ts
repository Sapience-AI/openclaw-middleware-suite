/**
 * PII Sanitizer Middleware — Type Definitions
 * This file is self-contained to ensure the module can operate independently.
 */

export interface MiddlewareContext {
  toolName: string;
  moduleName: string;
  methodName: string;
  params: Record<string, unknown>;
  sessionKey?: string;
  agentId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export interface MiddlewareResult {
  block: boolean;
  reason?: string;
  modifiedParams?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface Middleware {
  readonly name: string;
  readonly version: string;
  initialize(config: Record<string, unknown>): Promise<void>;
  beforeToolCall?(context: MiddlewareContext): Promise<MiddlewareResult>;
  getStatus(): { enabled: boolean; stats?: Record<string, unknown> };
  shutdown?(): Promise<void>;
}

/**
 * Data classification levels based on risk and impact.
 */
export type SeverityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * Possible actions the DLP engine can take when a match is found.
 */
export type ScannerAction = 'ALLOW' | 'REDACT' | 'ESCALATE' | 'BLOCK';

export interface DlpDetection {
  originalPattern: string; // The regex or pattern name that matched (e.g., 'credit_card')
  matchedString: string;
  startIndex: number;
  endIndex: number;
  severity: SeverityLevel;
  action: ScannerAction;
  replacementText?: string; // E.g., [REDACTED_CC] or sk-****123
}

export interface DlpRule {
  name: string;
  type: 'regex' | 'heuristic' | 'prefix';
  pattern: string;
  severity: SeverityLevel;
  action: ScannerAction;
  enabled: boolean;
  description?: string; // Human-readable explanation of what this rule protects
}

export type FieldPolicy = 'SCALABLE' | 'VALIDATE' | 'IGNORE';

export interface ToolFieldPolicy {
  [fieldName: string]: FieldPolicy;
}

export interface DlpPolicy {
  version: string;
  enabled: boolean;
  dryRunMode: boolean; // If true, log violations but do not redact/block
  globalRules: DlpRule[];
  toolPolicies: {
    [moduleName: string]: {
      [methodName: string]: {
        fields: ToolFieldPolicy;
        additionalRules?: DlpRule[]; // Tool-specific overrides or additions
      };
    };
  };
}
