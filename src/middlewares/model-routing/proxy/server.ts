/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Routing Proxy — Handles model-routing /v1/* requests.
 *
 * No longer owns the HTTP server — registers its route handler on the
 * shared SuiteServer so the dashboard is always available regardless of
 * whether model-routing is enabled.
 */

import http from 'http';
import { ModelRoutingConfig } from '../config.js';
import { RoutingStats } from '../types.js';
import {
  handleStats,
  handleChatCompletions,
  getStats,
  resetStats,
  setOnRouteCallback,
} from './handler.js';
import { getSuiteServer } from '../../../shared/server/suite-server.js';
import { logger } from '../../../shared/Logger.js';

export { setOnRouteCallback, getStats, resetStats };

export class RoutingProxy {
  private _config: ModelRoutingConfig;

  constructor(config: ModelRoutingConfig) {
    this._config = config;
  }

  /**
   * Update config without restarting the server (hot-reload).
   */
  updateConfig(config: ModelRoutingConfig): void {
    this._config = config;
  }

  /**
   * Register proxy routes on the suite server.
   */
  async start(): Promise<void> {
    const server = getSuiteServer(this._config.port);
    server.registerProxyHandler((req, res) => this.route(req, res));
    logger.info(
      `[model-routing] Proxy routes registered on suite server (port ${this._config.port})`
    );
  }

  /**
   * Unregister proxy routes from the suite server.
   */
  async stop(): Promise<void> {
    const server = getSuiteServer();
    server.unregisterProxyHandler();
    logger.info('[model-routing] Proxy routes unregistered');
  }

  /**
   * Whether the suite server (and thus the proxy) is currently running.
   */
  get isRunning(): boolean {
    try {
      return getSuiteServer().isRunning;
    } catch {
      return false;
    }
  }

  /**
   * Current stats snapshot.
   */
  getStats(): RoutingStats {
    return getStats();
  }

  // ── Internal routing ─────────────────────────────────────────────────────

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // Stats
    if (url === '/stats') {
      handleStats(req, res);
      return;
    }

    // Model list — required for OpenClaw to validate models on session creation.
    if (method === 'GET' && url === '/v1/models') {
      const { buildRouterModelList } = await import('../router-provider.js');
      const models = buildRouterModelList().map((m: { id: string; name: string }) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'sai-router',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models }));
      return;
    }

    // Chat completions
    if (method === 'POST' && url === '/v1/chat/completions') {
      handleChatCompletions(req, res, this._config);
      return;
    }

    // Unknown proxy route
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  }
}
