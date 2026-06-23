import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CostTracker, DEFAULT_COST_ALERT_CONFIG } = require(
  '../../dist/middlewares/model-routing/storage/cost-tracker.js',
);

// ---------------------------------------------------------------------------
// CostTracker — per-source attribution + per-source budgets
//
// Verifies:
//   - record() splits totals into bySource buckets keyed by event.source
//   - omitting source defaults to 'chat' (legacy compatibility)
//   - per-source warn/critical alerts fire independently of aggregate alerts
//   - per-source alerts latch (one warn + one critical per source per day)
// ---------------------------------------------------------------------------

function makeTracker(overrides = {}) {
  // Use a no-persist tracker (no persistPath) so tests don't hit disk.
  const config = {
    ...DEFAULT_COST_ALERT_CONFIG,
    // Detach from the default DEFAULT_COST_ALERT_CONFIG.budgets so each test
    // controls its own thresholds explicitly.
    budgets: {},
    ...overrides,
  };
  const tracker = new CostTracker(config);
  return tracker;
}

// Use a model with stable fallback pricing so cost math is predictable.
// `claude-haiku-4-5`: input 1.0/M, output 5.0/M.
// 1M input + 1M output = $1 + $5 = $6 per call.
function bigEvent(source) {
  return {
    model: 'claude-haiku-4-5',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    source,
  };
}

// ---------------------------------------------------------------------------
// Per-source bucketing
// ---------------------------------------------------------------------------

test('record: chat and icc events accumulate into separate bySource buckets', () => {
  const t = makeTracker({ warnThresholdUsd: 1000, criticalThresholdUsd: 1000 });
  t.record({ ...bigEvent('chat') });
  t.record({ ...bigEvent('icc') });
  t.record({ ...bigEvent('chat') });

  const summary = t.getSummary();
  const today = summary.today;
  assert.ok(today, 'today entry should exist');
  assert.equal(today.bySource.chat.requestCount, 2);
  assert.equal(today.bySource.icc.requestCount, 1);
  // chat: 2 × $6 = $12, icc: 1 × $6 = $6
  assert.ok(Math.abs(today.bySource.chat.costUsd - 12) < 0.01);
  assert.ok(Math.abs(today.bySource.icc.costUsd - 6) < 0.01);
  // Aggregate is the sum of all sources.
  assert.ok(Math.abs(today.totalUsd - 18) < 0.01);
});

test('record: omitting source defaults to "chat" (legacy callers stay attributed correctly)', () => {
  const t = makeTracker({ warnThresholdUsd: 1000, criticalThresholdUsd: 1000 });
  t.record({
    model: 'claude-haiku-4-5',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    // no source
  });
  const today = t.getSummary().today;
  assert.equal(today.bySource.chat.requestCount, 1);
  assert.equal(today.bySource.icc, undefined, 'no icc bucket created when source is omitted');
});

// ---------------------------------------------------------------------------
// Per-source budget alerts
// ---------------------------------------------------------------------------

test('per-source budgets: icc warn fires at the icc threshold, not the aggregate threshold', () => {
  const warnings = [];
  // Capture warn-level logs to confirm per-source alerting message contents.
  const origWarn = console.warn;
  const origLogger = require('../../dist/shared/Logger.js').logger;
  const origLoggerWarn = origLogger.warn;
  origLogger.warn = (msg, meta) => {
    warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
  };

  try {
    const t = makeTracker({
      warnThresholdUsd: 1000, // aggregate — won't fire in this test
      criticalThresholdUsd: 1000,
      budgets: {
        icc: { dailyWarn: 5, dailyCritical: 100 },
      },
    });
    // First icc event: $6 — crosses the icc warn threshold ($5).
    t.record(bigEvent('icc'));
    assert.ok(
      warnings.some((w) => w.includes('WARNING [icc]')),
      `expected per-source icc warning, got: ${warnings.join(' | ')}`,
    );
  } finally {
    origLogger.warn = origLoggerWarn;
    console.warn = origWarn;
  }
});

test('per-source budgets: chat warn does not fire when chat threshold is unset', () => {
  const warnings = [];
  const origLogger = require('../../dist/shared/Logger.js').logger;
  const origLoggerWarn = origLogger.warn;
  origLogger.warn = (msg) => warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg));

  try {
    const t = makeTracker({
      warnThresholdUsd: 1000,
      criticalThresholdUsd: 1000,
      budgets: { icc: { dailyWarn: 1 } }, // chat has no entry
    });
    t.record(bigEvent('chat')); // $6 — would trip if a chat budget existed
    assert.ok(
      !warnings.some((w) => w.includes('WARNING [chat]')),
      'no chat per-source alert should fire without a chat budget',
    );
  } finally {
    origLogger.warn = origLoggerWarn;
  }
});

test('per-source budgets: warn latches — second event over threshold does not re-warn', () => {
  const warnings = [];
  const origLogger = require('../../dist/shared/Logger.js').logger;
  const origLoggerWarn = origLogger.warn;
  origLogger.warn = (msg) => warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg));

  try {
    const t = makeTracker({
      warnThresholdUsd: 1000,
      criticalThresholdUsd: 1000,
      budgets: { icc: { dailyWarn: 5, dailyCritical: 100 } },
    });
    t.record(bigEvent('icc')); // first crosses warn → fires
    t.record(bigEvent('icc')); // already warned → must not fire again
    const iccWarnings = warnings.filter((w) => w.includes('WARNING [icc]'));
    assert.equal(iccWarnings.length, 1, 'icc warn must latch — fire once per day');
  } finally {
    origLogger.warn = origLoggerWarn;
  }
});

test('per-source budgets: critical fires after warn (separate latches)', () => {
  const warnings = [];
  const origLogger = require('../../dist/shared/Logger.js').logger;
  const origLoggerWarn = origLogger.warn;
  origLogger.warn = (msg) => warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg));

  try {
    const t = makeTracker({
      warnThresholdUsd: 1000,
      criticalThresholdUsd: 1000,
      budgets: { icc: { dailyWarn: 5, dailyCritical: 10 } },
    });
    // 1st event: $6 → crosses warn ($5).
    // 2nd event: cumulative $12 → crosses critical ($10).
    t.record(bigEvent('icc'));
    t.record(bigEvent('icc'));
    assert.ok(warnings.some((w) => w.includes('WARNING [icc]')));
    assert.ok(warnings.some((w) => w.includes('CRITICAL [icc]')));
  } finally {
    origLogger.warn = origLoggerWarn;
  }
});

test('per-source budgets: independent of aggregate alerts (both can fire on same day)', () => {
  const warnings = [];
  const origLogger = require('../../dist/shared/Logger.js').logger;
  const origLoggerWarn = origLogger.warn;
  origLogger.warn = (msg) => warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg));

  try {
    const t = makeTracker({
      warnThresholdUsd: 5,
      criticalThresholdUsd: 1000,
      budgets: { icc: { dailyWarn: 5 } },
    });
    // $6 chat event: aggregate $6 ≥ $5 → aggregate warn fires.
    // chat has no per-source budget → no [chat] warn.
    t.record(bigEvent('chat'));
    // $6 icc event: aggregate already warned (latched), but icc bucket
    // hits its own $5 threshold for the first time → [icc] warn fires.
    t.record(bigEvent('icc'));

    assert.ok(
      warnings.some((w) => w.includes('WARNING:') && !w.includes('[icc]') && !w.includes('[chat]')),
      'aggregate warn must fire',
    );
    assert.ok(warnings.some((w) => w.includes('WARNING [icc]')), 'icc per-source warn must fire');
  } finally {
    origLogger.warn = origLoggerWarn;
  }
});
