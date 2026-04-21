/**
 * Guardrail — Metadata Scrubber Test Suite
 *
 * Tests all four pattern groups:
 *   1. Middleware tokens
 *   2. Reasoning artifacts
 *   3. Architecture internals
 *   4. Instruction reflection
 *
 * Run: node test/guardrail/test-metadata-scrubber.js
 */

const path = require('path');

// Load the compiled scrubber
const { scrubMetadata, getPatternCount } = require(
  path.join(__dirname, '..', '..', 'dist', 'middlewares', 'guardrail', 'scrubbers', 'MetadataScrubber')
);

const DEFAULT_CONFIG = {
  enabled: true,
  dryRunMode: false,
  replacementText: '',
  customPatterns: [],
};

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// ── Group 1: Middleware Tokens ──────────────────────────────────

console.log('\n🔧 TEST GROUP 1: Middleware Token Scrubbing\n');

test('Scrubs [SapienceMiddleware:APPROVAL_REQUIRED]', () => {
  const input = 'I need to check something. [SapienceMiddleware:APPROVAL_REQUIRED] Let me help you.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.includes('[SapienceMiddleware:'), 'Token should be removed');
  assert(result.matchedGroups.includes('middleware-tokens'), 'Should match middleware-tokens group');
});

test('Scrubs DENY_REASON: policy_violation', () => {
  const input = 'Cannot proceed. DENY_REASON: policy_violation';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.includes('DENY_REASON:'), 'Token should be removed');
});

