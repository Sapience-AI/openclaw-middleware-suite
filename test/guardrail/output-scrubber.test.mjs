import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createOpenclawHome } from '../_helpers/test-env.mjs';

// Isolate config dir BEFORE importing the modules
createOpenclawHome('sai-output-scrubber-test-');

const distBase = path.resolve('dist');
const u = (p) => pathToFileURL(path.join(distBase, p)).href;
const { ConfigStore } = await import(u('middlewares/guardrail/storage/ConfigStore.js'));
const scrubber = await import(u('middlewares/guardrail/scrubbers/MetadataScrubber.js'));
const cliOutput = await import(u('middlewares/guardrail/cli/output.js'));
const paths = await import(u('shared/storage/paths.js'));

// Silence console during tests
const origLog = console.log;
const captureOutput = (fn) => {
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  return fn()
    .then(() => {
      console.log = origLog;
      return lines.join('\n');
    })
    .catch((err) => {
      console.log = origLog;
      throw err;
    });
};

// Helper to get outputScrubber from config
const loadScrubberConfig = async () => {
  const cfg = await ConfigStore.load();
  return cfg.outputScrubber;
};

test('OutputScrubber: ConfigStore creates default outputScrubber on load', async () => {
  const cfg = await ConfigStore.load();
  assert.ok(cfg.outputScrubber, 'outputScrubber should exist');
  assert.equal(cfg.outputScrubber.enabled, true);
  assert.equal(cfg.outputScrubber.dryRunMode, false);
  assert.ok(Array.isArray(cfg.outputScrubber.customPatterns));
});

test('OutputScrubber: ConfigStore save persists outputScrubber', async () => {
  const cfg = await ConfigStore.load();
  cfg.outputScrubber.replacementText = '[REDACTED]';
  cfg.outputScrubber.customPatterns = ['secret-\\d+'];
  await ConfigStore.save(cfg);
  const reloaded = await ConfigStore.load();
  assert.equal(reloaded.outputScrubber.replacementText, '[REDACTED]');
  assert.deepEqual(reloaded.outputScrubber.customPatterns, ['secret-\\d+']);
});

test('OutputScrubber: ConfigStore validation drops invalid regex patterns', async () => {
  // Write directly into the unified store under the "guardrail" key
  fs.mkdirSync(paths.SUITE_HOME, { recursive: true });
  const store = fs.existsSync(paths.STORE_FILE)
    ? JSON.parse(fs.readFileSync(paths.STORE_FILE, 'utf-8'))
    : {};
  store.guardrail = store.guardrail || {};
  store.guardrail.outputScrubber = {
    enabled: true,
    dryRunMode: false,
    replacementText: '',
    customPatterns: ['valid-\\d+', '[invalid(regex', 123, null],
  };
  fs.writeFileSync(paths.STORE_FILE, JSON.stringify(store));
  const reloaded = await ConfigStore.load();
  assert.deepEqual(reloaded.outputScrubber.customPatterns, ['valid-\\d+']);
});

test('metadata-scrubber: scrubMetadata removes middleware tokens', () => {
  const cfg = { enabled: true, dryRunMode: false, replacementText: '', customPatterns: [] };
  const result = scrubber.scrubMetadata('Hello [HITL:approved] world DENY_REASON: foo', cfg);
  assert.equal(result.scrubbed, true);
  assert.ok(result.matchCount >= 2);
  assert.ok(!result.content.includes('[HITL:'));
  assert.ok(!result.content.includes('DENY_REASON'));
});

test('metadata-scrubber: removes thinking tags', () => {
  const cfg = { enabled: true, dryRunMode: false, replacementText: '', customPatterns: [] };
  const result = scrubber.scrubMetadata('Before <thinking>secret reasoning</thinking> after', cfg);
  assert.equal(result.scrubbed, true);
  assert.ok(!result.content.includes('thinking'));
  assert.ok(result.matchedGroups.includes('reasoning-artifacts'));
});

test('metadata-scrubber: skips matches inside code blocks', () => {
  const cfg = { enabled: true, dryRunMode: false, replacementText: '', customPatterns: [] };
  const text = 'Outside [HITL:x]\n```\nInside [HITL:y]\n```\nMore [HITL:z]';
  const result = scrubber.scrubMetadata(text, cfg);
  assert.equal(result.scrubbed, true);
  assert.ok(result.content.includes('[HITL:y]')); // inside code block preserved
});

