/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * ICC Extraction Detection — Identifies Context Editing's structured-output
 * compaction calls so Model Routing can route them deterministically.
 *
 * When CE's ContextCurator invokes `runEmbeddedPiAgent` for ICC entity /
 * conflict / priority extraction, it prepends `ICC_EXTRACTION_MARKER` to the
 * prompt body. If that body lands in MR's proxy (because the user set the
 * compaction model to a `sai-router/*` profile), MR's scoring override
 * detects the marker and forces SIMPLE — bypassing keyword scoring,
 * tool-floor, and structured-output floor.
 *
 * Why this exists: ICC's prompt is one structured-extraction job — a fixed
 * shape, fixed cost, fixed quality requirement (just JSON parsing). But its
 * body contains the entire transcript being compacted, which is content-rich
 * and routinely scores COMPLEX/REASONING under MR's keyword scorer. Without
 * this signal, MR routes ICC calls to the user's most expensive tier on
 * every compaction.
 *
 * This is consumed by:
 *   - Context Editing: prepended to the prompt in `ContextCurator.ts`
 *   - Model Routing: detected in `overrides.ts` for the icc_extraction override
 */

/**
 * Sentinel string CE prepends to ICC extraction prompts. Chosen to be:
 *   - unique enough that organic user content can't accidentally match
 *     (square-bracket wrapped, all-caps, internal namespace prefix)
 *   - short and inert — modern LLMs treat it as a discardable header tag
 *   - LLM-tolerant — does not look like a system instruction or jailbreak
 *
 * If the value is ever changed, both consumers must be updated together.
 */
export const ICC_EXTRACTION_MARKER = '[SAI:ICC_EXTRACTION]';

/**
 * Check whether the given text is a CE ICC extraction call.
 *
 * Uses `includes` rather than `startsWith` so the detection survives any
 * future runtime that wraps or prefixes the body before it reaches MR.
 * The marker is unique enough that false positives are negligible.
 */
export function isIccExtractionCall(text: string): boolean {
  return text.includes(ICC_EXTRACTION_MARKER);
}

/**
 * Remove the marker from `text` so the upstream LLM provider never sees it.
 *
 * MR's proxy calls this AFTER the icc_extraction override has fired and
 * BEFORE forwarding the body upstream. Strips the marker, the immediately-
 * following `\n\n` separator (the form CE writes), and any remaining
 * leading whitespace.
 *
 * If the marker isn't present, returns the input unchanged.
 */
export function stripIccMarker(text: string): string {
  const idx = text.indexOf(ICC_EXTRACTION_MARKER);
  if (idx === -1) return text;
  const before = text.slice(0, idx);
  const after = text.slice(idx + ICC_EXTRACTION_MARKER.length);
  // Strip the leading separator CE writes after the marker. We accept a
  // few common separators rather than only the literal `\n\n` we emit,
  // so a future formatting tweak in CE doesn't leave a stray blank line.
  const trimmedAfter = after.replace(/^[\s]*/, '');
  // If the marker was at the start (typical case), `before` is empty and
  // we just return the cleaned tail. Otherwise preserve the prefix exactly
  // (some envelope wrapped the body) and join.
  return before.length === 0 ? trimmedAfter : `${before}${trimmedAfter}`;
}
