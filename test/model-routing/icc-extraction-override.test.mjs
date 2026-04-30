import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scoreRequest } = require('../../dist/middlewares/model-routing/scoring/scorer.js');
const { DEFAULT_SCORING_CONFIG } = require('../../dist/middlewares/model-routing/config.js');
const { ICC_EXTRACTION_MARKER } = require('../../dist/shared/icc-detection.js');

// ---------------------------------------------------------------------------
// Realistic CE compaction-prompt fixture
//
// CE composes its extraction prompt as `${ICC_EXTRACTION_MARKER}\n\n${instructions}\n\n
// Return ONLY valid JSON matching this schema...\n${schema}\n\nTRANSCRIPT:\n${transcript}`.
// We embed transcript content that would normally trip COMPLEX or REASONING
// (formal-logic keywords, code, technical density) to prove the override
// short-circuits BEFORE keyword scoring runs.
// ---------------------------------------------------------------------------

const HEAVY_TRANSCRIPT = `
User: Implement an algorithm to prove that sqrt(2) is irrational. Use formal proof.
Assistant: Here is a function that demonstrates the proof by contradiction...
function sqrt2_proof() { /* ... derive theorem axiom ... */ }
User: Now refactor this kubernetes deployment to use a sidecar pattern with mTLS.
Assistant: I will derive the proper schema and write the YAML manifest.
`.trim();

const FAKE_ICC_PROMPT = `${ICC_EXTRACTION_MARKER}

You are an Intelligent Context Curator. Extract entities, conflicts, and priorities.

Return ONLY valid JSON matching this schema (no markdown fences, no commentary):
{ "entities": [], "conflicts": [], "priorities": [] }

TRANSCRIPT:
${HEAVY_TRANSCRIPT}`;

function makeUserBody(content) {
  return { messages: [{ role: 'user', content }] };
}

// ---------------------------------------------------------------------------
// scoreRequest — the icc_extraction override fires before scoring runs
// ---------------------------------------------------------------------------

test('scoreRequest: ICC extraction prompt → SIMPLE / icc_extraction', () => {
  const result = scoreRequest({ body: makeUserBody(FAKE_ICC_PROMPT) }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
  assert.equal(result.reason, 'icc_extraction');
});

test('scoreRequest: ICC override beats reasoning_override (formal-logic keywords in transcript)', () => {
  // Without the override, "prove", "theorem", "axiom" etc. in the transcript
  // would land REASONING via formalLogicCount >= reasoningKeywordMin.
  // The icc_extraction override short-circuits before that branch runs.
  const result = scoreRequest({ body: makeUserBody(FAKE_ICC_PROMPT) }, DEFAULT_SCORING_CONFIG);
  assert.notEqual(result.reason, 'reasoning_override');
  assert.equal(result.reason, 'icc_extraction');
});

test('scoreRequest: ICC override beats tool_floor (tools present must NOT escalate to STANDARD)', () => {
  // disableTools: true is set in CE's runEmbeddedPiAgent call, but if a future
  // openclaw build forwards tool definitions anyway, the floor must not run.
  const body = {
    messages: [{ role: 'user', content: FAKE_ICC_PROMPT }],
    tools: [{ type: 'function', function: { name: 'get_weather' } }],
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
  assert.equal(result.reason, 'icc_extraction');
});

test('scoreRequest: ICC override beats structured_output floor (response_format set)', () => {
  // The ICC prompt itself contains the literal "schema" keyword multiple times
  // and the call may carry response_format too. Both must be ignored.
  const body = {
    messages: [{ role: 'user', content: FAKE_ICC_PROMPT }],
    response_format: { type: 'json_object' },
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
  assert.equal(result.reason, 'icc_extraction');
});

test('scoreRequest: ICC override beats large_context floor (transcript >> threshold)', () => {
  // Pad the transcript past largeContextTokens (default high tens of thousands).
  // The icc_extraction override fires BEFORE the large-context check.
  const huge = HEAVY_TRANSCRIPT + ' ' + 'word '.repeat(50_000);
  const body = makeUserBody(`${ICC_EXTRACTION_MARKER}\n\nTRANSCRIPT:\n${huge}`);
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
  assert.equal(result.reason, 'icc_extraction');
});

test('scoreRequest: organic chat that mentions ICC / extraction does NOT trip the override', () => {
  // Negative: only the literal marker fires the override. A user asking about
  // ICC, extraction, schemas, etc. is scored normally.
  const result = scoreRequest(
    {
      body: makeUserBody(
        'Can you help me understand how the ICC extraction pipeline works in CE? I want to write my own.',
      ),
    },
    DEFAULT_SCORING_CONFIG,
  );
  assert.notEqual(result.reason, 'icc_extraction');
});

test('scoreRequest: marker must be exact — case-mismatch does NOT trip the override', () => {
  const body = makeUserBody(`[sai:icc_extraction]\n\nfake call`);
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.notEqual(result.reason, 'icc_extraction');
});
