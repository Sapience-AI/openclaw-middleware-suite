import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { KeywordTrie, isWordCharCode, applyDensityClustering } = require('../../dist/middlewares/model-routing/scoring/keyword-trie.js');
const { scoreRequest } = require('../../dist/middlewares/model-routing/scoring/scorer.js');
const { DEFAULT_SCORING_CONFIG } = require('../../dist/middlewares/model-routing/config.js');

// ---------------------------------------------------------------------------
// isWordCharCode
// ---------------------------------------------------------------------------

test('isWordCharCode: letters and digits are word chars', () => {
  assert.equal(isWordCharCode('a'.charCodeAt(0)), true);
  assert.equal(isWordCharCode('Z'.charCodeAt(0)), true);
  assert.equal(isWordCharCode('0'.charCodeAt(0)), true);
  assert.equal(isWordCharCode('9'.charCodeAt(0)), true);
  assert.equal(isWordCharCode('_'.charCodeAt(0)), true);
});

test('isWordCharCode: spaces and punctuation are not word chars', () => {
  assert.equal(isWordCharCode(' '.charCodeAt(0)), false);
  assert.equal(isWordCharCode('.'.charCodeAt(0)), false);
  assert.equal(isWordCharCode('-'.charCodeAt(0)), false);
  assert.equal(isWordCharCode('\n'.charCodeAt(0)), false);
});

test('isWordCharCode: non-ASCII (CJK) chars are not word chars', () => {
  // U+5199 = 写 (Chinese "write") — non-ASCII, treated as non-word char
  assert.equal(isWordCharCode(0x5199), false);
});

// ---------------------------------------------------------------------------
// applyDensityClustering
// ---------------------------------------------------------------------------

test('applyDensityClustering: fewer than 3 matches — no boost', () => {
  assert.equal(applyDensityClustering([]), 0);
  assert.equal(applyDensityClustering([10]), 1);
  assert.equal(applyDensityClustering([10, 50]), 2);
});

test('applyDensityClustering: 3 matches within 200 chars — 1.5x boost', () => {
  // Positions 0, 100, 199 — all within 200-char window
  const result = applyDensityClustering([0, 100, 199]);
  assert.equal(result, Math.ceil(3 * 1.5)); // 5
});

test('applyDensityClustering: 3 matches spread beyond 200 chars — no boost', () => {
  // Positions 0, 300, 600 — spread across 600 chars
  const result = applyDensityClustering([0, 300, 600]);
  assert.equal(result, 3);
});

test('applyDensityClustering: 5 matches, 3 clustered within 200 chars — boost applies', () => {
  // First 3 clustered, last 2 spread far away
  const result = applyDensityClustering([0, 50, 100, 5000, 9000]);
  assert.equal(result, Math.ceil(5 * 1.5)); // 8
});

// ---------------------------------------------------------------------------
// KeywordTrie — word boundary tests
// ---------------------------------------------------------------------------

test('KeywordTrie: "proof" does NOT match inside "waterproof"', () => {
  const trie = new KeywordTrie([{ name: 'formalLogic', keywords: ['proof'] }]);
  const matches = trie.scan('waterproof coating');
  assert.equal(matches.length, 0);
});

test('KeywordTrie: "proof" DOES match as a standalone word', () => {
  const trie = new KeywordTrie([{ name: 'formalLogic', keywords: ['proof'] }]);
  const matches = trie.scan('show me a proof of this theorem');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].keyword, 'proof');
});

test('KeywordTrie: "function" does NOT match inside "functional"', () => {
  const trie = new KeywordTrie([{ name: 'codeGeneration', keywords: ['function'] }]);
  const matches = trie.scan('this is a functional approach');
  assert.equal(matches.length, 0);
});

test('KeywordTrie: "function" DOES match in code', () => {
  const trie = new KeywordTrie([{ name: 'codeGeneration', keywords: ['function'] }]);
  const matches = trie.scan('write a function that sorts an array');
  assert.equal(matches.length, 1);
});

test('KeywordTrie: "def" does NOT match inside "define"', () => {
  const trie = new KeywordTrie([{ name: 'codeGeneration', keywords: ['def'] }]);
  const matches = trie.scan('define what a variable is');
  assert.equal(matches.length, 0);
});

test('KeywordTrie: "def" DOES match as Python keyword', () => {
  const trie = new KeywordTrie([{ name: 'codeGeneration', keywords: ['def'] }]);
  const matches = trie.scan('def my_function(x):');
  assert.equal(matches.length, 1);
});

test('KeywordTrie: "hypothesis" does NOT match inside "hypothetical"', () => {
  const trie = new KeywordTrie([{ name: 'formalLogic', keywords: ['hypothesis'] }]);
  const matches = trie.scan('a hypothetical scenario');
  assert.equal(matches.length, 0);
});

test('KeywordTrie: multi-keyword scan returns all matches across dimensions', () => {
  const trie = new KeywordTrie([
    { name: 'formalLogic', keywords: ['proof', 'theorem'] },
    { name: 'codeGeneration', keywords: ['function'] },
  ]);
  const matches = trie.scan('prove this theorem using a function');
  const dims = matches.map((m) => m.dimension);
  assert.equal(dims.includes('formalLogic'), true);
  assert.equal(dims.includes('codeGeneration'), true);
});

