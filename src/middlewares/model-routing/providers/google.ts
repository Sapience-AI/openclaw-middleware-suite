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
 * Google Provider Adapter — Converts OpenAI ↔ Google Gemini format.
 *
 * Ported from Manifest's google-adapter.ts:
 *  - Converts messages to Gemini contents with parts
 *  - System messages go into systemInstruction
 *  - Tool definitions map to Gemini functionDeclarations
 *  - Sanitizes unsupported JSON Schema fields
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import {
  ProviderAdapter,
  ProviderFormat,
  ProviderRequestOptions,
  StreamConverter,
} from './types.js';
import { DiscoveredModel } from '../types.js';

export class GoogleAdapter implements ProviderAdapter {
  readonly name = 'google';
  readonly format: ProviderFormat = 'google';

  toProviderRequest(
    body: Record<string, unknown>,
    _model: string,
    _options?: ProviderRequestOptions
  ): Record<string, unknown> {
    // Gemini prompt caching is done via the cachedContents API (not inline
    // markers). Not implemented here yet; options parameter is accepted so
    // the handler can pass it uniformly and future Gemini caching lands here.
    const messages = (body.messages as Array<Record<string, unknown>>) || [];

    // Separate system instructions from conversation
    const systemParts: string[] = [];
    const contents: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === 'system' || msg.role === 'developer') {
        if (typeof msg.content === 'string') {
          systemParts.push(msg.content);
        }
        continue;
      }

      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts = convertToParts(msg);

