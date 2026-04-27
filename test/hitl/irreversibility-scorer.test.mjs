import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scoreIrreversibility } = require('../../dist/middlewares/hitl/scoring/IrreversibilityScorer.js');

test('scoreIrreversibility: rm -rf triggers destructive penalty', () => {
  const result = scoreIrreversibility('Shell', 'exec', {
    command: 'rm -rf /some/dir',
  });
  
  // Baseline for Shell.exec is 50, destructive pattern adds 25 = 75
  assert.equal(result.score >= 75, true);
  assert.equal(result.reasons.includes('Destructive command pattern detected'), true);
});

test('scoreIrreversibility: format C: triggers destructive penalty', () => {
  const result = scoreIrreversibility('Shell', 'exec', {
    command: 'format C:',
  });
  
  assert.equal(result.score >= 75, true);
  assert.equal(result.reasons.includes('Destructive command pattern detected'), true);
});

test('scoreIrreversibility: format-table does NOT trigger destructive penalty', () => {
  const result = scoreIrreversibility('Shell', 'exec', {
    command: 'Get-ChildItem -Path "C:\\" | Format-Table -AutoSize',
  });
  
  // Baseline is 50, should not add 25
  assert.equal(result.score, 50);
  assert.equal(result.reasons.includes('Destructive command pattern detected'), false);
});

test('scoreIrreversibility: format-list does NOT trigger destructive penalty', () => {
  const result = scoreIrreversibility('Shell', 'exec', {
    command: 'Get-Process | format-list *',
  });
  
  assert.equal(result.score, 50);
  assert.equal(result.reasons.includes('Destructive command pattern detected'), false);
});

test('scoreIrreversibility: payment action triggers penalty', () => {
  const result = scoreIrreversibility('Gateway', 'sendMessage', {
    message: 'wire transfer 1000 to Alice',
  });
  
  // Gateway.sendMessage baseline is 75. 75 + 35 = 110, capped at 100.
  assert.equal(result.score, 100);
  assert.equal(result.reasons.includes('Payment/transfer action detected'), true);
});
