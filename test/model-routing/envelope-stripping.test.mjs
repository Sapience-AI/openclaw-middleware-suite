import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractText } = require('../../dist/middlewares/model-routing/scoring/text-extractor.js');
const { scoreRequest } = require('../../dist/middlewares/model-routing/scoring/scorer.js');
const { DEFAULT_SCORING_CONFIG } = require('../../dist/middlewares/model-routing/config.js');

// ---------------------------------------------------------------------------
// Regression coverage for the envelope-aware extractText.
//
// Before the fix:
//   - `extractText` left timestamp prefixes inside user-role text.
//   - It also let `role: 'custom'` messages (which carry the "Sender
//     (untrusted metadata):" block in 2026.4.27) flow into the scoring
//     concatenation.
//   - Net: a 5-char user message like "hello" was scored as a 140+ char
//     blob, the `shortMessageChars` (50) threshold never tripped, and
//     simple chat consistently routed to STANDARD.
//
// These tests assert that:
//   (a) extractText drops role=custom and strips timestamp + sentinel blocks.
//   (b) scoreRequest returns SIMPLE / short_message for the realistic
//       2026.4.27 message shape (short user text + role=custom envelope).
//   (c) the same stripping works for the 2026.4.11 placement (envelope
//       inlined into the user-role body, no separate role=custom message).
// ---------------------------------------------------------------------------

const SENDER_BLOCK =
  'Sender (untrusted metadata):\n' +
  '```json\n' +
  '{\n  "label": "openclaw-control-ui",\n  "id": "openclaw-control-ui"\n}\n' +
  '```';

// Helpers — produce the realistic message arrays each version sends to MR.
function v_2026_4_27_messages(userText) {
  return [
    { role: 'user', content: [{ type: 'text', text: `[Thu 2026-04-30 21:09 UTC] ${userText}` }] },
    { role: 'custom', content: SENDER_BLOCK },
  ];
}

function v_2026_4_11_messages(userText) {
  // 2026.4.11 inlines the sender metadata into the user-role body; no
  // separate role=custom message exists in the chat-completion request.
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: `[Thu 2026-04-30 21:14 UTC] ${userText}\n\n${SENDER_BLOCK}` },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// extractText — direct verification
// ---------------------------------------------------------------------------

test('extractText: 2026.4.27 (timestamp + role=custom envelope) → bare user text', () => {
  const text = extractText({ messages: v_2026_4_27_messages('hello') });
  assert.equal(text, 'hello');
});

test('extractText: 2026.4.11 (timestamp + inlined sender block) → bare user text', () => {
  const text = extractText({ messages: v_2026_4_11_messages('hello') });
  assert.equal(text, 'hello');
});

test('extractText: role=custom messages are filtered (do not contribute to scoring text)', () => {
  const messages = [
    { role: 'user', content: 'real question' },
    { role: 'custom', content: 'Sender (untrusted metadata):\n```json\n{}\n```' },
    { role: 'custom', content: 'should not appear' },
  ];
  const text = extractText({ messages });
  assert.equal(text, 'real question');
  assert.ok(!text.includes('should not appear'));
});

test('extractText: plain user text without an envelope passes through unchanged', () => {
  const messages = [{ role: 'user', content: 'what is the capital of France?' }];
  assert.equal(extractText({ messages }), 'what is the capital of France?');
});

test('extractText: complex prompt content is preserved after envelope strip', () => {
  // Make sure the strip doesn't accidentally eat keywords. "prove that sqrt(2)
  // is irrational" must reach the scorer intact for reasoning_override to fire.
  const messages = [
    {
      role: 'user',
      content: `[Thu 2026-04-30 21:14 UTC] prove that sqrt(2) is irrational`,
    },
    { role: 'custom', content: SENDER_BLOCK },
  ];
  assert.equal(extractText({ messages }), 'prove that sqrt(2) is irrational');
});

// ---------------------------------------------------------------------------
// scoreRequest — end-to-end: the envelope no longer prevents short_message
// ---------------------------------------------------------------------------

test('scoreRequest: "hello" with 2026.4.27 envelope → SIMPLE / short_message', () => {
  const result = scoreRequest({ body: { messages: v_2026_4_27_messages('hello') } }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
  assert.equal(result.reason, 'short_message');
});

test('scoreRequest: "hello" with 2026.4.11 envelope → SIMPLE / short_message', () => {
  const result = scoreRequest({ body: { messages: v_2026_4_11_messages('hello') } }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
  assert.equal(result.reason, 'short_message');
});

test('scoreRequest: complex prompt with envelope still trips reasoning_override', () => {
  // Prove that stripping the envelope doesn't accidentally weaken complexity
  // detection. The user's actual question contains 2 formal-logic keywords
  // ("prove" + "theorem"); the override should fire after stripping.
  const messages = [
    {
      role: 'user',
      content: `[Thu 2026-04-30 21:14 UTC] prove the fundamental theorem of arithmetic`,
    },
    { role: 'custom', content: SENDER_BLOCK },
  ];
  const result = scoreRequest({ body: { messages } }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'REASONING');
  assert.equal(result.reason, 'reasoning_override');
});

test('scoreRequest: tool_floor still applies to short envelope-stripped messages (when tools present)', () => {
  // The envelope fix restores SIMPLE eligibility, but tool_floor is unchanged
  // by this PR — a short message with tools available still floors to STANDARD.
  // (Configurable tool_floor is a separate, future change.)
  const body = {
    messages: v_2026_4_27_messages('hello'),
    tools: [{ type: 'function', function: { name: 'get_weather' } }],
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'STANDARD');
  assert.equal(result.reason, 'tool_floor');
});

test('extractText: includeSystem=true is gated for the ROLE filter only — strip still runs', () => {
  // The role-custom filter is gated behind `includeSystem` along with
  // system/developer. The envelope-stripping pass runs unconditionally
  // on whatever messages survive the filter — that's intentional: a
  // debug caller asking for all roles still wants to see USER INTENT,
  // not the AI-facing envelope scaffolding.
  const messages = v_2026_4_27_messages('hello');
  const restrictive = extractText({ messages });
  const inclusive = extractText({ messages }, 3, true);
  assert.equal(restrictive, 'hello');
  // Inclusive keeps the role=custom message but strip removes its sender
  // block content, so the visible result is still just the bare user text
  // (the empty stripped custom message contributes a stray space at most).
  assert.ok(!inclusive.includes('Sender (untrusted metadata):'));
  assert.ok(inclusive.includes('hello'));
});
