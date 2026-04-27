/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Dashboard Static File Server
 *
 * Serves the built Vite/Preact dashboard from dist/dashboard/.
 * SPA fallback: any non-asset route under /dashboard serves index.html.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { DASHBOARD_DIST_DIR } from '../storage/paths.js';

// ── MIME types ──────────────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

// ── In-memory cache for hashed assets ──────────────────────────────────────

const fileCache = new Map<string, Buffer>();

function readCached(absPath: string, immutable: boolean): Buffer | null {
  if (immutable && fileCache.has(absPath)) {
    return fileCache.get(absPath)!;
  }
  try {
    const buf = fs.readFileSync(absPath);
    if (immutable) fileCache.set(absPath, buf);
    return buf;
  } catch {
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Serve a dashboard static file for a request under /dashboard*.
 * Returns true if handled, false if the dashboard is not built.
 */
export function serveDashboardFile(req: http.IncomingMessage, res: http.ServerResponse): void {
  const indexPath = path.join(DASHBOARD_DIST_DIR, 'index.html');

  // If dashboard hasn't been built yet, return a helpful message
  if (!fs.existsSync(indexPath)) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Dashboard not built. Run: npm run build:dashboard',
      })
    );
    return;
  }

  const url = (req.url || '/dashboard').split('?')[0]; // strip query string

  // Strip the /dashboard prefix to get the relative file path
  const relative = url.replace(/^\/dashboard\/?/, '') || 'index.html';

  // Prevent directory traversal
  if (relative.includes('..')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
    return;
  }

  const absPath = path.join(DASHBOARD_DIST_DIR, relative);
  const ext = path.extname(absPath);
  const isAsset = relative.startsWith('assets/') || (ext !== '' && ext !== '.html');

  // Try to serve the exact file
  if (isAsset && fs.existsSync(absPath)) {
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    // Hashed assets are immutable; cache forever
    const isHashed = /\.[a-f0-9]{8,}\./.test(relative);
    const cacheControl = isHashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';

    const body = readCached(absPath, isHashed);
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': body.length,
      'Cache-Control': cacheControl,
    });
    res.end(body);
    return;
  }

  // SPA fallback: serve index.html for any non-asset route
  const indexBody = readCached(indexPath, false);
  if (!indexBody) {
    res.writeHead(500);
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': indexBody.length,
    'Cache-Control': 'no-cache',
  });
  res.end(indexBody);
}
