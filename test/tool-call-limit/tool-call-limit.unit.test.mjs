import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createTestEnv } from '../_helpers/test-env.mjs';
const require = createRequire(import.meta.url);

createTestEnv('tool-call-limit-tests-');

const distBase = path.resolve(process.cwd(), 'dist');
const { ToolCallLimitMiddleware } = require(path.join(distBase, 'middlewares', 'tool-call-limit', 'ToolCallLimitMiddleware.js'));
const { TrackerStore } = require(path.join(distBase, 'middlewares', 'tool-call-limit', 'storage', 'TrackerStore.js'));

test('ToolCallLimitMiddleware enforces budgets', async (t) => {
  const sessionKey = 'test-session-config-limits';
  const middleware = new ToolCallLimitMiddleware();
  await middleware.initialize();
  
  // Clear any previous state
  await middleware.clearAllSessionLimits();
  
  await t.test('allows calls under limit for Shell.exec', async () => {
    const rule = { sessionCallLimit: { max: 10 } }; 
    const max = 10;
    
    for (let i = 0; i < 7; i++) {
       const status = await middleware.incrementAndCheck(sessionKey, 'Shell', 'exec', rule);
       assert.equal(status, 'OK', `Expected OK status at count ${i + 1}`);
    }
  });

  await t.test('returns SOFT_LIMIT when reaching threshold', async () => {
    const sessionKeySoft = 'test-session-soft';
    const rule = { action: 'ASK', sessionCallLimit: { max: 10 } };
    
    // Clear state for this subtest for better isolation
    await middleware.clearAllSessionLimits();

    // Increment up to 7 (for max 10, soft limit is max-2 = 8)
    for (let i = 0; i < 7; i++) {
        await middleware.incrementAndCheck(sessionKeySoft, 'Network', 'fetch', rule);
    }
    
    // 8th call -> SOFT_LIMIT
    const status = await middleware.incrementAndCheck(sessionKeySoft, 'Network', 'fetch', rule);
    assert.equal(status, 'SOFT_LIMIT', 'Expected SOFT_LIMIT warning');
    
    // 9th call -> OK (already warned)
    const status9 = await middleware.incrementAndCheck(sessionKeySoft, 'Network', 'fetch', rule);
    assert.equal(status9, 'OK', 'Expected OK on 9th call');

    // 10th call -> HARD_LIMIT
    const statusAfter = await middleware.incrementAndCheck(sessionKeySoft, 'Network', 'fetch', rule);
    assert.equal(statusAfter, 'HARD_LIMIT', 'Expected HARD_LIMIT on 10th call'); 
  });

  await t.test('tracks via agentId fallback if sessionKey missing', async () => {
    const agentId = 'agent-123';
    const rule = { sessionCallLimit: { max: 2 } };
    
    await middleware.clearAllSessionLimits();

    const status1 = await middleware.incrementAndCheck(undefined, 'Browser', 'screenshot', rule, undefined, agentId);
    assert.equal(status1, 'SOFT_LIMIT');

    const status2 = await middleware.incrementAndCheck(undefined, 'Browser', 'screenshot', rule, undefined, agentId);
    assert.equal(status2, 'HARD_LIMIT');
  });

  await t.test('global limits take precedence', async () => {
    const sessionKeyGlobal = 'test-session-global';
    const rule = { sessionCallLimit: { max: 50 } };
    const thresholds = { globalSessionCallLimit: 2 };
    
    await middleware.clearAllSessionLimits();

    const status1 = await middleware.incrementAndCheck(sessionKeyGlobal, 'Shell', 'bash', rule, thresholds);
    assert.equal(status1, 'SOFT_LIMIT');

    const status2 = await middleware.incrementAndCheck(sessionKeyGlobal, 'Shell', 'bash', rule, thresholds);
    assert.equal(status2, 'HARD_LIMIT');
  });

  await t.test('dual tracking of REQUEST and SESSION scopes', async () => {
    const session = 'dual-scope-session';
    const req1 = 'req-A';
    const rule = { 
      sessionCallLimit: { max: 100 }, 
      requestCallLimit: { max: 2 } 
    };

    await middleware.clearAllSessionLimits();

    // Request 1: two calls
    assert.equal(await middleware.incrementAndCheck(session, 'Files', 'read', rule, undefined, undefined, req1), 'SOFT_LIMIT');
    assert.equal(await middleware.incrementAndCheck(session, 'Files', 'read', rule, undefined, undefined, req1), 'HARD_LIMIT');
    
    const stats = middleware.getSessionStats();
    assert.equal(stats[session]['Files.read'], 2, 'Session count should be cumulative');
  });

  await t.test('atomic persistence via TrackerStore', async () => {
    const sessionKeyPersist = 'session-persist-test';
    const rule = { sessionCallLimit: { max: 5 } };

    await middleware.clearAllSessionLimits();
    await middleware.incrementAndCheck(sessionKeyPersist, 'Tool', 'action', rule);
    
    // Manually load from TrackerStore to verify it saved
    const savedState = await TrackerStore.load();
    assert.ok(savedState.sessions[sessionKeyPersist]);
    assert.equal(savedState.sessions[sessionKeyPersist]['Tool.action'].count, 1);
  });
});
