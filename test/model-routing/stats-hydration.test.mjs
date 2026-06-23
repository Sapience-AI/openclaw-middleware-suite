import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { createTestEnvWithOpenclaw } from '../_helpers/test-env.mjs';

// Set OPENCLAW_HOME *before* importing dist modules — the audit-log path
// is resolved at module-load time from this env var.
createTestEnvWithOpenclaw('sai-stats-hydration-');

const require = createRequire(import.meta.url);
const { RoutingAuditLog } = require(
  '../../dist/middlewares/model-routing/storage/RoutingAuditLog.js',
);

// Canonical audit file path — resolved once at module load through the
// same env-var-driven pipeline the production code uses, so we never
// hardcode the directory layout.
const AUDIT_FILE = RoutingAuditLog.filePath;
const AUDIT_DIR = path.dirname(AUDIT_FILE);

// ---------------------------------------------------------------------------
// `RoutingAuditLog.computeTierCounters` — used by `proxy/handler.ts` at module
// load to hydrate the in-memory `RoutingStats` counters from the persisted
// audit log so the dashboard's "Requests Routed / Simple / Standard / Complex+
// Reasoning" cards survive gateway restarts.
//
// Without this, those counters reset to zero on every restart even though
// the audit log (which the CLI's `sai router stats` reads) shows full history.
// ---------------------------------------------------------------------------

function makeEntry(tier, overrides = {}) {
  return {
    ts: new Date().toISOString(),
    tier,
    model: 'claude-sonnet-4-5',
    score: 0,
    confidence: 0.5,
    reason: 'scored',
    latencyMs: 1000,
    promptPreview: 'test',
    ...overrides,
  };
}

test('computeTierCounters: returns zeros when the audit file does not exist', () => {
  if (fs.existsSync(AUDIT_FILE)) fs.unlinkSync(AUDIT_FILE);
  const counters = new RoutingAuditLog().computeTierCounters();
  assert.deepEqual(counters, {
    total: 0,
    byTier: { SIMPLE: 0, STANDARD: 0, COMPLEX: 0, REASONING: 0 },
  });
});

test('computeTierCounters: sums per-tier counts from a populated audit file', () => {
  const audit = new RoutingAuditLog();
  audit.clear();
  audit.append(makeEntry('SIMPLE'));
  audit.append(makeEntry('SIMPLE'));
  audit.append(makeEntry('STANDARD'));
  audit.append(makeEntry('COMPLEX'));
  audit.append(makeEntry('REASONING'));

  const counters = new RoutingAuditLog().computeTierCounters();
  assert.equal(counters.total, 5);
  assert.equal(counters.byTier.SIMPLE, 2);
  assert.equal(counters.byTier.STANDARD, 1);
  assert.equal(counters.byTier.COMPLEX, 1);
  assert.equal(counters.byTier.REASONING, 1);
});

test('computeTierCounters: skips malformed lines without throwing', () => {
  // Mid-write crashes can leave partial JSON or garbage between valid
  // entries. Build a file that has both shapes and verify the counter
  // walks past the bad lines without crashing or miscounting.
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const valid1 = JSON.stringify(makeEntry('SIMPLE'));
  const valid2 = JSON.stringify(makeEntry('STANDARD'));
  const corrupted = '{"ts":"2026-04-30T22:00:00.000Z","tier":"SIM';
  const garbage = 'not even json at all';
  fs.writeFileSync(AUDIT_FILE, [valid1, corrupted, garbage, valid2, ''].join('\n'));

  const counters = new RoutingAuditLog().computeTierCounters();
  assert.equal(counters.total, 2);
  assert.equal(counters.byTier.SIMPLE, 1);
  assert.equal(counters.byTier.STANDARD, 1);
});

test('computeTierCounters: ignores entries with unknown tiers (defensive)', () => {
  const audit = new RoutingAuditLog();
  audit.clear();
  audit.append(makeEntry('SIMPLE'));
  // Inject an entry with a tier value that's not one of the four known tiers.
  // A future schema where someone added a new tier without updating this
  // module shouldn't crash — it should just skip the unknown rows.
  audit.append({ ...makeEntry('SIMPLE'), tier: 'EXPERIMENTAL' });
  audit.append(makeEntry('REASONING'));

  const counters = new RoutingAuditLog().computeTierCounters();
  assert.equal(counters.total, 2);
  assert.equal(counters.byTier.SIMPLE, 1);
  assert.equal(counters.byTier.REASONING, 1);
});

test('computeTierCounters: clear() then compute returns zeros (mirrors `sai router reset --stats` flow)', () => {
  const audit = new RoutingAuditLog();
  audit.append(makeEntry('SIMPLE'));
  audit.append(makeEntry('STANDARD'));
  audit.clear();

  const counters = new RoutingAuditLog().computeTierCounters();
  assert.deepEqual(counters, {
    total: 0,
    byTier: { SIMPLE: 0, STANDARD: 0, COMPLEX: 0, REASONING: 0 },
  });
});
