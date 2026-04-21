/**
 * Model Catalog — Fetches and caches model data from LiteLLM's pricing catalog.
 *
 * Source: https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
 *
 * Provides:
 *  - Real-time model pricing (input/output/cache per token)
 *  - Model capabilities (tool calling, vision, reasoning, streaming, etc.)
 *  - Context window sizes
 *  - Provider-based filtering
 *
 * Cached on disk with a 24h TTL to avoid repeated fetches.
 */

import fs from 'fs-extra';
import path from 'path';
import https from 'https';
import { logger } from '../../../shared/Logger.js';
import { MODEL_ROUTE_CATALOG_CACHE } from '../../../shared/storage/paths.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATALOG_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const CACHE_FILE = MODEL_ROUTE_CATALOG_CACHE;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw shape of a single model entry from LiteLLM's JSON. */
interface LiteLLMModelEntry {
  litellm_provider?: string;
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_tokens?: number;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  supports_native_streaming?: boolean;
  supports_prompt_caching?: boolean;
  supports_pdf_input?: boolean;
  supports_web_search?: boolean;
  supports_tool_choice?: boolean;
  supports_parallel_function_calling?: boolean;
  supports_system_messages?: boolean;
  supports_response_schema?: boolean;
  [key: string]: unknown;
}

/** Processed model entry exposed to the rest of the middleware. */
export interface CatalogModel {
  /** Model key as it appears in LiteLLM (e.g. "gemini/gemini-2.5-flash") */
  id: string;
  /** Clean display name (provider prefix stripped) */
  displayName: string;
  /** LiteLLM provider (e.g. "anthropic", "gemini", "openai") */
  litellmProvider: string;
  /** Normalised provider for openclaw auth matching ("openai"|"anthropic"|"google") */
  provider: string;
  /** Pricing per million tokens (USD) */
  pricing: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Context window limits */
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Capability flags */
  capabilities: {
    functionCalling: boolean;
    vision: boolean;
    reasoning: boolean;
    streaming: boolean;
    promptCaching: boolean;
    pdfInput: boolean;
    webSearch: boolean;
    toolChoice: boolean;
    parallelToolCalls: boolean;
    systemMessages: boolean;
    responseSchema: boolean;
  };
}

// ---------------------------------------------------------------------------
// Provider normalisation
// ---------------------------------------------------------------------------

/**
 * Map LiteLLM provider names to the provider IDs used by openclaw auth profiles.
 * Only providers we actively route to are mapped; the rest are ignored.
 */
const LITELLM_TO_AUTH_PROVIDER: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
};

const SUPPORTED_LITELLM_PROVIDERS = new Set(Object.keys(LITELLM_TO_AUTH_PROVIDER));

// ---------------------------------------------------------------------------
// Filtering helpers
// ---------------------------------------------------------------------------

/** Date-stamped model variant pattern (e.g. "-20260205", "-2025-04-14") */
export const DATE_SUFFIX_RE = /[-_]\d{4}[-]?\d{2}[-]?\d{2}(?:-v\d+)?$/;

/** Prefixes/patterns to exclude from the wizard list */
const EXCLUDE_PATTERNS = [
  /^ft:/, // fine-tuned
  /realtime/i, // realtime/streaming audio
  /audio/i, // audio-specific
  /transcribe/i, // transcription
  /tts/i, // text-to-speech
  /dall-e/i, // image generation
  /imagen/i, // image generation
  /veo/i, // video generation
  /lyria/i, // music generation
  /live-preview/i, // live preview (audio/video)
  /native-audio/i, // native audio
  /embedding/i, // embedding models
  /^\d+[-x]/, // dimension-prefixed (e.g. "1024-x-1024/dall-e-2")
  /container$/, // openai/container
];

function shouldExcludeModel(key: string): boolean {
  return EXCLUDE_PATTERNS.some((re) => re.test(key));
}

/**
 * For gemini models, strip the "gemini/" prefix. Used when building displayName.
 */
