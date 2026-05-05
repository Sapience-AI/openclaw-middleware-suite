/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Provider Auth Helper — Discovers which LLM providers have API keys configured.
 *
 * Uses OpenClaw's plugin-sdk/provider-auth to check auth profiles without
 * reading auth-profiles.json directly.  Falls back gracefully when the SDK
 * is not resolvable (e.g., running outside the OpenClaw process).
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../../../shared/Logger.js';
import {
  getOpenclawHome,
  getOpenAIApiKey,
  getAnthropicApiKey,
  getGoogleApiKey,
} from '../../../shared/env.js';

// ---------------------------------------------------------------------------
// SDK resolution
// ---------------------------------------------------------------------------

interface ProviderAuthSdk {
  ensureAuthProfileStore: (agentDir?: string, opts?: { allowKeychainPrompt?: boolean }) => unknown;
  listProfilesForProvider: (store: unknown, provider: string) => string[];
  isProviderApiKeyConfigured?: (params: { provider: string; agentDir?: string }) => boolean;
}

async function resolveProviderAuthSdk(): Promise<ProviderAuthSdk | null> {
  const anchors = [process.argv[1], __filename].filter(Boolean);

  for (const anchor of anchors) {
    try {
      const hostRequire = createRequire(anchor);
      const sdkPath = hostRequire.resolve('openclaw/plugin-sdk/provider-auth');
      const mod = await import(sdkPath);
      if (
        typeof mod.ensureAuthProfileStore === 'function' &&
        typeof mod.listProfilesForProvider === 'function'
      ) {
        return mod as unknown as ProviderAuthSdk;
      }
    } catch {
      continue;
    }
  }
  logger.debug('[provider-auth] Could not resolve openclaw/plugin-sdk/provider-auth');
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Provider IDs matching openclaw auth profile and LiteLLM catalog. */
const ALL_PROVIDERS = ['openai', 'anthropic', 'google'] as const;

/** Default base URLs per provider. */
const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
};

/** Provider format for the routing middleware. */
const PROVIDER_FORMATS: Record<string, 'openai' | 'anthropic' | 'google'> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
};

/**
 * Returns the set of providers that have at least one configured API key
 * in OpenClaw's auth profile store.
 *
 * Gracefully returns all providers if the SDK is not available (so the
 * wizard falls back to showing everything).
 */
export async function getConfiguredProviders(): Promise<Set<string>> {
  const sdk = await resolveProviderAuthSdk();
  if (!sdk) {
    logger.debug('[provider-auth] SDK not available — returning all providers');
    return new Set<string>(ALL_PROVIDERS);
  }

  const openclawHome = getOpenclawHome() || path.join(os.homedir(), '.openclaw');
  const agentDir = path.join(openclawHome, 'agents', 'main');

  const configured = new Set<string>();

  for (const provider of ALL_PROVIDERS) {
    try {
      // Try the convenience helper first
      if (sdk.isProviderApiKeyConfigured) {
        if (sdk.isProviderApiKeyConfigured({ provider, agentDir })) {
          configured.add(provider);
          continue;
        }
      }

      // Manual check via store
      const store = sdk.ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
      if (sdk.listProfilesForProvider(store, provider).length > 0) {
        configured.add(provider);
      }
    } catch (err) {
      logger.debug(`[provider-auth] Error checking provider "${provider}"`, { error: err });
    }
  }

  // If nothing was detected (possibly all keys in env vars we couldn't check),
  // fall back to showing everything rather than an empty list.
  if (configured.size === 0) {
    logger.debug('[provider-auth] No providers detected — returning all as fallback');
    return new Set<string>(ALL_PROVIDERS);
  }

  return configured;
}

// ---------------------------------------------------------------------------
// API key extraction — env vars → OpenClaw auth profiles
// ---------------------------------------------------------------------------

/** Env-var getter for each provider's API key. */
const PROVIDER_KEY_GETTERS: Record<string, () => string | undefined> = {
  openai: getOpenAIApiKey,
  anthropic: getAnthropicApiKey,
  google: getGoogleApiKey,
};

/**
 * Read API key for a provider from env vars or OpenClaw auth profiles.
 * Returns undefined if no key is found.
 */
function readApiKeyFromAuthProfiles(provider: string): string | undefined {
  const openclawHome = getOpenclawHome() || path.join(os.homedir(), '.openclaw');
  const authPath = path.join(openclawHome, 'agents', 'main', 'agent', 'auth-profiles.json');

  try {
    const raw = JSON.parse(readFileSync(authPath, 'utf8'));
    if (!raw?.profiles || typeof raw.profiles !== 'object') return undefined;

    // OpenClaw format: profiles["provider:profileId"] = { type, provider, key }
    for (const [, profile] of Object.entries(raw.profiles)) {
      const p = profile as Record<string, unknown>;
      if (p.provider === provider && typeof p.key === 'string' && p.key.length > 0) {
        return p.key;
      }
    }
  } catch {
    // File doesn't exist or can't be parsed — that's fine
  }
  return undefined;
}

/**
 * Resolve API key for a provider. Checks:
 *  1. Environment variables (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY)
 *  2. OpenClaw auth profiles (~/.openclaw/agents/main/agent/auth-profiles.json)
 */
export function getApiKeyForProvider(provider: string): string | undefined {
  // 1. Env var
  const fromEnv = PROVIDER_KEY_GETTERS[provider]?.();
  if (fromEnv) return fromEnv;

  // 2. OpenClaw auth profiles
  return readApiKeyFromAuthProfiles(provider);
}

/**
 * Build a ProviderConfig for a given provider name, resolving the API key
 * from available sources (env vars, OpenClaw auth profiles).
 * Returns undefined if no API key can be found.
 */
export function resolveProviderConfig(
  provider: string
):
  | { name: string; baseUrl: string; apiKey: string; format: 'openai' | 'anthropic' | 'google' }
  | undefined {
  const resolved = getApiKeyForProvider(provider);
  if (!resolved) return undefined;

  const baseUrl =
    process.env[`${provider.toUpperCase()}_BASE_URL`] ||
    PROVIDER_BASE_URLS[provider] ||
    PROVIDER_BASE_URLS.openai;
  const format = PROVIDER_FORMATS[provider] || 'openai';

  return { name: provider, baseUrl, apiKey: resolved, format };
}
