/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * OpenClaw Sync — Staged writes to openclaw.json.
 *
 * Middlewares stage their openclaw.json changes into sapience-ai-suite.json
 * under the `_openclaw_pending` key. Changes are only flushed to openclaw.json
 * when explicitly triggered (end of CLI init, dashboard Save button).
 *
 * This prevents uncontrolled openclaw.json writes that trigger gateway
 * hot-reloads and keeps the suite's own config store as the source of truth.
 */

import { ConfigStore } from '../storage/ConfigStore.js';
import { STORE_KEY_OPENCLAW_PENDING } from '../storage/paths.js';
import { loadOpenClawConfig, saveOpenClawConfig } from '../../plugin/config-manager.js';
import { logger } from '../Logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single staged write: dot-separated path → value to set in openclaw.json. */
export interface PendingWrite {
  dotPath: string;
  value: unknown;
}

// ---------------------------------------------------------------------------
// Stage — buffer a write in sapience-ai-suite.json
// ---------------------------------------------------------------------------

/**
 * Stage a write to openclaw.json without actually writing it.
 * The change is stored in sapience-ai-suite.json under `_openclaw_pending`.
 *
 * @param dotPath  Dot-separated path in openclaw.json (e.g. "agents.defaults.contextPruning")
 * @param value    The value to set at that path
 */
export async function stageOpenClawWrite(dotPath: string, value: unknown): Promise<void> {
  const store = await ConfigStore.read();
  const pending = (store[STORE_KEY_OPENCLAW_PENDING] || {}) as Record<string, unknown>;
  pending[dotPath] = value;
  await ConfigStore.update(STORE_KEY_OPENCLAW_PENDING, pending);
  logger.info('[openclaw-sync] Staged write', { dotPath });
}

/**
 * Stage multiple writes at once (avoids repeated ConfigStore reads).
 */
export async function stageOpenClawWrites(
  writes: Array<{ dotPath: string; value: unknown }>
): Promise<void> {
  const store = await ConfigStore.read();
  const pending = (store[STORE_KEY_OPENCLAW_PENDING] || {}) as Record<string, unknown>;
  for (const { dotPath, value } of writes) {
    pending[dotPath] = value;
  }
  await ConfigStore.update(STORE_KEY_OPENCLAW_PENDING, pending);
  logger.info('[openclaw-sync] Staged batch writes', {
    paths: writes.map((w) => w.dotPath),
  });
}

// ---------------------------------------------------------------------------
// Flush — apply staged writes to openclaw.json
// ---------------------------------------------------------------------------

/**
 * Paths where openclaw >= 2026.4.27 chooses hot-reload over a restart, but
 * the hot-reload does NOT propagate the new value into plugin runtimes that
 * captured an `api.config` reference at load time (e.g. ContextEditing's
 * `resolveExtractionTargets` reads `agents.defaults.compaction.model` from
 * `api.config` on every call but the reference is the stale snapshot).
 *
 * For these paths we override the `afterWrite` policy to `'restart'` so
 * `replaceConfigFile` forces a clean gateway restart and plugins see the
 * updated values on next load. Pre-4.27 openclaw always restarted on any
 * write, so this restores the prior behavior for the affected fields only.
 *
 * Add a path here only after confirming hot-reload doesn't take effect for
 * it — over-restarting defeats the point of openclaw's reload planner.
 */
const MUST_RESTART_PATHS: ReadonlySet<string> = new Set([
  'agents.defaults.compaction.model',
  'agents.defaults.contextPruning',
]);

/**
 * Apply all pending writes to openclaw.json and clear the pending set.
 * Call this at the end of CLI init or from the dashboard Sync button.
 *
 * Skips the openclaw.json disk write entirely when every pending value
 * already matches what's on disk — writing an unchanged file would still
 * trigger the gateway's file-watcher hot-reload. Pending entries are
 * always cleared regardless of whether the disk was touched.
 *
 * When any changed path is in `MUST_RESTART_PATHS`, the underlying
 * `saveOpenClawConfig` call is invoked with `afterWrite: 'restart'` so
 * the gateway restarts cleanly instead of attempting an ineffective
 * hot-reload. See the constant's docstring for why.
 *
 * @returns `{ count, restarted }`. `count` is the number of writes
 *   actually applied to disk (0 if all were no-ops). `restarted` is true
 *   iff a `'restart'` afterWrite policy was sent to the gateway — used
 *   by the dashboard PUT handlers to drive the "Gateway restarting…"
 *   overlay only when a restart was actually requested.
 */
