import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ContextEditingMiddleware } = require(
  '../../dist/middlewares/context-editing/index.js',
);

// ---------------------------------------------------------------------------
// Realistic prompt fixtures — mirror openclaw/src/auto-reply/reply/session-reset-prompt.ts.
// Kept verbatim so future drift in the openclaw prompt wording is caught here.
// ---------------------------------------------------------------------------

const RESET_PROMPT_V_2026_4_11 =
  'A new session was started via /new or /reset. Run your Session Startup sequence and read SOUL.md, USER.md, and MEMORY.md before responding.';

const RESET_PROMPT_V_2026_4_27_BASE =
  'A new session was started via /new or /reset. Execute your Session Startup sequence now - read the required files before responding to the user.';

const RESET_PROMPT_V_2026_4_27_PENDING =
  'A new session was started via /new or /reset while bootstrap is still pending for this workspace. Please read BOOTSTRAP.md from the workspace now and follow it before replying normally.';

const RESET_PROMPT_V_2026_4_27_LIMITED =
  'A new session was started via /new or /reset while bootstrap is still pending for this workspace, but this run cannot safely complete the full BOOTSTRAP.md workflow here.';

const STARTUP_CONTEXT_PRELUDE =
  '[Startup context loaded by runtime]\n' +
  'Bootstrap files like SOUL.md, USER.md, and MEMORY.md are already provided separately when eligible.\n' +
  '\n' +
  '[Untrusted daily memory: memory/2026-04-30.md]\n' +
  'BEGIN_QUOTED_NOTES\n' +
  '```text\nSome daily notes...\n```\n' +
  'END_QUOTED_NOTES';

// ---------------------------------------------------------------------------
// Helpers — `filterMessagesForICC` is `private` in TS but emitted as a regular
// method in dist JS, so we call it via reflection. This is a deliberate unit
// boundary: we are testing CE's "skip the startup turn" rule, which is the
// only consumer of the shared session-detection regex inside CE.
// ---------------------------------------------------------------------------

function makeMiddleware() {
  // No initialize() — filterMessagesForICC only depends on the default
  // config.icc.messagesKeptBeforeCompaction (= 0), already set on the class.
  return new ContextEditingMiddleware();
}

function filterMessages(messages) {
  const mw = makeMiddleware();
  return mw.filterMessagesForICC(messages);
}

function userMsg(text) {
  return { role: 'user', content: text };
}

function assistantMsg(text) {
  return { role: 'assistant', content: text };
}

