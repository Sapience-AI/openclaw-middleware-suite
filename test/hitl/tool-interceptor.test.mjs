import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { createOpenclawHome } from '../_helpers/test-env.mjs';

const tempDir = createOpenclawHome('sapience-mw-tool-interceptor-tests-');

const require = createRequire(import.meta.url);
const {
  createToolCallHook,
  getToolMapping,
  getProtectedModules,
} = require('../../dist/middlewares/hitl/tool-interceptor.js');
const { DEFAULT_POLICY } = require('../../dist/middlewares/hitl/config.js');

function makeMockInterceptor({ shouldThrow = false, throwMessage = 'denied' } = {}) {
  const calls = [];
  return {
    calls,
    getPolicy: () => DEFAULT_POLICY,
    evaluate: async (moduleName, methodName, args, sessionKey, agentId, intervention) => {
      calls.push({ moduleName, methodName, args, sessionKey, agentId, intervention });
      if (shouldThrow) {
        throw new Error(throwMessage);
      }
    },
  };
}

test('tool-interceptor', async (t) => {
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('getToolMapping returns a populated dictionary', () => {
    const mapping = getToolMapping();
    assert.ok(Object.keys(mapping).length > 20);
    assert.deepEqual(mapping.read, { module: 'FileSystem', method: 'read' });
    assert.deepEqual(mapping.bash, { module: 'Shell', method: 'bash' });
  });

  await t.test('getProtectedModules returns unique module names', () => {
    const modules = getProtectedModules();
    assert.ok(Array.isArray(modules));
    assert.ok(modules.includes('FileSystem'));
    assert.ok(modules.includes('Shell'));
    assert.ok(modules.includes('Browser'));
    // Verify uniqueness
    assert.equal(new Set(modules).size, modules.length);
  });

  await t.test('routes known tool name to module mapping', async () => {
    const interceptor = makeMockInterceptor();
    const hook = createToolCallHook(interceptor);
    const result = await hook(
      { toolName: 'read', params: { path: '/tmp/x' } },
      { sessionKey: 's1', toolName: 'read' }
    );
    assert.equal(interceptor.calls[0].moduleName, 'FileSystem');
    assert.equal(interceptor.calls[0].methodName, 'read');
    assert.equal(result?.block, undefined);
  });

  await t.test('falls back to Unknown module for unmapped tool', async () => {
    const interceptor = makeMockInterceptor();
    const hook = createToolCallHook(interceptor);
    await hook(
      { toolName: 'some_exotic_tool', params: {} },
      { sessionKey: 's1', toolName: 'some_exotic_tool' }
    );
    assert.equal(interceptor.calls[0].moduleName, 'Unknown');
    assert.equal(interceptor.calls[0].methodName, 'some_exotic_tool');
  });

  await t.test('resolves process tool via action param', async () => {
    const interceptor = makeMockInterceptor();
    const hook = createToolCallHook(interceptor);
    await hook(
      { toolName: 'process', params: { action: 'kill', pid: 1 } },
      { sessionKey: 's1', toolName: 'process' }
    );
    assert.equal(interceptor.calls[0].moduleName, 'Process');
    assert.equal(interceptor.calls[0].methodName, 'kill');
  });

  await t.test('routes gdrive shell command to GoogleDrive module', async () => {
    const interceptor = makeMockInterceptor();
    const hook = createToolCallHook(interceptor);
    await hook(
      { toolName: 'bash', params: { command: 'gdrive download file-id-123' } },
      { sessionKey: 's1', toolName: 'bash' }
    );
    assert.equal(interceptor.calls[0].moduleName, 'GoogleDrive');
    assert.equal(interceptor.calls[0].methodName, 'download');
  });

  await t.test('routes gog drive search to GoogleDrive.list', async () => {
    const interceptor = makeMockInterceptor();
    const hook = createToolCallHook(interceptor);
    await hook(
      { toolName: 'exec', params: { command: 'gog drive search "foo"' } },
      { sessionKey: 's1', toolName: 'exec' }
    );
    assert.equal(interceptor.calls[0].moduleName, 'GoogleDrive');
    assert.equal(interceptor.calls[0].methodName, 'list');
  });

  await t.test('routes rclone copy to upload', async () => {
    const interceptor = makeMockInterceptor();
    const hook = createToolCallHook(interceptor);
    await hook(
      { toolName: 'bash', params: { command: 'rclone copy src remote:' } },
      { sessionKey: 's1', toolName: 'bash' }
    );
    assert.equal(interceptor.calls[0].moduleName, 'GoogleDrive');
    assert.equal(interceptor.calls[0].methodName, 'upload');
  });

  await t.test('routes Maton Gmail gateway URL to Gmail.send', async () => {
    const interceptor = makeMockInterceptor();
    const hook = createToolCallHook(interceptor);
    await hook(
      {
        toolName: 'fetch',
        params: { url: 'https://gateway.maton.ai/google-mail/gmail/v1/users/me/messages/send' },
      },
      { sessionKey: 's1', toolName: 'fetch' }
    );
    assert.equal(interceptor.calls[0].moduleName, 'Gmail');
    assert.equal(interceptor.calls[0].methodName, 'send');
  });

  await t.test('routes Maton Drive gateway URL to GoogleDrive', async () => {
    const interceptor = makeMockInterceptor();
    const hook = createToolCallHook(interceptor);
    await hook(
      {
        toolName: 'fetch',
        params: { url: 'https://gateway.maton.ai/google-drive/drive/v3/files/abc?delete=1' },
      },
      { sessionKey: 's1', toolName: 'fetch' }
    );
    assert.equal(interceptor.calls[0].moduleName, 'GoogleDrive');
    assert.equal(interceptor.calls[0].methodName, 'delete');
  });

  await t.test('routes file-write with Gmail API content to Gmail module', async () => {
    const interceptor = makeMockInterceptor();
    const hook = createToolCallHook(interceptor);
    await hook(
      {
        toolName: 'write',
        params: {
          path: '/tmp/script.py',
          content:
            'import requests; requests.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")',
        },
      },
      { sessionKey: 's1', toolName: 'write' }
    );
    assert.equal(interceptor.calls[0].moduleName, 'Gmail');
  });

  await t.test('routes file-write with Drive API content to GoogleDrive module', async () => {
    const interceptor = makeMockInterceptor();
    const hook = createToolCallHook(interceptor);
    await hook(
      {
        toolName: 'write',
        params: {
          path: '/tmp/script.py',
          content: 'https://www.googleapis.com/drive/v3/files/abc delete',
        },
      },
      { sessionKey: 's1', toolName: 'write' }
    );
    assert.equal(interceptor.calls[0].moduleName, 'GoogleDrive');
    assert.equal(interceptor.calls[0].methodName, 'delete');
  });

  await t.test('does not match look-alike hosts (anchored regex)', async () => {
    const interceptor = makeMockInterceptor();
    const hook = createToolCallHook(interceptor);
    await hook(
      {
        toolName: 'write',
        params: {
          path: '/tmp/script.py',
          content: 'https://notgmail.googleapis.com/foo and https://evildrive.googleapis.com/bar',
        },
      },
      { sessionKey: 's1', toolName: 'write' }
    );
    // Look-alike hosts must not be classified as Gmail/GoogleDrive.
    const moduleNames = interceptor.calls.map((c) => c.moduleName);
    assert.ok(!moduleNames.includes('Gmail'));
    assert.ok(!moduleNames.includes('GoogleDrive'));
  });

  await t.test('blocks when interceptor.evaluate throws', async () => {
    const interceptor = makeMockInterceptor({ shouldThrow: true, throwMessage: 'policy-deny' });
    const hook = createToolCallHook(interceptor);
    const result = await hook(
      { toolName: 'read', params: { path: '/etc/passwd' } },
      { sessionKey: 's1', toolName: 'read' }
    );
    assert.equal(result?.block, true);
    assert.match(result.blockReason, /policy-deny/);
  });

  await t.test('Browser tool triggers session capture path', async () => {
    const interceptor = makeMockInterceptor();
    const hook = createToolCallHook(interceptor);
    const result = await hook(
      {
        toolName: 'navigate',
        params: { url: 'https://browser.test', cookies: [{ name: 'a', value: 'b' }] },
      },
      { sessionKey: 'browser-sess', toolName: 'navigate' }
    );
    assert.equal(interceptor.calls[0].moduleName, 'Browser');
    assert.equal(interceptor.calls[0].methodName, 'navigate');
    // Either block undefined or params returned
    assert.ok(result === undefined || typeof result === 'object');
  });

  await t.test('gog gmail send routes to Gmail.send', async () => {
    const interceptor = makeMockInterceptor();
    const hook = createToolCallHook(interceptor);
    await hook(
      { toolName: 'bash', params: { command: 'gog gmail send --to x@y.com' } },
      { sessionKey: 's1', toolName: 'bash' }
    );
    assert.equal(interceptor.calls[0].moduleName, 'Gmail');
    assert.equal(interceptor.calls[0].methodName, 'send');
  });
});