      // Handle tool results (role=tool → functionResponse)
      if (msg.role === 'tool') {
        contents.push({
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: msg.name || 'tool_result',
                response: {
                  result:
                    typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                },
              },
            },
          ],
        });
        continue;
      }

      // Handle assistant tool_calls → functionCall parts
      // Restore thoughtSignature from encoded tool call IDs (round-trip preservation).
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        const toolParts: Array<Record<string, unknown>> = [];
        if (typeof msg.content === 'string' && msg.content) {
          toolParts.push({ text: msg.content });
        }
        for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown>;
          const part: Record<string, unknown> = {
            functionCall: {
              name: fn?.name,
              args:
                typeof fn?.arguments === 'string'
                  ? JSON.parse(fn.arguments as string)
                  : fn?.arguments,
            },
          };
          // Extract thoughtSignature encoded in tool call ID
          const tcId = tc.id as string | undefined;
          const tsSig = extractThoughtSignature(tcId);
          if (tsSig) {
            part.thoughtSignature = tsSig;
          }
          toolParts.push(part);
        }
        contents.push({ role: 'model', parts: toolParts });
        continue;
      }

      contents.push({ role, parts });
    }

    const result: Record<string, unknown> = {
      contents,
    };

    if (systemParts.length > 0) {
      result.systemInstruction = {
        parts: [{ text: systemParts.join('\n\n') }],
      };
    }

    // Generation config
    const generationConfig: Record<string, unknown> = {};
    if (body.max_tokens !== undefined) generationConfig.maxOutputTokens = body.max_tokens;
    if (body.temperature !== undefined) generationConfig.temperature = body.temperature;
    if (body.top_p !== undefined) generationConfig.topP = body.top_p;
    if (Array.isArray(body.stop)) generationConfig.stopSequences = body.stop;
    if (Object.keys(generationConfig).length > 0) {
      result.generationConfig = generationConfig;
    }

    // Convert tools to Gemini functionDeclarations
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      result.tools = [
        {
          functionDeclarations: (body.tools as Array<Record<string, unknown>>).map(
            convertToolToGemini
          ),
        },
      ];

      // Convert tool_choice → toolConfig.functionCallingConfig
      const toolConfig = convertToolChoiceToGemini(body.tool_choice);
      if (toolConfig) {
        result.toolConfig = toolConfig;
      }
    }

    return result;
  }

  fromProviderResponse(response: Record<string, unknown>, model: string): Record<string, unknown> {
    const candidates = response.candidates as Array<Record<string, unknown>> | undefined;
    const candidate = candidates?.[0];
    const parts = (candidate?.content as Record<string, unknown>)?.parts as
      | Array<Record<string, unknown>>
      | undefined;

    let textContent = '';
    const toolCalls: Array<Record<string, unknown>> = [];

    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part.text) {
          textContent += part.text as string;
        } else if (part.functionCall) {
          const fc = part.functionCall as Record<string, unknown>;
          const tsSig = part.thoughtSignature as string | undefined;
          toolCalls.push({
            id: encodeThoughtSignature(tsSig),
            type: 'function',
            function: {
              name: fc.name,
              arguments: JSON.stringify(fc.args || {}),
            },
          });
        }
      }
    }

    const message: Record<string, unknown> = {
      role: 'assistant',
      content: textContent || null,
    };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    const finishReason = mapFinishReason(candidate?.finishReason as string);

    const usageMetadata = response.usageMetadata as Record<string, number> | undefined;

    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
        },
      ],
      usage: usageMetadata
        ? {
            prompt_tokens: usageMetadata.promptTokenCount || 0,
            completion_tokens: usageMetadata.candidatesTokenCount || 0,
            total_tokens: usageMetadata.totalTokenCount || 0,
            // Pass through Gemini cache tokens so extractUsage() can pick them up.
            // Google uses implicit context caching — cachedContentTokenCount is
            // the equivalent of Anthropic's cache_read_input_tokens.
            ...(usageMetadata.cachedContentTokenCount
              ? { cache_read_input_tokens: usageMetadata.cachedContentTokenCount }
              : {}),
          }
        : undefined,
    };
  }

  buildUrl(baseUrl: string, model: string, stream?: boolean): string {
    const cleanModel = stripProviderPrefix(model);
    const parsed = new URL(baseUrl);
    const method = stream ? 'streamGenerateContent' : 'generateContent';
    // Gemini streaming requires alt=sse query parameter for SSE format
    const query = stream ? '?alt=sse' : '';
    return parsed.origin + `/v1beta/models/${cleanModel}:${method}${query}`;
  }

  /**
   * Stateful stream converter for Gemini SSE → OpenAI SSE.
   *
   * Gemini streamGenerateContent sends SSE events where each `data:` payload
   * is a full candidate object with parts (text and/or functionCall).
   */
  createStreamConverter(model: string): StreamConverter {
    const baseChunk = () => ({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model,
      system_fingerprint: null,
    });

    let roleSent = false;
    let toolCallIndex = 0;

    return {
      processEvent(eventData: string): string | null {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(eventData);
        } catch {
          return null;
        }

        const candidates = event.candidates as Array<Record<string, unknown>> | undefined;
        if (!candidates || candidates.length === 0) return null;

        const candidate = candidates[0];
        const content = candidate.content as Record<string, unknown> | undefined;
        const parts = content?.parts as Array<Record<string, unknown>> | undefined;
        const finishReason = candidate.finishReason as string | undefined;

        const chunks: string[] = [];

        // Emit role chunk once
        if (!roleSent) {
          roleSent = true;
          chunks.push(
            `data: ${JSON.stringify({
              ...baseChunk(),
              choices: [
                { index: 0, delta: { role: 'assistant' }, logprobs: null, finish_reason: null },
              ],
            })}\n\n`
          );
        }

        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part.text && typeof part.text === 'string') {
              chunks.push(
                `data: ${JSON.stringify({
                  ...baseChunk(),
                  choices: [
                    {
                      index: 0,
                      delta: { content: part.text },
                      logprobs: null,
                      finish_reason: null,
                    },
                  ],
                })}\n\n`
              );
            } else if (part.functionCall) {
              const fc = part.functionCall as Record<string, unknown>;
              const tsSig = part.thoughtSignature as string | undefined;
              const tcIdx = toolCallIndex++;
              chunks.push(
                `data: ${JSON.stringify({
                  ...baseChunk(),
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: tcIdx,
                            id: encodeThoughtSignature(tsSig),
                            type: 'function',
                            function: {
                              name: fc.name,
                              arguments: JSON.stringify(fc.args || {}),
                            },
                          },
                        ],
                      },
                      logprobs: null,
                      finish_reason: null,
                    },
                  ],
                })}\n\n`
              );
            }
          }
        }

        // Emit finish reason if present
        if (finishReason && finishReason !== 'MALFORMED_FUNCTION_CALL') {
          const mappedReason = mapFinishReason(finishReason);
          // Extract usage if available
          const usageMetadata = event.usageMetadata as Record<string, number> | undefined;
          const usageObj: Record<string, unknown> | undefined = usageMetadata
            ? {
                prompt_tokens: usageMetadata.promptTokenCount || 0,
                completion_tokens: usageMetadata.candidatesTokenCount || 0,
                total_tokens: usageMetadata.totalTokenCount || 0,
                // Pass through Gemini cached content tokens in streaming responses
                ...(usageMetadata.cachedContentTokenCount
                  ? { cache_read_input_tokens: usageMetadata.cachedContentTokenCount }
                  : {}),
              }
            : undefined;
          chunks.push(
            `data: ${JSON.stringify({
              ...baseChunk(),
              choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: mappedReason }],
              ...(usageObj ? { usage: usageObj } : {}),
            })}\n\n`
          );
        }

        return chunks.length > 0 ? chunks.join('') : null;
      },

      flush(): string[] {
        return [];
      },
    };
  }

  buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    };
  }

  async listModels(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
    return new Promise((resolve) => {
      const url = `${baseUrl}/v1beta/models?key=${apiKey}`;
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;

      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        timeout: 10000,
      };

      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            const models = parseGeminiModels(data);
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

// ---------------------------------------------------------------------------
// Thought signature round-trip helpers
// ---------------------------------------------------------------------------

/** Separator used to encode thoughtSignature in tool call IDs. */
const TS_SEP = '__ts__';

/**
 * Encode a thoughtSignature into a tool call ID so it survives the
 * Gemini → OpenAI → OpenClaw → OpenAI → Gemini round-trip.
 */
function encodeThoughtSignature(signature: string | undefined): string {
  const base = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return signature ? `${base}${TS_SEP}${signature}` : base;
}

/**
 * Extract a thoughtSignature from an encoded tool call ID.
 * Returns undefined if no signature is embedded.
 */
function extractThoughtSignature(toolCallId: string | undefined): string | undefined {
  if (!toolCallId) return undefined;
  const idx = toolCallId.indexOf(TS_SEP);
  if (idx < 0) return undefined;
  return toolCallId.slice(idx + TS_SEP.length);
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function stripProviderPrefix(model: string): string {
  return model.replace(/^google\//, '').replace(/^gemini\//, '');
}

function convertToParts(msg: Record<string, unknown>): Array<Record<string, unknown>> {
  if (typeof msg.content === 'string') {
    return [{ text: msg.content }];
  }
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>).map((block) => {
      if (block.type === 'text') return { text: block.text };
      if (block.type === 'image_url') {
        const imageUrl = block.image_url as Record<string, string>;
        return {
          inlineData: {
            mimeType: 'image/jpeg',
            data: imageUrl?.url?.replace(/^data:image\/\w+;base64,/, '') || '',
          },
        };
      }
      return { text: JSON.stringify(block) };
    });
  }
  return [];
}

function convertToolToGemini(tool: Record<string, unknown>): Record<string, unknown> {
  const fn = tool.function as Record<string, unknown>;
  if (!fn) return {};
  return {
    name: fn.name,
    description: fn.description || '',
    parameters: sanitizeSchema(fn.parameters as Record<string, unknown>),
  };
}

/**
 * Convert OpenAI tool_choice to Gemini toolConfig.functionCallingConfig.
 * Without this, Gemini may not use tools even when they're provided.
 */
function convertToolChoiceToGemini(toolChoice: unknown): Record<string, unknown> | null {
  if (toolChoice === undefined || toolChoice === null) return null;
  if (toolChoice === 'auto') {
    return { functionCallingConfig: { mode: 'AUTO' } };
  }
  if (toolChoice === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } };
  }
  if (toolChoice === 'required' || toolChoice === 'any') {
    return { functionCallingConfig: { mode: 'ANY' } };
  }
  if (typeof toolChoice === 'object') {
    const obj = toolChoice as Record<string, unknown>;
    const fn = obj.function as Record<string, unknown> | undefined;
    if (fn?.name) {
      return {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [fn.name],
        },
      };
    }
  }
  return null;
}

