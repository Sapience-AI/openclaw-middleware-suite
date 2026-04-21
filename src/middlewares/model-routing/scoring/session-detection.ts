/**
 * Session Detection — Identifies OpenClaw session startup messages.
 *
 * When a user types /new or /reset in OpenClaw, a generic session startup
 * message is injected as the first user message. This message is a system
 * instruction to the agent, not a real user prompt, and should not be
 * scored by the complexity engine (it would pollute tier classification).
 *
 * The regex matches the constant `BARE_SESSION_RESET_PROMPT_BASE` defined
 * in openclaw/src/auto-reply/reply/session-reset-prompt.ts.
 */

/**
 * Regex to detect the OpenClaw session startup message injected by /new or /reset.
 *
 * Matches the prefix:
 *   "A new session was started via /new or /reset. Run your Session Startup sequence"
 *
 * The BARE_SESSION_RESET_PROMPT_BASE constant uses the literal string
 * "/new or /reset" (it does NOT vary based on which command was used).
 * The regex must match this exact format, plus the individual forms
 * in case the prompt changes in the future.
 *
 * The full message also appends a current-time line, so we only match the
 * stable prefix. This is intentionally anchored to the start (^) to avoid
 * false positives on user messages that happen to mention sessions.
 */
export const SESSION_STARTUP_REGEX =
  /^A new session was started via \/new or \/reset\.\s*Run your Session Startup sequence/;

/**
 * Check whether the given text is an OpenClaw session startup message.
 */
export function isSessionStartupMessage(text: string): boolean {
  return SESSION_STARTUP_REGEX.test(text.trim());
}
