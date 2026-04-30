import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ContextCurator } = require('../../dist/middlewares/context-editing/ContextCurator.js');
const { DEFAULT_CONTEXT_EDITING_CONFIG } = require(
  '../../dist/middlewares/context-editing/config.js',
);
const { ICC_EXTRACTION_MARKER } = require('../../dist/shared/icc-detection.js');

// ---------------------------------------------------------------------------
// CE ICC extraction — verifies that:
//   (1) compaction.model takes precedence over model.primary
//   (2) ICC_EXTRACTION_MARKER is prepended ONLY when the target is sai-router/*
//   (3) on first-target failure, CE retries with the second target (primary)
//   (4) the call shape passed to runEmbeddedPiAgent is correct (disableTools, etc.)
//
// We call ContextCurator.curate() with a fake pluginApi that captures the
// runEmbeddedPiAgent arguments without making a real LLM call.
// ---------------------------------------------------------------------------

const VALID_RESULT_TEXT = JSON.stringify({ entities: [], conflicts: [], priorities: [] });

function makeFakePluginApi(cfg, options = {}) {
  const calls = [];
  // `responder` is a function that receives the call params and returns the
  // result (or throws). Default: always succeed.
  const responder =
    options.responder ??
    (() => ({
      payloads: [{ isError: false, isReasoning: false, text: VALID_RESULT_TEXT }],
    }));
  const pluginApi = {
    config: cfg,
    runtime: {
      agent: {
        async runEmbeddedPiAgent(params) {
          calls.push(params);
          const result = responder(params, calls.length - 1);
          if (result instanceof Error) throw result;
          return result;
        },
      },
    },
  };
  return { pluginApi, calls };
}

const SHORT_TRANSCRIPT = 'User: hi\nAssistant: hello';

// ---------------------------------------------------------------------------
// Conditional marker — ONLY added for sai-router/* targets
// ---------------------------------------------------------------------------

test('curate: marker IS prepended when target is sai-router/* (MR is in the loop)', async () => {
  const { pluginApi, calls } = makeFakePluginApi({
    agents: { defaults: { compaction: { model: 'sai-router/eco' } } },
  });
  const curator = new ContextCurator();
  await curator.curate(SHORT_TRANSCRIPT, DEFAULT_CONTEXT_EDITING_CONFIG.icc, 'manual', pluginApi);
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].prompt.startsWith(ICC_EXTRACTION_MARKER),
    `prompt should start with marker for sai-router target; got: ${calls[0].prompt.slice(0, 60)}`,
  );
});

test('curate: marker is NOT prepended when target is a direct provider (anthropic, openai, etc.)', async () => {
  const { pluginApi, calls } = makeFakePluginApi({
    agents: { defaults: { compaction: { model: 'anthropic/claude-haiku-4-5' } } },
  });
  const curator = new ContextCurator();
  await curator.curate(SHORT_TRANSCRIPT, DEFAULT_CONTEXT_EDITING_CONFIG.icc, 'manual', pluginApi);
  assert.equal(calls.length, 1);
  assert.ok(
    !calls[0].prompt.includes(ICC_EXTRACTION_MARKER),
    'marker must not appear in non-MR prompts (would just be noise to the LLM)',
  );
});

test('curate: marker is NOT prepended when no model is configured (openclaw default path)', async () => {
  const { pluginApi, calls } = makeFakePluginApi({ agents: { defaults: {} } });
  const curator = new ContextCurator();
  await curator.curate(SHORT_TRANSCRIPT, DEFAULT_CONTEXT_EDITING_CONFIG.icc, 'manual', pluginApi);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].prompt.includes(ICC_EXTRACTION_MARKER));
});

// ---------------------------------------------------------------------------
// Target precedence — compaction.model > model.primary
// ---------------------------------------------------------------------------

test('curate: compaction.model overrides model.primary when both are set', async () => {
  const { pluginApi, calls } = makeFakePluginApi({
    agents: {
      defaults: {
        model: { primary: 'anthropic/claude-opus-4-7' }, // expensive — should be ignored
        compaction: { model: 'sai-router/eco' }, // user's compaction choice
      },
    },
  });
  const curator = new ContextCurator();
  await curator.curate(SHORT_TRANSCRIPT, DEFAULT_CONTEXT_EDITING_CONFIG.icc, 'manual', pluginApi);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'sai-router');
  assert.equal(calls[0].model, 'eco');
});

test('curate: compaction.model alone is used (model.primary unset)', async () => {
  const { pluginApi, calls } = makeFakePluginApi({
    agents: { defaults: { compaction: { model: 'sai-router/premium' } } },
  });
  const curator = new ContextCurator();
  await curator.curate(SHORT_TRANSCRIPT, DEFAULT_CONTEXT_EDITING_CONFIG.icc, 'manual', pluginApi);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'sai-router');
  assert.equal(calls[0].model, 'premium');
});

test('curate: model.primary is used when compaction.model is not set', async () => {
  const { pluginApi, calls } = makeFakePluginApi({
    agents: { defaults: { model: { primary: 'anthropic/claude-haiku-4-5' } } },
  });
  const curator = new ContextCurator();
  await curator.curate(SHORT_TRANSCRIPT, DEFAULT_CONTEXT_EDITING_CONFIG.icc, 'manual', pluginApi);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'anthropic');
  assert.equal(calls[0].model, 'claude-haiku-4-5');
});

