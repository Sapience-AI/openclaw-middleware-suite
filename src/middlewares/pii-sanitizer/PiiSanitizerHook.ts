/**
 * Sapience Middleware PII Sanitizer Hook
 * Handles PII scanning and redaction for tool calls.
 */

import { PiiSanitizerMiddleware } from './PiiSanitizerMiddleware.js';
import { logger } from '../../shared/Logger.js';

export const piiSanitizer = new PiiSanitizerMiddleware();
piiSanitizer.initialize({}).catch((err) => {
  logger.error('Failed to initialize PII Sanitizer', { error: err });
});

export interface PiiScanResult {
  params: Record<string, unknown>;
  modified: boolean;
  block?: boolean;
  reason?: string;
}

/**
 * Execute PII scanning on tool parameters.
 */
export async function executePiiScan(
  toolName: string,
  moduleName: string,
  methodName: string,
  params: Record<string, unknown>,
  sessionKey?: string,
  agentId?: string
): Promise<PiiScanResult> {
  const piiResult = await piiSanitizer.beforeToolCall({
    toolName,
    moduleName,
    methodName,
    params,
    sessionKey,
    agentId,
    metadata: {},
  });

  const result: PiiScanResult = {
    params: (piiResult.modifiedParams as Record<string, unknown>) || params,
    modified: !!piiResult.modifiedParams,
  };

  // Hard deny ONLY for BLOCK-severity DLP rules.
  if (piiResult.block && piiResult.metadata?.dlpAction === 'BLOCK') {
    result.block = true;
    result.reason = piiResult.reason || 'Blocked by DLP Engine';
  }

  // Check for escalation flags (to be used by the HITL interceptor)
  if (piiResult.metadata?.dlpAction === 'ESCALATE' || !!piiResult.metadata?.dlpEscalate) {
    (result as any).escalated = true;
  }

  return result;
}
