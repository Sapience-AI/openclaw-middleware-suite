/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Sapience Middleware TOTP Manager
 *
 * Manages Authenticator App (TOTP) setup and verification.
 * The TOTP secret is configured once during `sapience-middleware init`
 * and persisted to ~/.openclaw/sapience-middleware/totp.json.
 *
 * When configured, high-risk actions require a valid 6-digit TOTP code
 * instead of the legacy hex confirmation token.  If no TOTP secret is
 * configured the caller should fall back to simple YES/NO approval.
 */

import { TOTP, Secret } from 'otpauth';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '../../../shared/Logger.js';
import { HITL_TOTP_FILE, HITL_DIR } from '../../../shared/storage/paths.js';

// ---------------------------------------------------------------------------
// Persisted secret shape
// ---------------------------------------------------------------------------

export interface TotpSecretData {
  /** Base32-encoded TOTP secret. */
  secret: string;
  /** Issuer label shown in authenticator apps. */
  issuer: string;
  /** Account label shown in authenticator apps. */
  account: string;
  /** ISO-8601 timestamp of when the secret was saved. */
  configuredAt: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const TOTP_FILE = HITL_TOTP_FILE;

const DEFAULT_ISSUER = 'SapienceMiddleware';
const DEFAULT_ACCOUNT = 'openclaw-user';

/** TOTP validity window: accept ±1 step (30 s each) to tolerate clock drift. */
const TOTP_WINDOW = 1;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildTOTP(secretBase32: string): TOTP {
  return new TOTP({
    issuer: DEFAULT_ISSUER,
    label: DEFAULT_ACCOUNT,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

// ---------------------------------------------------------------------------
// Public API — all methods are synchronous (file I/O is tiny)
// ---------------------------------------------------------------------------

export class TotpManager {
  /**
   * Generate a fresh TOTP secret.
   * Returns the base32 string that the user enters into their authenticator app.
   */
  static generateSecret(): { secret: string; manualSetupCode: string } {
    const secret = new Secret({ size: 20 });
    const base32 = secret.base32;
    return { secret: base32, manualSetupCode: base32 };
  }

  /**
   * Verify a 6-digit TOTP code against the stored secret.
   * Returns true if the code is valid within the tolerance window.
   */
  static verifyCode(code: string): boolean {
    const data = TotpManager.loadSecret();
    if (!data) {
      logger.warn('[totp] verifyCode called but no TOTP secret is configured');
      return false;
    }

    const totp = buildTOTP(data.secret);
    const delta = totp.validate({ token: code.trim(), window: TOTP_WINDOW });
    // delta is null when the token is invalid, otherwise an integer offset.
    const valid = delta !== null;

    logger.info('[totp] Code verification', { valid, delta });
    return valid;
  }

  /**
   * Check whether a TOTP secret has been configured (file exists and is parseable).
   */
  static isConfigured(): boolean {
    try {
      if (!existsSync(TOTP_FILE)) return false;
      const raw = readFileSync(TOTP_FILE, 'utf-8');
      const data: TotpSecretData = JSON.parse(raw);
      return typeof data.secret === 'string' && data.secret.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Persist a TOTP secret to disk.
   */
  static saveSecret(secretBase32: string): void {
    if (!existsSync(HITL_DIR)) {
      mkdirSync(HITL_DIR, { recursive: true });
    }

    const data: TotpSecretData = {
      secret: secretBase32,
      issuer: DEFAULT_ISSUER,
      account: DEFAULT_ACCOUNT,
      configuredAt: new Date().toISOString(),
    };

    writeFileSync(TOTP_FILE, JSON.stringify(data, null, 2), 'utf-8');
    logger.info('[totp] Secret saved', { path: TOTP_FILE });
  }

  /**
   * Load the stored TOTP secret, or return undefined if not configured.
   */
  static loadSecret(): TotpSecretData | undefined {
    try {
      if (!existsSync(TOTP_FILE)) return undefined;
      const raw = readFileSync(TOTP_FILE, 'utf-8');
      return JSON.parse(raw) as TotpSecretData;
    } catch (err) {
      logger.warn('[totp] Failed to load TOTP secret', { error: err });
      return undefined;
    }
  }

  /**
   * Return the base32 secret string for manual entry in an Authenticator App.
   * Returns undefined if not configured.
   */
  static getManualSetupCode(): string | undefined {
    return TotpManager.loadSecret()?.secret;
  }

  /**
   * Get the path to the TOTP configuration file.
   */
  static getPath(): string {
    return TOTP_FILE;
  }
}
