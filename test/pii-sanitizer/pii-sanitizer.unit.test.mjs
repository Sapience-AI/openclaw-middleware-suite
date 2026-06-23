import test from 'node:test';
import assert from 'node:assert';
import { PiiSanitizerMiddleware } from '../../dist/middlewares/pii-sanitizer/PiiSanitizerMiddleware.js';
import { ScannerEngine } from '../../dist/middlewares/pii-sanitizer/ScannerEngine.js';
import { ShellParser } from '../../dist/middlewares/pii-sanitizer/ShellParser.js';
import { PolicyEngine } from '../../dist/middlewares/pii-sanitizer/PolicyEngine.js';
import {
  DEFAULT_DLP_POLICY,
  DlpStore,
} from '../../dist/middlewares/pii-sanitizer/storage/DlpStore.js';
import * as paths from '../../dist/shared/storage/paths.js';
import { createTestEnvWithOpenclaw, seedSuiteStore } from '../_helpers/test-env.mjs';

createTestEnvWithOpenclaw('pii-sanitizer-unit-tests-');

// Seed the DLP config inside the unified sapience-ai-suite.json store under
// the "pii_sanitizer" key — DlpStore.getPath() now returns a human-readable
// label, not a real filesystem path.
seedSuiteStore(paths.SUITE_HOME, paths.STORE_FILE, 'pii_sanitizer', DEFAULT_DLP_POLICY);

test('PII Sanitizer Middleware - Unit Test Suite', async (t) => {
  await t.test('ScannerEngine - Regex Detections', () => {
    const scanner = new ScannerEngine(DEFAULT_DLP_POLICY.globalRules);

    // SSN test
    const ssnMock = 'My SSN is 123-45-6789 do not share it';
    const detections = scanner.scan(ssnMock);
    assert.ok(detections.length >= 1, 'Should find at least regex match');
    assert.strictEqual(detections[0].matchedString, '123-45-6789');
    assert.strictEqual(detections[0].severity, 'HIGH');

    // Redaction
    const redacted = scanner.redact(ssnMock, detections);
    assert.strictEqual(redacted, 'My SSN is [REDACTED_SSN] do not share it');

    // Email test
    const emailMock = 'Contact us at support@example.com';
    const emailDets = scanner.scan(emailMock);
    assert.ok(emailDets.length >= 1, 'Should find at least email match');
    assert.ok(emailDets.some((d) => d.originalPattern === 'email'));
  });

  await t.test('ScannerEngine - Prefix and Partial Redaction', () => {
    const scanner = new ScannerEngine(DEFAULT_DLP_POLICY.globalRules);

    // AWS Key
    const awsMock = 'export AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE';
    const detections = scanner.scan(awsMock);
    assert.ok(detections.length >= 1, 'Should find at least the prefix match');
    assert.ok(
      detections.some((d) => d.action === 'ESCALATE'),
      'Should find an escalate action'
    );
    assert.strictEqual(detections[0].severity, 'CRITICAL');

    assert.ok(
      detections.some((d) => d.replacementText.includes('****')),
      'Should find a redacted replacement'
    );
  });

  await t.test('ShellParser - Literals extraction', () => {
    const parser = new ShellParser();

    const command = 'echo "hello my phone is $PHONE"';
    const literals = parser.extractLiterals(command);

    assert.ok(
      literals.includes('"hello my phone is $PHONE"'),
      'Should extract literal string with quotes'
    );
  });

  await t.test('PiiSanitizerMiddleware - beforeToolCall ESCALATE logic', async () => {
    // Post-Pass-1: ESCALATE-severity rules surface via the first-class
    // MiddlewareResult.escalate / escalateReason fields instead of
    // returning block:true. This lets the orchestrator route the call
    // through HITL approval rather than hard-blocking.
    const middleware = new PiiSanitizerMiddleware();
    await middleware.initialize({});

    const context = {
      toolName: 'Shell.bash',
      moduleName: 'Shell',
      methodName: 'bash',
      params: {
        command: 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
      },
      metadata: {},
    };

    const result = await middleware.beforeToolCall(context);

    assert.strictEqual(result.block, false, 'ESCALATE-severity rules no longer hard-block');
    assert.strictEqual(result.escalate, true, 'Should set first-class escalate flag');
    assert.ok(
      typeof result.escalateReason === 'string' && result.escalateReason.length > 0,
      'Should provide an escalateReason string'
    );
    assert.ok(result.metadata?.piiIntercept, 'Should flag as pii intercept');
    assert.ok(
      Array.isArray(result.metadata?.piiDetections) && result.metadata.piiDetections.length > 0,
      'Should expose detection list for audit'
    );
  });

  await t.test('PiiSanitizerMiddleware - beforeToolCall Redaction', async () => {
    const middleware = new PiiSanitizerMiddleware();
    await middleware.initialize({});

    const context = {
      toolName: 'Network.fetch',
      moduleName: 'Network',
      methodName: 'fetch',
      params: {
        url: 'https://api.example.com',
        body: '{"payment": "4111222233334444"}',
      },
      metadata: {},
    };

    const result = await middleware.beforeToolCall(context);

    assert.strictEqual(result.block, false);
    assert.ok(result.modifiedParams, 'Params should be modified');

    const newBody = result.modifiedParams.body;
    assert.strictEqual(newBody, '{"payment": "****-****-****-4444"}');
  });

  await t.test('PiiSanitizerMiddleware - Deep Object Traversal (beforeToolCall)', async () => {
    // Mixed payload: AWS key (ESCALATE → block:false + escalate:true) plus
    // a credit card (REDACT → modifiedParams). Post-Pass-1 ESCALATE wins
    // the result shape (it's the higher-impact signal); REDACT is folded
    // into modifiedParams alongside.
    const middleware = new PiiSanitizerMiddleware();
    await middleware.initialize({});

    const ctx = {
      toolName: 'fetch',
      moduleName: 'Network',
      methodName: 'fetch',
      params: {
        url: 'https://api.example.com',
        headers: {
          Authorization: 'Bearer AKIAIOSFODNN7EXAMPLE',
          Nested: ['safe', { deeply_nested: 'Account: 4111222233334444' }],
        },
      },
      metadata: {},
    };

    const result = await middleware.beforeToolCall(ctx);

    assert.strictEqual(result.block, false, 'ESCALATE no longer hard-blocks');
    assert.strictEqual(result.escalate, true, 'AWS key ESCALATE rule should set escalate flag');
    assert.ok(
      typeof result.escalateReason === 'string' && result.escalateReason.length > 0,
      'escalateReason should describe the matched rules'
    );

    const detections = result.metadata?.piiDetections;
    assert.ok(Array.isArray(detections), 'Detections list should be present in metadata');
    assert.ok(detections.some((d) => d.originalPattern === 'aws_key'));
    assert.ok(detections.some((d) => d.originalPattern === 'credit_card'));
  });
});
