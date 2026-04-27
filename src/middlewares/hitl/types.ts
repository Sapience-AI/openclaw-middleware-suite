/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * HITL Middleware — Type Definitions
 * Types specific to the Human-in-the-Loop middleware
 */

// Re-export base types that HITL modules depend on
export type {
  Decision,
  SecurityRule,
  SecurityPolicy,
  SystemThresholds,
  ExecutionContext,
} from '../../types.js';
export type { InterventionMetadata } from '../../types.js';
