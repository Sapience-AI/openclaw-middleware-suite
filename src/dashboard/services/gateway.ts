/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Gateway connection monitor — background heartbeat detects when the
 * gateway becomes unreachable (restart, crash, manual stop) and drives
 * the reconnect overlay via shared Preact signals.
 */

import { signal } from '@preact/signals';
import { invalidateMiddlewareCache } from './useMiddlewareEnabled';

// ── Shared signals ────────────────────────────────────────────────────────

/** True when the gateway is unreachable. */
export const gatewayDisconnected = signal(false);

/** Human-readable reason shown in the overlay (null = generic). */
export const disconnectReason = signal<string | null>(null);

// ── Proactive restart grace period ────────────────────────────────────────
// When we *know* a restart is coming (e.g. model-routing toggle), the
// overlay is shown immediately.  But the gateway may still be up for a
// second or two while it processes the shutdown.  The grace period
// prevents the heartbeat from prematurely dismissing the overlay when
// it sees a successful probe in that brief window.

let graceUntil = 0;

/**
 * Call after an action known to trigger a gateway restart.
 * Shows the overlay proactively and sets a grace period so the heartbeat
 * doesn't dismiss it before the gateway actually goes down.
 */
export function notifyGatewayRestart(reason: string): void {
  disconnectReason.value = reason;
  gatewayDisconnected.value = true;
  graceUntil = Date.now() + 6000; // 6 s grace
  // Switch heartbeat to fast polling immediately
  switchInterval(FAST_MS);
}

// ── Health probe ──────────────────────────────────────────────────────────

async function probeHealth(): Promise<boolean> {
  // /api/health reports gateway readiness, not just suite-server liveness.
  // It returns 503 while the gateway is restarting (suite-server is up but
  // OpenClaw sidecars haven't finished booting), so the overlay won't
  // briefly flash "connected" mid-restart and bounce back.
  try {
    const res = await fetch('/api/health', {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────

const SLOW_MS = 5000; // connected: check every 5 s
const FAST_MS = 2000; // disconnected: check every 2 s

let timer: ReturnType<typeof setInterval> | null = null;
let currentInterval = 0;
let started = false;

function switchInterval(ms: number): void {
  if (ms === currentInterval) return;
  if (timer) clearInterval(timer);
  currentInterval = ms;
  timer = setInterval(tick, ms);
}

async function tick(): Promise<void> {
  const ok = await probeHealth();

  if (ok) {
    // Still in the grace window after a proactive restart notification?
    // Don't dismiss — the gateway hasn't actually gone down yet.
    if (gatewayDisconnected.value && Date.now() < graceUntil) {
      return;
    }

    if (gatewayDisconnected.value) {
      // Was disconnected → now reconnected
      invalidateMiddlewareCache();
      gatewayDisconnected.value = false;
      disconnectReason.value = null;
    }
    switchInterval(SLOW_MS);
  } else {
    // API unreachable
    if (!gatewayDisconnected.value) {
      gatewayDisconnected.value = true;
      if (!disconnectReason.value) {
        disconnectReason.value = 'Lost connection to the gateway';
      }
    }
    graceUntil = 0; // no longer need grace — it's actually down
    switchInterval(FAST_MS);
  }
}

/**
 * Start the background heartbeat.  Safe to call multiple times (no-op
 * after the first).  Should be called once from Shell on mount.
 */
export function startConnectionMonitor(): void {
  if (started) return;
  started = true;
  currentInterval = SLOW_MS;
  timer = setInterval(tick, SLOW_MS);
}
