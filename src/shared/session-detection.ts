/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Session Detection — Identifies OpenClaw session startup messages.
 *
 * When a user types /new or /reset in OpenClaw, a generic session startup
 * message is injected into the user-role body of the next agent run. It is
 * a system instruction, not a real user prompt, and consumers of this
 * shared utility use it to exclude that message from their pipelines:
 *
 *   - model-routing: skips complexity scoring (would otherwise score the
 *     full reset prompt + bootstrap blob as STANDARD/COMPLEX)
 *   - context-editing: excludes the message from the threshold counter
 *     and from the ICC input transcript
 *
 * The regex matches the constants defined in
 * openclaw/src/auto-reply/reply/session-reset-prompt.ts:
 *   - BARE_SESSION_RESET_PROMPT_BASE
 *   - BARE_SESSION_RESET_PROMPT_BOOTSTRAP_PENDING
 *   - BARE_SESSION_RESET_PROMPT_BOOTSTRAP_LIMITED
 */

/**
 * Regex to detect the OpenClaw session startup message injected by /new or /reset.
 *
 * Known shapes (across openclaw versions):
 *   - "A new session was started via /new or /reset. Run your Session Startup sequence …"
 *       (BASE, openclaw <= 2026.4.11)
 *   - "A new session was started via /new or /reset. Execute your Session Startup sequence now …"
 *       (BASE, openclaw >= 2026.4.27)
 *   - "A new session was started via /new or /reset while bootstrap is still pending …"
 *       (BOOTSTRAP_PENDING / BOOTSTRAP_LIMITED, openclaw >= 2026.4.27)
 *
 * The regex is intentionally NOT anchored to start-of-string: openclaw >= 2026.4.27
 * may prepend a runtime-loaded "[Startup context loaded by runtime]" prelude (daily
 * memory blocks) ahead of the reset prompt within the same user-role message body.
 *
 * The literal phrase "A new session was started via /new or /reset" is unique enough
 * that organic user text matching it is effectively impossible — false-positive risk
 * is negligible without the anchor.
 */
export const SESSION_STARTUP_REGEX =
  /A new session was started via \/new or \/reset(?:\.\s*(?:Run|Execute) your Session Startup sequence|\s+while bootstrap is still pending)/;

/**
 * Check whether the given text is an OpenClaw session startup message.
 */
export function isSessionStartupMessage(text: string): boolean {
  return SESSION_STARTUP_REGEX.test(text.trim());
}
