/*
 * Copyright (c) Kevin Wu and Pegasi contributors
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * This file is derived from the Reins project (https://github.com/pegasi-ai/reins)
 * and has been modified for use in the OpenClaw Middleware Suite.
 */

/**
 * Sapience Middleware Logger
 * Production-grade logging with Winston
 */

import { createLogger, format, transports } from 'winston';
import { existsSync, mkdirSync } from 'fs';
import { SUITE_HOME, STORE_FILE, LOG_FILE as SUITE_LOG_FILE } from './storage/paths.js';
import { getLogLevel } from './env.js';

// Only create the root data directory eagerly.
// Per-middleware directories are created by each middleware when it initializes,
// so disabled middlewares leave no footprint on disk.
if (!existsSync(SUITE_HOME)) {
  mkdirSync(SUITE_HOME, { recursive: true });
}

const LOG_FILE = SUITE_LOG_FILE;

export const logger = createLogger({
  level: getLogLevel() || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: 'sapience-ai-suite' },
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
          return `[${timestamp}] ${level}: ${message} ${metaStr}`;
        })
      ),
    }),

    new transports.File({
      filename: LOG_FILE,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      format: format.combine(format.json(), format.prettyPrint()),
    }),
  ],
});

// Re-export path constants for backward compatibility.
// New code should import from './storage/paths.js' directly.
export const LOG_PATH = LOG_FILE;
export const SAPIENCE_MW_DATA_DIR = SUITE_HOME;
export const SAPIENCE_MW_LOG_DIR = SUITE_HOME; // legacy alias — logs now live in per-middleware dirs
export const SAPIENCE_MW_STORE_FILE = STORE_FILE;
