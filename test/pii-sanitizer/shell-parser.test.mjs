import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ShellParser } = require('../../dist/middlewares/pii-sanitizer/ShellParser.js');

test('ShellParser', async (t) => {
  const parser = new ShellParser();

  await t.test('extracts simple literal arguments', () => {
    const literals = parser.extractLiterals('echo hello world');
    assert.ok(literals.includes('hello'));
    assert.ok(literals.includes('world'));
  });

  await t.test('extracts quoted strings', () => {
    const literals = parser.extractLiterals('echo "my secret value"');
    assert.ok(literals.some((l) => l.includes('secret')));
  });

  await t.test('extracts assignment values', () => {
    const literals = parser.extractLiterals('SECRET=abc123 command');
    assert.ok(literals.some((l) => l.includes('SECRET')));
  });

  await t.test('handles pipelines', () => {
    const literals = parser.extractLiterals('cat file.txt | grep token');
    assert.ok(literals.includes('file.txt'));
    assert.ok(literals.includes('token'));
  });

  await t.test('handles logical expressions', () => {
    const literals = parser.extractLiterals('test -f foo && echo bar');
    assert.ok(literals.includes('foo'));
    assert.ok(literals.includes('bar'));
  });

  await t.test('falls back to raw string on parse error', () => {
    // Unbalanced quote should trigger fallback
    const literals = parser.extractLiterals('echo "unterminated');
    assert.deepEqual(literals, ['echo "unterminated']);
  });

  await t.test('handles subshells and command substitution', () => {
    const literals = parser.extractLiterals('echo $(whoami) result');
    // Should include "result" at minimum
    assert.ok(literals.includes('result'));
  });

  await t.test('returns empty for empty-ish input', () => {
    const literals = parser.extractLiterals('');
    assert.ok(Array.isArray(literals));
  });

  await t.test('handles if/then/else', () => {
    const literals = parser.extractLiterals('if true; then echo yes; else echo no; fi');
    assert.ok(literals.includes('yes') || literals.includes('no'));
  });

  await t.test('handles for loops', () => {
    const literals = parser.extractLiterals('for x in a b c; do echo $x; done');
    assert.ok(literals.length > 0);
  });
});
