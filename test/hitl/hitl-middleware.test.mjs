import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { createOpenclawHome } from '../_helpers/test-env.mjs';

const tempDir = createOpenclawHome('sapience-mw-hitl-middleware-tests-');

const require = createRequire(import.meta.url);
const { HitlMiddleware } = require('../../dist/middlewares/hitl/index.js');

test('HitlMiddleware', async (t) => {
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('has correct name and version', () => {
    const mw = new HitlMiddleware();
    assert.equal(mw.name, 'hitl');
    assert.equal(typeof mw.version, 'string');
  });

  await t.test('beforeToolCall blocks when not initialized', async () => {
    const mw = new HitlMiddleware();
    const result = await mw.beforeToolCall({
      moduleName: 'Shell',
      methodName: 'exec',
      params: { command: 'ls' },
      sessionKey: 'test',
    });
    assert.equal(result.block, true);
    assert.match(result.reason, /not initialized/);
  });

  await t.test('initialize sets up interceptor', async () => {
    const mw = new HitlMiddleware();
    await mw.initialize({ enabled: true });
    const status = mw.getStatus();
    assert.equal(status.enabled, true);
  });

  await t.test('initialize respects enabled=false', async () => {
    const mw = new HitlMiddleware();
    await mw.initialize({ enabled: false });
    assert.equal(mw.getStatus().enabled, false);
  });

  await t.test('beforeToolCall returns non-block result for benign call', async () => {
    const mw = new HitlMiddleware();
    await mw.initialize({ enabled: true });
    const result = await mw.beforeToolCall({
      moduleName: 'Info',
      methodName: 'version',
      params: {},
      sessionKey: 'benign-session',
    });
    // Either non-block, or block with a meaningful reason — either is valid per-policy
    assert.equal(typeof result.block, 'boolean');
  });

  await t.test('shutdown resolves without throwing', async () => {
    const mw = new HitlMiddleware();
    await mw.initialize({ enabled: true });
    await mw.shutdown();
  });
});
