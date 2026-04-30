/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * OpenClaw Envelope Stripper — removes the AI-facing scaffolding OpenClaw
 * prepends to user-role message bodies before they reach an LLM provider.
 *
 * What OpenClaw injects on every user turn (verified across 2026.4.11 and
 * 2026.4.27):
 *
 *   1. A timestamp prefix at the start of the user-role message:
 *        "[Thu 2026-04-30 21:09 UTC] hello how are you?"
 *      Added by `injectTimestamp()` in
 *      openclaw/src/gateway/server-methods/agent-timestamp.ts.
 *
 *   2. Zero or more sentinel-delimited fenced-JSON metadata blocks
 *      (sender info, conversation info, replied-message context, etc.).
 *      Added by `buildInboundUserContextPrefix()` in
 *      openclaw/src/auto-reply/reply/inbound-meta.ts.
 *
 *      Each block has the shape:
 *        Sender (untrusted metadata):
 *        ```json
 *        { "label": "openclaw-control-ui", ... }
 *        ```
 *
 *      In 2026.4.11 the metadata is inlined into the user-role message body.
 *      In 2026.4.27 the chat-completion translator splits it into a separate
 *      `role: "custom"` API message — the sender block content is otherwise
 *      identical. Consumers must drop `role: "custom"` messages AND strip
 *      inlined sentinel blocks from the surviving user-role text.
 *
 * Why these envelopes are AI-facing only:
 *   - The model uses them to know who's writing, what channel, what the
 *     replied-to message was, etc.
 *   - Downstream tools that score, hash, fingerprint, or display the
 *     "user's actual question" must strip them, otherwise: complexity
 *     scorers see padded text, hashes mis-key the same prompt across
 *     senders, UIs leak metadata back into chat history.
 *
 * The official OpenClaw stripper lives at
 * openclaw/src/auto-reply/reply/strip-inbound-meta.ts (`stripInboundMetadata`).
 * This module re-implements just the parts downstream proxies / scorers /
 * curators need — the timestamp prefix and the sentinel-delimited blocks —
 * keeping the regex and sentinel list in lock-step with the OpenClaw source.
 *
 * Consumers in this repo:
 *   - Model Routing  : `extractText()` calls this before scoring so the
 *                       complexity scorer sees raw user intent, not envelope.
 *   - Context Editing: `extractCleanedTextForICC()` calls this so ICC's
 *                       entity / conflict / priority extraction is not
 *                       polluted by sender metadata.
 */

/**
 * Leading-timestamp regex — verbatim from OpenClaw's
 * `LEADING_TIMESTAMP_PREFIX_RE` in strip-inbound-meta.ts.
 *
 * Matches "[Mon YYYY-MM-DD HH:MM ...]" prefixes including optional timezone
 * suffix (e.g., " UTC", " America/New_York", " +0530"). Tolerant by design —
 * any non-`]` content after the time field is accepted.
 */
export const LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;

/**
 * Sentinel header strings that mark the start of an injected metadata block.
 * Kept in lock-step with `INBOUND_META_SENTINELS` in
 * openclaw/src/auto-reply/reply/strip-inbound-meta.ts.
 *
 * If OpenClaw adds a new sentinel, mirror it here — until then, that
 * envelope shape will pass through scoring/extraction unchanged (which
 * matches today's behavior, never worse).
 */
export const INBOUND_META_SENTINELS = [
  'Conversation info (untrusted metadata):',
  'Sender (untrusted metadata):',
  'Thread starter (untrusted, for context):',
  'Replied message (untrusted, for context):',
  'Forwarded message context (untrusted metadata):',
  'Chat history since last reply (untrusted, for context):',
] as const;

const SENTINEL_FAST_RE = new RegExp(
  INBOUND_META_SENTINELS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
);

function isInboundMetaSentinelLine(line: string): boolean {
  const trimmed = line.trim();
  return INBOUND_META_SENTINELS.some((sentinel) => sentinel === trimmed);
}

/**
 * Remove the timestamp prefix and every sentinel-delimited fenced-JSON
 * metadata block from `text`. Returns the original string unchanged when
 * no envelope is present (zero-allocation fast path).
 *
 * Each metadata block has the shape:
 *
 *     <sentinel-line>
 *     ```json
 *     { ... }
 *     ```
 *
 * Lines outside a recognized envelope are passed through unchanged. If a
 * sentinel is not followed by a ` ```json ` opening fence, the sentinel
 * itself is treated as user content (defensive — avoids stripping legit
 * user text that happens to contain a sentinel string).
 */
export function stripOpenClawEnvelope(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;

  // Fast path: no timestamp AND no sentinel → return as-is, zero allocation.
  const hasTimestamp = LEADING_TIMESTAMP_PREFIX_RE.test(text);
  const hasSentinel = SENTINEL_FAST_RE.test(text);
  if (!hasTimestamp && !hasSentinel) return text;

  // Strip the leading timestamp (if any) before walking lines.
  const withoutTimestamp = hasTimestamp ? text.replace(LEADING_TIMESTAMP_PREFIX_RE, '') : text;
  if (!SENTINEL_FAST_RE.test(withoutTimestamp)) {
    return withoutTimestamp.trim();
  }

  // Walk lines and drop sentinel-delimited fenced JSON blocks.
  const lines = withoutTimestamp.split('\n');
  const out: string[] = [];
  let inMetaBlock = false;
  let inFencedJson = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inMetaBlock && isInboundMetaSentinelLine(line)) {
      // Only strip the sentinel if a fenced JSON block follows it. Otherwise
      // treat the sentinel line as ordinary user content.
      const next = lines[i + 1];
      if (next?.trim() !== '```json') {
        out.push(line);
        continue;
      }
      inMetaBlock = true;
      inFencedJson = false;
      continue;
    }

    if (inMetaBlock) {
      if (!inFencedJson && line.trim() === '```json') {
        inFencedJson = true;
        continue;
      }
      if (inFencedJson) {
        if (line.trim() === '```') {
          inMetaBlock = false;
          inFencedJson = false;
        }
        continue;
      }
      // Blank separator between consecutive blocks — drop.
      if (line.trim() === '') continue;
      // Unexpected non-blank line — bail out of the meta state and emit
      // this line as user content (defensive against malformed envelopes).
      inMetaBlock = false;
    }

    out.push(line);
  }

  return out.join('\n').replace(/^\n+/, '').replace(/\n+$/, '').trim();
}
