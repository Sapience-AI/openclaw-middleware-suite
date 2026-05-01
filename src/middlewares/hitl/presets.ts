/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * HITL security presets — shared by CLI init wizard and dashboard.
 *
 * Each preset defines a module → method → SecurityRule map. Thresholds
 * default to DEFAULT_POLICY.systemThresholds (not overridden per preset).
 */

import { SecurityRule } from '../../types.js';
import { DEFAULT_POLICY } from './config.js';

export type SecurityLevel = 'permissive' | 'balanced' | 'strict' | 'custom';

export interface SecurityPreset {
  name: string;
  description: string;
  policy: Record<string, Record<string, SecurityRule>>;
}

export const SECURITY_PRESETS: Record<Exclude<SecurityLevel, 'custom'>, SecurityPreset> = {
  permissive: {
    name: '🟢 Permissive',
    description: 'read: ALLOW, write: ASK, delete: ASK, bash: ASK',
    policy: {
      FileSystem: {
        read: { action: 'ALLOW', description: 'Safe read-only' },
        write: { action: 'ASK', description: 'Needs approval' },
        delete: { action: 'ASK', description: 'Requires confirmation' },
      },
      Shell: {
        bash: { action: 'ALLOW', description: 'RCE risk' },
        exec: { action: 'ALLOW', description: 'RCE risk' },
      },
      GoogleDrive: {
        list: { action: 'ALLOW', description: 'Safe read-only listing' },
        read: { action: 'ALLOW', description: 'Safe read-only access' },
        download: { action: 'ASK', description: 'Needs approval' },
        upload: { action: 'ASK', description: 'Needs approval' },
        move: { action: 'ASK', description: 'Needs approval' },
        write: { action: 'ASK', description: 'Needs approval' },
        share: { action: 'ASK', description: 'Sharing externally — needs approval' },
        delete: { action: 'ASK', description: 'Requires confirmation' },
      },
      Gmail: {
        list: { action: 'ALLOW', description: 'Safe read-only listing' },
        read: { action: 'ALLOW', description: 'Safe read-only access' },
        download: { action: 'ASK', description: 'Needs approval' },
        draft: { action: 'ALLOW', description: 'Drafting is harmless' },
        send: { action: 'ASK', description: 'Outbound emails need approval' },
        write: { action: 'ASK', description: 'Needs approval' },
        delete: { action: 'ASK', description: 'Requires confirmation' },
      },
      Memory: {
        search: { action: 'ALLOW', description: 'Safe read-only search' },
        add: { action: 'ASK', description: 'Needs approval' },
        delete: { action: 'ASK', description: 'Requires confirmation' },
      },
      Process: {
        list: { action: 'ALLOW', description: 'Safe read-only listing' },
        poll: { action: 'ALLOW', description: 'Safe process output drain' },
        log: { action: 'ALLOW', description: 'Safe read-only output logging' },
        write: { action: 'ASK', description: 'Needs approval' },
        kill: { action: 'ASK', description: 'Requires confirmation' },
        clear: { action: 'ALLOW', description: 'Safe memory cleanup' },
        remove: { action: 'ASK', description: 'Needs approval' },
      },
    },
  },
  balanced: {
    name: '🟡 Balanced (Recommended)',
    description: 'read: ALLOW, write: ASK, delete: DENY, bash: ASK',
    policy: DEFAULT_POLICY.modules,
  },
  strict: {
    name: '🔴 Strict',
    description: 'read: ASK, write: ASK, delete: DENY, bash: DENY',
    policy: {
      FileSystem: {
        read: { action: 'ASK', description: 'Confirm all reads' },
        write: { action: 'ASK', description: 'Needs approval' },
        delete: { action: 'DENY', description: 'Strictly prohibited' },
      },
      Shell: {
        bash: { action: 'DENY', description: 'RCE blocked' },
        exec: { action: 'DENY', description: 'RCE blocked' },
      },
      GoogleDrive: {
        list: { action: 'ASK', description: 'Confirm all Drive access' },
        read: { action: 'ASK', description: 'Confirm all Drive reads' },
        download: { action: 'ASK', description: 'Needs approval' },
        upload: { action: 'ASK', description: 'Needs approval' },
        move: { action: 'ASK', description: 'Needs approval' },
        write: { action: 'ASK', description: 'Needs approval' },
        share: { action: 'ASK', description: 'Sharing externally — needs approval' },
        delete: { action: 'DENY', description: 'Strictly prohibited' },
      },
      Gmail: {
        list: { action: 'ASK', description: 'Confirm all Gmail access' },
        read: { action: 'ASK', description: 'Confirm all Gmail reads' },
        download: { action: 'ASK', description: 'Needs approval' },
        draft: { action: 'ASK', description: 'Confirm drafts' },
        send: { action: 'ASK', description: 'Outbound emails need approval' },
        write: { action: 'ASK', description: 'Needs approval' },
        delete: { action: 'DENY', description: 'Strictly prohibited' },
      },
      Memory: {
        search: { action: 'ALLOW', description: 'Safe read-only search' },
        add: { action: 'ASK', description: 'Needs approval' },
        delete: { action: 'ASK', description: 'Requires confirmation' },
      },
      Process: {
        list: { action: 'ASK', description: 'Confirm all list access' },
        poll: { action: 'ASK', description: 'Confirm all process polling' },
        log: { action: 'ASK', description: 'Confirm all process logs' },
        write: { action: 'DENY', description: 'Strictly prohibited' },
        kill: { action: 'DENY', description: 'Strictly prohibited' },
        clear: { action: 'ALLOW', description: 'Safe memory cleanup' },
        remove: { action: 'DENY', description: 'Strictly prohibited' },
      },
    },
  },
};

export const DEFAULT_MODULES = [
  'FileSystem',
  'Shell',
  'Browser',
  'GoogleDrive',
  'Gmail',
  'Memory',
  'Process',
];
