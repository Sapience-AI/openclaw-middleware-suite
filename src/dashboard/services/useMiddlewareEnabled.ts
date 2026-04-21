import { useState, useEffect } from 'preact/hooks';
import { fetchMiddlewares } from './api';

/**
 * Returns whether a specific middleware is enabled.
 * Fetches /api/middlewares once and caches in module scope.
 * Call invalidateMiddlewareCache() after toggling to force a refetch.
 */

let cache: Record<string, boolean> | null = null;
let pending: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (cache) return Promise.resolve();
  if (!pending) {
    pending = fetchMiddlewares()
      .then((list) => {
        cache = {};
        for (const mw of list) {
          cache[mw.name] = mw.enabled;
        }
      })
      .catch(() => {
        cache = {};
      });
  }
  return pending;
}

/**
 * Clear the cached middleware enabled state so the next
 * useMiddlewareEnabled call refetches from the server.
 */
export function invalidateMiddlewareCache(): void {
  cache = null;
  pending = null;
}

export function useMiddlewareEnabled(name: string): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(cache ? (cache[name] ?? false) : null);

  useEffect(() => {
    ensureLoaded().then(() => {
      setEnabled(cache![name] ?? false);
    });
  }, [name]);

  return enabled;
}
