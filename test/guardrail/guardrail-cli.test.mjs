import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOpenclawHome, clearDataDir } from '../_helpers/test-env.mjs';

createOpenclawHome('sai-guardrail-cli-test-');
clearDataDir();

const distBase = path.resolve('dist');
const u = (p) => pathToFileURL(path.join(distBase, p)).href;

const { ConfigStore } = await import(u('middlewares/guardrail/storage/ConfigStore.js'));
const status = await import(u('middlewares/guardrail/cli/status.js'));
const list = await import(u('middlewares/guardrail/cli/list.js'));
const toggle = await import(u('middlewares/guardrail/cli/toggle.js'));
const reset = await import(u('middlewares/guardrail/cli/reset.js'));
const configGet = await import(u('middlewares/guardrail/cli/config-get.js'));
const ruleToggle = await import(u('middlewares/guardrail/cli/rule-toggle.js'));
const ruleAction = await import(u('middlewares/guardrail/cli/rule-action.js'));
const ruleAdd = await import(u('middlewares/guardrail/cli/rule-add.js'));
const ruleRemove = await import(u('middlewares/guardrail/cli/rule-remove.js'));
const paths = await import(u('middlewares/guardrail/cli/paths.js'));
const egress = await import(u('middlewares/guardrail/cli/egress.js'));
const destructive = await import(u('middlewares/guardrail/cli/destructive.js'));

const origLog = console.log;
const capture = (fn) => {
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  return Promise.resolve(fn()).then(() => {
    console.log = origLog;
    return lines.join('\n');
  }).catch((err) => {
    console.log = origLog;
    throw err;
  });
};

test('guardrail status command prints state', async () => {
  const out = await capture(() => status.guardrailStatusCommand());
  assert.ok(out.includes('Guardrail Status'));
  assert.ok(out.includes('Detection Rules'));
  assert.ok(out.includes('L2 Guards'));
});

test('guardrail list command prints all categories', async () => {
  const out = await capture(() => list.guardrailListCommand());
  assert.ok(out.includes('Input Guardrail Rules'));
});

test('guardrail list command with category filter', async () => {
  const out = await capture(() => list.guardrailListCommand('promptInjection'));
  assert.ok(out.includes('promptInjection'));
});

test('guardrail list command with invalid category', async () => {
  const out = await capture(() => list.guardrailListCommand('nonexistent'));
  assert.ok(out.includes('Unknown category'));
});

test('guardrail toggle enable/disable now defers to plugin-level config', async () => {
  // The per-middleware `enabled` flag was removed; `enable`/`disable` now
  // print a hint and exit without mutating GuardrailConfig.
  const enableOut = await capture(() => toggle.guardrailToggleCommand('enable'));
  assert.ok(enableOut.includes('dashboard') || enableOut.includes('sai init'));
  const disableOut = await capture(() => toggle.guardrailToggleCommand('disable'));
  assert.ok(disableOut.includes('dashboard') || disableOut.includes('sai init'));
});

test('guardrail toggle dry-run flips the dryRunMode field', async () => {
  const before = (await ConfigStore.load()).dryRunMode;
  await capture(() => toggle.guardrailToggleCommand('dry-run'));
  const after = (await ConfigStore.load()).dryRunMode;
  assert.notEqual(before, after);
  // toggle dry-run again
  await capture(() => toggle.guardrailToggleCommand('dry-run'));
  assert.equal((await ConfigStore.load()).dryRunMode, before);
});

test('guardrail toggle unknown setting', async () => {
  const out = await capture(() => toggle.guardrailToggleCommand('garbage'));
  assert.ok(out.includes('Unknown'));
});

test('guardrail config-get prints config', async () => {
  const out = await capture(() => configGet.guardrailConfigGetCommand());
  assert.ok(out.includes('Configuration File'));
  assert.ok(out.includes('"version"'));
});

test('guardrail reset restores defaults', async () => {
  await capture(() => reset.guardrailResetCommand());
  const cfg = await ConfigStore.load();
  assert.ok(cfg.rules.promptInjection.length > 0);
});

test('guardrail rule-add and rule-remove', async () => {
  await capture(() => ruleAdd.guardrailRuleAddCommand('test_rule', 'suspicious', {
    pattern: 'foo',
    severity: 'high',
    action: 'BLOCK',
    description: 'test',
  }));
  let cfg = await ConfigStore.load();
  assert.ok(cfg.rules.suspicious.find((r) => r.name === 'test_rule'));

  // Update existing
  await capture(() => ruleAdd.guardrailRuleAddCommand('test_rule', 'suspicious', {
    pattern: 'bar',
  }));
  cfg = await ConfigStore.load();
  assert.equal(cfg.rules.suspicious.find((r) => r.name === 'test_rule').pattern, 'bar');

  // Invalid category
  const out = await capture(() => ruleAdd.guardrailRuleAddCommand('x', 'invalid', {}));
  assert.ok(out.includes('Invalid category'));

  // Remove
  await capture(() => ruleRemove.guardrailRuleRemoveCommand('test_rule'));
  cfg = await ConfigStore.load();
  assert.equal(cfg.rules.suspicious.find((r) => r.name === 'test_rule'), undefined);

  // Remove nonexistent
  const out2 = await capture(() => ruleRemove.guardrailRuleRemoveCommand('nonexistent'));
  assert.ok(out2.includes('not found'));
});

