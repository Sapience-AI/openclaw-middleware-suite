import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createOpenclawHome } from '../_helpers/test-env.mjs';

createOpenclawHome('sai-mr-policystore-');

const distBase = path.resolve('dist');
const u = (p) => pathToFileURL(path.join(distBase, p)).href;

const { ModelRoutingPolicyStore } = await import(
  u('middlewares/model-routing/storage/ModelRoutingPolicyStore.js')
);
const paths = await import(u('shared/storage/paths.js'));

function resetStoreFile() {
  fs.mkdirSync(paths.SUITE_HOME, { recursive: true });
  if (fs.existsSync(paths.STORE_FILE)) fs.rmSync(paths.STORE_FILE);
}

// ---------------------------------------------------------------------------
// defaults()
// ---------------------------------------------------------------------------

test('defaults() returns an empty ModelRoutingPolicyData shape', () => {
  assert.deepEqual(ModelRoutingPolicyStore.defaults(), {});
});

// ---------------------------------------------------------------------------
// load() — defaults path when the store is empty
// ---------------------------------------------------------------------------

test('load() returns defaults when no config is persisted', async () => {
  resetStoreFile();
  const loaded = await ModelRoutingPolicyStore.load();
  assert.deepEqual(loaded, ModelRoutingPolicyStore.defaults());
});

// ---------------------------------------------------------------------------
// save() + load() round-trip
// ---------------------------------------------------------------------------

test('save() + load() round-trip preserves every field', async () => {
  resetStoreFile();

  const payload = {
    weightOverrides: { reasoning: 0.7, costSensitivity: 0.3 },
    boundaryOverrides: { simpleStandard: 0.25, standardComplex: 0.55 },
    tierOverridesByProfile: {
      eco: {
        SIMPLE: { primary: 'gpt-4o-mini', fallbacks: [] },
      },
      premium: {
        COMPLEX: { primary: 'claude-opus-4-6', fallbacks: ['anthropic/claude-sonnet-4-6'] },
      },
    },
    exclusions: ['gpt-3.5-turbo'],
    providerConfigs: {
      anthropic: { baseURL: 'https://api.anthropic.com', apiKey: 'test-key' },
    },
    defaultProfile: 'premium',
    sessionPinningEnabled: true,
    providerCacheEnabled: false,
  };

  await ModelRoutingPolicyStore.save(payload);
  const loaded = await ModelRoutingPolicyStore.load();
  assert.deepEqual(loaded, payload);
});

// ---------------------------------------------------------------------------
// update() — partial-merge semantics
// ---------------------------------------------------------------------------

test('update() merges partial writes without wiping other fields', async () => {
  resetStoreFile();

  // Seed with a multi-field shape.
  const initial = {
    weightOverrides: { reasoning: 0.6 },
    exclusions: ['gpt-3.5-turbo'],
    defaultProfile: 'eco',
    sessionPinningEnabled: false,
  };
  await ModelRoutingPolicyStore.save(initial);

  // First partial update — only touches defaultProfile.
  await ModelRoutingPolicyStore.update({ defaultProfile: 'premium' });
  let loaded = await ModelRoutingPolicyStore.load();
  assert.equal(loaded.defaultProfile, 'premium');
  assert.deepEqual(
    loaded.exclusions,
    ['gpt-3.5-turbo'],
    'exclusions must survive first partial update'
  );
  assert.deepEqual(loaded.weightOverrides, { reasoning: 0.6 });
  assert.equal(loaded.sessionPinningEnabled, false);

  // Second partial update — only touches pinning toggles.
  await ModelRoutingPolicyStore.update({
    sessionPinningEnabled: true,
    providerCacheEnabled: true,
  });
  loaded = await ModelRoutingPolicyStore.load();
  assert.equal(loaded.sessionPinningEnabled, true);
  assert.equal(loaded.providerCacheEnabled, true);
  // Earlier fields must still be present.
  assert.equal(loaded.defaultProfile, 'premium');
  assert.deepEqual(loaded.exclusions, ['gpt-3.5-turbo']);
  assert.deepEqual(loaded.weightOverrides, { reasoning: 0.6 });
});

// ---------------------------------------------------------------------------
// reset via save(defaults()) wipes the whole key
// ---------------------------------------------------------------------------

test('save(defaults()) wipes all fields — the reset path', async () => {
  resetStoreFile();

  await ModelRoutingPolicyStore.save({
    defaultProfile: 'eco',
    exclusions: ['x'],
    sessionPinningEnabled: true,
  });

  await ModelRoutingPolicyStore.save(ModelRoutingPolicyStore.defaults());
  const loaded = await ModelRoutingPolicyStore.load();
  assert.deepEqual(loaded, {});
});

// ---------------------------------------------------------------------------
// loadSync() parity with async load()
// ---------------------------------------------------------------------------

test('loadSync() returns the same shape as load()', async () => {
  resetStoreFile();

  const payload = {
    defaultProfile: 'eco',
    exclusions: ['foo', 'bar'],
  };
  await ModelRoutingPolicyStore.save(payload);

  const loaded = await ModelRoutingPolicyStore.load();
  const loadedSync = ModelRoutingPolicyStore.loadSync();
  assert.deepEqual(loadedSync, loaded);
});
