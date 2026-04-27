/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Centralized environment-variable access.
 *
 * Every module that reads an environment variable should import a getter from
 * here instead of reading env values directly. This keeps env access isolated
 * to one file that does no I/O, so modules that make network calls contain
 * no env reads.
 */

// ── Provider credentials ─────────────────────────────────────────────

export function getOpenAIApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY;
}

export function getOpenAIBaseUrl(): string | undefined {
  return process.env.OPENAI_BASE_URL;
}

export function getAnthropicApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY;
}

export function getGoogleApiKey(): string | undefined {
  return process.env.GOOGLE_API_KEY;
}

// ── OpenClaw app paths ───────────────────────────────────────────────

export function getOpenclawHome(): string | undefined {
  return process.env.OPENCLAW_HOME;
}

export function getOpenclawDir(): string | undefined {
  return process.env.OPENCLAW_DIR;
}

export function getOpenclawConfig(): string | undefined {
  return process.env.OPENCLAW_CONFIG;
}

export function getOpenclawPluginId(): string | undefined {
  return process.env.OPENCLAW_PLUGIN_ID;
}

export function getOpenclawPluginDir(): string | undefined {
  return process.env.OPENCLAW_PLUGIN_DIR;
}

// ── Sapience middleware config ───────────────────────────────────────

export function getSessionKey(): string | undefined {
  return process.env.SAPIENCE_MW_SESSION_KEY;
}

export function getSecurityLevel(): string | undefined {
  return process.env.SAPIENCE_MW_SECURITY_LEVEL;
}

export function getModules(): string | undefined {
  return process.env.SAPIENCE_MW_MODULES;
}

// ── Logging ──────────────────────────────────────────────────────────

export function getLogLevel(): string | undefined {
  return process.env.LOG_LEVEL;
}

// ── OS ───────────────────────────────────────────────────────────────

export function getHome(): string | undefined {
  return process.env.HOME;
}

export function getUserProfile(): string | undefined {
  return process.env.USERPROFILE;
}
