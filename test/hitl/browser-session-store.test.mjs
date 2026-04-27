import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { createOpenclawHome } from '../_helpers/test-env.mjs';

const tempDir = createOpenclawHome('sapience-mw-browser-session-tests-');

const require = createRequire(import.meta.url);
const {
  BrowserSessionStore,
} = require('../../dist/middlewares/hitl/storage/BrowserSessionStore.js');

test('BrowserSessionStore', async (t) => {
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('buildSessionId composes scope + host', () => {
    const id = BrowserSessionStore.buildSessionId('user-1', { url: 'https://example.com/path' });
    assert.equal(id, 'user-1::example.com');
  });

  await t.test('buildSessionId falls back to unknown-host for invalid URL', () => {
    const id = BrowserSessionStore.buildSessionId('user-1', { url: 'not-a-url' });
    assert.equal(id, 'user-1::unknown-host');
  });

  await t.test('buildSessionId uses global scope when sessionKey missing', () => {
    const id = BrowserSessionStore.buildSessionId(undefined, { href: 'https://a.test' });
    assert.equal(id, 'global::a.test');
  });

  await t.test('captureState returns empty when no session fields', () => {
    const fields = BrowserSessionStore.captureState('s1::a.test', { url: 'https://a.test' });
    assert.deepEqual(fields, []);
  });

  await t.test('captureState + injectState round-trips cookies', () => {
    const sessionId = 'round::site.test';
    const fields = BrowserSessionStore.captureState(sessionId, {
      url: 'https://site.test',
      cookies: [{ name: 'sid', value: 'abc123' }],
      storageState: { local: { token: 't' } },
    });
    assert.ok(fields.includes('cookies'));
    assert.ok(fields.includes('storageState'));

    const { params, injectedFields } = BrowserSessionStore.injectState(sessionId, {
      url: 'https://site.test',
    });
    assert.ok(injectedFields.includes('cookies'));
    assert.deepEqual(params.cookies, [{ name: 'sid', value: 'abc123' }]);
  });

  await t.test('injectState is a no-op for unknown sessionId', () => {
    const { params, injectedFields } = BrowserSessionStore.injectState('nope::x.test', {
      url: 'https://x.test',
    });
    assert.deepEqual(injectedFields, []);
    assert.deepEqual(params, { url: 'https://x.test' });
  });

  await t.test('injectState does not overwrite existing fields', () => {
    const sessionId = 'noover::site.test';
    BrowserSessionStore.captureState(sessionId, {
      url: 'https://site.test',
      cookies: [{ name: 'old', value: '1' }],
    });

    const { params, injectedFields } = BrowserSessionStore.injectState(sessionId, {
      url: 'https://site.test',
      cookies: [{ name: 'new', value: '2' }],
    });
    assert.equal(injectedFields.includes('cookies'), false);
    assert.deepEqual(params.cookies, [{ name: 'new', value: '2' }]);
  });

  await t.test('captures authorization/cookie headers only', () => {
    const sessionId = 'hdr::api.test';
    const fields = BrowserSessionStore.captureState(sessionId, {
      url: 'https://api.test',
      headers: { Authorization: 'Bearer x', 'X-Ignored': 'y' },
    });
    assert.ok(fields.includes('headers'));

    const { params, injectedFields } = BrowserSessionStore.injectState(sessionId, {
      url: 'https://api.test',
    });
    assert.ok(injectedFields.includes('headers.authorization'));
    assert.equal(params.headers.authorization, 'Bearer x');
    assert.equal(params.headers['X-Ignored'], undefined);
  });
});
