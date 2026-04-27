import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { createOpenclawHome } from '../_helpers/test-env.mjs';

const tempDir = createOpenclawHome('sapience-mw-approval-cmd-tests-');

const require = createRequire(import.meta.url);
const {
  createApproveCommand,
  createDenyCommand,
} = require('../../dist/middlewares/hitl/approval/approval-commands.js');
const { approvalQueue } = require('../../dist/middlewares/hitl/approval/ApprovalQueue.js');

test('approval-commands', async (t) => {
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  t.beforeEach(() => {
    // Reset queue state between tests by resolving any pending entries
    for (let i = 0; i < 10; i++) {
      if (!approvalQueue.resolveLatestPending('deny')) break;
    }
  });

  await t.test('createApproveCommand returns proper definition', () => {
    const cmd = createApproveCommand();
    assert.equal(cmd.name, 'approve');
    assert.equal(cmd.acceptsArgs, true);
    assert.equal(cmd.requireAuth, true);
    assert.equal(typeof cmd.handler, 'function');
  });

  await t.test('createDenyCommand returns proper definition', () => {
    const cmd = createDenyCommand();
    assert.equal(cmd.name, 'deny');
    assert.equal(cmd.requireAuth, true);
  });

  await t.test('approve rejects unauthorized sender', async () => {
    const cmd = createApproveCommand();
    const result = await cmd.handler({ isAuthorizedSender: false });
    assert.equal(result.isError, true);
    assert.match(result.text, /Not authorized/);
  });

  await t.test('deny rejects unauthorized sender', async () => {
    const cmd = createDenyCommand();
    const result = await cmd.handler({ isAuthorizedSender: false });
    assert.equal(result.isError, true);
  });

  await t.test('approve warns when no pending approval', async () => {
    const cmd = createApproveCommand();
    const result = await cmd.handler({ isAuthorizedSender: true });
    assert.equal(result.isError, true);
    assert.match(result.text, /No pending approval/);
  });

  await t.test('deny warns when no pending approval', async () => {
    const cmd = createDenyCommand();
    const result = await cmd.handler({ isAuthorizedSender: true });
    assert.equal(result.isError, true);
    assert.match(result.text, /No pending approval/);
  });

  await t.test('approve succeeds on non-strict pending entry without TOTP', async () => {
    approvalQueue.request('sess-a', 'Shell', 'exec', {
      requiresExplicitConfirmation: false,
      args: [{ command: 'ls -la' }],
    });

    const cmd = createApproveCommand();
    const result = await cmd.handler({ isAuthorizedSender: true, from: 'test' });
    assert.ok(!result.isError);
    assert.match(result.text, /Approved: Shell\.exec/);
    assert.match(result.text, /ls -la/);
  });

  await t.test('approve renders path-style args', async () => {
    approvalQueue.request('sess-b', 'FS', 'write', {
      requiresExplicitConfirmation: false,
      args: [{ path: '/etc/hosts' }],
    });

    const cmd = createApproveCommand();
    const result = await cmd.handler({ isAuthorizedSender: true });
    assert.match(result.text, /path: \/etc\/hosts/);
  });

  await t.test('deny resolves pending and records denial', async () => {
    approvalQueue.request('sess-c', 'Net', 'fetch', {
      requiresExplicitConfirmation: false,
    });

    const cmd = createDenyCommand();
    const result = await cmd.handler({ isAuthorizedSender: true, from: 'test' });
    assert.equal(result.isError, undefined);
    assert.match(result.text, /Denied/);
  });
});
