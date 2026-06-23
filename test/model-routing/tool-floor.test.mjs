import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scoreRequest } = require('../../dist/middlewares/model-routing/scoring/scorer.js');
const { DEFAULT_SCORING_CONFIG } = require('../../dist/middlewares/model-routing/config.js');

// ---------------------------------------------------------------------------
// tool_floor — fires only when there is post-tool-call evidence in messages,
// not when tools are merely listed as available.
//
// Detected evidence shapes:
//   - OpenAI:   role='tool' message
//   - OpenAI:   role='assistant' with non-empty tool_calls[]
//   - Anthropic: content block with type='tool_use' or type='tool_result'
//
// Bypass:
//   - tool_choice === 'none' (caller has explicitly disabled tool use)
//   - no tools listed in the request body
// ---------------------------------------------------------------------------

const tools = [{ type: 'function', function: { name: 'get_weather' } }];

// ── Negative cases: floor must NOT fire ────────────────────────────────────

test('tool_floor: tools listed, no agent call yet → no floor', () => {
  // First turn of a chat, OpenClaw inventory is attached but the agent
  // hasn't decided to use any tool. Scorer's tier wins.
  const body = { messages: [{ role: 'user', content: 'hi' }], tools };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
  assert.notEqual(result.reason, 'tool_floor');
});

test('tool_floor: tool_choice="none" bypasses the floor even with tool-call evidence', () => {
  // Caller disabled tool use for this request; the floor's premise (model
  // needs to handle tool I/O) doesn't apply.
  const body = {
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{}' },
    ],
    tools,
    tool_choice: 'none',
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.notEqual(result.reason, 'tool_floor');
});

test('tool_floor: no tools listed → no floor regardless of message content', () => {
  // Defensive: even if the messages array somehow had a role: 'tool'
  // entry but the body lists no tools, the floor stays off.
  const body = {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'c1', content: '{}' },
    ],
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.notEqual(result.reason, 'tool_floor');
});

// ── Positive cases: floor SHOULD fire ─────────────────────────────────────

test('tool_floor: OpenAI role="tool" message in history → floor fires', () => {
  const body = {
    messages: [
      { role: 'user', content: 'what is the weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"temp":18}' },
    ],
    tools,
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'STANDARD');
  assert.equal(result.reason, 'tool_floor');
});

test('tool_floor: OpenAI assistant with tool_calls but no tool message yet → floor fires', () => {
  // Mid-flight: the agent emitted tool_calls in its previous turn but the
  // tool's response isn't in messages[] yet. The presence of tool_calls
  // alone is sufficient evidence — the next turn will need to handle them.
  const body = {
    messages: [
      { role: 'user', content: 'what is the weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
        ],
      },
    ],
    tools,
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'STANDARD');
  assert.equal(result.reason, 'tool_floor');
});

test('tool_floor: Anthropic tool_use content block → floor fires', () => {
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'what is the weather?' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'get_weather',
            input: { city: 'Paris' },
          },
        ],
      },
    ],
    tools,
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'STANDARD');
  assert.equal(result.reason, 'tool_floor');
});

test('tool_floor: Anthropic tool_result content block → floor fires', () => {
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'what is the weather?' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'get_weather',
            input: { city: 'Paris' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01',
            content: '{"temp":18}',
          },
        ],
      },
    ],
    tools,
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'STANDARD');
  assert.equal(result.reason, 'tool_floor');
});

// ── Edge cases ────────────────────────────────────────────────────────────

test('tool_floor: empty assistant.tool_calls array does NOT trigger the floor', () => {
  // An assistant message with `tool_calls: []` (empty array) is not
  // evidence of a call. Some serializers emit empty arrays even when
  // no tool was used.
  const body = {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hi back!', tool_calls: [] },
    ],
    tools,
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.notEqual(result.reason, 'tool_floor');
});

test('tool_floor: assistant.tool_calls is not an array (malformed) → no floor (defensive)', () => {
  const body = {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hi', tool_calls: 'malformed' },
    ],
    tools,
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  // Should not throw and should not treat the malformed value as evidence.
  assert.notEqual(result.reason, 'tool_floor');
});

test('tool_floor: text-only Anthropic content blocks (no tool_use/tool_result) → no floor', () => {
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi back' }] },
    ],
    tools,
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.notEqual(result.reason, 'tool_floor');
});

test('tool_floor: floor only fires when current tier is below STANDARD', () => {
  // Reasoning-keyword override → REASONING already exceeds STANDARD;
  // tool_floor should be a no-op (ScoringResult unchanged).
  const body = {
    messages: [
      { role: 'user', content: 'prove that sqrt(2) is irrational' },
      { role: 'tool', tool_call_id: 'c1', content: '{}' },
    ],
    tools,
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  // REASONING (or COMPLEX) is fine here — point is tool_floor didn't downgrade it.
  assert.notEqual(result.tier, 'STANDARD');
  assert.notEqual(result.reason, 'tool_floor');
});
