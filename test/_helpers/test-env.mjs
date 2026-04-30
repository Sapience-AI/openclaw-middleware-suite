import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

// ── Tempdir + combined setup ─────────────────────────────────────────

export function createTestEnv(prefix) {
  const testHome = mkdtempSync(path.join(os.tmpdir(), prefix));
  mkdirSync(testHome, { recursive: true });
  process.env.SAPIENCE_MW_DATA_DIR = testHome;
  process.env.NODE_ENV = 'test';
  return testHome;
}

export function createTestEnvWithOpenclaw(prefix) {
  const testHome = mkdtempSync(path.join(os.tmpdir(), prefix));
  mkdirSync(testHome, { recursive: true });
  process.env.OPENCLAW_HOME = testHome;
  process.env.SAPIENCE_MW_DATA_DIR = testHome;
  process.env.NODE_ENV = 'test';
  return testHome;
}

export function createOpenclawHome(prefix) {
  const testHome = mkdtempSync(path.join(os.tmpdir(), prefix));
  mkdirSync(testHome, { recursive: true });
  process.env.OPENCLAW_HOME = testHome;
  return testHome;
}

// ── Named setters (keep env-var names out of test files) ─────────────

export function setOpenclawHome(dir) {
  process.env.OPENCLAW_HOME = dir;
}

export function setDataDir(dir) {
  process.env.SAPIENCE_MW_DATA_DIR = dir;
}

export function clearDataDir() {
  delete process.env.SAPIENCE_MW_DATA_DIR;
}

export function setNodeEnvTest() {
  process.env.NODE_ENV = 'test';
}

export function enableDestructiveGating() {
  process.env.SAPIENCE_MW_DESTRUCTIVE_GATING = 'on';
}

export function disableDestructiveGating() {
  process.env.SAPIENCE_MW_DESTRUCTIVE_GATING = 'off';
}

export function setBulkThreshold(n) {
  process.env.SAPIENCE_MW_BULK_THRESHOLD = String(n);
}

export function setOpenclawConfig(configPath) {
  process.env.OPENCLAW_CONFIG = configPath;
  return configPath;
}

export function setOpenclawPluginId(id) {
  process.env.OPENCLAW_PLUGIN_ID = id;
}

// ── Generic helpers ──────────────────────────────────────────────────

export function clearEnvKey(key) {
  const saved = process.env[key];
  delete process.env[key];
  return saved;
}

export function setEnvKey(key, value) {
  const saved = process.env[key];
  process.env[key] = value;
  return saved;
}

export function restoreEnvKey(key, saved) {
  if (saved !== undefined) process.env[key] = saved;
  else delete process.env[key];
}

// ── Named wrappers for OPENAI_API_KEY ────────────────────────────────

export const clearOpenAIKey = () => clearEnvKey('OPENAI_API_KEY');
export const setOpenAIKey = (value) => setEnvKey('OPENAI_API_KEY', value);
export const restoreOpenAIKey = (saved) => restoreEnvKey('OPENAI_API_KEY', saved);

// ── Suite-store seeding (for tests that need a pre-populated store) ──

export function seedSuiteStore(suiteHome, storeFile, key, value) {
  mkdirSync(suiteHome, { recursive: true });
  // No existsSync precheck — read directly and tolerate ENOENT.
  // Removing the precheck eliminates the TOCTOU window
  // (CodeQL js/file-system-race).
  let existing;
  try {
    existing = JSON.parse(readFileSync(storeFile, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    existing = {};
  }
  existing[key] = value;
  writeFileSync(storeFile, JSON.stringify(existing, null, 2));
}
