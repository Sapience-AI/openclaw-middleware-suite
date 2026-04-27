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
 * Sapience Middleware ApprovalQueue
 * In-memory store for channel-based ASK approvals (daemon / messaging mode).
 */

import crypto from 'crypto';
import { logger } from '../../../shared/Logger.js';

// ---------------------------------------------------------------------------
// Argument hashing — binds an approval to the exact args shown to the user.
// ---------------------------------------------------------------------------

/**
 * Produce a short, stable SHA-256 fingerprint of any serialisable value.
 * Used to bind an approval entry to the specific arguments that were
 * shown to the human, preventing an agent from substituting different
 * arguments after the approval is granted.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const val = (value as Record<string, unknown>)[k];
    if (val !== undefined) {
      parts.push(JSON.stringify(k) + ':' + stableStringify(val));
    }
  }
  return '{' + parts.join(',') + '}';
}

export function hashArgs(args: unknown): string {
  let raw: string;
  try {
    raw = stableStringify(args);
  } catch {
    raw = String(args);
  }
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export interface ApprovalRequestOptions {
  requiresExplicitConfirmation?: boolean;
  actionSummary?: string;
  allowRetryAsApproval?: boolean;
  /**
   * SHA-256 fingerprint of the arguments that triggered the ASK.
   * When set, `consume()` will reject calls whose args produce a different hash,
   * preventing an agent from substituting arguments after the user approves.
   */
  argsHash?: string;
  /** The exact arguments that were requested, so they can be displayed on approval. */
  args?: unknown;
}

export interface ApprovalEntry {
  sessionKey: string;
  moduleName: string;
  methodName: string;
  requiresExplicitConfirmation: boolean;
  actionSummary?: string;
  allowRetryAsApproval: boolean;
  status: 'pending' | 'approved' | 'denied';
  createdAt: number;
  expiresAt: number;
  /**
   * SHA-256 fingerprint of the arguments that were shown to the human
   * when the approval was requested. Verified on consume() to prevent
   * argument substitution after the user grants approval.
   */
  argsHash: string;
  /** The exact arguments that were requested, so they can be displayed on approval. */
  args?: unknown;
}

/** Default time-to-live for an approval entry (2 minutes). */
const DEFAULT_TTL_MS = 120_000;

/**
 * Maximum age for a pending entry before a new one is created on re-request.
 */
const CONSUME_MAX_AGE_MS = 60_000;

/** Cleanup runs at most every 30 seconds. */
const CLEANUP_INTERVAL_MS = 30_000;

