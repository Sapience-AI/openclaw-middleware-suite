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
 * Apply all pending writes to openclaw.json and clear the pending set.
 * Call this at the end of CLI init or from the dashboard Sync button.
 *
 * @returns Number of writes applied, or 0 if nothing was pending.
 */
export async function flushToOpenClaw(): Promise<number> {
  const store = await ConfigStore.read();
  const pending = (store[STORE_KEY_OPENCLAW_PENDING] || {}) as Record<string, unknown>;
  const paths = Object.keys(pending);

  if (paths.length === 0) {
    logger.debug('[openclaw-sync] Nothing to flush');
    return 0;
  }

  // Load current openclaw.json
  const config = (await loadOpenClawConfig()) || {};

  // Apply each staged write
  for (const dotPath of paths) {
    setNestedValue(config as Record<string, unknown>, dotPath, pending[dotPath]);
  }

  await saveOpenClawConfig(config);
  logger.info('[openclaw-sync] Flushed to openclaw.json', { count: paths.length, paths });

  // Clear pending
  await ConfigStore.update(STORE_KEY_OPENCLAW_PENDING, {});

  return paths.length;
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
