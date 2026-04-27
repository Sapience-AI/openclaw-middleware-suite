import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  createOpenclawHome,
  setOpenclawConfig,
  setOpenclawPluginId,
} from '../_helpers/test-env.mjs';

const testHome = createOpenclawHome('sai-pcfg-');
const openclawConfigPath = setOpenclawConfig(path.join(testHome, 'openclaw.json'));
setOpenclawPluginId('sapience-ai-suite');

const distBase = path.resolve('dist');
const u = (p) => pathToFileURL(path.join(distBase, p)).href;

const cm = await import(u('plugin/config-manager.js'));
const { PolicyStore } = await import(u('middlewares/hitl/storage/PolicyStore.js'));
// PiiSanitizerHook.js was removed in the Pass-1 refactor — the free function
// `executePiiScan` is gone; programmatic consumers (and tests) now construct
// the middleware class directly and call `beforeToolCall(ctx)`.
const { PiiSanitizerMiddleware } = await import(
  u('middlewares/pii-sanitizer/PiiSanitizerMiddleware.js')
);
const { DlpStore } = await import(u('middlewares/pii-sanitizer/storage/DlpStore.js'));

// Shared singleton for the PII subtests below — initialize once.
const piiSanitizer = new PiiSanitizerMiddleware();
await piiSanitizer.initialize({});

// ── config-manager ───────────────────────────────────────────

test('config-manager: getOpenClawPaths uses env', () => {
  const p = cm.getOpenClawPaths();
  assert.equal(p.openclawHome, testHome);
  assert.equal(p.pluginId, 'sapience-ai-suite');
});

test('config-manager: isOpenClawInstalled true when home exists', async () => {
  assert.equal(await cm.isOpenClawInstalled(), true);
});

test('config-manager: loadOpenClawConfig returns null when missing', async () => {
  if (fs.existsSync(openclawConfigPath)) fs.unlinkSync(openclawConfigPath);
  const c = await cm.loadOpenClawConfig();
  assert.equal(c, null);
});

test('config-manager: registerPlugin creates entries and saves', async () => {
  await cm.registerPlugin();
  const c = await cm.loadOpenClawConfig();
  assert.equal(c.plugins.entries['sapience-ai-suite'].enabled, true);
});

test('config-manager: isPluginRegistered true after register', async () => {
  assert.equal(await cm.isPluginRegistered(), true);
});

test('config-manager: registerPlugin preserves existing plugins object', async () => {
  // Pre-existing config with non-object plugins
  await cm.saveOpenClawConfig({ plugins: 'invalid', other: 1 });
  await cm.registerPlugin();
  const c = await cm.loadOpenClawConfig();
  assert.ok(typeof c.plugins === 'object');
  assert.ok(c.plugins.entries['sapience-ai-suite']);
});

test('config-manager: unregisterPlugin removes entry', async () => {
  await cm.unregisterPlugin();
  const c = await cm.loadOpenClawConfig();
  assert.equal(c.plugins.entries['sapience-ai-suite'], undefined);
});

test('config-manager: unregisterPlugin no-op when no entries', async () => {
  await cm.saveOpenClawConfig({});
  await cm.unregisterPlugin();
  const c = await cm.loadOpenClawConfig();
  assert.deepEqual(c, {});
});

test('config-manager: isPluginRegistered false when no config', async () => {
  if (fs.existsSync(openclawConfigPath)) fs.unlinkSync(openclawConfigPath);
  assert.equal(await cm.isPluginRegistered(), false);
});

// ── PolicyStore ──────────────────────────────────────────────

test('PolicyStore: load creates default when missing', async () => {
  const p = PolicyStore.getPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const policy = await PolicyStore.load();
  assert.ok(policy.version);
});

test('PolicyStore: load reads existing', async () => {
  const policy = await PolicyStore.load();
  assert.ok(policy.version);
});

test('PolicyStore: reset writes defaults', async () => {
  await PolicyStore.reset();
  const policy = await PolicyStore.load();
  assert.ok(policy.updatedAt);
});

test('PolicyStore: loadSync creates default when missing', () => {
  const p = PolicyStore.getPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const policy = PolicyStore.loadSync();
  assert.ok(policy.version);
});

test('PolicyStore: loadSync reads existing', () => {
  const policy = PolicyStore.loadSync();
  assert.ok(policy.version);
});

// ── PiiSanitizerMiddleware ───────────────────────────────────

test('PiiSanitizerMiddleware: beforeToolCall with clean params returns no block', async () => {
  const r = await piiSanitizer.beforeToolCall({
    toolName: 'read',
    moduleName: 'FileSystem',
    methodName: 'read',
    params: { path: '/tmp/x' },
  });
  assert.ok(r);
  assert.equal(r.block, false);
});

test('PiiSanitizerMiddleware: beforeToolCall with credit card triggers redaction', async () => {
  const r = await piiSanitizer.beforeToolCall({
    toolName: 'write',
    moduleName: 'FileSystem',
    methodName: 'write',
    params: { content: 'My card is 4532-1234-5678-9010' },
  });
  assert.ok(r);
  // REDACT-severity rule → block:false with modifiedParams populated.
  assert.equal(r.block, false);
  assert.ok(r.modifiedParams);
});

test('PiiSanitizerMiddleware: beforeToolCall with private key triggers BLOCK', async () => {
  const r = await piiSanitizer.beforeToolCall({
    toolName: 'write',
    moduleName: 'FileSystem',
    methodName: 'write',
    params: { content: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA' },
  });
  assert.ok(r);
  // BLOCK-severity rule → block:true (or escalate:true if rule was downgraded).
  assert.ok(r.block === true || r.escalate === true);
});
