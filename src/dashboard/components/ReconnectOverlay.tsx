/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

import { gatewayDisconnected, disconnectReason } from '../services/gateway';

/**
 * Full-screen overlay shown when the gateway is unreachable.
 * Pure display component — connection monitoring and reconnection
 * detection are handled by the heartbeat in services/gateway.ts.
 */
export function ReconnectOverlay() {
  if (!gatewayDisconnected.value) return null;

  const reason = disconnectReason.value;

  return (
    <div class="reconnect-overlay">
      <div class="reconnect-content">
        {/* Pulsing rings with SAI logo in center */}
        <div class="reconnect-rings">
          <div class="reconnect-ring reconnect-ring-1" />
          <div class="reconnect-ring reconnect-ring-2" />
          <div class="reconnect-ring reconnect-ring-3" />
          <div class="reconnect-logo">
            <img src="/dashboard/sai-logo.svg" alt="SAI" width="40" height="40" />
          </div>
        </div>

        <h2 class="reconnect-title">Gateway Unavailable</h2>

        {reason && (
          <div class="reconnect-reason">{reason}</div>
        )}

        <p class="reconnect-desc">
          Waiting for the gateway to come back online.
          <br />
          Reconnecting automatically
          <span class="reconnect-dots" />
        </p>

        <div class="reconnect-bar-track">
          <div class="reconnect-bar-fill" />
        </div>
      </div>
    </div>
  );
}
