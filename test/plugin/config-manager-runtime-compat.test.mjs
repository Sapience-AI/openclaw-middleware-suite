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

function makeOldRuntime(initialConfig = { plugins: { entries: {} } }) {
  // Pre-2026.4.27: only `loadConfig` / `writeConfigFile` exist.
  const calls = { loadConfig: 0, writeConfigFile: 0 };
  let stored = initialConfig;
  return {
    runtime: {
      config: {
        loadConfig() {
          calls.loadConfig++;
          return stored;
        },
        async writeConfigFile(cfg) {
          calls.writeConfigFile++;
          stored = cfg;
        },
      },
    },
    calls,
    getStored: () => stored,
  };
}

function makeNewRuntime(initialConfig = { plugins: { entries: {} } }) {
  // openclaw >= 2026.4.27: all four exist; the new ones are preferred.
  // Mirror the gateway-side behavior where loadConfig / writeConfigFile are
  // deprecation shims that delegate to current / replaceConfigFile.
  const calls = {
    current: 0,
    replaceConfigFile: 0,
    loadConfig: 0,
    writeConfigFile: 0,
  };
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
    loadConfig() {
      calls.loadConfig++;
      return stored;
    },
    async writeConfigFile(cfg) {
      calls.writeConfigFile++;
      stored = cfg;
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

test('loadOpenClawConfig: openclaw >= 2026.4.27 — uses current() and skips deprecated loadConfig()', async () => {
  const r = makeNewRuntime({ plugins: { entries: { 'foo': { enabled: true } } } });
  setOpenClawRuntime(r.runtime);
  try {
    const cfg = await loadOpenClawConfig();
    assert.deepEqual(cfg, { plugins: { entries: { 'foo': { enabled: true } } } });
    assert.equal(r.calls.current, 1);
    assert.equal(r.calls.loadConfig, 0, 'must not invoke deprecated loadConfig() when current() exists');
  } finally {
    clearRuntime();
  }
});

test('loadOpenClawConfig: openclaw < 2026.4.27 — falls back to deprecated loadConfig()', async () => {
  const r = makeOldRuntime({ plugins: { entries: { 'bar': { enabled: false } } } });
  setOpenClawRuntime(r.runtime);
  try {
    const cfg = await loadOpenClawConfig();
    assert.deepEqual(cfg, { plugins: { entries: { 'bar': { enabled: false } } } });
    assert.equal(r.calls.loadConfig, 1);
  } finally {
    clearRuntime();
  }
});

test('loadOpenClawConfig: deep-clones the snapshot so callers can mutate without leaking back', async () => {
  const stored = { plugins: { entries: { 'a': { enabled: true } } } };
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

test('saveOpenClawConfig: openclaw >= 2026.4.27 — uses replaceConfigFile() with afterWrite mode "auto"', async () => {
  const r = makeNewRuntime();
  // Spy on the params replaceConfigFile receives.
  const calls = [];
  r.runtime.config.replaceConfigFile = async (params) => {
    calls.push(params);
  };
  setOpenClawRuntime(r.runtime);
  try {
    await saveOpenClawConfig({ plugins: { entries: { 'x': { enabled: true } } } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].nextConfig, { plugins: { entries: { 'x': { enabled: true } } } });
    assert.deepEqual(calls[0].afterWrite, { mode: 'auto' });
  } finally {
    clearRuntime();
  }
});

test('saveOpenClawConfig: openclaw < 2026.4.27 — falls back to deprecated writeConfigFile()', async () => {
  const r = makeOldRuntime();
  setOpenClawRuntime(r.runtime);
  try {
    await saveOpenClawConfig({ plugins: { entries: { 'y': { enabled: true } } } });
    assert.equal(r.calls.writeConfigFile, 1);
    assert.deepEqual(r.getStored(), { plugins: { entries: { 'y': { enabled: true } } } });
  } finally {
    clearRuntime();
  }
});

test('saveOpenClawConfig: openclaw >= 2026.4.27 — does NOT also call deprecated writeConfigFile()', async () => {
  const r = makeNewRuntime();
  setOpenClawRuntime(r.runtime);
  try {
    await saveOpenClawConfig({ plugins: { entries: { 'z': { enabled: true } } } });
    assert.equal(r.calls.replaceConfigFile, 1);
    assert.equal(
      r.calls.writeConfigFile,
      0,
      'must not invoke deprecated writeConfigFile() when replaceConfigFile() exists',
    );
  } finally {
    clearRuntime();
  }
});

// ---------------------------------------------------------------------------
// Defense — runtime missing both APIs must not crash the consumer
// ---------------------------------------------------------------------------

test('loadOpenClawConfig: neither current() nor loadConfig() exposed — falls through to file I/O', async () => {
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

test('saveOpenClawConfig: neither replaceConfigFile() nor writeConfigFile() exposed — falls through to file I/O', async () => {
  const r = makeBrokenRuntime();
  setOpenClawRuntime(r.runtime);
  try {
    // Should not throw; the file-I/O fallback writes to the temp openclaw home.
    await saveOpenClawConfig({ plugins: { entries: {} } });
  } finally {
    clearRuntime();
  }
});
