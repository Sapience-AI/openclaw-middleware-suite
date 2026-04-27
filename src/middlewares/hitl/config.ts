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
 * Sapience Middleware Default Security Policy
 * Philosophy: "Secure by Default"
 */

import { SecurityPolicy } from '../../types.js';

export const DEFAULT_POLICY: SecurityPolicy = {
  // PARANOIA MODE: If a tool is unknown, ask the human.
  defaultAction: 'ASK',

  systemThresholds: {
    forceAskIrreversibilityThreshold: 55,
    explicitConfirmIrreversibilityThreshold: 80,
    attackPauseThreshold: 72,
    explicitConfirmMemoryThreshold: 85,
    destructiveBulkThreshold: 20,
    destructiveGatingEnabled: true,
    trustRateLimitLevel1: 10,
    trustRateLimitLevel2: 15,
  },

  modules: {
    FileSystem: {
      read: {
        action: 'ALLOW',
        description: 'Read-only access is generally safe',
      },
      list: {
        action: 'ALLOW',
        description: 'Directory listing is read-only',
      },
      write: {
        action: 'ASK',
        description: 'Modification of files requires approval',
      },
      delete: {
        action: 'DENY',
        description: 'Deletion is strictly prohibited',
      },
    },
    Shell: {
      bash: {
        action: 'ALLOW',
        description: 'Shell command execution risk',
      },
      exec: {
        action: 'ALLOW',
        description: 'Arbitrary Code Execution (RCE) risk',
      },
      spawn: {
        action: 'ASK',
        description: 'Process spawning risk',
      },
    },
    Browser: {
      navigate: {
        action: 'ASK',
        description: 'Navigation can trigger auth walls and sensitive workflows',
      },
      click: {
        action: 'ASK',
        description: 'Clicks can submit irreversible actions',
      },
      type: {
        action: 'ASK',
        description: 'Typing can submit credentials or confirmations',
      },
      evaluate: {
        action: 'ASK',
        description: 'Browser script execution may bypass UI safeguards',
      },
      screenshot: {
        action: 'ALLOW',
        description: 'Screenshots are allowed to support challenge verification',
      },
    },
    Gateway: {
      sendMessage: {
        action: 'ASK',
        description: 'Outbound messages may be irreversible/public',
      },
    },
    Network: {
      fetch: {
        action: 'ASK',
        description: 'Potential data exfiltration',
      },
      request: {
        action: 'ASK',
        description: 'HTTP request may leak data',
      },
    },
    Gmail: {
      list: {
        action: 'ALLOW',
        description: 'Read-only message headers/labels',
      },
      read: {
        action: 'ALLOW',
        description: 'Read-only message bodies',
      },
      download: {
        action: 'ASK',
        description: 'Saving attachments locally',
      },
      draft: {
        action: 'ALLOW',
        description: 'Creating drafts is generally harmless',
      },
      send: {
        action: 'ASK',
        description: 'Outbound communication',
      },
      write: {
        action: 'ASK',
        description: 'Modifying labels, marking as read/unread',
      },
      delete: {
        action: 'DENY',
        description: 'Deleting emails should be strictly prohibited by default',
      },
    },
    GoogleDrive: {
      list: {
        action: 'ALLOW',
        description: 'Read-only directory listing',
      },
      read: {
        action: 'ALLOW',
        description: 'Read-only file access',
      },
      download: {
        action: 'ASK',
        description: 'Moves data out of Google Drive',
      },
      upload: {
        action: 'ASK',
        description: 'Creates or overwrites files in Google Drive',
      },
      write: {
        action: 'ASK',
        description: 'Modifies existing Google Drive files',
      },
      delete: {
        action: 'ASK',
        description: 'Permanently removes files from Google Drive',
      },
      share: {
        action: 'ASK',
        description: 'Changes access permissions on Google Drive files',
      },
      move: {
        action: 'ASK',
        description: 'Relocates files within Google Drive',
      },
    },
    Memory: {
      search: {
        action: 'ALLOW',
        description: 'Searching memory is read-only',
      },
      add: {
        action: 'ASK',
        description: 'Adding memory requires approval',
      },
      delete: {
        action: 'ASK',
        description: 'Deleting memory requires approval',
      },
    },
    Process: {
      list: {
        action: 'ALLOW',
        description: 'Read-only listing of running and finished processes',
      },
      poll: {
        action: 'ALLOW',
        description: 'Read-only draining of process output',
      },
      log: {
        action: 'ALLOW',
        description: 'Read-only aggregated process output',
      },
      write: {
        action: 'ASK',
        description: 'Sending input to a process can execute commands or change state',
      },
      kill: {
        action: 'ASK',
        description: 'Terminating a background session requires approval',
      },
      clear: {
        action: 'ALLOW',
        description: 'Removing a finished process from manager memory is safe',
      },
      remove: {
        action: 'ASK',
        description: 'Removing a process may kill it if it is running',
      },
    },
  },
};
