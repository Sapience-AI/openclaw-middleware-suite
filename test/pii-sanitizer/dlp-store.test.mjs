import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createTestEnvWithOpenclaw } from '../_helpers/test-env.mjs';

const tempDir = createTestEnvWithOpenclaw('sapience-mw-dlp-store-tests-');

const require = createRequire(import.meta.url);
const {
  DlpStore,
  DEFAULT_DLP_POLICY,
} = require('../../dist/middlewares/pii-sanitizer/storage/DlpStore.js');
const paths = require('../../dist/shared/storage/paths.js');

function writeStore(obj) {
  mkdirSync(paths.SUITE_HOME, { recursive: true });
  writeFileSync(paths.STORE_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

test('DlpStore', async (t) => {
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('getPath returns a stable label', () => {
    const p = DlpStore.getPath();
    assert.equal(typeof p, 'string');
    assert.ok(p.includes('pii_sanitizer'));
  });

  await t.test('defaults returns a deep clone of DEFAULT_DLP_POLICY', () => {
    const a = DlpStore.defaults();
    const b = DlpStore.defaults();
    assert.deepEqual(a, DEFAULT_DLP_POLICY);
    assert.notEqual(a, DEFAULT_DLP_POLICY, 'should not be the same reference');
    a.dryRunMode = true;
    assert.equal(b.dryRunMode, false, 'mutating one clone must not affect another');
  });

  await t.test('load returns defaults when store key is missing', async () => {
    writeStore({}); // no pii_sanitizer key
    const policy = await DlpStore.load();
    assert.equal(policy.version, DEFAULT_DLP_POLICY.version);
    assert.ok(Array.isArray(policy.globalRules));
  });

  await t.test('save then load round-trips the policy', async () => {
    const policy = DlpStore.defaults();
    policy.dryRunMode = true;
    policy.version = '9.9.9';
    await DlpStore.save(policy);

    const loaded = await DlpStore.load();
    assert.equal(loaded.dryRunMode, true);
    assert.equal(loaded.version, '9.9.9');
  });

  await t.test('loadSync returns the persisted policy', () => {
    const sync = DlpStore.loadSync();
    assert.equal(sync.dryRunMode, true);
    assert.equal(sync.version, '9.9.9');
  });

  await t.test('loadSync returns defaults when key is missing', () => {
    writeStore({}); // wipe pii_sanitizer
    const sync = DlpStore.loadSync();
    assert.equal(sync.version, DEFAULT_DLP_POLICY.version);
  });

  await t.test('update shallow-merges the policy', async () => {
    await DlpStore.save(DlpStore.defaults());
    await DlpStore.update({ dryRunMode: true, version: '2.0.0' });
    const loaded = await DlpStore.load();
    assert.equal(loaded.dryRunMode, true);
    assert.equal(loaded.version, '2.0.0');
    // siblings preserved
    assert.ok(loaded.globalRules.length > 0);
  });

  await t.test('isPluginEnabled is false when plugin_config is absent', () => {
    writeStore({}); // no plugin_config
    DlpStore.refreshCache();
    assert.equal(DlpStore.isPluginEnabled(), false);
  });

  await t.test('isPluginEnabled reflects plugin_config.middlewares["pii-sanitizer"]', () => {
    writeStore({ plugin_config: { middlewares: { 'pii-sanitizer': true } } });
    DlpStore.refreshCache();
    assert.equal(DlpStore.isPluginEnabled(), true);

    writeStore({ plugin_config: { middlewares: { 'pii-sanitizer': false } } });
    DlpStore.refreshCache();
    assert.equal(DlpStore.isPluginEnabled(), false);
  });
});
