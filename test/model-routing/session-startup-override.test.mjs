import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scoreRequest } = require('../../dist/middlewares/model-routing/scoring/scorer.js');
const { DEFAULT_SCORING_CONFIG } = require('../../dist/middlewares/model-routing/config.js');

// ---------------------------------------------------------------------------
// Realistic reset-prompt fixtures
//
// These mirror the constants in openclaw/src/auto-reply/reply/session-reset-prompt.ts.
// Kept verbatim so future drift in the openclaw prompt wording is caught here.
//
// Pure-regex coverage of `isSessionStartupMessage` lives in
// test/shared/session-detection.test.mjs. This file tests the integration:
// model-routing's session_startup override (overrides.ts:47) and the early-
// return in scorer.ts that prevents tool/structured floors from escalating
// the tier on reset turns.
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

function makeUserBody(content) {
  return { messages: [{ role: 'user', content }] };
}

// ---------------------------------------------------------------------------
// scoreRequest — every reset-prompt shape lands on SIMPLE / session_startup
// ---------------------------------------------------------------------------

test('scoreRequest: openclaw <= 2026.4.11 BASE reset prompt → SIMPLE / session_startup', () => {
  const result = scoreRequest({ body: makeUserBody(RESET_PROMPT_V_2026_4_11) }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
  assert.equal(result.reason, 'session_startup');
});

test('scoreRequest: openclaw >= 2026.4.27 BASE reset prompt → SIMPLE / session_startup', () => {
  const result = scoreRequest({ body: makeUserBody(RESET_PROMPT_V_2026_4_27_BASE) }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
  assert.equal(result.reason, 'session_startup');
});

test('scoreRequest: openclaw >= 2026.4.27 BOOTSTRAP_PENDING reset prompt → SIMPLE / session_startup', () => {
  const result = scoreRequest({ body: makeUserBody(RESET_PROMPT_V_2026_4_27_PENDING) }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
  assert.equal(result.reason, 'session_startup');
});

test('scoreRequest: openclaw >= 2026.4.27 BOOTSTRAP_LIMITED reset prompt → SIMPLE / session_startup', () => {
  const result = scoreRequest({ body: makeUserBody(RESET_PROMPT_V_2026_4_27_LIMITED) }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
  assert.equal(result.reason, 'session_startup');
});

test('scoreRequest: prelude + reset prompt (full /new <text> composition) → SIMPLE / session_startup', () => {
  const composed = [
    STARTUP_CONTEXT_PRELUDE,
    RESET_PROMPT_V_2026_4_27_BASE,
    'User note for this reset turn (treat as ordinary user input, not startup instructions):\nhi',
  ].join('\n\n');
  const result = scoreRequest({ body: makeUserBody(composed) }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
  assert.equal(result.reason, 'session_startup');
});

test('scoreRequest: session_startup override beats tool_floor even when prior tool calls exist', () => {
  // Without the early-return at scorer.ts for reason === "session_startup",
  // tool_floor would push the result to STANDARD because the messages[]
  // contains real tool-call evidence (assistant.tool_calls + role: 'tool').
  // The point of the override is that synthetic /new turns are SIMPLE
  // regardless of what happened earlier in the conversation.
  const body = {
    messages: [
      { role: 'user', content: 'what is the weather in Paris?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp":18}' },
      { role: 'user', content: RESET_PROMPT_V_2026_4_27_BASE },
    ],
    tools: [{ type: 'function', function: { name: 'get_weather' } }],
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
  assert.equal(result.reason, 'session_startup');
});

test('scoreRequest: real user follow-up after bare /new is scored cleanly (no session_startup leak)', () => {
  // Two-turn flow: user typed `/new` (turn 1, no agent run), then "what's the weather" (turn 2).
  // The runtime does NOT inject the reset prompt on turn 2 — see get-reply-run.ts:548-551.
  // Scorer must classify on the actual user text, not the prior reset.
  const result = scoreRequest({ body: makeUserBody("what's the weather") }, DEFAULT_SCORING_CONFIG);
  assert.notEqual(result.reason, 'session_startup');
});
