import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createOpenclawHome } from '../_helpers/test-env.mjs';

createOpenclawHome('sai-cs-validation-');

const distBase = path.resolve('dist');
const u = (p) => pathToFileURL(path.join(distBase, p)).href;

const cs = await import(u('middlewares/guardrail/storage/ConfigStore.js'));
const paths = await import(u('shared/storage/paths.js'));

// ConfigStore reads from the unified sapience-ai-suite.json under key "guardrail".
async function withConfig(raw, fn) {
  fs.mkdirSync(paths.SUITE_HOME, { recursive: true });
  fs.writeFileSync(paths.STORE_FILE, JSON.stringify({ guardrail: raw }));
  return fn();
}

test('ConfigStore: invalid root config falls back to defaults', async () => {
  await withConfig('not-an-object', async () => {
    const c = await cs.ConfigStore.load();
    assert.equal(c.enabled, true);
    assert.equal(c.entropyThreshold, 4.0);
  });
});

test('ConfigStore: invalid enabled type warned, default kept', async () => {
  await withConfig({ enabled: 'no', dryRunMode: 'maybe' }, async () => {
    const c = await cs.ConfigStore.load();
    assert.equal(c.enabled, true);
    assert.equal(c.dryRunMode, false);
  });
});

test('ConfigStore: out-of-range entropyThreshold reset', async () => {
  await withConfig({ entropyThreshold: 99 }, async () => {
    const c = await cs.ConfigStore.load();
    assert.equal(c.entropyThreshold, 4.0);
  });
});

test('ConfigStore: in-range entropyThreshold accepted', async () => {
  await withConfig({ entropyThreshold: 3.5 }, async () => {
    const c = await cs.ConfigStore.load();
    assert.equal(c.entropyThreshold, 3.5);
  });
});

test('ConfigStore: invalid unicodeNormalization forces true', async () => {
  await withConfig({ unicodeNormalization: 'yes' }, async () => {
    const c = await cs.ConfigStore.load();
    assert.equal(c.unicodeNormalization, true);
  });
});

test('ConfigStore: invalid rule fields dropped', async () => {
  await withConfig(
    {
      rules: {
        pii: [
          { name: '', type: 'regex', pattern: 'x', severity: 'HIGH', action: 'BLOCK' },
          { name: 'bad-type', type: 'foo', pattern: 'x', severity: 'HIGH', action: 'BLOCK' },
          {
            name: 'bad-regex',
            type: 'regex',
            pattern: '[unclosed',
            severity: 'HIGH',
            action: 'BLOCK',
          },
          { name: 'bad-sev', type: 'regex', pattern: 'x', severity: 'WHATEVER', action: 'BLOCK' },
          { name: 'bad-act', type: 'regex', pattern: 'x', severity: 'HIGH', action: 'NOPE' },
          {
            name: 'bad-conf',
            type: 'regex',
            pattern: 'x',
            severity: 'HIGH',
            action: 'BLOCK',
            confidence: 'super',
          },
          { name: 'good', type: 'regex', pattern: 'x', severity: 'HIGH', action: 'BLOCK' },
        ],
        promptInjection: 'not-array',
      },
    },
    async () => {
      const c = await cs.ConfigStore.load();
      assert.equal(c.rules.pii.length, 1);
      assert.equal(c.rules.pii[0].name, 'good');
    }
  );
});

test('ConfigStore: sensitivePaths sub-config validated', async () => {
  await withConfig(
    {
      sensitivePaths: {
        enabled: 'yes',
        action: 'INVALID',
        blockedPaths: ['/x', 123, '/y'],
        allowedPaths: 'not-array',
      },
    },
    async () => {
      const c = await cs.ConfigStore.load();
      assert.equal(c.sensitivePaths.enabled, true);
      assert.equal(c.sensitivePaths.action, 'BLOCK');
      assert.deepEqual(c.sensitivePaths.blockedPaths, ['/x', '/y']);
      assert.deepEqual(c.sensitivePaths.allowedPaths, []);
    }
  );
});

test('ConfigStore: egressControl sub-config validated', async () => {
  await withConfig(
    {
      egressControl: {
        enabled: false,
        defaultAction: 'WARN',
        allowedDomains: ['a.com', 5, 'b.com'],
        blockDataSending: false,
        blockPrivateIPs: false,
      },
    },
    async () => {
      const c = await cs.ConfigStore.load();
      assert.equal(c.egressControl.enabled, false);
      assert.equal(c.egressControl.defaultAction, 'WARN');
      assert.deepEqual(c.egressControl.allowedDomains, ['a.com', 'b.com']);
    }
  );
});

test('ConfigStore: destructiveCommands invalid custom regex dropped', async () => {
  await withConfig(
    {
      destructiveCommands: {
        enabled: true,
        action: 'BLOCK',
        customPatterns: ['ok-pattern', '[bad', 42, 'nuke'],
      },
    },
    async () => {
      const c = await cs.ConfigStore.load();
      assert.deepEqual(c.destructiveCommands.customPatterns, ['ok-pattern', 'nuke']);
    }
  );
});

test('ConfigStore: loadSync returns defaults when config missing', () => {
  if (fs.existsSync(paths.STORE_FILE)) fs.unlinkSync(paths.STORE_FILE);
  const c = cs.ConfigStore.loadSync();
  assert.equal(c.enabled, true);
  assert.equal(c.entropyThreshold, 4.0);
});

test('ConfigStore: loadSync invalid JSON falls back to defaults', () => {
  fs.mkdirSync(paths.SUITE_HOME, { recursive: true });
  fs.writeFileSync(paths.STORE_FILE, '{not valid json');
  const c = cs.ConfigStore.loadSync();
  assert.equal(c.enabled, true);
});

test('ConfigStore: getPath returns unified-store label', () => {
  assert.equal(cs.ConfigStore.getPath(), 'sapience-ai-suite.json [guardrail]');
});
