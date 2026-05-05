/*
 * Copyright (c) 2026 BlockRun
 * Modifications copyright (c) 2026 Sapience AI Corporation
 *
 * This file is derived from the ClawRouter project
 * (https://github.com/BlockRunAI/ClawRouter) and has been modified for use
 * in the OpenClaw Middleware Suite.
 *
 * Used under the MIT License — see NOTICE for the full license text.
 */

/**
 * Sapience Router Provider — Registers the model-routing proxy as an
 * OpenClaw LLM provider so that OpenClaw routes requests through the proxy.
 *
 * Follows the same pattern as CLawRouter's provider registration
 * (ClawRouter/src/index.ts:1191-1221, ClawRouter/src/provider.ts).
 *
 * The model list exposes meta-routing models (eco, premium, agentic)
 * rather than individual models — the proxy's scoring engine decides which
 * actual model to use at request time. Same pattern as CLawRouter's
 * "blockrun/auto", "blockrun/eco", "blockrun/premium" (models.ts:231-258).
 */

// ---------------------------------------------------------------------------
// Types (matching OpenClaw's expected shapes from CLawRouter/src/types.ts)
// ---------------------------------------------------------------------------

export interface ModelDefinitionConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export interface SapienceRouterProvider {
  id: string;
  label: string;
  docsPath?: string;
  aliases?: string[];
  envVars?: string[];
  models?: {
    baseUrl: string;
    api?: string;
    apiKey?: string;
    models: ModelDefinitionConfig[];
  };
  auth: unknown[];
}

// ---------------------------------------------------------------------------
// Meta-routing models — these are what the user sees in the dropdown.
// The proxy scores each request and picks the actual model at runtime.
// ---------------------------------------------------------------------------

const ROUTING_MODELS: ModelDefinitionConfig[] = [
  {
    id: 'eco',
    name: 'sai-router/eco',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 128_000,
  },
  {
    id: 'premium',
    name: 'sai-router/premium',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 128_000,
  },
  {
    id: 'agentic',
    name: 'sai-router/agentic',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 128_000,
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the meta-routing model list for OpenClaw provider registration.
 * These are the models users see in the dropdown (auto, eco, premium, agentic).
 */
export function buildRouterModelList(): ModelDefinitionConfig[] {
  return [...ROUTING_MODELS];
}

/**
 * Build the provider definition that gets registered with OpenClaw.
 * Points to the local proxy so OpenClaw routes requests through it.
 */
export function buildSapienceRouterProvider(
  port: number,
  modelList: ModelDefinitionConfig[]
): SapienceRouterProvider {
  return {
    id: 'sai-router',
    label: 'SAI Router',
    aliases: ['sapience-router'],
    envVars: [],
    models: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: 'openai-completions',
      apiKey: 'placeholder-sai-router',
      models: modelList,
    },
    auth: [],
  };
}