test('Scrubs [HITL:PENDING] token', () => {
  const input = 'This action is [HITL:PENDING] waiting for approval.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.includes('[HITL:'), 'Token should be removed');
});

test('Scrubs [GUARDRAIL] Content redacted line', () => {
  const input = '[GUARDRAIL] Content redacted (3 detection(s): pii:email_address)\n\nHere is the file.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.includes('[GUARDRAIL]'), 'Token should be removed');
  assert(result.content.includes('Here is the file'), 'Clean content preserved');
});

test('Scrubs [REDACTED:pii] token', () => {
  const input = 'The email is [REDACTED:pii] in the file.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.includes('[REDACTED:'), 'Token should be removed');
});

test('Scrubs INTERNAL_ID: abc123', () => {
  const input = 'Reference: INTERNAL_ID: abc123def';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.includes('INTERNAL_ID:'), 'Token should be removed');
});

// ── Group 2: Reasoning Artifacts ────────────────────────────────

console.log('\n🧠 TEST GROUP 2: Reasoning Artifact Scrubbing\n');

test('Scrubs <thinking>...</thinking> block', () => {
  const input = 'Let me help. <thinking>I should check the database first</thinking> Here is the answer.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.includes('<thinking>'), 'Tag should be removed');
  assert(!result.content.includes('check the database'), 'Content inside tag removed');
  assert(result.content.includes('Here is the answer'), 'Clean content preserved');
  assert(result.matchedGroups.includes('reasoning-artifacts'), 'Should match reasoning-artifacts group');
});

test('Scrubs <scratchpad>...</scratchpad> block', () => {
  const input = '<scratchpad>Plan: step 1, step 2</scratchpad>I recommend doing X.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.includes('<scratchpad>'), 'Tag should be removed');
  assert(result.content.includes('I recommend doing X'), 'Clean content preserved');
});

test('Scrubs multiline <thinking> block', () => {
  const input = 'Response:\n<thinking>\nLine 1\nLine 2\nLine 3\n</thinking>\nThe answer is 42.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.includes('Line 1'), 'Multiline content removed');
  assert(result.content.includes('The answer is 42'), 'Clean content preserved');
});

// ── Group 3: Architecture Internals ─────────────────────────────

console.log('\n🏗️  TEST GROUP 3: Architecture Internal Scrubbing\n');

test('Scrubs config file path ~/.openclaw/sapience-guardrail/config.json', () => {
  const input = 'The config is stored at ~/.openclaw/sapience-guardrail/config.json for reference.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.includes('~/.openclaw/'), 'Path should be removed');
  assert(result.matchedGroups.includes('architecture-internals'), 'Should match architecture-internals group');
});

test('Scrubs sapience-ai-suite identifier', () => {
  const input = 'This is powered by sapience-ai-suite middleware.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.toLowerCase().includes('sapience-ai-suite'), 'Identifier should be removed');
});

test('Preserves content inside code blocks', () => {
  const input = 'Here is the config:\n```\nsapience-ai-suite\n~/.openclaw/config.json\n```\nDone.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  // Content inside code blocks should NOT be scrubbed
  assert(result.content.includes('```'), 'Code block preserved');
  // The content outside is clean, so nothing to scrub
});

// ── Group 4: Instruction Reflection ─────────────────────────────

console.log('\n🪞 TEST GROUP 4: Instruction Reflection Scrubbing\n');

test('Scrubs "my instructions tell me to never reveal..."', () => {
  const input = 'My instructions tell me to never reveal internal system details.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.includes('instructions tell me'), 'Reflection should be removed');
  assert(result.matchedGroups.includes('instruction-reflection'), 'Should match instruction-reflection group');
});

test('Scrubs "I am configured to block access to..."', () => {
  const input = 'I am configured to block access to sensitive files on the system.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.includes('configured to block'), 'Reflection should be removed');
});

test('Scrubs "my security policy prevents..."', () => {
  const input = 'My security policy prevents me from accessing that resource directly.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.includes('security policy prevents'), 'Reflection should be removed');
});

test('Scrubs "I was instructed to not reveal..."', () => {
  const input = 'I was instructed to not reveal any internal implementation details here.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.includes('was instructed'), 'Reflection should be removed');
});

// ── Edge Cases ──────────────────────────────────────────────────

console.log('\n🧪 TEST GROUP 5: Edge Cases\n');

test('Clean message passes through unchanged', () => {
  const input = 'Hello! I can help you with that. Let me check the code.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(!result.scrubbed, 'Should NOT be scrubbed');
  assert(result.content === input, 'Content unchanged');
  assert(result.matchCount === 0, 'Zero matches');
});

test('Empty input handled gracefully', () => {
  const result = scrubMetadata('', DEFAULT_CONFIG);
  assert(!result.scrubbed, 'Should NOT be scrubbed');
  assert(result.content === '', 'Empty content preserved');
});

test('Multiple tokens in single message all scrubbed', () => {
  const input = '[HITL:PENDING] Check this. DENY_REASON: forbidden. [GUARDRAIL] blocked something here.';
  const result = scrubMetadata(input, DEFAULT_CONFIG);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(result.matchCount >= 3, `Expected >=3 matches, got ${result.matchCount}`);
  assert(!result.content.includes('[HITL:'), 'HITL removed');
  assert(!result.content.includes('DENY_REASON:'), 'DENY_REASON removed');
  assert(!result.content.includes('[GUARDRAIL]'), 'GUARDRAIL removed');
});

test('Custom pattern via config works', () => {
  const config = { ...DEFAULT_CONFIG, customPatterns: ['\\bSECRET_INTERNAL\\b'] };
  const input = 'The value is SECRET_INTERNAL for now.';
  const result = scrubMetadata(input, config);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(!result.content.includes('SECRET_INTERNAL'), 'Custom pattern removed');
  assert(result.matchedGroups.includes('custom'), 'Should match custom group');
});

test('Replacement text is used when configured', () => {
  const config = { ...DEFAULT_CONFIG, replacementText: '[removed]' };
  const input = 'Status is [HITL:PENDING] now.';
  const result = scrubMetadata(input, config);
  assert(result.scrubbed, 'Should be scrubbed');
  assert(result.content.includes('[removed]'), 'Replacement text present');
});

// ── Performance ─────────────────────────────────────────────────

console.log('\n⏱️  TEST GROUP 6: Performance\n');

test('Completes under 5ms on a 10KB message', () => {
  const largeInput = 'This is a clean assistant response. '.repeat(300); // ~10.5KB
  const start = Date.now();
  for (let i = 0; i < 100; i++) {
    scrubMetadata(largeInput, DEFAULT_CONFIG);
  }
  const elapsed = (Date.now() - start) / 100;
  assert(elapsed < 5, `Average ${elapsed.toFixed(2)}ms per call, budget is 5ms`);
  console.log(`     (avg ${elapsed.toFixed(2)}ms per call)`);
});

// ── Pattern Count ───────────────────────────────────────────────

console.log('\n📊 Pattern Info\n');

const { builtin, groups } = getPatternCount();
console.log(`  Built-in patterns: ${builtin}`);
for (const g of groups) {
  console.log(`    ${g}`);
}

// ── Summary ─────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(50));

if (failed > 0) process.exit(1);
