import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ICC_EXTRACTION_MARKER,
  isIccExtractionCall,
  stripIccMarker,
} = require('../../dist/shared/icc-detection.js');

// ---------------------------------------------------------------------------
// ICC_EXTRACTION_MARKER + isIccExtractionCall — direct coverage
//
// Consumer-side integration tests live with their consumers:
//   - test/model-routing/icc-extraction-override.test.mjs
// ---------------------------------------------------------------------------

test('ICC_EXTRACTION_MARKER: is exported and is the documented sentinel', () => {
  assert.equal(ICC_EXTRACTION_MARKER, '[SAI:ICC_EXTRACTION]');
});

test('isIccExtractionCall: matches the marker at the start of the body', () => {
  assert.equal(
    isIccExtractionCall('[SAI:ICC_EXTRACTION]\n\nExtract the following entities...'),
    true,
  );
});

test('isIccExtractionCall: matches the marker even if something is prepended', () => {
  // Defense-in-depth: future runtimes may wrap the body. Detection uses
  // `includes`, not `startsWith`, so the marker still trips the override.
  assert.equal(
    isIccExtractionCall('Some envelope wrapping\n[SAI:ICC_EXTRACTION]\nExtract...'),
    true,
  );
});

test('isIccExtractionCall: rejects organic user content that does not contain the marker', () => {
  assert.equal(isIccExtractionCall('Please summarize this conversation about ICC.'), false);
  assert.equal(isIccExtractionCall('Write me a function that extracts entities.'), false);
});

test('isIccExtractionCall: rejects an empty string', () => {
  assert.equal(isIccExtractionCall(''), false);
});

test('isIccExtractionCall: rejects a near-miss marker (case / punctuation differences)', () => {
  // The marker is intentionally exact so a typo can't accidentally match a
  // user's documentation about ICC.
  assert.equal(isIccExtractionCall('[sai:icc_extraction]'), false);
  assert.equal(isIccExtractionCall('SAI:ICC_EXTRACTION'), false);
  assert.equal(isIccExtractionCall('[SAI: ICC_EXTRACTION]'), false);
});

// ---------------------------------------------------------------------------
// stripIccMarker — used by MR before forwarding the body upstream
// ---------------------------------------------------------------------------

test('stripIccMarker: removes the marker and the trailing \\n\\n separator', () => {
  const input = '[SAI:ICC_EXTRACTION]\n\nReturn ONLY valid JSON matching this schema...';
  const output = stripIccMarker(input);
  assert.equal(output, 'Return ONLY valid JSON matching this schema...');
});

test('stripIccMarker: returns input unchanged when marker is absent', () => {
  const input = 'No marker here, just a normal user message.';
  assert.equal(stripIccMarker(input), input);
});

test('stripIccMarker: handles marker followed by a single newline (lenient separator handling)', () => {
  const input = '[SAI:ICC_EXTRACTION]\nbody here';
  assert.equal(stripIccMarker(input), 'body here');
});

test('stripIccMarker: preserves prefix when marker is mid-string (envelope-wrapped case)', () => {
  const input = 'envelope-prefix: [SAI:ICC_EXTRACTION]\n\nbody here';
  // The strip leaves the envelope intact and removes the marker + separator.
  // Use of `includes` for detection (not anchoring) means the prefix is real
  // content from some wrapping layer, not an LLM-visible anomaly.
  assert.equal(stripIccMarker(input), 'envelope-prefix: body here');
});

test('stripIccMarker: empty string is unchanged', () => {
  assert.equal(stripIccMarker(''), '');
});

test('stripIccMarker round-trip: stripping the prefix CE actually emits gives a clean body', () => {
  // Construct the exact composition CE produces in composeExtractionPrompt():
  //   `${MARKER}\n\n${instructions}\n\nReturn ONLY valid JSON ...`
  const ceComposed = `${ICC_EXTRACTION_MARKER}\n\nYou are an ICC curator.\n\nReturn ONLY valid JSON matching this schema:\n{}\n\nTRANSCRIPT:\nuser: hi`;
  const stripped = stripIccMarker(ceComposed);
  assert.ok(!stripped.includes(ICC_EXTRACTION_MARKER));
  assert.ok(stripped.startsWith('You are an ICC curator.'));
});
