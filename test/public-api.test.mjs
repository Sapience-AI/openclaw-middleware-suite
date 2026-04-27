/**
 * Public API Smoke Test
 *
 * Asserts that every documented name under each subpath is actually re-exported
 * from dist/public/*.js, and that the root surface exposes the trimmed set.
 *
 * Prevents README-vs-code drift: if someone removes or renames a documented
 * export without updating this test (and the README), the test fails loudly
 * before publish.
 *
 * When updating: keep the constants below in sync with src/public/*.ts and the
 * corresponding "Programmatic API" / "Integration" tables in README.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestEnvWithOpenclaw } from './_helpers/test-env.mjs';

// Isolate before any dist/ import — several middleware singletons touch
// ~/.openclaw/ at module-load time.
createTestEnvWithOpenclaw('sai-public-api-');

const distBase = path.resolve('dist');

function distUrl(relativePath) {
  return pathToFileURL(path.join(distBase, relativePath)).href;
}

function assertAllExported(mod, names, subpath) {
  for (const name of names) {
    assert.notStrictEqual(
      mod[name],
      undefined,
      `sapience-ai-suite${subpath} is missing export: ${name}`
    );
  }
}

// ── Expected surfaces ───────────────────────────────────────────────────

const HITL_NAMES = [
  // Middleware class
  'HitlMiddleware',
  // Interceptor + approval engine
  'Interceptor',
  'Arbitrator',
  'approvalQueue',
  // Hook factory + mapping
  'createToolCallHook',
  'getToolMapping',
  'getProtectedModules',
  // Storage
  'PolicyStore',
  'DecisionLog',
  'StatsTracker',
  'BrowserSessionStore',
  // Scoring + risk
  'classifyDestructiveAction',
  'hashArgs',
  'scoreIrreversibility',
  'MemoryRiskForecaster',
  'detectBrowserChallenge',
  'trustRateLimiter',
  'TrustRateLimiter',
  // Config defaults
  'DEFAULT_POLICY',
];

const CONTEXT_EDITING_NAMES = [
  'ContextEditingMiddleware',
  'DEFAULT_CONTEXT_EDITING_CONFIG',
  'ContextEditingPolicyStore',
];

const MODEL_ROUTING_NAMES = [
  'ModelRoutingMiddleware',
  'DEFAULT_MODEL_ROUTING_CONFIG',
  'DEFAULT_SCORING_CONFIG',
  'DEFAULT_CLASSIFIER_CONFIG',
  'DEFAULT_DEDUP_CONFIG',
  'scoreRequest',
  'classifyWithLLM',
  'RequestDeduplicator',
  'ResponseCache',
  'discoverAllModels',
  'resolveProvider',
  'autoAssignTiers',
  'MomentumTracker',
  'SessionStore',
  'PROFILE_CONFIGS',
  'VALID_PROFILES',
  'isValidProfile',
  'CostTracker',
  'PluginRegistry',
  'ModelRoutingPolicyStore',
];

const GUARDRAIL_NAMES = [
  'GuardrailMiddleware',
  'GuardrailScanner',
  'executeGuardrailScan',
  'createWriteScannerHook',
  'createPromptGuardHook',
  // Async OpenAI Moderation hook + cache reader for the before_message_write
  // sync enforcement path. Added when guardrail's full lifecycle surface was
  // exposed to programmatic consumers.
  'createModerationGuardHook',
  'consumeModerationResult',
  'scrubMetadata',
  'getPatternCount',
  'GuardrailConfigStore',
  'GuardrailDecisionLog',
];

const PII_SANITIZER_NAMES = ['PiiSanitizerMiddleware', 'PII_PATTERNS', 'DlpStore'];

const TOOL_CALL_LIMIT_NAMES = ['ToolCallLimitMiddleware', 'LimitPolicyStore'];

const ROOT_NAMES = [
  'MiddlewareRegistry',
  'logger',
  'LOG_PATH',
  'SAPIENCE_MW_DATA_DIR',
  'SapienceMiddlewarePlugin',
  'SapienceMiddlewareManifest',
  'registerPlugin',
  'unregisterPlugin',
  'isPluginRegistered',
  'isOpenClawInstalled',
  'loadOpenClawConfig',
  'saveOpenClawConfig',
];

// Names that MUST NOT be re-exported from the root anymore — guards against
// accidentally re-introducing middleware-specific symbols into the flat root.
const ROOT_FORBIDDEN = [
  'Interceptor',
  'Arbitrator',
  'approvalQueue',
  'HitlMiddleware',
  'createToolCallHook',
  'ContextEditingMiddleware',
  'ModelRoutingMiddleware',
  'GuardrailScanner',
  'GuardrailMiddleware',
  'PiiSanitizerMiddleware',
  'PII_PATTERNS',
  'ToolCallLimitMiddleware',
  'classifyDestructiveAction',
  'scoreIrreversibility',
  'MemoryRiskForecaster',
  'trustRateLimiter',
];

// ── Tests ───────────────────────────────────────────────────────────────

test('sapience-ai-suite/hitl exports the documented surface', async () => {
  const mod = await import(distUrl('public/hitl.js'));
  assertAllExported(mod, HITL_NAMES, '/hitl');
});

test('sapience-ai-suite/context-editing exports the documented surface', async () => {
  const mod = await import(distUrl('public/context-editing.js'));
  assertAllExported(mod, CONTEXT_EDITING_NAMES, '/context-editing');
});

test('sapience-ai-suite/model-routing exports the documented surface', async () => {
  const mod = await import(distUrl('public/model-routing.js'));
  assertAllExported(mod, MODEL_ROUTING_NAMES, '/model-routing');
});

test('sapience-ai-suite/guardrail exports the documented surface', async () => {
  const mod = await import(distUrl('public/guardrail.js'));
  assertAllExported(mod, GUARDRAIL_NAMES, '/guardrail');
});

test('sapience-ai-suite/pii-sanitizer exports the documented surface', async () => {
  const mod = await import(distUrl('public/pii-sanitizer.js'));
  assertAllExported(mod, PII_SANITIZER_NAMES, '/pii-sanitizer');
});

test('sapience-ai-suite/tool-call-limit exports the documented surface', async () => {
  const mod = await import(distUrl('public/tool-call-limit.js'));
  assertAllExported(mod, TOOL_CALL_LIMIT_NAMES, '/tool-call-limit');
});

test('sapience-ai-suite root exports only cross-cutting symbols', async () => {
  const mod = await import(distUrl('index.js'));
  assertAllExported(mod, ROOT_NAMES, '');
  for (const name of ROOT_FORBIDDEN) {
    assert.strictEqual(
      mod[name],
      undefined,
      `sapience-ai-suite root leaked middleware-specific export: ${name}`
    );
  }
});

test('GuardrailMiddleware implements the Middleware interface', async () => {
  const { GuardrailMiddleware } = await import(distUrl('public/guardrail.js'));
  const gr = new GuardrailMiddleware();
  assert.equal(gr.name, 'guardrail');
  assert.equal(typeof gr.version, 'string');
  assert.equal(typeof gr.initialize, 'function');
  assert.equal(typeof gr.beforeToolCall, 'function');
  // Post-Pass-1: guardrail covers all three lifecycle surfaces through the
  // class — symmetrical with the other middleware adapters.
  assert.equal(typeof gr.beforeAgentStart, 'function');
  assert.equal(typeof gr.beforeMessageWrite, 'function');
  assert.equal(typeof gr.getStatus, 'function');

  await gr.initialize({});
  const status = gr.getStatus();
  assert.equal(typeof status.enabled, 'boolean');
  assert.equal(typeof status.stats, 'object');
});
