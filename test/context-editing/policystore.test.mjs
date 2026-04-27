import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createOpenclawHome } from '../_helpers/test-env.mjs';

createOpenclawHome('sai-ce-policystore-');

const distBase = path.resolve('dist');
const u = (p) => pathToFileURL(path.join(distBase, p)).href;

const { ContextEditingPolicyStore } = await import(
  u('middlewares/context-editing/storage/ContextEditingPolicyStore.js')
);
const { ContextEditingStats } = await import(
  u('middlewares/context-editing/storage/ContextEditingStats.js')
);
const paths = await import(u('shared/storage/paths.js'));

function resetStoreFile() {
  fs.mkdirSync(paths.SUITE_HOME, { recursive: true });
  // Leave the file absent so `load()` exercises the defaults path when asked.
  if (fs.existsSync(paths.STORE_FILE)) fs.rmSync(paths.STORE_FILE);
}

function readRawStore() {
  if (!fs.existsSync(paths.STORE_FILE)) return {};
  return JSON.parse(fs.readFileSync(paths.STORE_FILE, 'utf-8'));
}

// ---------------------------------------------------------------------------
// defaults()
// ---------------------------------------------------------------------------

test('defaults() returns the full ContextEditingPolicyData shape', () => {
  const d = ContextEditingPolicyStore.defaults();

  // triggerMode is required and must be one of the three literals.
  assert.ok(['token', 'message', 'both'].includes(d.triggerMode));
  assert.equal(typeof d.tokenThreshold, 'number');
  assert.equal(typeof d.messageThreshold, 'number');
  assert.equal(typeof d.pruningMode, 'string');
  assert.equal(typeof d.ttl, 'string');
  assert.equal(typeof d.model, 'string');
  assert.equal(typeof d.customPromptEnabled, 'boolean');
  assert.equal(typeof d.customInstructions, 'string');
  assert.equal(typeof d.customSchema, 'string');
  assert.equal(typeof d.messagesKeptBeforeCompaction, 'number');
});

// ---------------------------------------------------------------------------
// load() — defaults path when the store is empty
// ---------------------------------------------------------------------------

test('load() returns defaults when no config is persisted', async () => {
  resetStoreFile();
  const loaded = await ContextEditingPolicyStore.load();
  assert.deepEqual(loaded, ContextEditingPolicyStore.defaults());
});

// ---------------------------------------------------------------------------
// save() + load() round-trip
// ---------------------------------------------------------------------------

test('save() + load() round-trip preserves every field', async () => {
  resetStoreFile();

  const payload = {
    triggerMode: 'token',
    tokenThreshold: 12345,
    messageThreshold: 42,
    pruningMode: 'enabled',
    ttl: '7m',
    model: 'anthropic/claude-4-7-sonnet',
    customPromptEnabled: true,
    customInstructions: 'Extract X, Y, Z.',
    customSchema: '{ "entities": [] }',
    messagesKeptBeforeCompaction: 5,
  };

  await ContextEditingPolicyStore.save(payload);
  const loaded = await ContextEditingPolicyStore.load();
  assert.deepEqual(loaded, payload);
});

// ---------------------------------------------------------------------------
// update() — partial-merge semantics
// ---------------------------------------------------------------------------

test('update() merges partial writes without wiping other fields', async () => {
  resetStoreFile();

  // Seed with a full shape.
  const initial = {
    triggerMode: 'both',
    tokenThreshold: 80000,
    messageThreshold: 50,
    pruningMode: 'disabled',
    ttl: '5m',
    model: 'openai/gpt-4',
    customPromptEnabled: false,
    customInstructions: '',
    customSchema: '',
    messagesKeptBeforeCompaction: 0,
  };
  await ContextEditingPolicyStore.save(initial);

  // First partial update — only touches model.
  await ContextEditingPolicyStore.update({ model: 'anthropic/claude-4-7-sonnet' });
  let loaded = await ContextEditingPolicyStore.load();
  assert.equal(loaded.model, 'anthropic/claude-4-7-sonnet');
  assert.equal(loaded.tokenThreshold, 80000, 'tokenThreshold must survive first partial update');
  assert.equal(loaded.triggerMode, 'both');

  // Second partial update — only touches pruning fields.
  await ContextEditingPolicyStore.update({ pruningMode: 'enabled', ttl: '10m' });
  loaded = await ContextEditingPolicyStore.load();
  assert.equal(loaded.pruningMode, 'enabled');
  assert.equal(loaded.ttl, '10m');
  // Earlier fields must still be present.
  assert.equal(loaded.model, 'anthropic/claude-4-7-sonnet');
  assert.equal(loaded.tokenThreshold, 80000);
  assert.equal(loaded.triggerMode, 'both');
});

