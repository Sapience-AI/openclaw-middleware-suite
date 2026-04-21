/**
 * HITL Middleware — Human-in-the-Loop
 * Implements the Middleware interface, wrapping the Interceptor for pipeline integration.
 */

import { Middleware, MiddlewareContext, MiddlewareResult } from '../../types.js';
import { Interceptor } from './Interceptor.js';
import { PolicyStore } from './storage/PolicyStore.js';
import { logger } from '../../shared/Logger.js';

// Re-export key HITL types and modules for convenience
export { Interceptor } from './Interceptor.js';
export { Arbitrator } from './approval/Arbitrator.js';
export { approvalQueue, hashArgs as approvalHashArgs } from './approval/ApprovalQueue.js';
export { TotpManager } from './approval/TotpManager.js';
export { trustRateLimiter, TrustRateLimiter } from './approval/TrustRateLimiter.js';
export { detectBrowserChallenge } from './scoring/BrowserChallengeDetector.js';
export type {
  BrowserChallengeSignal,
  BrowserChallengeLevel,
  BrowserChallengeKind,
} from './scoring/BrowserChallengeDetector.js';
export { classifyDestructiveAction, hashArgs } from './scoring/DestructiveClassifier.js';
export type {
  DestructiveClassification,
  DestructiveSeverity,
} from './scoring/DestructiveClassifier.js';
export { scoreIrreversibility } from './scoring/IrreversibilityScorer.js';
export type {
  IrreversibilityAssessment,
  IrreversibilityLevel,
} from './scoring/IrreversibilityScorer.js';
export { MemoryRiskForecaster } from './scoring/MemoryRiskForecaster.js';
export type { MemoryRiskAssessment, SimulatedPath } from './scoring/MemoryRiskForecaster.js';
export { BrowserSessionStore } from './storage/BrowserSessionStore.js';
export type { SessionInjectionResult } from './storage/BrowserSessionStore.js';
export { DEFAULT_POLICY } from './config.js';
export type { EscalationLevel, TrustRateLimiterState } from './approval/TrustRateLimiter.js';

const HITL_VERSION = '1.0.0';

export class HitlMiddleware implements Middleware {
  readonly name = 'hitl';
  readonly version = HITL_VERSION;

  private interceptor: Interceptor | null = null;
  private enabled = true;

  async initialize(config: Record<string, unknown>): Promise<void> {
    const policy = PolicyStore.loadSync();
    this.interceptor = new Interceptor(policy);
    this.enabled = config.enabled !== false;
    logger.info('[HitlMiddleware] Initialized', {
      defaultAction: policy.defaultAction,
      moduleCount: Object.keys(policy.modules).length,
    });
  }

  async beforeToolCall(context: MiddlewareContext): Promise<MiddlewareResult> {
    if (!this.interceptor) {
      return { block: true, reason: 'HITL middleware not initialized' };
    }

    try {
      await this.interceptor.evaluate(
        context.moduleName,
        context.methodName,
        [context.params],
        context.sessionKey,
        context.agentId
      );
      return { block: false };
    } catch (err: unknown) {
      const reason =
        err instanceof Error
          ? err.message
          : `${context.moduleName}.${context.methodName}() blocked by HITL policy`;
      return { block: true, reason };
    }
  }

  getStatus(): { enabled: boolean; stats?: Record<string, unknown> } {
    return { enabled: this.enabled };
  }

  async shutdown(): Promise<void> {
    logger.info('[HitlMiddleware] Shutting down');
  }
}
