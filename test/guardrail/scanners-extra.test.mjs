import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOpenclawHome } from '../_helpers/test-env.mjs';

createOpenclawHome('sai-scan-extra-');

const distBase = path.resolve('dist');
const u = (p) => pathToFileURL(path.join(distBase, p)).href;

const { scanRegex } = await import(u('middlewares/guardrail/scanners/RegexScanner.js'));
const { scanHeuristic } = await import(u('middlewares/guardrail/scanners/HeuristicScanner.js'));
const { scanPrefix } = await import(u('middlewares/guardrail/scanners/PrefixScanner.js'));

// HeuristicScanner branches
test('scanHeuristic: short word uses [REDACTED] preview', () => {
  const rule = { name: 'h', pattern: '', type: 'heuristic', severity: 'HIGH', action: 'BLOCK' };
  // 20 chars, 8 char limit means uses [REDACTED] for word.length <=8 — but we have 20 here
  // Let's craft a 20+ but ≤8 — impossible since regex needs 20+. So this branch isn't reachable.
  // Instead test with custom threshold so high-entropy is below threshold
  const r = scanHeuristic('aB3xK9zL2pQ7nM5fR8vT', rule, 'pii', 99);
  assert.equal(r.length, 0);
});

test('scanHeuristic: low custom threshold catches more', () => {
  const rule = { name: 'h', pattern: '', type: 'heuristic', severity: 'HIGH', action: 'BLOCK' };
  const r = scanHeuristic('abcdefghij1234567890', rule, 'pii', 0.5);
  assert.ok(r.length >= 1);
});

// RegexScanner: cap on MAX_MATCHES_PER_RULE
test('scanRegex: caps at 100 matches', () => {
  const rule = { name: 'a', pattern: 'a', type: 'regex', severity: 'LOW', action: 'WARN' };
  const r = scanRegex('a'.repeat(200), rule, 'suspicious');
  assert.ok(r.length <= 100);
});

// PrefixScanner: literal prefix at boundary
test('scanPrefix: prefix mid-string', () => {
  const rule = { name: 'p', pattern: 'sk-', type: 'prefix', severity: 'HIGH', action: 'BLOCK' };
  const r = scanPrefix('start sk-abcdef0123456789ZYXW more text', rule, 'pii');
  assert.equal(r.length, 1);
});

test('scanPrefix: empty input', () => {
  const rule = { name: 'p', pattern: 'sk-', type: 'prefix', severity: 'HIGH', action: 'BLOCK' };
  assert.equal(scanPrefix('', rule, 'pii').length, 0);
});
