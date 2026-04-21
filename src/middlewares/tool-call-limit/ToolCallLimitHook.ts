/**
 * Sapience Middleware Tool Call Limit Hook
 * Handles budget enforcement for concurrent and sequential tool calls.
 */

import { ToolCallLimitMiddleware } from './ToolCallLimitMiddleware.js';
import { logger } from '../../shared/Logger.js';

export const toolCallLimit = new ToolCallLimitMiddleware();
toolCallLimit.initialize().catch((err) => {
  logger.error('Failed to initialize Tool Call Limit middleware', { error: err });
});

export interface LimitResult {
  block: boolean;
  reason?: string;
  softLimitTriggered?: boolean;
}

/**
 * Execute tool call budgeting logic.
 */
export async function executeLimitCheck(
  toolName: string,
  moduleName: string,
  methodName: string,
  params: Record<string, unknown>,
  sessionKey?: string,
  requestId?: string
): Promise<LimitResult> {
  const limitResult = await toolCallLimit.beforeToolCall({
    toolName,
    moduleName,
    methodName,
    params,
    sessionKey,
    requestId,
    metadata: {
      sessionKey,
      requestId,
    },
  });

  return {
    block: !!limitResult.block,
    reason: limitResult.reason || 'Tool call budget exceeded',
    softLimitTriggered: !!limitResult.metadata?.softLimitTriggered,
  };
}

/**
 * Resolve Request ID with Virtual Fallback if Gateway is silent
 */
export function resolveRequestId(sessionKey: string, requestId?: string): string {
  return toolCallLimit.resolveRequestId(sessionKey, requestId);
}
