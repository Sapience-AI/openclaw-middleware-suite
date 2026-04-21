/**
 * Context Editing Diagnostic Logger
 * Writes to a separate file so diagnostic output is never mixed with or
 * filtered by the main logger's log level.
 */

import fs from 'fs';
import { CTX_EDIT_DIAGNOSTIC_FILE } from '../../shared/storage/paths.js';

const DIAG_FILE = CTX_EDIT_DIAGNOSTIC_FILE;

function timestamp(): string {
  return new Date().toISOString();
}

export function diag(label: string, data?: Record<string, unknown>): void {
  const entry = data
    ? `[${timestamp()}] ${label} ${JSON.stringify(data)}\n`
    : `[${timestamp()}] ${label}\n`;

  try {
    fs.appendFileSync(DIAG_FILE, entry, 'utf-8');
  } catch {
    // Best-effort — never throw from diagnostics
  }
}