// ---------------------------------------------------------------------------
// triggerMode — regression: survives all three paths (load / save / update)
// ---------------------------------------------------------------------------

test('triggerMode survives save → load', async () => {
  resetStoreFile();

  for (const mode of ['token', 'message', 'both']) {
    const defaults = ContextEditingPolicyStore.defaults();
    await ContextEditingPolicyStore.save({ ...defaults, triggerMode: mode });
    const loaded = await ContextEditingPolicyStore.load();
    assert.equal(loaded.triggerMode, mode, `triggerMode must survive save→load for "${mode}"`);
  }
});

test('triggerMode survives update() partial write', async () => {
  resetStoreFile();

  await ContextEditingPolicyStore.update({ triggerMode: 'token' });
  let loaded = await ContextEditingPolicyStore.load();
  assert.equal(loaded.triggerMode, 'token');

  await ContextEditingPolicyStore.update({ tokenThreshold: 90000 });
  loaded = await ContextEditingPolicyStore.load();
  assert.equal(loaded.triggerMode, 'token', 'triggerMode must survive an unrelated partial update');
  assert.equal(loaded.tokenThreshold, 90000);
});

test('invalid triggerMode string falls back to the default on load', async () => {
  resetStoreFile();

  // Write an invalid value directly so we bypass save()'s shape.
  fs.mkdirSync(paths.SUITE_HOME, { recursive: true });
  const current = readRawStore();
  current[paths.STORE_KEY_CONTEXT_EDITING] = { configOverrides: { triggerMode: 'garbage' } };
  fs.writeFileSync(paths.STORE_FILE, JSON.stringify(current, null, 2));

  const loaded = await ContextEditingPolicyStore.load();
  assert.equal(loaded.triggerMode, ContextEditingPolicyStore.defaults().triggerMode);
});

// ---------------------------------------------------------------------------
// loadSync() parity with async load()
// ---------------------------------------------------------------------------

test('loadSync() returns the same shape as load()', async () => {
  resetStoreFile();

  const payload = {
    ...ContextEditingPolicyStore.defaults(),
    triggerMode: 'message',
    tokenThreshold: 99999,
  };
  await ContextEditingPolicyStore.save(payload);

  const loaded = await ContextEditingPolicyStore.load();
  const loadedSync = ContextEditingPolicyStore.loadSync();
  assert.deepEqual(loadedSync, loaded);
});

// ---------------------------------------------------------------------------
// ContextEditingStats.getConfigOverrides() — flat → nested translator
// reads what PolicyStore writes and returns Partial<ContextEditingConfig>.
// ---------------------------------------------------------------------------

test('ContextEditingStats.getConfigOverrides() surfaces triggerMode', async () => {
  resetStoreFile();

  await ContextEditingPolicyStore.save({
    ...ContextEditingPolicyStore.defaults(),
    triggerMode: 'message',
  });

  const stats = new ContextEditingStats();
  const overrides = stats.getConfigOverrides();
  assert.equal(overrides.triggerMode, 'message');
});

test('ContextEditingStats.getConfigOverrides() translates flat pruning fields into nested shape', async () => {
  resetStoreFile();

  await ContextEditingPolicyStore.save({
    ...ContextEditingPolicyStore.defaults(),
    pruningMode: 'enabled',
    ttl: '12m',
  });

  const stats = new ContextEditingStats();
  const overrides = stats.getConfigOverrides();

  assert.ok(overrides.pruning, 'pruning subtree must be populated');
  assert.equal(overrides.pruning.enabled, true);
  assert.equal(overrides.pruning.mode, 'cache-ttl');
  assert.equal(overrides.pruning.ttl, '12m');
});

test('ContextEditingStats.getConfigOverrides() ignores unknown triggerMode values', async () => {
  resetStoreFile();

  // Bypass save()'s shape to plant a bad value directly on disk.
  fs.mkdirSync(paths.SUITE_HOME, { recursive: true });
  const current = readRawStore();
  current[paths.STORE_KEY_CONTEXT_EDITING] = {
    configOverrides: { triggerMode: 'not-a-mode', tokenThreshold: 1234 },
  };
  fs.writeFileSync(paths.STORE_FILE, JSON.stringify(current, null, 2));

  const stats = new ContextEditingStats();
  const overrides = stats.getConfigOverrides();
  assert.equal(overrides.triggerMode, undefined);
  assert.equal(overrides.tokenThreshold, 1234);
});
