import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  LEADING_TIMESTAMP_PREFIX_RE,
  INBOUND_META_SENTINELS,
  stripOpenClawEnvelope,
} = require('../../dist/shared/openclaw-envelope.js');

// ---------------------------------------------------------------------------
// Realistic envelope fixtures from BOTH supported openclaw versions.
//
// Locking these in as test fixtures means future drift in either version's
// envelope shape will fail loudly here rather than silently degrade scoring
// quality.
// ---------------------------------------------------------------------------

// Sender metadata block — same content across versions; only the placement
// (inlined vs. separate role) differs.
const SENDER_BLOCK =
  'Sender (untrusted metadata):\n' +
  '```json\n' +
  '{\n' +
  '  "label": "openclaw-control-ui",\n' +
  '  "id": "openclaw-control-ui"\n' +
  '}\n' +
  '```';

// 2026.4.11 user-role body: timestamp + inlined sender metadata block,
// all in a single `role: "user"` message body. Pulled verbatim from the
// session.jsonl format the user shared.
const V_2026_4_11_USER_BODY = `[Thu 2026-04-30 21:14 UTC] hello\n\n${SENDER_BLOCK}`;

// 2026.4.27 user-role body: only the timestamp prefix; the sender block
// lives in a separate `role: "custom"` message that consumers filter out
// before reaching this stripper.
const V_2026_4_27_USER_BODY = `[Thu 2026-04-30 21:09 UTC] hello how are you?`;

// ---------------------------------------------------------------------------
// Constant exports
// ---------------------------------------------------------------------------

test('LEADING_TIMESTAMP_PREFIX_RE matches the format injected by openclaw injectTimestamp()', () => {
  assert.ok(LEADING_TIMESTAMP_PREFIX_RE.test('[Thu 2026-04-30 21:14 UTC] hello'));
  assert.ok(LEADING_TIMESTAMP_PREFIX_RE.test('[Mon 2026-01-05 03:07] hello')); // no tz
  assert.ok(LEADING_TIMESTAMP_PREFIX_RE.test('[Wed 2026-12-31 23:59 +0530] hello'));
  assert.ok(
    LEADING_TIMESTAMP_PREFIX_RE.test('[Sat 2026-06-15 10:30 America/New_York] hello'),
    'IANA timezone suffix must be tolerated',
  );
});

test('LEADING_TIMESTAMP_PREFIX_RE rejects strings that only superficially resemble a timestamp', () => {
  assert.equal(LEADING_TIMESTAMP_PREFIX_RE.test('[Thursday 2026-04-30 21:14 UTC] hello'), false);
  assert.equal(LEADING_TIMESTAMP_PREFIX_RE.test('not a timestamp'), false);
  assert.equal(LEADING_TIMESTAMP_PREFIX_RE.test('[Thu] hello'), false);
});

test('INBOUND_META_SENTINELS lists exactly the six openclaw inbound-meta block headers', () => {
  // Lock-step with openclaw/src/auto-reply/reply/strip-inbound-meta.ts.
  // Drift here means our scorer/ICC stops recognizing a block openclaw still emits.
  assert.deepEqual(
    [...INBOUND_META_SENTINELS],
    [
      'Conversation info (untrusted metadata):',
      'Sender (untrusted metadata):',
      'Thread starter (untrusted, for context):',
      'Replied message (untrusted, for context):',
      'Forwarded message context (untrusted metadata):',
      'Chat history since last reply (untrusted, for context):',
    ],
  );
});

// ---------------------------------------------------------------------------
// Real-world fixtures: 2026.4.11 + 2026.4.27
// ---------------------------------------------------------------------------

test('stripOpenClawEnvelope: 2026.4.11 user body (timestamp + inlined sender block) → "hello"', () => {
  assert.equal(stripOpenClawEnvelope(V_2026_4_11_USER_BODY), 'hello');
});

test('stripOpenClawEnvelope: 2026.4.27 user body (timestamp only, sender in role=custom) → "hello how are you?"', () => {
  assert.equal(stripOpenClawEnvelope(V_2026_4_27_USER_BODY), 'hello how are you?');
});

test('stripOpenClawEnvelope: standalone Sender block (the role=custom content from 2026.4.27) → ""', () => {
  // When extractText filters role=custom messages it will never invoke
  // stripOpenClawEnvelope on the block content directly, but defense-in-
  // depth: stripping the block in isolation must yield empty text.
  assert.equal(stripOpenClawEnvelope(SENDER_BLOCK), '');
});

