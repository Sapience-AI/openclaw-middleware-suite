import test from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { setOpenclawHome, setDataDir } from '../_helpers/test-env.mjs';

// Set environment variable BEFORE any imports that might use it
const TEST_DIR = path.join(os.tmpdir(), `sapience-mw-req-tests-${Date.now()}-${Math.random().toString(36).substring(7)}`);
setDataDir(TEST_DIR);
setOpenclawHome(TEST_DIR);

// Using dynamic import so it picks up the environment variable we just set
const { ToolCallLimitMiddleware } = await import('../../dist/middlewares/tool-call-limit/index.js');
const { LimitPolicyStore } = await import('../../dist/middlewares/tool-call-limit/storage/LimitPolicyStore.js');

test.before(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true });
});

test.after(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

test('Integration: Request Budget Enforcement', async (t) => {
  const limitPolicy = {
    version: '1.0.0',
    updatedAt: new Date().toISOString(),
    globalSessionCallLimit: 0,
    globalRequestCallLimit: 0,
    modules: {
      FileSystem: {
        read: {
          sessionCallLimit: { max: 100 },
          requestCallLimit: { max: 5 }
        }
      }
    }
  };

  await LimitPolicyStore.save(limitPolicy);

  const limitMw = new ToolCallLimitMiddleware();
  await limitMw.initialize();

  const uniqueSuffix = Math.random().toString(36).substring(7);
  const sessionKey = `integration-test-${uniqueSuffix}`;
  const requestId = `turn-${uniqueSuffix}`;

  const callTool = () => limitMw.beforeToolCall({
    toolName: 'read',
    moduleName: 'FileSystem',
    methodName: 'read',
    params: { file_path: 'dummy.txt' },
    sessionKey,
    metadata: { requestId },
  });

  // Calls 1-4 should be OK (max=5)
  // enforceLimit increments count BEFORE checking: count >= max => HARD_LIMIT
  for (let i = 0; i < 4; i++) {
    const res = await callTool();
    assert.ok(res.block !== true, `Call ${i+1} should not be blocked`);
  }

  // 5th call -> count=5 >= max=5 -> HARD_LIMIT
  const res5 = await callTool();
  assert.strictEqual(res5.block, true, '5th call should be blocked when limit is 5');
  assert.match(res5.reason, /limit reached/i, 'Should indicate limit reached');

  // Verify that a different requestId is NOT blocked despite the session count
  const newRequestId = `turn-new-${uniqueSuffix}`;
  const newRes = await limitMw.beforeToolCall({
    toolName: 'read',
    moduleName: 'FileSystem',
    methodName: 'read',
    params: { file_path: 'other.txt' },
    sessionKey,
    metadata: { requestId: newRequestId },
  });
  assert.ok(newRes.block !== true, 'New request ID should have fresh budget');
});