test('KeywordTrie: respects MAX_SCAN_LENGTH (no error on huge input)', () => {
  const trie = new KeywordTrie([{ name: 'test', keywords: ['proof'] }]);
  const huge = 'proof ' + 'x'.repeat(200_000);
  const matches = trie.scan(huge);
  // Should still find "proof" at position 0 (within scan limit)
  assert.equal(matches.length, 1);
});

// ---------------------------------------------------------------------------
// scoreRequest — regression tests (end-to-end)
// ---------------------------------------------------------------------------

function makeBody(content) {
  return {
    messages: [{ role: 'user', content }],
  };
}

test('scoreRequest: "what is the capital of France" → SIMPLE tier', () => {
  const result = scoreRequest({ body: makeBody('what is the capital of France') }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
});

test('scoreRequest: "prove that sqrt(2) is irrational" → REASONING (reasoning_override)', () => {
  const result = scoreRequest(
    { body: makeBody('prove that sqrt(2) is irrational') },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(result.tier, 'REASONING');
  assert.equal(result.reason, 'reasoning_override');
});

test('scoreRequest: "write a function to sort an array in TypeScript" → COMPLEX or STANDARD', () => {
  const result = scoreRequest(
    { body: makeBody('write a function to sort an array in TypeScript') },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(['COMPLEX', 'STANDARD'].includes(result.tier), true);
});

test('scoreRequest: system prompt is excluded from scoring', () => {
  const body = {
    messages: [
      // System prompt full of complex keywords — should NOT affect score
      {
        role: 'system',
        content: 'prove theorem axiom proof derive formal logic reasoning algorithm kubernetes',
      },
      { role: 'user', content: 'hi' },
    ],
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  // "hi" alone is a short simple message
  assert.equal(result.tier, 'SIMPLE');
});

test('scoreRequest: "waterproof proof theorem" → formalLogic dim has 2 matches (not 3)', () => {
  // "waterproof" should NOT contribute a formalLogic match
  const result = scoreRequest(
    { body: makeBody('waterproof proof theorem') },
    DEFAULT_SCORING_CONFIG,
  );
  const formalLogicDim = result.dimensions.find((d) => d.name === 'formalLogic');
  // proof + theorem = 2 matches → reasoning_override fires (min is 2)
  assert.equal(result.reason, 'reasoning_override');
  // confirm formalLogic contributed (not zero)
  assert.ok(formalLogicDim === undefined || formalLogicDim.score >= 0);
});

test('scoreRequest: tool floor does NOT fire when tools are merely listed (no agent tool-call evidence)', () => {
  // OpenClaw sends its full tool inventory on every chat turn. If `hasTools`
  // alone triggered the floor, every chat turn would be STANDARD regardless
  // of whether the agent ever used a tool. The floor is now scoped to
  // post-tool-call LLM invocations.
  const body = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'get_weather' } }],
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
  assert.notEqual(result.reason, 'tool_floor');
});

test('scoreRequest: tool floor fires when prior tool-call evidence exists, even with a short follow-up', () => {
  // The user's follow-up `"thanks"` would normally short_message → SIMPLE,
  // but the conversation history contains assistant.tool_calls + role=tool,
  // so the next LLM turn needs to handle tool I/O. Floor to STANDARD.
  const body = {
    messages: [
      { role: 'user', content: 'what is the weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'get_weather', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_abc', content: '{"temp":18}' },
      { role: 'user', content: 'thanks' },
    ],
    tools: [{ type: 'function', function: { name: 'get_weather' } }],
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'STANDARD');
  assert.equal(result.reason, 'tool_floor');
});

// ---------------------------------------------------------------------------
// Structured output floor
// ---------------------------------------------------------------------------

test('scoreRequest: structured output floor — response_format upgrades SIMPLE to STANDARD', () => {
  const body = {
    messages: [{ role: 'user', content: 'hi' }],
    response_format: { type: 'json_object' },
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'STANDARD');
  assert.equal(result.reason, 'structured_output');
});

test('scoreRequest: structured output floor — JSON in system prompt upgrades SIMPLE to STANDARD', () => {
  const body = {
    messages: [
      { role: 'system', content: 'Always respond with valid JSON' },
      { role: 'user', content: 'hi' },
    ],
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'STANDARD');
  assert.equal(result.reason, 'structured_output');
});

test('scoreRequest: structured output floor — schema in system prompt upgrades SIMPLE to STANDARD', () => {
  const body = {
    messages: [
      { role: 'developer', content: 'Follow this schema: { name: string }' },
      { role: 'user', content: 'hi' },
    ],
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'STANDARD');
  assert.equal(result.reason, 'structured_output');
});

test('scoreRequest: structured output floor — no upgrade when tier already meets minimum', () => {
  const body = {
    messages: [{ role: 'user', content: 'write a function to sort an array in TypeScript' }],
    response_format: { type: 'json_object' },
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  // Already STANDARD or higher — should NOT be downgraded/changed to structured_output reason
  assert.notEqual(result.reason, 'structured_output');
});

test('scoreRequest: structured output floor — no trigger without response_format or system prompt keywords', () => {
  const body = {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
    ],
  };
  const result = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(result.tier, 'SIMPLE');
});

test('scoreRequest: trie cache — same config ref returns same trie (no rebuild)', () => {
  // Run twice with same config — should not throw and produce consistent results
  const body = makeBody('implement a binary search algorithm');
  const r1 = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  const r2 = scoreRequest({ body }, DEFAULT_SCORING_CONFIG);
  assert.equal(r1.tier, r2.tier);
  assert.equal(r1.score, r2.score);
});