export async function flushToOpenClaw(): Promise<{ count: number; restarted: boolean }> {
  const store = await ConfigStore.read();
  const pending = (store[STORE_KEY_OPENCLAW_PENDING] || {}) as Record<string, unknown>;
  const paths = Object.keys(pending);

  if (paths.length === 0) {
    logger.debug('[openclaw-sync] Nothing to flush');
    return { count: 0, restarted: false };
  }

  // Load current openclaw.json.
  const config = (await loadOpenClawConfig()) || {};

  // Filter to only the writes whose values actually differ from disk.
  // Writing openclaw.json at all triggers a gateway restart, so identical
  // values must not reach saveOpenClawConfig. Paths with custom semantic
  // comparers (e.g. contextPruning where absent ≡ mode:off) use those
  // instead of structural deepEqual.
  const changedPaths: string[] = [];
  for (const dotPath of paths) {
    const currentValue = getNestedValue(config as Record<string, unknown>, dotPath);
    const areEqual = SEMANTIC_EQUAL[dotPath] ?? deepEqual;
    if (!areEqual(currentValue, pending[dotPath])) {
      changedPaths.push(dotPath);
      setNestedValue(config as Record<string, unknown>, dotPath, pending[dotPath]);
    }
  }

  if (changedPaths.length === 0) {
    logger.debug('[openclaw-sync] All pending writes match disk — skipping flush', {
      paths,
    });
    await ConfigStore.update(STORE_KEY_OPENCLAW_PENDING, {});
    return { count: 0, restarted: false };
  }

  const restartPaths = changedPaths.filter((p) => MUST_RESTART_PATHS.has(p));
  if (restartPaths.length > 0) {
    await saveOpenClawConfig(config, {
      afterWrite: 'restart',
      reason: `sapience-middleware-suite: hot-reload-broken paths changed (${restartPaths.join(', ')})`,
    });
  } else {
    await saveOpenClawConfig(config);
  }
  logger.info('[openclaw-sync] Flushed to openclaw.json', {
    count: changedPaths.length,
    paths: changedPaths,
    forcedRestart: restartPaths.length > 0,
    restartPaths: restartPaths.length > 0 ? restartPaths : undefined,
  });

  // Clear pending
  await ConfigStore.update(STORE_KEY_OPENCLAW_PENDING, {});

  return { count: changedPaths.length, restarted: restartPaths.length > 0 };
}

// ---------------------------------------------------------------------------
// Read — inspect pending writes
// ---------------------------------------------------------------------------

/**
 * Get all currently staged writes (for dashboard display).
 */
export async function getPendingWrites(): Promise<Record<string, unknown>> {
  const store = await ConfigStore.read();
  return (store[STORE_KEY_OPENCLAW_PENDING] || {}) as Record<string, unknown>;
}

/**
 * Check if there are pending writes waiting to be flushed.
 */
export async function hasPendingWrites(): Promise<boolean> {
  const pending = await getPendingWrites();
  return Object.keys(pending).length > 0;
}

// ---------------------------------------------------------------------------
// Clear — discard pending writes without applying
// ---------------------------------------------------------------------------

/**
 * Discard all pending writes without applying them to openclaw.json.
 */
export async function clearPendingWrites(): Promise<void> {
  await ConfigStore.update(STORE_KEY_OPENCLAW_PENDING, {});
  logger.info('[openclaw-sync] Cleared pending writes');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setNestedValue(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const keys = dotPath.split('.');
  // Reject any path segment that could pollute Object.prototype
  // (CodeQL js/prototype-pollution-utility).
  for (const k of keys) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
      throw new Error(`Refusing to set property at unsafe path segment: ${k}`);
    }
  }
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!current[key] || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  current[keys[keys.length - 1]] = value;
}

function getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
  const keys = dotPath.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Per-path semantic comparers for paths where structural deepEqual would
 * over-report "changed". Each entry returns true when the two values are
 * functionally equivalent for OpenClaw's runtime, even if they aren't
 * byte-identical. Paths not in this map fall back to deepEqual.
 */
const SEMANTIC_EQUAL: Record<string, (a: unknown, b: unknown) => boolean> = {
  // OpenClaw treats an absent `contextPruning` key the same as
  // `{ mode: 'off' }` — the middleware just doesn't run. ttl is meaningless
  // when pruning is off, so two "off" pruning blocks with different ttls
  // are equivalent. Only when either side is actually enabled do mode + ttl
  // both matter.
  'agents.defaults.contextPruning': (current, target) => {
    const c = (current ?? {}) as { mode?: unknown; ttl?: unknown };
    const t = (target ?? {}) as { mode?: unknown; ttl?: unknown };
    const cOff = !c.mode || c.mode === 'off';
    const tOff = !t.mode || t.mode === 'off';
    if (cOff && tOff) return true;
    if (cOff || tOff) return false;
    return c.mode === t.mode && c.ttl === t.ttl;
  },
};

/**
 * Structural equality for the subset of JSON values that openclaw.json holds.
 * Treats `undefined` as distinct from `null`. Arrays compared element-wise;
 * objects compared by own-keys.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}
