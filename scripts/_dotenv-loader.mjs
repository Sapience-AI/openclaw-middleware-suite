// Side-effect-only `.env` loader. Reads a local `.env` file from the current
// working directory (if present) and merges missing keys into the environment.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

try {
  const lines = readFileSync(resolve(process.cwd(), '.env'), 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  /* no .env file — fall back to environment */
}
