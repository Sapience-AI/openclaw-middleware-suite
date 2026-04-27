import test from 'node:test';
import assert from 'node:assert';
import { PiiSanitizerMiddleware } from '../../dist/middlewares/pii-sanitizer/PiiSanitizerMiddleware.js';
import { DEFAULT_DLP_POLICY } from '../../dist/middlewares/pii-sanitizer/storage/DlpStore.js';
import { createTestEnvWithOpenclaw } from '../_helpers/test-env.mjs';

const openclawHome = createTestEnvWithOpenclaw('repro-escalation-loop-');

test('Reproduction - PII Escalation Loop via Magnitude Regex', async (t) => {
  const middleware = new PiiSanitizerMiddleware();
  await middleware.initialize({});

  // Verify the loaded policy in the test
  const status = middleware.getStatus();
  console.log(`[REPRO_DEBUG] Middleware status: ${JSON.stringify(status)}`);
  
  // Resolve absolute path to confirm we are using the right dist
  const dlpStorePath = (await import.meta.resolve('../../dist/middlewares/pii-sanitizer/storage/DlpStore.js')).replace('file:///', '');
  console.log(`[REPRO_DEBUG] DlpStore Path: ${dlpStorePath}`);

  await t.test('System messages containing magnitude words should NOT escalate', async () => {
    // A system message often contains words like "entire" or "thousands" as part of the block/allow reason.
    const systemError = "[SapienceMiddleware:BLOCK] Access to the entire ~/.ssh directory is restricted.";
    
    const context = {
      toolName: 'Shell.bash',
      moduleName: 'Shell',
      methodName: 'bash',
      params: {
        command: `echo "${systemError}"`
      },
      metadata: {}
    };

    const result = await middleware.beforeToolCall(context);

    // REDACT is okay, but ESCALATE is what causes the loop (HITL forces
    // human approval, agent retries with the same content, loops).
    // Post-Pass-1: ESCALATE surfaces as `result.escalate === true` with
    // `block: false` (the orchestrator routes to HITL via metadata.forceAsk).
    if (result.escalate === true) {
        assert.fail(`FAIL: System word "entire" triggered ESCALATION instead of silent redaction/allow. Result: ${JSON.stringify(result)}`);
    }

    assert.ok(true, 'Magnitude words did not trigger escalation!');
  });
});
