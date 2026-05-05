import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createTestEnvWithOpenclaw } from '../_helpers/test-env.mjs';

createTestEnvWithOpenclaw('sai-config-manager-compat-');

const require = createRequire(import.meta.url);
const {
  loadOpenClawConfig,
  saveOpenClawConfig,
  setOpenClawRuntime,
} = require('../../dist/plugin/config-manager.js');

// ---------------------------------------------------------------------------
// Helpers — shape the runtime fakes per supported openclaw version.
// ---------------------------------------------------------------------------

function makeNewRuntime(initialConfig = { plugins: { entries: {} } }) {
  // openclaw >= 2026.5.3 (our peerDep floor): `current` and
  // `replaceConfigFile` are required. The legacy `loadConfig` /
  // `writeConfigFile` shims were dropped from `OpenClawRuntime` in
  // suite 1.0.3 — covering them here would be testing an interface we
  // no longer ship.
  const calls = { current: 0, replaceConfigFile: 0 };
  let stored = initialConfig;
  const config = {
    current() {
      calls.current++;
      return stored;
    },
    async replaceConfigFile(params) {
      calls.replaceConfigFile++;
      stored = params.nextConfig;
      return undefined;
    },
  };
  return { runtime: { config }, calls, getStored: () => stored };
}

function makeBrokenRuntime() {
  // Neither API is exposed (e.g., a future runtime that strips both).
  // Should not crash the consumer — falls back to file I/O.
  return { runtime: { config: {} } };
}

function clearRuntime() {
  setOpenClawRuntime(null);
}

// ---------------------------------------------------------------------------
// Read path — loadOpenClawConfig
// ---------------------------------------------------------------------------

test('loadOpenClawConfig: uses runtime.config.current() snapshot', async () => {
  const r = makeNewRuntime({ plugins: { entries: { foo: { enabled: true } } } });
  setOpenClawRuntime(r.runtime);
  try {
    const cfg = await loadOpenClawConfig();
    assert.deepEqual(cfg, { plugins: { entries: { foo: { enabled: true } } } });
    assert.equal(r.calls.current, 1);
  } finally {
    clearRuntime();
  }
});

test('loadOpenClawConfig: deep-clones the snapshot so callers can mutate without leaking back', async () => {
  const stored = { plugins: { entries: { a: { enabled: true } } } };
  const r = makeNewRuntime(stored);
  setOpenClawRuntime(r.runtime);
  try {
    const cfg = await loadOpenClawConfig();
    cfg.plugins.entries['mutated'] = { enabled: true };
    // Re-read — the original snapshot must be untouched.
    const cfg2 = await loadOpenClawConfig();
    assert.equal(cfg2.plugins.entries['mutated'], undefined);
  } finally {
    clearRuntime();
  }
});

// ---------------------------------------------------------------------------
// Write path — saveOpenClawConfig
// ---------------------------------------------------------------------------

test('saveOpenClawConfig: uses replaceConfigFile() with afterWrite mode "auto" by default', async () => {
  const r = makeNewRuntime();
  const calls = [];
  r.runtime.config.replaceConfigFile = async (params) => {
    calls.push(params);
  };
  setOpenClawRuntime(r.runtime);
  try {
    await saveOpenClawConfig({ plugins: { entries: { x: { enabled: true } } } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].nextConfig, { plugins: { entries: { x: { enabled: true } } } });
    assert.deepEqual(calls[0].afterWrite, { mode: 'auto' });
  } finally {
    clearRuntime();
  }
});

// ---------------------------------------------------------------------------
// Defense — a malformed runtime missing the required APIs must not crash
// the consumer. The interface declares `current()` / `replaceConfigFile()`
// as required (see `OpenClawRuntime` in src/plugin/index.ts), but the test
// case below exercises the runtime-error fallback: if openclaw ever ships
// a build where the methods are missing or throw, the suite should fall
// through to plain file I/O instead of crashing.
// ---------------------------------------------------------------------------

test('loadOpenClawConfig: runtime current() throwing falls through to file I/O', async () => {
  const r = makeBrokenRuntime();
  setOpenClawRuntime(r.runtime);
  try {
    // No openclaw.json in the temp home — file I/O returns null cleanly.
    const cfg = await loadOpenClawConfig();
    assert.equal(cfg, null);
  } finally {
    clearRuntime();
  }
});

test('saveOpenClawConfig: runtime replaceConfigFile() throwing falls through to file I/O', async () => {
  const r = makeBrokenRuntime();
  setOpenClawRuntime(r.runtime);
  try {
    // Should not throw; the file-I/O fallback writes to the temp openclaw home.
    await saveOpenClawConfig({ plugins: { entries: {} } });
  } finally {
    clearRuntime();
  }
});
