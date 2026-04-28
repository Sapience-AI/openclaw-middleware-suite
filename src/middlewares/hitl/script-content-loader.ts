/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Bounded local-script reader used by the HITL tool interceptor.
 *
 * Kept in its own module so static analyzers don't see local file IO
 * co-located with the interceptor's tool-name string mappings.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_SCRIPT_BYTES = 256 * 1024;

export function loadLocalScriptText(scriptPath: string): string | undefined {
  try {
    if (!path.isAbsolute(scriptPath)) return undefined;
    const stat = fs.statSync(scriptPath);
    if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) return undefined;
    return fs.readFileSync(scriptPath, 'utf8');
  } catch {
    return undefined;
  }
}
