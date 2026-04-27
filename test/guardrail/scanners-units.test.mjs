import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOpenclawHome } from '../_helpers/test-env.mjs';

createOpenclawHome('sai-scanners-units-');

const distBase = path.resolve('dist');
const u = (p) => pathToFileURL(path.join(distBase, p)).href;

const { scanRegex } = await import(u('middlewares/guardrail/scanners/RegexScanner.js'));
const { scanPrefix } = await import(u('middlewares/guardrail/scanners/PrefixScanner.js'));
const { scanHeuristic } = await import(u('middlewares/guardrail/scanners/HeuristicScanner.js'));
const { makeDetection } = await import(u('middlewares/guardrail/analyzers/DetectionFactory.js'));
const sens = await import(u('middlewares/guardrail/guards/sensitive-paths.js'));

// ── RegexScanner ───────────────────────────────────────────────

test('scanRegex: invalid pattern fails closed', () => {
  const rule = { name: 'bad', pattern: '[unclosed', type: 'regex', severity: 'HIGH', action: 'BLOCK' };
  const r = scanRegex('hello', rule, 'suspicious');
  assert.equal(r.length, 1);
  assert.equal(r[0].matchedContent, '[regex-compile-error]');
});

test('scanRegex: matches multiple', () => {
  const rule = { name: 'foo', pattern: 'foo', type: 'regex', severity: 'LOW', action: 'WARN' };
  const r = scanRegex('foo foo foo', rule, 'suspicious');
  assert.equal(r.length, 3);
});

test('scanRegex: no matches returns empty', () => {
  const rule = { name: 'x', pattern: 'xyz', type: 'regex', severity: 'LOW', action: 'WARN' };
  assert.equal(scanRegex('abc', rule, 'suspicious').length, 0);
});

test('scanRegex: zero-length match handled', () => {
  const rule = { name: 'empty', pattern: 'a*', type: 'regex', severity: 'LOW', action: 'WARN' };
  const r = scanRegex('aaaaa', rule, 'suspicious');
  assert.ok(r.length >= 1);
});

// ── PrefixScanner ──────────────────────────────────────────────

test('scanPrefix: matches sk- prefix', () => {
  const rule = { name: 'openai', pattern: 'sk-', type: 'prefix', severity: 'HIGH', action: 'BLOCK' };
  const r = scanPrefix('my key sk-abcdef0123456789ABC', rule, 'pii');
  assert.equal(r.length, 1);
});

test('scanPrefix: no match short suffix', () => {
  const rule = { name: 'openai', pattern: 'sk-', type: 'prefix', severity: 'HIGH', action: 'BLOCK' };
  assert.equal(scanPrefix('sk-abc', rule, 'pii').length, 0);
});

// ── HeuristicScanner ───────────────────────────────────────────

test('scanHeuristic: flags high entropy token', () => {
  const rule = { name: 'entropy', pattern: '', type: 'heuristic', severity: 'HIGH', action: 'BLOCK' };
  // High-entropy fake fixture: prefix flags it as obviously not a real
  // secret to a human reader, while the random-looking body keeps Shannon
  // entropy above the heuristic-scanner threshold so the test still fires.
  const r = scanHeuristic('token: FAKE_TEST_aB3xK9zL2pQ7nM5fR8vT4yC6jH0wE1sD7gY3uI9oP2', rule, 'pii');
  assert.ok(r.length >= 1);
  assert.match(r[0].matchedContent, /\*\*\*\*/);
});

test('scanHeuristic: low entropy ignored', () => {
  const rule = { name: 'entropy', pattern: '', type: 'heuristic', severity: 'HIGH', action: 'BLOCK' };
  assert.equal(scanHeuristic('aaaaaaaaaaaaaaaaaaaaaaaaa', rule, 'pii').length, 0);
});

// ── DetectionFactory ───────────────────────────────────────────

test('makeDetection: pii preview truncated', () => {
  const rule = { name: 'r', pattern: 'x', type: 'regex', severity: 'HIGH', action: 'BLOCK' };
  const d = makeDetection(rule, 'pii', 'A'.repeat(100), 0);
  assert.ok(d.matchedContent.length <= 16);
  assert.match(d.matchedContent, /\.\.\./);
});

test('makeDetection: non-pii not truncated', () => {
  const rule = { name: 'r', pattern: 'x', type: 'regex', severity: 'HIGH', action: 'BLOCK' };
  const d = makeDetection(rule, 'suspicious', 'long text content here', 5);
  assert.equal(d.matchedContent, 'long text content here');
  assert.equal(d.matchIndex, 5);
});

test('makeDetection: confidence default high', () => {
  const rule = { name: 'r', pattern: 'x', type: 'regex', severity: 'HIGH', action: 'BLOCK' };
  const d = makeDetection(rule, 'suspicious', 'x', 0);
  assert.equal(d.confidence, 'high');
});

// ── sensitive-paths additional cases ─────────────────────────

test('sensitive: blocks .env file', () => {
  const r = sens.checkSensitivePath('/home/user/.env');
  assert.equal(r.blocked, true);
});

test('sensitive: blocks .aws/credentials', () => {
  const r = sens.checkSensitivePath('/home/user/.aws/credentials');
  assert.equal(r.blocked, true);
});

test('sensitive: dry-run does not block', () => {
  const r = sens.checkSensitivePath('/home/user/.ssh/id_rsa', undefined, true);
  assert.equal(r.blocked, false);
  assert.ok(r.reason);
});

test('sensitive: empty path not blocked', () => {
  const r = sens.checkSensitivePath('');
  assert.equal(r.blocked, false);
});

test('sensitive: allowlist exposed as default array', () => {
  assert.ok(Array.isArray(sens.DEFAULT_ALLOWED_PATHS));
});

test('sensitive: custom blocked path', () => {
  const cfg = {
    ...sens.DEFAULT_SENSITIVE_PATH_CONFIG,
    blockedPaths: [...sens.DEFAULT_SENSITIVE_PATHS, '**/secret.txt'],
  };
  const r = sens.checkSensitivePath('/x/secret.txt', cfg);
  assert.equal(r.blocked, true);
});
