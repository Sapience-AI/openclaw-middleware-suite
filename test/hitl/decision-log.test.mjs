import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { createOpenclawHome } from '../_helpers/test-env.mjs';

const tempDir = createOpenclawHome('sapience-mw-decision-log-tests-');

const require = createRequire(import.meta.url);
const { DecisionLog } = require('../../dist/middlewares/hitl/storage/DecisionLog.js');

function makeRecord(overrides = {}) {
  return {
    timestamp: new Date().toISOString(),
    module: 'FileSystem',
    method: 'write',
    args: [{ path: '/tmp/x' }],
    decision: 'APPROVED',
    decisionTime: 12,
    ...overrides,
  };
}

test('DecisionLog', async (t) => {
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('getPath returns the configured decisions file path', () => {
    const p = DecisionLog.getPath();
    assert.equal(typeof p, 'string');
    assert.ok(p.length > 0);
  });

  await t.test('readAll returns [] when log file does not exist', async () => {
    const records = await DecisionLog.readAll();
    assert.deepEqual(records, []);
  });

  await t.test('readLast returns [] when log is empty', async () => {
    const records = await DecisionLog.readLast(5);
    assert.deepEqual(records, []);
  });

  await t.test('append writes a record and enriches with cwd/hostname/pid', async () => {
    await DecisionLog.append(makeRecord({ decision: 'ALLOWED', module: 'A', method: 'a' }));

    const all = await DecisionLog.readAll();
    assert.equal(all.length, 1);
    const r = all[0];
    assert.equal(r.decision, 'ALLOWED');
    assert.equal(r.module, 'A');
    // enrichment fields
    assert.equal(typeof r.cwd, 'string');
    assert.equal(typeof r.hostname, 'string');
    assert.equal(typeof r.pid, 'number');
  });

  await t.test('append + readAll handles multiple records via the --- delimiter', async () => {
    await DecisionLog.append(makeRecord({ decision: 'APPROVED', module: 'B', method: 'b' }));
    await DecisionLog.append(makeRecord({ decision: 'REJECTED', module: 'C', method: 'c' }));

    const all = await DecisionLog.readAll();
    // 1 from prior test + 2 here
    assert.equal(all.length, 3);
    assert.equal(all[1].module, 'B');
    assert.equal(all[2].decision, 'REJECTED');
  });

  await t.test('readLast returns the trailing N records', async () => {
    const last2 = await DecisionLog.readLast(2);
    assert.equal(last2.length, 2);
    assert.equal(last2[0].module, 'B');
    assert.equal(last2[1].module, 'C');
  });

  await t.test('readAll tolerates a stray legacy JSONL line embedded in a block', async () => {
    // Write a hand-crafted file that mixes pretty-JSON blocks and a JSONL line.
    const filePath = DecisionLog.getPath();
    const stray =
      JSON.stringify(makeRecord({ module: 'PRETTY', method: 'p' }), null, 2) +
      '\n---\n' +
      JSON.stringify(makeRecord({ module: 'LEGACY', method: 'l' })) +
      '\n---\n';
    // overwrite cleanly so we control parse paths
    const fs = require('node:fs');
    fs.writeFileSync(filePath, stray, 'utf8');

    const all = await DecisionLog.readAll();
    const modules = all.map((r) => r.module);
    assert.ok(modules.includes('PRETTY'));
    assert.ok(modules.includes('LEGACY'));
  });

  await t.test('append swallows errors instead of throwing', async () => {
    // Pass a circular structure to force JSON.stringify to throw inside append.
    // The function should log + return without raising.
    const circular = makeRecord();
    circular.self = circular;
    await assert.doesNotReject(() => DecisionLog.append(circular));
  });
});
