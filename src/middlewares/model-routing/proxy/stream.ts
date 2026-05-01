/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Stream — SSE streaming passthrough for chat completions.
 *
 * Pipes upstream Server-Sent Events directly to the client, handling
 * connection drops and back-pressure gracefully.
 */

import { IncomingMessage, ServerResponse } from 'http';

/**
 * Pipe an upstream SSE stream to the client response.
 * Sets appropriate headers for SSE before piping.
 */
export function pipeStream(upstream: IncomingMessage, res: ServerResponse): void {
  res.writeHead(upstream.statusCode || 200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Forward any routing headers already set on res
    ...getExistingHeaders(res),
  });

  upstream.pipe(res);

  // Clean up on premature client disconnect
  res.on('close', () => {
    upstream.destroy();
  });
}

/**
 * Read back any headers already set on the response (e.g., X-Router-* headers)
 * so they aren't lost when we call writeHead.
 */
function getExistingHeaders(res: ServerResponse): Record<string, string> {
  const headers: Record<string, string> = {};
  const names = res.getHeaderNames();
  for (const name of names) {
    const val = res.getHeader(name);
    if (val !== undefined) {
      headers[name] = String(val);
    }
  }
  return headers;
}
