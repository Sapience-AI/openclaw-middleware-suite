/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

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