/**
 * Sanitize JSON Schema for Gemini — remove unsupported fields.
 */
function sanitizeSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema) return { type: 'object', properties: {} };

  const result: Record<string, unknown> = {};
  const UNSUPPORTED = new Set([
    '$ref',
    '$schema',
    '$id',
    'allOf',
    'anyOf',
    'oneOf',
    'not',
    'patternProperties',
    'additionalProperties',
    'additionalItems',
    'dependencies',
    'if',
    'then',
    'else',
    'const',
    'default',
    'examples',
    'title',
  ]);

  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
        if (pv && typeof pv === 'object') {
          props[pk] = sanitizeSchema(pv as Record<string, unknown>);
        } else {
          props[pk] = pv;
        }
      }
      result[key] = props;
    } else if (key === 'items' && value && typeof value === 'object') {
      result[key] = sanitizeSchema(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function mapFinishReason(reason: string | undefined): string {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
      return 'content_filter';
    case 'RECITATION':
      return 'content_filter';
    default:
      return 'stop';
  }
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

function parseGeminiModels(data: {
  models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
}): DiscoveredModel[] {
  if (!data?.models || !Array.isArray(data.models)) return [];

  return data.models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => {
      const id = m.name.replace('models/', '');
      return {
        id,
        name: m.displayName || id,
        provider: 'google',
        capabilities: {
          toolCalling: true,
          vision: id.includes('pro') || id.includes('flash'),
          reasoning: id.includes('thinking') || id.includes('pro'),
          contextWindow: id.includes('flash') ? 1000000 : 2000000,
        },
      };
    });
}
