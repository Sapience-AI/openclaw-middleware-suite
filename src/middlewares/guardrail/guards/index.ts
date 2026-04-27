/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Guards — fast-path security checks for L2 (before_tool_call) and L3 (before_message_write)
 *
 * L2 guards (run before tool execution):
 *   1. Sensitive path blocklist
 *   2. Network egress control
 *   3. Destructive command blocker
 *
 * L3 guards (run before message write):
 *   4. Role impersonation detection
 *   5. Canary / leakback detection
 */

// L2 guards
export { checkSensitivePath, DEFAULT_SENSITIVE_PATH_CONFIG } from './sensitive-paths.js';
export type { SensitivePathResult } from './sensitive-paths.js';

export { checkEgressControl, DEFAULT_EGRESS_CONFIG } from './egress-control.js';
export type { EgressCheckResult } from './egress-control.js';

export {
  checkDestructiveCommand,
  DEFAULT_DESTRUCTIVE_CONFIG,
  getBuiltinPatterns,
} from './destructive-commands.js';
export type { DestructiveCheckResult } from './destructive-commands.js';

// L3 guards
export { detectRoleImpersonation, neutralizeImpersonation } from './role-impersonation.js';
export type { RoleImpersonationResult } from './role-impersonation.js';

export { detectAgentInterrogation, neutralizeInterrogation } from './agent-interrogation.js';
export type { AgentInterrogationResult } from './agent-interrogation.js';

export { registerCanary, detectCanaries, getCanaryCount, clearCanaries } from './canary-tracker.js';
export type { CanaryMatch } from './canary-tracker.js';

export { checkContentModeration, getOverallSeverity } from './content-moderation.js';
export type { ContentModerationResult, ModerationCategory } from './content-moderation.js';
