/**
 * Suite Server — Always-on HTTP server for the Sapience AI Suite.
 *
 * Runs on localhost:{port} regardless of which middlewares are enabled.
 * Dashboard, API, and SSE endpoints are always available. When model-routing
 * is active, its /v1/* proxy handlers are registered on the same server.
 */

import http from 'http';
import net from 'net';
import { logger } from '../Logger.js';
import { handleApiRoute, handleSseRoute } from './dashboard-api.js';
import { serveDashboardFile } from './dashboard-static.js';

export type ProxyRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => Promise<void> | void;

let _instance: SuiteServer | null = null;

export class SuiteServer {
  private server: http.Server | null = null;
  private _port: number;
  private _proxyHandler: ProxyRouteHandler | null = null;

  constructor(port = 9000) {
    this._port = port;
  }

  /** Register model-routing proxy handler for /v1/* and /stats routes. */
  registerProxyHandler(handler: ProxyRouteHandler): void {
    this._proxyHandler = handler;
    logger.info('[suite-server] Proxy routes registered');
  }

  /** Unregister the proxy handler (e.g. on model-routing shutdown). */
  unregisterProxyHandler(): void {
    this._proxyHandler = null;
    logger.info('[suite-server] Proxy routes unregistered');
  }

  /** Start listening. Resolves immediately if port is already in use. */
  start(): Promise<void> {
    if (this.server) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', (err: NodeJS.ErrnoException) => {
        probe.close();
        if (err.code === 'EADDRINUSE') {
          logger.info(
            `[suite-server] Port ${this._port} already bound — ` +
              `managed by another process, skipping.`
          );
          resolve();
          return;
        }
        reject(err);
      });
      probe.once('listening', () => {
        probe.close(() => this.createServer(resolve, reject));
      });
      probe.listen(this._port, '127.0.0.1');
    });
  }

  private createServer(resolve: () => void, reject: (err: Error) => void): void {
    this.server = http.createServer((req, res) => {
      this.route(req, res);
    });

    this.server.on('error', reject);

    this.server.listen(this._port, '127.0.0.1', () => {
      logger.info(`[suite-server] Dashboard listening on http://127.0.0.1:${this._port}/dashboard`);
      resolve();
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        logger.info('[suite-server] Stopped');
        this.server = null;
        resolve();
      });
    });
  }

  get isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  get port(): number {
    return this._port;
  }

  get hasProxy(): boolean {
    return this._proxyHandler !== null;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/';

    // Health
    if (url === '/' || url === '/health') {
      const body = JSON.stringify({
        status: 'ok',
        service: 'sapience-ai-suite',
        port: this._port,
        proxyActive: this._proxyHandler !== null,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    // Model-routing proxy routes (only if registered)
    if (this._proxyHandler && (url.startsWith('/v1/') || url === '/stats')) {
      await this._proxyHandler(req, res);
      return;
    }

    // Dashboard API
    if (url.startsWith('/api/')) {
      handleApiRoute(req, res);
      return;
    }

    // SSE log streams
    if (url.startsWith('/sse/')) {
      handleSseRoute(req, res);
      return;
    }

    // Dashboard static files
    if (url === '/dashboard' || url.startsWith('/dashboard/')) {
      serveDashboardFile(req, res);
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  }
}

/** Get or create the singleton suite server. */
export function getSuiteServer(port = 9000): SuiteServer {
  if (!_instance) {
    _instance = new SuiteServer(port);
  }
  return _instance;
}