function stripGeminiPrefix(name: string): string {
  return name.replace(/^gemini\//, '');
}

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

function fetchJson(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 15_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        fetchJson(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

async function loadFromCache(): Promise<Record<string, LiteLLMModelEntry> | null> {
  try {
    if (!(await fs.pathExists(CACHE_FILE))) return null;
    const stat = await fs.stat(CACHE_FILE);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) {
      logger.debug('[model-catalog] Cache expired');
      return null;
    }
    return await fs.readJson(CACHE_FILE);
  } catch {
    return null;
  }
}

async function saveToCache(data: Record<string, LiteLLMModelEntry>): Promise<void> {
  try {
    await fs.ensureDir(path.dirname(CACHE_FILE));
    await fs.writeJson(CACHE_FILE, data);
  } catch (err) {
    logger.debug('[model-catalog] Failed to write cache', { error: err });
  }
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

function parseEntry(key: string, raw: LiteLLMModelEntry): CatalogModel | null {
  const litellmProvider = raw.litellm_provider;
  if (!litellmProvider || !SUPPORTED_LITELLM_PROVIDERS.has(litellmProvider)) return null;
  if (raw.mode !== 'chat') return null;
  if (shouldExcludeModel(key)) return null;

  const provider = LITELLM_TO_AUTH_PROVIDER[litellmProvider];
  const inputPerToken = raw.input_cost_per_token ?? 0;
  const outputPerToken = raw.output_cost_per_token ?? 0;
  const cacheReadPerToken = raw.cache_read_input_token_cost;
  const cacheWritePerToken = raw.cache_creation_input_token_cost;

  // Convert per-token to per-million-tokens
  const toPerMillion = (v: number) => v * 1_000_000;

  let displayName: string;
  if (litellmProvider === 'gemini') {
    displayName = stripGeminiPrefix(key);
  } else {
    displayName = key;
  }

  return {
    id: key,
    displayName,
    litellmProvider,
    provider,
    pricing: {
      input: toPerMillion(inputPerToken),
      output: toPerMillion(outputPerToken),
      cacheRead: cacheReadPerToken != null ? toPerMillion(cacheReadPerToken) : undefined,
      cacheWrite: cacheWritePerToken != null ? toPerMillion(cacheWritePerToken) : undefined,
    },
    maxInputTokens: raw.max_input_tokens ?? 0,
    maxOutputTokens: raw.max_output_tokens ?? raw.max_tokens ?? 0,
    capabilities: {
      functionCalling: raw.supports_function_calling === true,
      vision: raw.supports_vision === true,
      reasoning: raw.supports_reasoning === true,
      streaming: raw.supports_native_streaming === true,
      promptCaching: raw.supports_prompt_caching === true,
      pdfInput: raw.supports_pdf_input === true,
      webSearch: raw.supports_web_search === true,
      toolChoice: raw.supports_tool_choice === true,
      parallelToolCalls: raw.supports_parallel_function_calling === true,
      systemMessages: raw.supports_system_messages === true,
      responseSchema: raw.supports_response_schema === true,
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory cache (singleton)
// ---------------------------------------------------------------------------

let cachedModels: CatalogModel[] | null = null;
let cacheTimestamp = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch and parse the full model catalog.
 * Returns cached data if available and fresh (in-memory → disk → remote).
 */
export async function fetchModelCatalog(): Promise<CatalogModel[]> {
  // In-memory cache (valid for current process lifetime up to TTL)
  if (cachedModels && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  let raw: Record<string, LiteLLMModelEntry> | null = null;

  // Try disk cache
  raw = await loadFromCache();

  // Fetch from remote
  if (!raw) {
    try {
      logger.debug('[model-catalog] Fetching from remote...');
      const json = await fetchJson(CATALOG_URL);
      raw = JSON.parse(json) as Record<string, LiteLLMModelEntry>;
      // Write to disk cache (fire-and-forget)
      saveToCache(raw).catch(() => {});
    } catch (err) {
      logger.warn('[model-catalog] Failed to fetch remote catalog', { error: err });
      // Last resort: return whatever we have cached (even if expired)
      try {
        if (await fs.pathExists(CACHE_FILE)) {
          raw = await fs.readJson(CACHE_FILE);
        }
      } catch {
        // nothing
      }
    }
  }

  if (!raw) {
    logger.warn('[model-catalog] No catalog data available');
    cachedModels = [];
    cacheTimestamp = Date.now();
    return [];
  }

  // Parse all entries. Keep every variant (dated + undated, prefixed + unprefixed)
  // so lookup by any id form hits. Deduplication for browsable lists happens in
  // discovery.ts → normalizeDiscoveredModels; consumers that browse the catalog
  // directly must dedup on use.
  const models: CatalogModel[] = [];
  for (const [key, entry] of Object.entries(raw)) {
    const parsed = parseEntry(key, entry);
    if (parsed) models.push(parsed);
  }

  cachedModels = models;
  cacheTimestamp = Date.now();
  return models;
}

/**
 * Get models filtered by a set of provider IDs (openclaw auth provider names).
 * Sorted by price (cheapest first).
 */
export function filterByProviders(models: CatalogModel[], providers: Set<string>): CatalogModel[] {
  return models
    .filter((m) => providers.has(m.provider))
    .sort((a, b) => a.pricing.input - b.pricing.input);
}

/**
 * Get models suitable for the init wizard:
 * - Chat mode (already filtered during parse)
 * - Has pricing > 0 (not experimental/free)
 * - Supports function calling
 * - Sorted by provider then price
 */
export function getWizardModels(models: CatalogModel[], providers: Set<string>): CatalogModel[] {
  return filterByProviders(models, providers)
    .filter((m) => m.pricing.input > 0 && m.capabilities.functionCalling)
    .sort((a, b) => {
      // Group by provider, then sort by price within provider
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return a.pricing.input - b.pricing.input;
    });
}

/**
 * Look up a single model by id. Tolerant of the naming variants provider APIs
 * produce: tries exact id, displayName, date-stripped id, and gemini-prefixed
 * forms. This lets enrichment hit the catalog whether the caller passes
 * "claude-sonnet-4-5-20250929", "claude-sonnet-4-5", "gemini-2.5-flash", or
 * "gemini/gemini-2.5-flash".
 */
export function lookupModel(models: CatalogModel[], modelId: string): CatalogModel | undefined {
  const stripped = modelId.replace(DATE_SUFFIX_RE, '');
  const withGemini = `gemini/${modelId}`;
  const strippedWithGemini = `gemini/${stripped}`;
  return (
    models.find((m) => m.id === modelId) ||
    models.find((m) => m.displayName === modelId) ||
    models.find((m) => m.id === stripped) ||
    models.find((m) => m.displayName === stripped) ||
    models.find((m) => m.id === withGemini) ||
    models.find((m) => m.id === strippedWithGemini)
  );
}

/**
 * Get pricing for a model in USD per million tokens.
 * Returns undefined if model not found in catalog.
 */
export function getModelPricing(
  models: CatalogModel[],
  modelId: string
): CatalogModel['pricing'] | undefined {
  const model = lookupModel(models, modelId);
  return model?.pricing;
}

/**
 * Check if a model supports a specific capability.
 */
export function modelSupports(
  models: CatalogModel[],
  modelId: string,
  capability: keyof CatalogModel['capabilities']
): boolean {
  const model = lookupModel(models, modelId);
  return model?.capabilities[capability] ?? false;
}

/**
 * Project CatalogModel entries to the DiscoveredModel shape. Produces one
 * output per input (no dedup). Callers must run the result through
 * normalizeDiscoveredModels (discovery.ts) to strip date suffixes and dedup.
 */
export function toDiscoveredModels(catalog: CatalogModel[]): Array<{
  id: string;
  name: string;
  provider: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  capabilities: {
    toolCalling: boolean;
    vision: boolean;
    reasoning: boolean;
    contextWindow: number;
    maxOutput: number;
    toolChoice?: boolean;
    parallelToolCalls?: boolean;
    functionCalling?: boolean;
  };
  qualityScore: number;
}> {
  return catalog.map((m) => ({
    id: m.displayName,
    name: m.displayName,
    provider: m.provider,
    inputPrice: m.pricing.input,
    outputPrice: m.pricing.output,
    cacheReadPrice: m.pricing.cacheRead,
    cacheWritePrice: m.pricing.cacheWrite,
    capabilities: {
      toolCalling: m.capabilities.functionCalling,
      vision: m.capabilities.vision,
      reasoning: m.capabilities.reasoning,
      contextWindow: m.maxInputTokens,
      maxOutput: m.maxOutputTokens,
      toolChoice: m.capabilities.toolChoice,
      parallelToolCalls: m.capabilities.parallelToolCalls,
      functionCalling: m.capabilities.functionCalling,
    },
    qualityScore:
      m.pricing.input >= 10
        ? 5
        : m.pricing.input >= 3
          ? 4
          : m.pricing.input >= 1
            ? 3
            : m.pricing.input >= 0.3
              ? 2
              : 1,
  }));
}

/**
 * Return the in-memory catalog cache synchronously (may be empty if not yet loaded).
 * Used by enrichment paths that run concurrently with the async catalog fetch.
 */
export function getCachedCatalog(): CatalogModel[] {
  return cachedModels ?? [];
}

/**
 * Force-clear the in-memory cache (for testing).
 */
export function clearCatalogCache(): void {
  cachedModels = null;
  cacheTimestamp = 0;
}
