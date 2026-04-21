import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolCallLimitMiddleware } from '../../dist/middlewares/tool-call-limit/index.js';
import { createOpenclawHome, setDataDir } from '../_helpers/test-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', '..', 'dist');

const testHome = createOpenclawHome('sapience-mw-tracker-tests-');
setDataDir(path.join(testHome, 'sapience-tool-call-limit'));

test('ToolCallLimitMiddleware enforces tool call limits', async (t) => {
  const sessionKey = 'test-session-config-limits';
  const mw = new ToolCallLimitMiddleware();
  await mw.initialize();
  
  await mw.clearSessionLimits(sessionKey);

  const globalThresholds = {
    globalSessionCallLimit: 1000,
    globalRequestCallLimit: 100
  };

  await t.test('allows tool calls under limits', async () => {
    const rule = { sessionCallLimit: { max: 10 } }; 
    const result = await mw.incrementAndCheck(sessionKey, 'Shell', 'exec', rule, globalThresholds);
    assert.ok(result === 'OK' || result === 'SOFT_LIMIT', `Expected OK or SOFT_LIMIT, got ${result}`);
  });

  await t.test('eventually blocks calls that exceed session limit', async () => {
    const sessionKey2 = 'test-session-limit-exceed';
    await mw.clearSessionLimits(sessionKey2);

    const rule = { sessionCallLimit: { max: 2 } };
    
    // Call 1
    const r1 = await mw.incrementAndCheck(sessionKey2, 'FS', 'write', rule, globalThresholds);
    assert.ok(r1 !== 'HARD_LIMIT', '1st call should not be blocked');
    
    // Call 2
    const r2 = await mw.incrementAndCheck(sessionKey2, 'FS', 'write', rule, globalThresholds);
    assert.strictEqual(r2, 'HARD_LIMIT', '2nd call should be blocked when max=2');
  });

  await t.test('tracks per-request limits independently', async () => {
    const sessionKey3 = 'test-req-independence';
    const requestId1 = 'req-A';
    const requestId2 = 'req-B';

    const rule = { requestCallLimit: { max: 1 } }; 
    
    // Request A: 1st call triggers HARD_LIMIT
    const ra = await mw.incrementAndCheck(sessionKey3, 'Net', 'req', rule, globalThresholds, undefined, requestId1);
    assert.strictEqual(ra, 'HARD_LIMIT', '1st call should be blocked when request max=1');

    // Request B: Fresh budget for new ID
    const rb = await mw.incrementAndCheck(sessionKey3, 'Net', 'req', rule, globalThresholds, undefined, requestId2);
    assert.strictEqual(rb, 'HARD_LIMIT', '1st call in request B should also be blocked but is independent');
  });

  await t.test('enforces global session limits', async () => {
    const sessionKey4 = 'test-global-exceed';
    await mw.clearSessionLimits(sessionKey4);

    const tightGlobal = { globalSessionCallLimit: 1, globalRequestCallLimit: 100 };
    const rule = { sessionCallLimit: { max: 100 } };

    const r1 = await mw.incrementAndCheck(sessionKey4, 'Any', 'tool', rule, tightGlobal);
    assert.strictEqual(r1, 'HARD_LIMIT', '1st call should be blocked by tight global limit of 1');
  });
});
