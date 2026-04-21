import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createOpenclawHome,
  enableDestructiveGating,
  setBulkThreshold,
} from '../_helpers/test-env.mjs';

const openclawHome = createOpenclawHome('sapience-mw-destructive-tests-');
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

test('destructive tool call is blocked without approval', async () => {
  const interceptor = new Interceptor(allowAllPolicy());
  const hook = createToolCallHook(interceptor);

  const result = await hook(
    {
      toolName: 'write',
      params: {
        path: '/tmp/demo.txt',
        content: 'overwrite this file',
      },
    },
    {
      toolName: 'write',
      sessionKey: 'it:no-approval',
    }
  );

  assert.equal(result.block, true);
});

test('HIGH destructive action executes after OOB !approve', async () => {
  const interceptor = new Interceptor(allowAllPolicy());
  interceptor.onBlockCallback = async () => true;
  const hook = createToolCallHook(interceptor);
  const sessionKey = 'it:high-oob';

  // Fire the hook — it stalls on OOB waiting for human approval.
  // We must resolve the pending entry concurrently while it waits.
  const hookPromise = hook(
    { toolName: 'write', params: { path: '/tmp/high-risk.txt', content: 'overwrite' } },
    { toolName: 'write', sessionKey }
  );

  // Give the hook time to register the pending entry, then approve
  await new Promise((r) => setTimeout(r, 500));
  const info = approvalQueue.getNotificationInfo(sessionKey, 'FileSystem', 'write');
  assert.ok(info, 'expected an entry in the pending queue');
  const resolved = approvalQueue.resolveLatestPending('approve');
  assert.equal(resolved, true);

  // After OOB approval, the hook resolves with pass-through (not block)
  const result = await hookPromise;
  assert.notEqual(result.block, true, 'OOB-approved call should pass through');
  // Token must NOT appear in any reason text
  assert.doesNotMatch(result.blockReason || '', /CONFIRM-/);
});

test('CATASTROPHIC action executes after OOB !approve with token', async () => {
  const interceptor = new Interceptor(allowAllPolicy());
  interceptor.onBlockCallback = async () => true;
  const hook = createToolCallHook(interceptor);
  const sessionKey = 'it:cat-oob';

  // Fire the hook — it stalls on OOB waiting for human approval.
  const hookPromise = hook(
    { toolName: 'bash', params: { command: 'rm -rf /' } },
    { toolName: 'bash', sessionKey }
  );

  await new Promise((r) => setTimeout(r, 500));
  const info = approvalQueue.getNotificationInfo(sessionKey, 'Shell', 'bash');
  assert.ok(info, 'expected an entry in the pending queue');
  assert.equal(approvalQueue.resolveLatestPending('approve'), true);

  // After OOB approval, the hook resolves with pass-through (not block)
  const result = await hookPromise;
  assert.notEqual(result.block, true, 'OOB-approved call should pass through');
  // Token must NOT appear in any reason text — agent cannot self-approve
  assert.doesNotMatch(result.blockReason || '', /CONFIRM-/);
});
