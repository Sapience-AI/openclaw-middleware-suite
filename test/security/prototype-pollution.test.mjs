import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestEnvWithOpenclaw } from '../_helpers/test-env.mjs';

createTestEnvWithOpenclaw('sai-prototype-pollution-');

const distBase = path.resolve('dist');
const u = (p) => pathToFileURL(path.join(distBase, p)).href;

// Regression tests for CodeQL js/prototype-pollution-utility (#4, #5).
// Both setNestedValue helpers must refuse to write through path segments
// that could pollute Object.prototype.

test('ConfigStore.updateSync refuses __proto__ in dotted path', async () => {
  const { ConfigStore } = await import(u('shared/storage/ConfigStore.js'));

  // Snapshot prototype to detect any leak.
  // eslint-disable-next-line no-proto
  const protoBefore = {}.__proto__;

  assert.throws(() => ConfigStore.updateSync('__proto__.polluted', 'oops'), /unsafe path segment/);
  assert.throws(
    () => ConfigStore.updateSync('a.b.__proto__.polluted', 'oops'),
    /unsafe path segment/
  );
  assert.throws(() => ConfigStore.updateSync('constructor.x', 'oops'), /unsafe path segment/);
  assert.throws(() => ConfigStore.updateSync('prototype.x', 'oops'), /unsafe path segment/);

  // Object.prototype must be unchanged.
  // eslint-disable-next-line no-proto
  assert.equal({}.__proto__, protoBefore);
  assert.equal({}.polluted, undefined);
});
