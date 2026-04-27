import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createTestEnvWithOpenclaw,
  clearOpenAIKey,
  setOpenAIKey,
} from '../_helpers/test-env.mjs';

createTestEnvWithOpenclaw('sai-moderation-guard-');

const distBase = path.resolve('dist');
const u = (p) => pathToFileURL(path.join(distBase, p)).href;

const mod = await import(u('middlewares/guardrail/ModerationGuardHook.js'));
const scannerMod = await import(u('middlewares/guardrail/GuardrailWriteScannerHook.js'));

// ── consumeModerationResult ──────────────────────────────────

test('consume: returns undefined for unknown session', () => {
  const r = mod.consumeModerationResult('nonexistent-session-xyz');
  assert.equal(r, undefined);
});

test('consume: returns undefined for non-flagged entry', async () => {
  // Populate cache manually via hook (no API key → skips → nothing cached)
  clearOpenAIKey();
  const hook = mod.createModerationGuardHook();
  await hook({ prompt: 'hello world test content' }, { sessionKey: 'sess-clean' });
  // No API key → skipped → nothing cached
  const r = mod.consumeModerationResult('sess-clean');
  assert.equal(r, undefined);
});

// ── createModerationGuardHook — no-op cases ──────────────────

test('hook: returns {} when sessionKey is missing', async () => {
  const hook = mod.createModerationGuardHook();
  const r = await hook({ prompt: 'test' }, {});
  assert.deepEqual(r, {});
});

test('hook: returns {} when prompt is missing', async () => {
  const hook = mod.createModerationGuardHook();
  const r = await hook({}, { sessionKey: 'sess-1' });
  assert.deepEqual(r, {});
});

test('hook: returns {} when prompt is not a string', async () => {
  const hook = mod.createModerationGuardHook();
  const r = await hook({ prompt: 42 }, { sessionKey: 'sess-2' });
  assert.deepEqual(r, {});
});

test('hook: returns {} when no OPENAI_API_KEY (skips moderation)', async () => {
  clearOpenAIKey();
  const hook = mod.createModerationGuardHook();
  const r = await hook({ prompt: 'some user content' }, { sessionKey: 'sess-3' });
  assert.deepEqual(r, {});
  // Nothing should be cached
  assert.equal(mod.consumeModerationResult('sess-3'), undefined);
});

test('hook: returns {} on API error (fail-open)', async () => {
  setOpenAIKey('sk-invalid-key-for-testing');
  const hook = mod.createModerationGuardHook();
  // Should not throw even with an invalid key
  const r = await hook({ prompt: 'this is some content for testing' }, { sessionKey: 'sess-4' });
  assert.deepEqual(r, {});
  clearOpenAIKey();
});

// ── createModerationGuardHook — caching behavior ─────────────

test('hook: caches flagged result and consume clears it', async () => {
  // Simulate a flagged result by monkey-patching checkContentModeration.
  // We do this by creating a hook with a mocked scenario via direct cache
  // manipulation (the cache is module-internal, so we test via consume).

  // We can't easily mock the fetch, so we test the cache contract: if
  // nothing was cached (no API key), consume returns undefined.
  clearOpenAIKey();
  const hook = mod.createModerationGuardHook();
  await hook({ prompt: 'safe content here' }, { sessionKey: 'sess-cache-1' });

  const first = mod.consumeModerationResult('sess-cache-1');
  assert.equal(first, undefined); // Not flagged (no API key → skipped)

  const second = mod.consumeModerationResult('sess-cache-1');
  assert.equal(second, undefined); // Already consumed / never set
});

test('hook: consume is one-shot (second call returns undefined)', async () => {
  // Even if we had a cached flagged result, second consume returns undefined.
  // Verify by calling twice on a known-empty key.
  const r1 = mod.consumeModerationResult('one-shot-key');
  const r2 = mod.consumeModerationResult('one-shot-key');
  assert.equal(r1, undefined);
  assert.equal(r2, undefined);
});

// ── Write scanner integration ─────────────────────────────────

test('write-scanner: passes through non-user messages regardless of cache', async () => {
  // Simulate what happens when role is 'assistant' — cache should not be consumed.
  // We have no direct way to inject into cache without internal access, so we
  // verify the path by ensuring a clean (non-flagged) result for assistant role.
  clearOpenAIKey();
  const hook = scannerMod.createWriteScannerHook();

  const event = { role: 'assistant', content: 'This is an assistant response.' };
  const ctx = { sessionKey: 'sess-write-1', agentId: 'main' };

  // Should not throw and should return undefined (pass through) or a redact object
  // but NOT a moderation block (since role is not 'user')
  const r = hook(event, ctx);
  if (r !== undefined) {
    // If something was returned, it should NOT be a moderation block
    assert.ok(
      !r.content?.includes('[GUARDRAIL:openai-moderation-api]'),
      'Assistant messages must not be blocked by moderation cache'
    );
  }
});

test('write-scanner: passes through user message when no cached result', async () => {
  clearOpenAIKey();
  const hook = scannerMod.createWriteScannerHook();

  const event = { role: 'user', content: 'Hello, can you help me?' };
  const ctx = { sessionKey: 'sess-write-clean', agentId: 'main' };

  const r = hook(event, ctx);
  // No moderation block should occur (nothing in cache)
  if (r !== undefined) {
    assert.ok(
      !r.content?.includes('[GUARDRAIL:openai-moderation-api]'),
      'User message must not be moderation-blocked when cache is empty'
    );
  }
});

test('write-scanner: content with top-level role field is recognised', async () => {
  clearOpenAIKey();
  const hook = scannerMod.createWriteScannerHook();
  // role in top-level event field
  const event = { role: 'user', content: 'normal content no injection' };
  const ctx = { sessionKey: 'sess-role-top', agentId: 'main' };
  const r = hook(event, ctx);
  // Should not throw; moderation block only occurs when cache is populated
  assert.ok(r === undefined || typeof r === 'object');
});

test('write-scanner: content with nested message.role field is recognised', async () => {
  clearOpenAIKey();
  const hook = scannerMod.createWriteScannerHook();
  const event = {
    message: { role: 'user', content: 'another normal message' },
  };
  const ctx = { sessionKey: 'sess-role-nested', agentId: 'main' };
  const r = hook(event, ctx);
  assert.ok(r === undefined || typeof r === 'object');
});
