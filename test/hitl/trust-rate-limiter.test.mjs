import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TrustRateLimiter } = require('../../dist/middlewares/hitl/approval/TrustRateLimiter.js');

test('TrustRateLimiter', async (t) => {
  await t.test('defaults to level 0 for unknown session', () => {
    const lim = new TrustRateLimiter();
    assert.equal(lim.getLevel('unknown'), 0);
    const state = lim.getState('unknown');
    assert.equal(state.level, 0);
    assert.equal(state.denialCount, 0);
    assert.equal(state.oldestDenialAge, null);
  });

  await t.test('escalates to level 1 at threshold', () => {
    const lim = new TrustRateLimiter();
    lim.recordDenial('sess', 3, 5);
    lim.recordDenial('sess', 3, 5);
    assert.equal(lim.getLevel('sess', 3, 5), 0);
    lim.recordDenial('sess', 3, 5);
    assert.equal(lim.getLevel('sess', 3, 5), 1);
  });

  await t.test('escalates to level 2 at higher threshold', () => {
    const lim = new TrustRateLimiter();
    for (let i = 0; i < 5; i++) lim.recordDenial('sess2', 3, 5);
    assert.equal(lim.getLevel('sess2', 3, 5), 2);
  });

  await t.test('getState returns denialCount and oldestDenialAge', () => {
    const lim = new TrustRateLimiter();
    lim.recordDenial('sess3');
    const state = lim.getState('sess3');
    assert.equal(state.denialCount, 1);
    assert.ok(state.oldestDenialAge !== null);
    assert.ok(state.windowMs > 0);
  });

  await t.test('prunes denials outside the rolling window', async () => {
    const lim = new TrustRateLimiter(50); // 50 ms window
    lim.recordDenial('sessp');
    lim.recordDenial('sessp');
    assert.equal(lim.getState('sessp').denialCount, 2);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(lim.getLevel('sessp'), 0);
    assert.equal(lim.getState('sessp').denialCount, 0);
  });

  await t.test('independent sessions track separately', () => {
    const lim = new TrustRateLimiter();
    for (let i = 0; i < 3; i++) lim.recordDenial('a', 3, 5);
    assert.equal(lim.getLevel('a', 3, 5), 1);
    assert.equal(lim.getLevel('b', 3, 5), 0);
  });
});
