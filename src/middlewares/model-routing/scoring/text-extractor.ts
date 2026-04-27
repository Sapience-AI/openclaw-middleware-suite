/*
 * Copyright (c) 2026 MNFST, Inc.
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * This file is derived from the Manifest project
 * (https://github.com/mnfst/manifest) and has been modified for use in
 * the OpenClaw Middleware Suite.
 *
 * Used under the MIT License — see NOTICE for the full license text.
 */

/**
 * Text Extractor — Extracts scorable text from chat completion messages.
 *
 * Key design decisions (from iblai):
 *  - Skips system/developer role messages (they inflate scores with repeated keywords)
 *  - Only takes the last N messages (default 3) to reflect current intent
 *  - Handles both string content and content-block arrays
 */

export interface ExtractionInput {
  messages?: Array<{
    role?: string;
    content?: unknown;
  }>;
}

/**
 * Extract text suitable for scoring from a chat completion request body.
 *
 * @param body        The request body containing messages[]
 * @param window      Number of recent messages to consider (default 3)
 * @param includeSystem  Whether to include system/developer messages (default false)
 * @returns The concatenated text for scoring
 */
export function extractText(body: ExtractionInput, window = 3, includeSystem = false): string {
  if (!body.messages || !Array.isArray(body.messages)) return '';

  // Filter out system/developer roles unless explicitly included
  const scorable = includeSystem
    ? body.messages
    : body.messages.filter((m) => m.role !== 'system' && m.role !== 'developer');

  // Take last N messages
  const recent = scorable.slice(-window);

  const parts: string[] = [];
  for (const msg of recent) {
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (
          block &&
          typeof block === 'object' &&
          'type' in block &&
          block.type === 'text' &&
          'text' in block &&
          typeof block.text === 'string'
        ) {
          parts.push(block.text);
        }
      }
    }
  }

  return parts.join(' ');
}

/**
 * Estimate token count from text (conservative: ~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total message tokens across ALL messages (for large-context override).
 */
export function estimateTotalTokens(body: ExtractionInput): number {
  if (!body.messages || !Array.isArray(body.messages)) return 0;

  let total = 0;
  for (const msg of body.messages) {
    if (typeof msg.content === 'string') {
      total += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (
          block &&
          typeof block === 'object' &&
          'text' in block &&
          typeof block.text === 'string'
        ) {
          total += block.text.length;
        }
      }
    }
  }
  return Math.ceil(total / 4);
}