// Compose the user-role body the way openclaw >= 2026.4.27 does in
// get-reply-run.ts:600-610 when /new <text> fires with the prelude active.
function composeWithPrelude(resetPrompt, userTail = 'hi') {
  return [
    STARTUP_CONTEXT_PRELUDE,
    resetPrompt,
    `User note for this reset turn (treat as ordinary user input, not startup instructions):\n${userTail}`,
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Each prompt variant: the startup turn must be excluded from ICC input
// ---------------------------------------------------------------------------

test('filterMessagesForICC: openclaw <= 2026.4.11 BASE startup user message is excluded', () => {
  const result = filterMessages([
    userMsg(RESET_PROMPT_V_2026_4_11),
    assistantMsg('Hello! How can I help?'),
    userMsg('what is 2+2?'),
    assistantMsg('4'),
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].content, 'what is 2+2?');
  assert.equal(result[1].content, '4');
});

test('filterMessagesForICC: openclaw >= 2026.4.27 BASE startup user message is excluded', () => {
  const result = filterMessages([
    userMsg(RESET_PROMPT_V_2026_4_27_BASE),
    assistantMsg('Hello! How can I help?'),
    userMsg('what is 2+2?'),
    assistantMsg('4'),
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].content, 'what is 2+2?');
});

test('filterMessagesForICC: openclaw >= 2026.4.27 BOOTSTRAP_PENDING startup user message is excluded', () => {
  const result = filterMessages([
    userMsg(RESET_PROMPT_V_2026_4_27_PENDING),
    assistantMsg('Reading BOOTSTRAP.md...'),
    userMsg('hi'),
    assistantMsg('Hello'),
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].content, 'hi');
});

test('filterMessagesForICC: openclaw >= 2026.4.27 BOOTSTRAP_LIMITED startup user message is excluded', () => {
  const result = filterMessages([
    userMsg(RESET_PROMPT_V_2026_4_27_LIMITED),
    assistantMsg('Acknowledging bootstrap limitation.'),
    userMsg('hi'),
    assistantMsg('Hello'),
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].content, 'hi');
});

// ---------------------------------------------------------------------------
// THE bug we just fixed: prelude-prepended body must still be excluded
// ---------------------------------------------------------------------------

test('filterMessagesForICC: 2026.4.27 prelude + reset prompt + user-note body is excluded (regression: startsWith bug)', () => {
  const composedBody = composeWithPrelude(RESET_PROMPT_V_2026_4_27_BASE, 'hi');
  const result = filterMessages([
    userMsg(composedBody),
    assistantMsg('Hello! How can I help?'),
    userMsg('what is 2+2?'),
    assistantMsg('4'),
  ]);
  // Without the fix, the composed body would NOT be excluded (it starts with
  // "[Startup context loaded by runtime]") — startIndex stays at 0 and all
  // four messages flow through. With the shared isSessionStartupMessage check,
  // the regex finds the canonical phrase mid-body and the startup turn is
  // skipped along with its assistant reply.
  assert.equal(result.length, 2);
  assert.equal(result[0].content, 'what is 2+2?');
});

test('filterMessagesForICC: 2026.4.27 prelude + BOOTSTRAP_PENDING body is excluded', () => {
  const composedBody = composeWithPrelude(RESET_PROMPT_V_2026_4_27_PENDING, 'hi');
  const result = filterMessages([
    userMsg(composedBody),
    assistantMsg('Reading BOOTSTRAP.md...'),
    userMsg('continue'),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].content, 'continue');
});

// ---------------------------------------------------------------------------
// Negative cases: organic conversations must NOT be over-trimmed
// ---------------------------------------------------------------------------

test('filterMessagesForICC: organic conversation with no startup message is unchanged', () => {
  const messages = [
    userMsg('what is the capital of France?'),
    assistantMsg('Paris.'),
    userMsg('and Germany?'),
    assistantMsg('Berlin.'),
  ];
  const result = filterMessages(messages);
  assert.equal(result.length, 4);
  assert.equal(result[0].content, 'what is the capital of France?');
});

test('filterMessagesForICC: user message that mentions sessions but is not the startup prompt is kept', () => {
  const messages = [
    userMsg('Hey, can you start a new session in the database when the user logs in?'),
    assistantMsg('Sure, here is the code...'),
  ];
  const result = filterMessages(messages);
  assert.equal(result.length, 2);
  assert.equal(
    result[0].content,
    'Hey, can you start a new session in the database when the user logs in?',
  );
});

test('filterMessagesForICC: empty message array returns empty', () => {
  const result = filterMessages([]);
  assert.equal(result.length, 0);
});

// ---------------------------------------------------------------------------
// Skip-window correctness: assistant turns between the startup user message
// and the next user message must be skipped together with the startup turn
// (they are the agent's reply to the synthetic startup prompt and would
// pollute ICC input if kept).
// ---------------------------------------------------------------------------

test('filterMessagesForICC: skips assistant replies that belong to the startup turn', () => {
  const result = filterMessages([
    userMsg(RESET_PROMPT_V_2026_4_27_BASE),
    assistantMsg('Hello! How can I help?'),
    assistantMsg('I am ready.'), // multi-part assistant reply to the startup
    userMsg('first real question'),
    assistantMsg('first real answer'),
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].content, 'first real question');
  assert.equal(result[1].content, 'first real answer');
});

test('filterMessagesForICC: handles content as text-block array (not just string)', () => {
  // openclaw also delivers messages with content: [{ type: 'text', text: '...' }]
  const result = filterMessages([
    {
      role: 'user',
      content: [{ type: 'text', text: composeWithPrelude(RESET_PROMPT_V_2026_4_27_BASE, 'hi') }],
    },
    assistantMsg('Hello!'),
    { role: 'user', content: [{ type: 'text', text: 'real question' }] },
  ]);
  assert.equal(result.length, 1);
  // The text-block array form should also be passed through extractTextFromMessage
  // and recognized by isSessionStartupMessage.
  const surviving = result[0];
  const survivingText = Array.isArray(surviving.content)
    ? surviving.content[0].text
    : surviving.content;
  assert.equal(survivingText, 'real question');
});
