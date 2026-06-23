/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Gateway-ready state — driven by OpenClaw's `gateway_start` / `gateway_stop`
 * plugin hooks. Suite-server's /api/health endpoint reads this so the
 * dashboard reconnect overlay only dismisses once the gateway is fully
 * ready (sidecars started), not while it is still spinning up.
 */

import { logger } from '../Logger.js';

let gatewayReady = false;
let lastChange = Date.now();

export function setGatewayReady(ready: boolean, reason?: string): void {
  if (gatewayReady === ready) return;
  gatewayReady = ready;
  lastChange = Date.now();
  logger.info(`[gateway-state] ready=${ready}${reason ? ` (${reason})` : ''}`);
}

export function isGatewayReady(): boolean {
  return gatewayReady;
}

export function getGatewayState(): { ready: boolean; since: number } {
  return { ready: gatewayReady, since: lastChange };
}
