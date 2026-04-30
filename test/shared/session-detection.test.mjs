import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isSessionStartupMessage,
  SESSION_STARTUP_REGEX,
} = require('../../dist/shared/session-detection.js');

// ---------------------------------------------------------------------------
// Realistic prompt fixtures
//
// These mirror the constants in openclaw/src/auto-reply/reply/session-reset-prompt.ts.
// Kept verbatim so future drift in the openclaw prompt wording is caught here.
//
// Consumer-side integration tests live with their consumers:
//   - test/model-routing/session-startup-override.test.mjs
//   - test/context-editing/session-startup-filter.test.mjs
// ---------------------------------------------------------------------------

// openclaw <= 2026.4.11
const RESET_PROMPT_V_2026_4_11 =
  'A new session was started via /new or /reset. Run your Session Startup sequence and read SOUL.md, USER.md, and MEMORY.md before responding.';

// openclaw >= 2026.4.27 — BASE
const RESET_PROMPT_V_2026_4_27_BASE =
  'A new session was started via /new or /reset. Execute your Session Startup sequence now - read the required files before responding to the user. If BOOTSTRAP.md exists in the provided Project Context, read it and follow its instructions first. Then greet the user in your configured persona, if one is provided.';

// openclaw >= 2026.4.27 — BOOTSTRAP_PENDING
const RESET_PROMPT_V_2026_4_27_PENDING =
  'A new session was started via /new or /reset while bootstrap is still pending for this workspace. Please read BOOTSTRAP.md from the workspace now and follow it before replying normally.';

// openclaw >= 2026.4.27 — BOOTSTRAP_LIMITED
const RESET_PROMPT_V_2026_4_27_LIMITED =
  'A new session was started via /new or /reset while bootstrap is still pending for this workspace, but this run cannot safely complete the full BOOTSTRAP.md workflow here.';

// Daily-memory prelude that openclaw >= 2026.4.27 prepends inside the same user-role body.
const STARTUP_CONTEXT_PRELUDE =
  '[Startup context loaded by runtime]\n' +
  'Bootstrap files like SOUL.md, USER.md, and MEMORY.md are already provided separately when eligible.\n' +
  'Recent daily memory was selected and loaded by runtime for this new session.\n' +
  '\n' +
  '[Untrusted daily memory: memory/2026-04-30.md]\n' +
  'BEGIN_QUOTED_NOTES\n' +
  '```text\n' +
  'Some daily notes...\n' +
  '```\n' +
  'END_QUOTED_NOTES';

// ---------------------------------------------------------------------------
// isSessionStartupMessage — direct regex coverage
// ---------------------------------------------------------------------------

test('isSessionStartupMessage: matches openclaw <= 2026.4.11 BASE ("Run your Session Startup sequence")', () => {
  assert.equal(isSessionStartupMessage(RESET_PROMPT_V_2026_4_11), true);
});

test('isSessionStartupMessage: matches openclaw >= 2026.4.27 BASE ("Execute your Session Startup sequence now")', () => {
  assert.equal(isSessionStartupMessage(RESET_PROMPT_V_2026_4_27_BASE), true);
});

test('isSessionStartupMessage: matches openclaw >= 2026.4.27 BOOTSTRAP_PENDING ("while bootstrap is still pending")', () => {
  assert.equal(isSessionStartupMessage(RESET_PROMPT_V_2026_4_27_PENDING), true);
});

test('isSessionStartupMessage: matches openclaw >= 2026.4.27 BOOTSTRAP_LIMITED', () => {
  assert.equal(isSessionStartupMessage(RESET_PROMPT_V_2026_4_27_LIMITED), true);
});

test('isSessionStartupMessage: matches when daily-memory prelude is prepended (regex must not be ^-anchored)', () => {
  const composed = `${STARTUP_CONTEXT_PRELUDE}\n\n${RESET_PROMPT_V_2026_4_27_BASE}`;
  assert.equal(isSessionStartupMessage(composed), true);
});

test('isSessionStartupMessage: matches when prelude + reset prompt + soft-reset user-note tail are all concatenated', () => {
  // Mirrors get-reply-run.ts:600-610 composition for /new <text>
  const composed = [
    STARTUP_CONTEXT_PRELUDE,
    RESET_PROMPT_V_2026_4_27_BASE,
    'User note for this reset turn (treat as ordinary user input, not startup instructions):\nhi',
  ].join('\n\n');
  assert.equal(isSessionStartupMessage(composed), true);
});

test('isSessionStartupMessage: matches when current-time line is appended (appendCronStyleCurrentTimeLine)', () => {
  const composed = `${RESET_PROMPT_V_2026_4_27_BASE}\nCurrent time: 2026-04-30T20:34:00Z`;
  assert.equal(isSessionStartupMessage(composed), true);
});

test('isSessionStartupMessage: rejects empty string', () => {
  assert.equal(isSessionStartupMessage(''), false);
});

test('isSessionStartupMessage: rejects whitespace-only string', () => {
  assert.equal(isSessionStartupMessage('   \n\t  '), false);
});

test('isSessionStartupMessage: rejects organic user message that mentions sessions', () => {
  assert.equal(
    isSessionStartupMessage('Hey, can you start a new session in the database when the user logs in?'),
    false,
  );
});

test('isSessionStartupMessage: rejects message that mentions /new or /reset commands without the full phrase', () => {
  assert.equal(isSessionStartupMessage('/new or /reset are commands you can type'), false);
});

test('isSessionStartupMessage: rejects the canonical phrase if it has no known continuation', () => {
  // Defensive: bare prefix without "Run/Execute" or "while bootstrap..." must NOT match —
  // we want the regex to break loudly if openclaw introduces a fourth shape rather than
  // silently classify unknown-shape user text as session_startup.
  assert.equal(
    isSessionStartupMessage('A new session was started via /new or /reset.'),
    false,
  );
});

test('SESSION_STARTUP_REGEX: is exported and is a RegExp', () => {
  assert.ok(SESSION_STARTUP_REGEX instanceof RegExp);
});
