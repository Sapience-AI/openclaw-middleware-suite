import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createTestEnvWithOpenclaw } from '../_helpers/test-env.mjs';

createTestEnvWithOpenclaw('sai-redos-regressions-');

const distBase = path.resolve('dist');
const u = (p) => pathToFileURL(path.join(distBase, p)).href;

// Regression tests for CodeQL-flagged ReDoS sites. Each test exercises a
// worst-case input that, with the unbounded original regex, would trigger
// polynomial / exponential backtracking. With bounded quantifiers in place,
// each call must complete well under the 250ms budget.

// Generous budget: a polynomial-redos blowup would take many seconds, so
// 500ms catches regressions while tolerating CI/local-machine variance.
const BUDGET_MS = 500;

function timed(fn) {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

test('ReDoS: rm-recursive-root pattern terminates quickly on adversarial input', async () => {
  const mod = await import(u('middlewares/guardrail/guards/destructive-commands.js'));
  // 50k chars of -fr-style flag soup followed by no path — original (unbounded
  // *) backtracks polynomially when the trailing path token never matches.
  const adversarial = 'rm ' + '-rfafafaf '.repeat(5000) + 'xxx';
  const ms = timed(() => mod.checkDestructiveCommand(adversarial));
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(1)}ms (budget ${BUDGET_MS}ms)`);
});

test('ReDoS: egress extractScpHostname terminates quickly on no-colon input', async () => {
  const mod = await import(u('middlewares/guardrail/guards/egress-control.js'));
  // Long alnum string with no `:` — original /(?:\w+@)?([a-zA-Z0-9.-]+):/
  // would try every start position with greedy backtracking.
  const adversarial = 'a'.repeat(100000);
  const ms = timed(() => mod.checkEgressControl(`scp ${adversarial} dest`));
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(1)}ms (budget ${BUDGET_MS}ms)`);
});

test('ReDoS: DestructiveClassifier access-control patterns terminate quickly', async () => {
  const mod = await import(u('middlewares/hitl/scoring/DestructiveClassifier.js'));
  // Input that hits each `<verb>.*<target>` alternative without ever reaching
  // the closing keyword — original `.*` would polynomial-backtrack.
  const adversarial = 'revoke ' + 'x'.repeat(100000);
  const ms = timed(() => mod.classifyDestructiveAction('unknown', { text: adversarial }));
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(1)}ms (budget ${BUDGET_MS}ms)`);
});

test('ReDoS: scoreConditionalLogic if/then + when/happens patterns terminate quickly', async () => {
  const mod = await import(
    u('middlewares/model-routing/scoring/dimensions/structural-dimensions.js')
  );
  // Long input starting with "if " / "when " but never closing — original
  // `.+\s*` would polynomial-backtrack.
  const adversarial = 'if ' + 'x'.repeat(100000);
  const ms = timed(() => mod.scoreConditionalLogic(adversarial));
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(1)}ms (budget ${BUDGET_MS}ms)`);
});

test('ReDoS: scoreConstraintDensity O(...) pattern terminates quickly', async () => {
  const mod = await import(
    u('middlewares/model-routing/scoring/dimensions/structural-dimensions.js')
  );
  // Long input with `O(` and no closing `)` — original `[^)]+` would
  // polynomial-backtrack.
  const adversarial = 'O(' + 'x'.repeat(100000);
  const ms = timed(() => mod.scoreConstraintDensity(adversarial));
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(1)}ms (budget ${BUDGET_MS}ms)`);
});
