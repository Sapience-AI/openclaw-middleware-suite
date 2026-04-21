import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createOpenclawHome,
  enableDestructiveGating,
  setBulkThreshold,
} from '../_helpers/test-env.mjs';

const openclawHome = createOpenclawHome('sapience-mw-argshash-tests-');
enableDestructiveGating();
setBulkThreshold(20);

const require = createRequire(import.meta.url);
const { Interceptor } = require('../../dist/middlewares/hitl/Interceptor.js');
const { createToolCallHook } = require('../../dist/middlewares/hitl/tool-interceptor.js');
const { approvalQueue } = require('../../dist/middlewares/hitl/approval/ApprovalQueue.js');

function allowAllPolicy() {
  return {
    defaultAction: 'ALLOW',
    modules: {},
  };
}

// This test mimics the real-world flow: NO onBlockCallback set (OOB removed).
// 1. First call is blocked, returns { block: true }
// 2. User /approve (resolveLatestPending)
// 3. Agent retries with the SAME params → should succeed
test('argsHash: same params succeed after /approve (no OOB callback)', async () => {
  const interceptor = new Interceptor(allowAllPolicy());
  // DO NOT set interceptor.onBlockCallback — mimics the user's current plugin/index.ts
  const hook = createToolCallHook(interceptor);
  const sessionKey = 'it:argshash-same';

  const first = await hook(
    { toolName: 'write', params: { path: '/tmp/risk.txt', content: 'overwrite' } },
    { toolName: 'write', sessionKey }
  );

  console.log('first result:', JSON.stringify(first));
  assert.equal(first.block, true, 'first call should be blocked');

  // Simulate user typing /approve
  const resolved = approvalQueue.resolveLatestPending('approve');
  console.log('resolved:', resolved);
  assert.equal(resolved, true, 'should find and approve the pending entry');

  // Agent retries with the exact same params
  const second = await hook(
    { toolName: 'write', params: { path: '/tmp/risk.txt', content: 'overwrite' } },
    { toolName: 'write', sessionKey }
  );

  console.log('second result:', JSON.stringify(second));
  assert.notEqual(second.block, true, 'second call should NOT be blocked after approval');
});

// This test verifies that DIFFERENT params are rejected after /approve
test('argsHash: different params are rejected after /approve', async () => {
  const interceptor = new Interceptor(allowAllPolicy());
  const hook = createToolCallHook(interceptor);
  const sessionKey = 'it:argshash-diff';

  const first = await hook(
    { toolName: 'write', params: { path: '/tmp/safe.txt', content: 'overwrite' } },
    { toolName: 'write', sessionKey }
  );

  assert.equal(first.block, true, 'first call should be blocked');

  const resolved = approvalQueue.resolveLatestPending('approve');
  assert.equal(resolved, true, 'should find and approve the pending entry');

  // Agent retries with DIFFERENT params — should be blocked
  const second = await hook(
    { toolName: 'write', params: { path: '/tmp/EVIL.txt', content: 'rm -rf /' } },
    { toolName: 'write', sessionKey }
  );

  console.log('different-params result:', JSON.stringify(second));
  assert.equal(second.block, true, 'different params should still be blocked');
});
