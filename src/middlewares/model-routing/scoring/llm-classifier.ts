/**
 * LLM Fallback Classifier — Disambiguates ambiguous scoring results.
 *
 * Ported from ClawRouter's llm-classifier.ts:
 *  - Triggered only when scorer confidence < threshold
 *  - Calls the cheapest configured model with a classification prompt
 *  - In-memory cache with configurable TTL (default 1 hour)
 *  - Graceful degradation: on any error, defaults to STANDARD
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { createHash } from 'crypto';
import { Tier, ClassifierConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Classification prompt
// ---------------------------------------------------------------------------

const CLASSIFIER_PROMPT = `You are a query complexity classifier. Classify the user's query into exactly one category.

Categories:
- SIMPLE: Factual Q&A, definitions, translations, short answers
- STANDARD: Summaries, explanations, moderate code generation
- COMPLEX: Multi-step code, system design, creative writing, analysis
- REASONING: Mathematical proofs, formal logic, step-by-step problem solving

Respond with ONLY one word: SIMPLE, STANDARD, COMPLEX, or REASONING.`;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  tier: Tier;
  expires: number;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 1000;

function cacheKey(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expires < now) cache.delete(key);
  }
  // If still over limit, remove oldest
  if (cache.size > MAX_CACHE_SIZE) {
    const keys = [...cache.keys()];
    for (let i = 0; i < keys.length - MAX_CACHE_SIZE; i++) {
      cache.delete(keys[i]);
    }
  }
}

// ---------------------------------------------------------------------------
// Tier parsing
// ---------------------------------------------------------------------------

const TIER_PATTERNS: Array<{ tier: Tier; regex: RegExp }> = [
  { tier: 'REASONING', regex: /\bREASONING\b/ },
  { tier: 'COMPLEX', regex: /\bCOMPLEX\b/ },
  { tier: 'STANDARD', regex: /\bSTANDARD\b/ },
  { tier: 'SIMPLE', regex: /\bSIMPLE\b/ },
];

function parseTier(content: string): Tier | null {
  const upper = content.toUpperCase();
  for (const { tier, regex } of TIER_PATTERNS) {
    if (regex.test(upper)) return tier;
  }
  return null;
}

// ---------------------------------------------------------------------------
// LLM classification
// ---------------------------------------------------------------------------

/**
 * Classify a prompt's complexity by calling a cheap LLM.
 *
 * @param promptPreview   First N chars of the user prompt
 * @param config          Classifier configuration
 * @param baseUrl         LLM API base URL
 * @param apiKey          LLM API key
 * @returns               The classified tier, or null if classification fails
 */
export async function classifyWithLLM(
  promptPreview: string,
  config: ClassifierConfig,
  baseUrl: string,
  apiKey: string
): Promise<{ tier: Tier; confidence: number } | null> {
  const truncated = promptPreview.slice(0, config.truncationChars);

  // Check cache
  const key = cacheKey(truncated);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    return { tier: cached.tier, confidence: 0.75 };
  }

  try {
    const result = await callLLM(truncated, config, baseUrl, apiKey);
    if (!result) return null;

    const tier = parseTier(result);
    if (!tier) return null;

    // Cache result
    cache.set(key, { tier, expires: Date.now() + config.cacheTtlMs });
    if (cache.size > MAX_CACHE_SIZE) pruneCache();

    return { tier, confidence: 0.75 };
  } catch {
    return null; // Graceful degradation
  }
}

/**
 * Clear the classifier cache.
 */
export function clearClassifierCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// HTTP call to LLM
// ---------------------------------------------------------------------------

function callLLM(
  prompt: string,
  config: ClassifierConfig,
  baseUrl: string,
  apiKey: string
): Promise<string | null> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: CLASSIFIER_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      stream: false,
    });

    const parsed = new URL(baseUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: (parsed.pathname.replace(/\/$/, '') || '') + '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 5000,
    };

    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          const content = data?.choices?.[0]?.message?.content?.trim() ?? '';
          resolve(content || null);
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}