test('guardrail rule-toggle by name', async () => {
  const cfg = await ConfigStore.load();
  const rule = cfg.rules.promptInjection[0];
  const before = rule.enabled;
  await capture(() => ruleToggle.guardrailRuleToggleCommand(rule.name));
  const cfg2 = await ConfigStore.load();
  const after = cfg2.rules.promptInjection.find((r) => r.name === rule.name).enabled;
  assert.notEqual(before, after);

  // explicit enable
  await capture(() => ruleToggle.guardrailRuleToggleCommand(rule.name, true));
  assert.equal((await ConfigStore.load()).rules.promptInjection.find((r) => r.name === rule.name).enabled, true);

  // missing rule
  const out = await capture(() => ruleToggle.guardrailRuleToggleCommand('nonexistent_rule'));
  assert.ok(out.includes('not found'));
});

test('guardrail rule-action sets and validates', async () => {
  const cfg = await ConfigStore.load();
  const rule = cfg.rules.promptInjection[0];

  await capture(() => ruleAction.guardrailRuleActionCommand(rule.name, 'WARN'));
  assert.equal((await ConfigStore.load()).rules.promptInjection.find((r) => r.name === rule.name).action, 'WARN');

  // Same value (no change)
  const out = await capture(() => ruleAction.guardrailRuleActionCommand(rule.name, 'WARN'));
  assert.ok(out.includes('already set'));

  // Invalid action
  const out2 = await capture(() => ruleAction.guardrailRuleActionCommand(rule.name, 'INVALID'));
  assert.ok(out2.includes('Invalid action'));

  // Missing rule
  const out3 = await capture(() => ruleAction.guardrailRuleActionCommand('nonexistent', 'BLOCK'));
  assert.ok(out3.includes('not found'));
});

test('guardrail paths CLI commands', async () => {
  await capture(() => paths.pathsStatusCommand());
  await capture(() => paths.pathsToggleCommand());
  // toggle back
  await capture(() => paths.pathsToggleCommand());

  await capture(() => paths.pathsBlockCommand('/tmp/secret'));
  let cfg = await ConfigStore.load();
  assert.ok(cfg.sensitivePaths.blockedPaths.includes('/tmp/secret'));

  // Already exists
  const out = await capture(() => paths.pathsBlockCommand('/tmp/secret'));
  assert.ok(out.includes('already'));

  await capture(() => paths.pathsAllowCommand('/tmp/ok'));
  cfg = await ConfigStore.load();
  assert.ok(cfg.sensitivePaths.allowedPaths.includes('/tmp/ok'));

  const out2 = await capture(() => paths.pathsAllowCommand('/tmp/ok'));
  assert.ok(out2.includes('already'));

  await capture(() => paths.pathsRemoveCommand('/tmp/secret'));
  cfg = await ConfigStore.load();
  assert.ok(!cfg.sensitivePaths.blockedPaths.includes('/tmp/secret'));

  await capture(() => paths.pathsRemoveCommand('/tmp/ok'));
  cfg = await ConfigStore.load();
  assert.ok(!cfg.sensitivePaths.allowedPaths.includes('/tmp/ok'));

  // Remove nothing
  const out3 = await capture(() => paths.pathsRemoveCommand('/tmp/nope'));
  assert.ok(out3.includes('not found'));

  await capture(() => paths.pathsListCommand());
});

test('guardrail egress CLI commands', async () => {
  await capture(() => egress.egressStatusCommand());
  await capture(() => egress.egressToggleCommand());
  await capture(() => egress.egressToggleCommand());

  await capture(() => egress.egressAllowCommand('example.com'));
  let cfg = await ConfigStore.load();
  assert.ok(cfg.egressControl.allowedDomains.includes('example.com'));

  const out = await capture(() => egress.egressAllowCommand('example.com'));
  assert.ok(out.includes('already'));

  await capture(() => egress.egressRemoveCommand('example.com'));
  cfg = await ConfigStore.load();
  assert.ok(!cfg.egressControl.allowedDomains.includes('example.com'));

  const out2 = await capture(() => egress.egressRemoveCommand('example.com'));
  assert.ok(out2.includes('not in the allowlist'));

  await capture(() => egress.egressListCommand());
  await capture(() => egress.egressDataSendingCommand('on'));
  await capture(() => egress.egressDataSendingCommand('off'));
  await capture(() => egress.egressPrivateIpsCommand('on'));
  await capture(() => egress.egressPrivateIpsCommand('off'));
});

test('guardrail destructive CLI commands', async () => {
  await capture(() => destructive.destructiveStatusCommand());
  await capture(() => destructive.destructiveToggleCommand());
  await capture(() => destructive.destructiveToggleCommand());
  await capture(() => destructive.destructiveListCommand());

  await capture(() => destructive.destructiveAddCommand('rm\\s+-rf\\s+/'));
  let cfg = await ConfigStore.load();
  assert.ok(cfg.destructiveCommands.customPatterns.includes('rm\\s+-rf\\s+/'));

  // Already exists
  const out = await capture(() => destructive.destructiveAddCommand('rm\\s+-rf\\s+/'));
  assert.ok(out.includes('already'));

  // Invalid regex
  const out2 = await capture(() => destructive.destructiveAddCommand('[invalid('));
  assert.ok(out2.includes('Invalid'));

  await capture(() => destructive.destructiveRemoveCommand('rm\\s+-rf\\s+/'));
  cfg = await ConfigStore.load();
  assert.ok(!cfg.destructiveCommands.customPatterns.includes('rm\\s+-rf\\s+/'));

  // Remove nonexistent
  const out3 = await capture(() => destructive.destructiveRemoveCommand('nonexistent'));
  assert.ok(out3.includes('not found'));

  await capture(() => destructive.destructiveListCommand());
});

test('Guardrail ConfigStore loadSync', () => {
  const cfg = ConfigStore.loadSync();
  assert.ok(cfg);
  assert.ok(cfg.rules);
});