// ---------------------------------------------------------------------------
// All six sentinel headers are covered (not just the two CE handled before)
// ---------------------------------------------------------------------------

function makeBlock(sentinel) {
  return `${sentinel}\n\`\`\`json\n{ "k": "v" }\n\`\`\``;
}

for (const sentinel of [
  'Conversation info (untrusted metadata):',
  'Thread starter (untrusted, for context):',
  'Replied message (untrusted, for context):',
  'Forwarded message context (untrusted metadata):',
  'Chat history since last reply (untrusted, for context):',
]) {
  test(`stripOpenClawEnvelope: removes ${JSON.stringify(sentinel)} block`, () => {
    const composed = `[Thu 2026-04-30 21:14 UTC] hello\n\n${makeBlock(sentinel)}`;
    assert.equal(stripOpenClawEnvelope(composed), 'hello');
  });
}

test('stripOpenClawEnvelope: removes multiple stacked metadata blocks in one message', () => {
  const composed =
    `[Thu 2026-04-30 21:14 UTC] please help with my budget\n\n` +
    `${makeBlock('Conversation info (untrusted metadata):')}\n\n` +
    `${makeBlock('Sender (untrusted metadata):')}`;
  assert.equal(stripOpenClawEnvelope(composed), 'please help with my budget');
});

// ---------------------------------------------------------------------------
// Defensive: no envelope present → return unchanged (fast path)
// ---------------------------------------------------------------------------

test('stripOpenClawEnvelope: plain user text passes through unchanged', () => {
  const plain = 'Can you write me a python function that sorts a list?';
  assert.equal(stripOpenClawEnvelope(plain), plain);
});

test('stripOpenClawEnvelope: empty string returns empty', () => {
  assert.equal(stripOpenClawEnvelope(''), '');
});

test('stripOpenClawEnvelope: non-string input is returned unchanged (defensive)', () => {
  // Defensive: a malformed message body (null, number, undefined) shouldn't
  // throw — caller may pass values from JSON.parse output which is unknown.
  assert.equal(stripOpenClawEnvelope(null), null);
  assert.equal(stripOpenClawEnvelope(undefined), undefined);
  assert.equal(stripOpenClawEnvelope(42), 42);
});

// ---------------------------------------------------------------------------
// Edge cases — sentinel-shaped user content must not be over-stripped
// ---------------------------------------------------------------------------

test('stripOpenClawEnvelope: sentinel-looking line WITHOUT a fenced JSON body is kept (defensive)', () => {
  // If a user happens to type "Sender (untrusted metadata):" followed by
  // anything other than ```json, we keep their text. Aggressively stripping
  // would lose legitimate user content.
  const text =
    `[Thu 2026-04-30 21:14 UTC] Hi! Can you parse logs of the form ` +
    `"Sender (untrusted metadata):" that aren't followed by JSON?`;
  const stripped = stripOpenClawEnvelope(text);
  assert.ok(stripped.includes('Sender (untrusted metadata):'));
  assert.ok(stripped.startsWith('Hi!'));
});

test('stripOpenClawEnvelope: text that starts with a sentinel but has fenced JSON later is kept', () => {
  // Stricter: only sentinel-followed-IMMEDIATELY-by-```json triggers a strip.
  const text = `Sender (untrusted metadata): not json here\n\nbut later: \`\`\`json\n{}\n\`\`\``;
  const stripped = stripOpenClawEnvelope(text);
  assert.ok(stripped.includes('Sender (untrusted metadata):'));
});

// ---------------------------------------------------------------------------
// The contract that matters for MR scoring: short user message → short
// stripped text (this is the regression that motivated the fix)
// ---------------------------------------------------------------------------

test('stripOpenClawEnvelope: 5-char "hello" with full envelope strips back to 5 chars', () => {
  // Regression: before this fix, MR's scorer saw 33+ chars (timestamp + "hello")
  // or 140+ chars (timestamp + "hello" + sender block) and never tripped the
  // shortMessageChars threshold. The strip must restore the 5-char length so
  // MR's short_message override fires correctly.
  const fullEnvelope = `[Thu 2026-04-30 21:14 UTC] hello\n\n${SENDER_BLOCK}`;
  assert.equal(stripOpenClawEnvelope(fullEnvelope), 'hello');
  assert.equal(stripOpenClawEnvelope(fullEnvelope).length, 5);
});