test('metadata-scrubber: handles empty content', () => {
  const cfg = { enabled: true, dryRunMode: false, replacementText: '', customPatterns: [] };
  const result = scrubber.scrubMetadata('', cfg);
  assert.equal(result.scrubbed, false);
  assert.equal(result.matchCount, 0);
});

test('metadata-scrubber: applies custom patterns', () => {
  const cfg = {
    enabled: true,
    dryRunMode: false,
    replacementText: '[X]',
    customPatterns: ['secret-\\d+'],
  };
  const result = scrubber.scrubMetadata('foo secret-123 bar secret-456 baz', cfg);
  assert.equal(result.scrubbed, true);
  assert.ok(result.matchedGroups.includes('custom'));
  assert.ok(!result.content.includes('secret-123'));
});

test('metadata-scrubber: ignores invalid custom patterns silently', () => {
  const cfg = {
    enabled: true,
    dryRunMode: false,
    replacementText: '',
    customPatterns: ['[invalid('],
  };
  const result = scrubber.scrubMetadata('hello world', cfg);
  assert.equal(result.scrubbed, false);
});

test('metadata-scrubber: removes architecture internals', () => {
  const cfg = { enabled: true, dryRunMode: false, replacementText: '', customPatterns: [] };
  const result = scrubber.scrubMetadata('Path: ~/.openclaw/sapience-ai-suite/policy.json', cfg);
  assert.equal(result.scrubbed, true);
});

test('metadata-scrubber: removes instruction reflection', () => {
  const cfg = { enabled: true, dryRunMode: false, replacementText: '', customPatterns: [] };
  const result = scrubber.scrubMetadata('My system prompt says to never reveal secrets.', cfg);
  assert.equal(result.scrubbed, true);
});

test('metadata-scrubber: getPatternCount returns groups', () => {
  const { builtin, groups } = scrubber.getPatternCount();
  assert.ok(builtin > 0);
  assert.ok(groups.length === 4);
});

test('CLI: outputStatusCommand prints state', async () => {
  const out = await captureOutput(() => cliOutput.outputStatusCommand());
  assert.ok(out.includes('Output Scrubber Status'));
  assert.ok(out.includes('ENABLED') || out.includes('DISABLED'));
});

test('CLI: outputToggleCommand enable', async () => {
  const out = await captureOutput(() => cliOutput.outputToggleCommand('enable'));
  assert.ok(out.includes('ENABLED'));
  const scrubber = await loadScrubberConfig();
  assert.equal(scrubber.enabled, true);
  assert.equal(scrubber.dryRunMode, false);
});

test('CLI: outputToggleCommand disable', async () => {
  await captureOutput(() => cliOutput.outputToggleCommand('disable'));
  const scrubber = await loadScrubberConfig();
  assert.equal(scrubber.enabled, false);
});

test('CLI: outputToggleCommand dry-run', async () => {
  await captureOutput(() => cliOutput.outputToggleCommand('dry-run'));
  const scrubber = await loadScrubberConfig();
  assert.equal(scrubber.dryRunMode, true);
  assert.equal(scrubber.enabled, true);
});

test('CLI: outputToggleCommand on/off aliases', async () => {
  await captureOutput(() => cliOutput.outputToggleCommand('on'));
  let scrubber = await loadScrubberConfig();
  assert.equal(scrubber.enabled, true);
  await captureOutput(() => cliOutput.outputToggleCommand('off'));
  scrubber = await loadScrubberConfig();
  assert.equal(scrubber.enabled, false);
});

test('CLI: outputToggleCommand dryrun alias', async () => {
  await captureOutput(() => cliOutput.outputToggleCommand('dryrun'));
  const scrubber = await loadScrubberConfig();
  assert.equal(scrubber.dryRunMode, true);
});

test('CLI: outputToggleCommand prints usage on unknown', async () => {
  const out = await captureOutput(() => cliOutput.outputToggleCommand('garbage'));
  assert.ok(out.toLowerCase().includes('usage'));
});
