/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * OpenAI Provider Adapter — Pass-through for OpenAI-compatible APIs.
 *
 * The default adapter. OpenAI-compatible providers (OpenAI, OpenRouter,
 * Ollama, etc.) use this format natively, so most methods are identity
 * transforms.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { ProviderAdapter, ProviderFormat, ProviderRequestOptions } from './types.js';
import { DiscoveredModel } from '../types.js';

export class OpenAIAdapter implements ProviderAdapter {
  readonly name = 'openai';
  readonly format: ProviderFormat = 'openai';

  toProviderRequest(
    body: Record<string, unknown>,
    _model: string,
    _options?: ProviderRequestOptions
  ): Record<string, unknown> {
    // OpenAI format is the canonical format — pass through.
    // OpenAI's prompt caching is server-side automatic; no client-side hints.
    return body;
  }

  fromProviderResponse(response: Record<string, unknown>, _model: string): Record<string, unknown> {
    return response;
  }

  buildUrl(baseUrl: string, _model: string): string {
    const parsed = new URL(baseUrl);
    return parsed.origin + (parsed.pathname.replace(/\/$/, '') || '') + '/v1/chat/completions';
  }

  buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  async listModels(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
    return new Promise((resolve) => {
      const parsed = new URL(baseUrl);
      const url = parsed.origin + (parsed.pathname.replace(/\/$/, '') || '') + '/v1/models';
      const transport = parsed.protocol === 'https:' ? https : http;

      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: new URL(url).pathname,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 10000,
      };

      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            const models = parseOpenAIModels(data, 'openai');
            resolve(models);
          } catch {
            resolve([]);
          }
        });
      });

      req.on('error', () => resolve([]));
      req.on('timeout', () => {
        req.destroy();
        resolve([]);
      });
      req.end();
    });
  }
}

/**
 * Parse OpenAI /v1/models response into DiscoveredModel[].
 * Deduplicates dated snapshots (e.g. gpt-4o-2024-05-13 → gpt-4o).
 */
function parseOpenAIModels(
  data: { data?: Array<{ id: string; owned_by?: string }> },
  provider: string
): DiscoveredModel[] {
  if (!data?.data || !Array.isArray(data.data)) return [];

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];

  for (const entry of data.data) {
    if (!entry.id) continue;

    // Deduplicate dated snapshots
    const baseId = entry.id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    if (seen.has(baseId)) continue;
    seen.add(baseId);

    models.push({
      id: entry.id,
      name: baseId,
      provider,
      capabilities: inferCapabilities(entry.id),
    });
  }

  return models;
}

/**
 * Infer capabilities from model ID patterns.
 */
function inferCapabilities(modelId: string): DiscoveredModel['capabilities'] {
  const lower = modelId.toLowerCase();
  return {
    toolCalling: !lower.includes('instruct') && !lower.includes('base'),
    vision: lower.includes('vision') || lower.includes('gpt-4o') || lower.includes('gpt-4-turbo'),
    reasoning: lower.includes('o1') || lower.includes('o3') || lower.includes('o4'),
    contextWindow: inferContextWindow(lower),
  };
}

function inferContextWindow(modelId: string): number | undefined {
  if (modelId.includes('gpt-4o')) return 128000;
  if (modelId.includes('gpt-4-turbo')) return 128000;
  if (modelId.includes('gpt-3.5')) return 16385;
  if (modelId.includes('o1') || modelId.includes('o3') || modelId.includes('o4')) return 200000;
  return undefined;
}