test('curate: neither model is set — provider/model are omitted (let openclaw resolve)', async () => {
  const { pluginApi, calls } = makeFakePluginApi({ agents: { defaults: {} } });
  const curator = new ContextCurator();
  await curator.curate(SHORT_TRANSCRIPT, DEFAULT_CONTEXT_EDITING_CONFIG.icc, 'manual', pluginApi);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, undefined);
  assert.equal(calls[0].model, undefined);
});

test('curate: malformed model (no "/" separator) is skipped — openclaw default path', async () => {
  const { pluginApi, calls } = makeFakePluginApi({
    agents: { defaults: { compaction: { model: 'just-a-model-name' } } },
  });
  const curator = new ContextCurator();
  await curator.curate(SHORT_TRANSCRIPT, DEFAULT_CONTEXT_EDITING_CONFIG.icc, 'manual', pluginApi);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, undefined);
  assert.equal(calls[0].model, undefined);
});

// ---------------------------------------------------------------------------
// Fallback — when compaction.model fails, retry with model.primary
// ---------------------------------------------------------------------------

test('curate: compaction.model failure falls back to model.primary', async () => {
  const { pluginApi, calls } = makeFakePluginApi(
    {
      agents: {
        defaults: {
          model: { primary: 'anthropic/claude-haiku-4-5' },
          compaction: { model: 'sai-router/eco' },
        },
      },
    },
    {
      responder: (_params, attemptIdx) => {
        // First call (compaction.model) — fail.
        if (attemptIdx === 0) return new Error('401 invalid api key');
        // Second call (model.primary) — succeed.
        return { payloads: [{ isError: false, isReasoning: false, text: VALID_RESULT_TEXT }] };
      },
    },
  );
  const curator = new ContextCurator();
  await curator.curate(SHORT_TRANSCRIPT, DEFAULT_CONTEXT_EDITING_CONFIG.icc, 'manual', pluginApi);
  assert.equal(calls.length, 2, 'should attempt both targets in order');
  assert.equal(calls[0].provider, 'sai-router');
  assert.equal(calls[1].provider, 'anthropic');
  assert.equal(calls[1].model, 'claude-haiku-4-5');
});

test('curate: marker is dropped on the fallback attempt when primary is non-sai-router', async () => {
  const { pluginApi, calls } = makeFakePluginApi(
    {
      agents: {
        defaults: {
          model: { primary: 'anthropic/claude-haiku-4-5' },
          compaction: { model: 'sai-router/eco' },
        },
      },
    },
    {
      responder: (_params, attemptIdx) => {
        if (attemptIdx === 0) return new Error('rate limited');
        return { payloads: [{ isError: false, isReasoning: false, text: VALID_RESULT_TEXT }] };
      },
    },
  );
  const curator = new ContextCurator();
  await curator.curate(SHORT_TRANSCRIPT, DEFAULT_CONTEXT_EDITING_CONFIG.icc, 'manual', pluginApi);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].prompt.startsWith(ICC_EXTRACTION_MARKER), 'first attempt is sai-router → marker');
  assert.ok(!calls[1].prompt.includes(ICC_EXTRACTION_MARKER), 'fallback is anthropic → no marker');
});

test('curate: when both targets fail, falls through to regex (no throw at curate level)', async () => {
  const { pluginApi, calls } = makeFakePluginApi(
    {
      agents: {
        defaults: {
          model: { primary: 'anthropic/claude-haiku-4-5' },
          compaction: { model: 'sai-router/eco' },
        },
      },
    },
    { responder: () => new Error('upstream down') },
  );
  const curator = new ContextCurator();
  // Should not throw — curate() catches and falls through to regex extraction.
  const result = await curator.curate(
    SHORT_TRANSCRIPT,
    DEFAULT_CONTEXT_EDITING_CONFIG.icc,
    'manual',
    pluginApi,
  );
  assert.equal(calls.length, 2, 'both targets attempted');
  assert.ok(result, 'curate returns a result (regex fallback) instead of throwing');
});

test('curate: identical compaction.model and model.primary are deduped (no double attempt)', async () => {
  const { pluginApi, calls } = makeFakePluginApi({
    agents: {
      defaults: {
        model: { primary: 'sai-router/eco' },
        compaction: { model: 'sai-router/eco' },
      },
    },
  });
  const curator = new ContextCurator();
  await curator.curate(SHORT_TRANSCRIPT, DEFAULT_CONTEXT_EDITING_CONFIG.icc, 'manual', pluginApi);
  assert.equal(calls.length, 1, 'duplicate targets should be deduped, not retried');
});

// ---------------------------------------------------------------------------
// runEmbeddedPiAgent receives disableTools: true
// ---------------------------------------------------------------------------

test('curate: invokes runEmbeddedPiAgent with disableTools: true', async () => {
  const { pluginApi, calls } = makeFakePluginApi({
    agents: { defaults: { compaction: { model: 'sai-router/eco' } } },
  });
  const curator = new ContextCurator();
  await curator.curate(SHORT_TRANSCRIPT, DEFAULT_CONTEXT_EDITING_CONFIG.icc, 'manual', pluginApi);
  assert.equal(calls[0].disableTools, true);
});
