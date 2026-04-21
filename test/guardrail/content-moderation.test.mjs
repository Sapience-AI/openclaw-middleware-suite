import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createTestEnvWithOpenclaw,
  clearOpenAIKey,
  setOpenAIKey,
  restoreOpenAIKey,
} from '../_helpers/test-env.mjs';

createTestEnvWithOpenclaw('sai-content-moderation-');

const distBase = path.resolve('dist');
const u = (p) => pathToFileURL(path.join(distBase, p)).href;

const mod = await import(u('middlewares/guardrail/guards/content-moderation.js'));

// ── checkContentModeration — pre-flight checks ──────────────

test('content-moderation: skips when OPENAI_API_KEY is not set', async () => {
  const saved = clearOpenAIKey();

  const r = await mod.checkContentModeration('some violent content here');
  assert.equal(r.flagged, false);
  assert.equal(r.skipped, true);
  assert.equal(r.skipReason, 'no-api-key');
  assert.equal(r.source, 'openai-moderation-api');

  restoreOpenAIKey(saved);
});

test('content-moderation: skips when content is empty', async () => {
  // Set a dummy key so we get past the API key check
  const saved = setOpenAIKey('sk-test-dummy');

  const r = await mod.checkContentModeration('');
  assert.equal(r.skipped, true);
  assert.equal(r.skipReason, 'content-too-short');

  restoreOpenAIKey(saved);
});

test('content-moderation: skips when content is too short', async () => {
  const saved = setOpenAIKey('sk-test-dummy');

  const r = await mod.checkContentModeration('hi');
  assert.equal(r.skipped, true);
  assert.equal(r.skipReason, 'content-too-short');

  restoreOpenAIKey(saved);
});

test('content-moderation: skips when content is null/undefined', async () => {
  const saved = setOpenAIKey('sk-test-dummy');

  const r = await mod.checkContentModeration(null);
  assert.equal(r.skipped, true);
  assert.equal(r.skipReason, 'content-too-short');

  restoreOpenAIKey(saved);
});

// ── checkContentModeration — API error handling (fail-open) ──

test('content-moderation: fail-open on invalid API key', async () => {
  const saved = setOpenAIKey('sk-invalid-key-for-testing');

  const r = await mod.checkContentModeration('This is test content for moderation checking.');
  // Should either get an API error (fail-open) or a valid response
  assert.equal(r.source, 'openai-moderation-api');
  if (r.skipped) {
    assert.ok(r.skipReason.startsWith('api-error') || r.skipReason === 'fetch-error');
  }

  restoreOpenAIKey(saved);
});

// ── getOverallSeverity ───────────────────────────────────────

test('severity: empty array returns MEDIUM', () => {
  const s = mod.getOverallSeverity([]);
  assert.equal(s, 'MEDIUM');
});

test('severity: violence returns HIGH', () => {
  const s = mod.getOverallSeverity([
    { name: 'violence', flagged: true, score: 0.95 },
  ]);
  assert.equal(s, 'HIGH');
});

test('severity: harassment returns MEDIUM', () => {
  const s = mod.getOverallSeverity([
    { name: 'harassment', flagged: true, score: 0.8 },
  ]);
  assert.equal(s, 'MEDIUM');
});

test('severity: sexual/minors returns CRITICAL', () => {
  const s = mod.getOverallSeverity([
    { name: 'sexual/minors', flagged: true, score: 0.9 },
  ]);
  assert.equal(s, 'CRITICAL');
});

test('severity: hate/threatening returns CRITICAL', () => {
  const s = mod.getOverallSeverity([
    { name: 'hate/threatening', flagged: true, score: 0.85 },
  ]);
  assert.equal(s, 'CRITICAL');
});

test('severity: illicit/violent returns CRITICAL', () => {
  const s = mod.getOverallSeverity([
    { name: 'illicit/violent', flagged: true, score: 0.7 },
  ]);
  assert.equal(s, 'CRITICAL');
});

test('severity: self-harm/intent returns HIGH', () => {
  const s = mod.getOverallSeverity([
    { name: 'self-harm/intent', flagged: true, score: 0.6 },
  ]);
  assert.equal(s, 'HIGH');
});

test('severity: highest wins (MEDIUM + CRITICAL = CRITICAL)', () => {
  const s = mod.getOverallSeverity([
    { name: 'harassment', flagged: true, score: 0.8 },
    { name: 'sexual/minors', flagged: true, score: 0.9 },
  ]);
  assert.equal(s, 'CRITICAL');
});

test('severity: highest wins (MEDIUM + HIGH = HIGH)', () => {
  const s = mod.getOverallSeverity([
    { name: 'harassment', flagged: true, score: 0.7 },
    { name: 'violence', flagged: true, score: 0.9 },
  ]);
  assert.equal(s, 'HIGH');
});

// ── Result structure ─────────────────────────────────────────

test('result: source is always openai-moderation-api', async () => {
  clearOpenAIKey();
  const r = await mod.checkContentModeration('test content here');
  assert.equal(r.source, 'openai-moderation-api');
});

test('result: categories and flaggedCategories are arrays', async () => {
  clearOpenAIKey();
  const r = await mod.checkContentModeration('test content here');
  assert.ok(Array.isArray(r.categories));
  assert.ok(Array.isArray(r.flaggedCategories));
});