export class ApprovalQueue {
  private entries = new Map<string, ApprovalEntry>();
  private lastCleanup = Date.now();
  private ttl: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttl = ttlMs;
  }

  // ---------------------------------------------------------------------------
  // Key helpers
  // ---------------------------------------------------------------------------

  /** Composite key: one pending per session + module.method */
  private key(sessionKey: string, moduleName: string, methodName: string): string {
    return `${sessionKey}::${moduleName}.${methodName}`;
  }

  // ---------------------------------------------------------------------------
  // Core API
  // ---------------------------------------------------------------------------

  request(
    sessionKey: string,
    moduleName: string,
    methodName: string,
    options: ApprovalRequestOptions = {}
  ): string {
    this.maybeCleanup();
    const k = this.key(sessionKey, moduleName, methodName);
    const existing = this.entries.get(k);

    if (existing && existing.status === 'pending' && Date.now() < existing.expiresAt) {
      const age = Date.now() - existing.createdAt;
      if (age <= CONSUME_MAX_AGE_MS) {
        logger.debug(`ApprovalQueue: pending already exists within retry window, skipping`, {
          sessionKey,
          action: `${moduleName}.${methodName}`,
          ageMs: age,
        });
        return k;
      }
    }

    const entry: ApprovalEntry = {
      sessionKey,
      moduleName,
      methodName,
      requiresExplicitConfirmation: options.requiresExplicitConfirmation ?? false,
      actionSummary: options.actionSummary,
      allowRetryAsApproval: options.allowRetryAsApproval ?? true,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttl,
      argsHash: options.argsHash ?? '',
      args: options.args,
    };

    this.entries.set(k, entry);
    logger.info(`ApprovalQueue: pending request created`, {
      sessionKey,
      action: `${moduleName}.${methodName}`,
      requiresExplicitConfirmation: entry.requiresExplicitConfirmation,
      argsHash: entry.argsHash,
    });
    return k;
  }

  /**
   * Attempt to consume an approved entry.
   *
   * @param argsHash - SHA-256 fingerprint of the arguments being executed now.
   *   Must match the hash recorded at request() time. If the entry has an empty
   *   hash (legacy / no-args case) the check is skipped for backward compatibility.
   *   Pass the result of `hashArgs(args)` from the caller.
   */
  consume(sessionKey: string, moduleName: string, methodName: string, argsHash: string): boolean {
    const k = this.key(sessionKey, moduleName, methodName);
    const entry = this.entries.get(k);

    if (entry && entry.status === 'approved' && Date.now() < entry.expiresAt) {
      // Verify argument fingerprint when both sides recorded a hash.
      // An empty hash on the entry means it was created before this feature
      // existed (or args were empty), so we skip the check to stay compatible.
      if (entry.argsHash && argsHash && entry.argsHash !== argsHash) {
        logger.warn(
          `ApprovalQueue.consume: argsHash mismatch — possible argument substitution attack`,
          {
            sessionKey,
            action: `${moduleName}.${methodName}`,
            expected: entry.argsHash,
            received: argsHash,
          }
        );
        // Invalidate the tampered entry immediately — do not leave it consumable.
        this.entries.delete(k);
        return false;
      }

      this.entries.delete(k);
      logger.info(`ApprovalQueue: approval consumed`, {
        sessionKey,
        action: `${moduleName}.${methodName}`,
        argsHash,
      });
      return true;
    }

    const expired = entry ? Date.now() >= entry.expiresAt : false;
    logger.debug(`ApprovalQueue.consume: not found/not approved`, {
      sessionKey,
      action: `${moduleName}.${methodName}`,
      entryStatus: entry?.status ?? 'missing',
      expired,
      queueSize: this.entries.size,
    });
    return false;
  }

  // ---------------------------------------------------------------------------
  // Session-based resolution (replaces token-based lookup)
  // ---------------------------------------------------------------------------

  /**
   * Resolve a pending entry by session + module.method.
   * Used when the human approves/denies via /approve or /deny commands.
   */
  resolveBySession(
    sessionKey: string,
    moduleName: string,
    methodName: string,
    decision: 'approve' | 'deny'
  ): boolean {
    this.maybeCleanup();
    const k = this.key(sessionKey, moduleName, methodName);
    const entry = this.entries.get(k);

    if (!entry || entry.status !== 'pending' || Date.now() >= entry.expiresAt) {
      return false;
    }

    if (decision === 'approve') {
      entry.status = 'approved';
      entry.expiresAt = Date.now() + this.ttl;
      logger.info('ApprovalQueue: resolved (approved) by session', {
        sessionKey,
        action: `${moduleName}.${methodName}`,
      });
    } else {
      this.entries.delete(k);
      logger.info('ApprovalQueue: resolved (denied) by session', {
        sessionKey,
        action: `${moduleName}.${methodName}`,
      });
    }
    return true;
  }

  /**
   * Peek at the most recently created pending entry without resolving it.
   */
  peekLatestPending(): { key: string; entry: ApprovalEntry } | undefined {
    this.maybeCleanup();
    let latest: { key: string; entry: ApprovalEntry } | undefined;

    for (const [k, entry] of this.entries) {
      if (entry.status !== 'pending' || Date.now() >= entry.expiresAt) continue;
      if (!latest || entry.createdAt > latest.entry.createdAt) {
        latest = { key: k, entry };
      }
    }

    return latest;
  }

  /**
   * Resolve the most recently created pending entry across all sessions.
   * Used by the /approve and /deny commands when session context is not available.
   */
  resolveLatestPending(decision: 'approve' | 'deny'): boolean {
    this.maybeCleanup();
    let latest: { key: string; entry: ApprovalEntry } | undefined;

    for (const [k, entry] of this.entries) {
      if (entry.status !== 'pending' || Date.now() >= entry.expiresAt) continue;
      if (!latest || entry.createdAt > latest.entry.createdAt) {
        latest = { key: k, entry };
      }
    }

    if (!latest) return false;

    if (decision === 'approve') {
      latest.entry.status = 'approved';
      latest.entry.expiresAt = Date.now() + this.ttl;
      logger.info('ApprovalQueue: resolved (approved) latest pending', {
        action: `${latest.entry.moduleName}.${latest.entry.methodName}`,
      });
    } else {
      this.entries.delete(latest.key);
      logger.info('ApprovalQueue: resolved (denied) latest pending', {
        action: `${latest.entry.moduleName}.${latest.entry.methodName}`,
      });
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Legacy token-based resolution (kept for backward compatibility)
  // ---------------------------------------------------------------------------

  /**
   * Resolve any pending entry that has the given token.
   * @deprecated Use resolveBySession() or resolveLatestPending() instead.
   */
  resolveByToken(token: string, decision: 'approve' | 'deny'): boolean {
    this.maybeCleanup();
    const normalized = token.trim().toUpperCase();

    for (const [k, entry] of this.entries) {
      if (entry.status !== 'pending' || Date.now() >= entry.expiresAt) continue;
      // Legacy token matching — no longer generated but kept for transition
      if (k.includes(normalized)) {
        if (decision === 'approve') {
          entry.status = 'approved';
          entry.expiresAt = Date.now() + this.ttl;
        } else {
          this.entries.delete(k);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Return summary for a pending entry in one call.
   * Used by the OOB notifier to build the notification message sent to the human.
   */
  getNotificationInfo(
    sessionKey: string,
    moduleName: string,
    methodName: string
  ): { summary?: string; requiresExplicit: boolean } | undefined {
    const k = this.key(sessionKey, moduleName, methodName);
    const entry = this.entries.get(k);
    if (!entry || entry.status !== 'pending' || Date.now() >= entry.expiresAt) return undefined;
    return { summary: entry.actionSummary, requiresExplicit: entry.requiresExplicitConfirmation };
  }

  /**
   * Stall the caller until the entry is approved, denied, or times out.
   * Polls every 500 ms. Returns true if approved, false otherwise.
   */
  waitForApproval(
    sessionKey: string,
    moduleName: string,
    methodName: string,
    timeoutMs: number = DEFAULT_TTL_MS
  ): Promise<boolean> {
    const k = this.key(sessionKey, moduleName, methodName);
    const deadline = Date.now() + timeoutMs;

    return new Promise<boolean>((resolve) => {
      const tick = (): void => {
        const entry = this.entries.get(k);

        if (!entry || Date.now() >= entry.expiresAt) {
          logger.info('ApprovalQueue: stall ended — expired or removed', {
            sessionKey,
            action: `${moduleName}.${methodName}`,
          });
          resolve(false);
          return;
        }

        if (entry.status === 'approved') {
          this.entries.delete(k);
          logger.info('ApprovalQueue: stall resolved (approved)', {
            sessionKey,
            action: `${moduleName}.${methodName}`,
          });
          resolve(true);
          return;
        }

        if (Date.now() >= deadline) {
          logger.info('ApprovalQueue: stall timed out', {
            sessionKey,
            action: `${moduleName}.${methodName}`,
          });
          resolve(false);
          return;
        }

        setTimeout(tick, 500);
      };

      setTimeout(tick, 500);
    });
  }

  // ---------------------------------------------------------------------------
  // Housekeeping
  // ---------------------------------------------------------------------------

  private maybeCleanup(): void {
    if (Date.now() - this.lastCleanup > CLEANUP_INTERVAL_MS) {
      this.cleanup();
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [k, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(k);
      }
    }
    this.lastCleanup = now;
  }
}

/** Singleton instance shared across the plugin. */
export const approvalQueue = new ApprovalQueue();
