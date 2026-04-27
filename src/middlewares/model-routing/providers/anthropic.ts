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
 * Anthropic Provider Adapter — Converts OpenAI ↔ Anthropic Messages format.
 *
 * Ported from Manifest's anthropic-adapter.ts:
 *  - Extracts system message from messages array into top-level system field
 *  - Converts tool_call / function_call to Anthropic tool_use blocks
 *  - Converts tool results to Anthropic tool_result blocks
 *  - Handles both streaming and non-streaming responses
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

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic';
  readonly format: ProviderFormat = 'anthropic';

  toProviderRequest(
    body: Record<string, unknown>,
    model: string,
    options?: ProviderRequestOptions
  ): Record<string, unknown> {
    // Default to caching on — preserves prior behavior when called without options.
    const promptCacheEnabled = options?.promptCacheEnabled ?? true;
    const messages = (body.messages as Array<Record<string, unknown>>) || [];

    // Extract system messages into top-level system field
    const systemMessages: string[] = [];
    const nonSystemMessages: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === 'system' || msg.role === 'developer') {
        if (typeof msg.content === 'string') {
          systemMessages.push(msg.content);
        }
      } else {
        nonSystemMessages.push(convertMessage(msg));
      }
    }

    const result: Record<string, unknown> = {
      model: stripProviderPrefix(model),
      messages: nonSystemMessages,
      max_tokens: body.max_tokens ?? 4096,
    };

    if (systemMessages.length > 0) {
      // Use content block array format to support cache_control markers
      const systemBlocks: Array<Record<string, unknown>> = systemMessages.map((text) => ({
        type: 'text',
        text,
      }));
      if (promptCacheEnabled) {
        // Inject cache_control on last system block (Anthropic prompt caching).
        // System prompts are stable across requests — caching them avoids
        // re-processing on every turn.  Matches Manifest's injection strategy.
        systemBlocks[systemBlocks.length - 1].cache_control = { type: 'ephemeral' };
      }
      result.system = systemBlocks;
    }

    // Forward optional parameters
    if (body.temperature !== undefined) result.temperature = body.temperature;
    if (body.top_p !== undefined) result.top_p = body.top_p;
    if (body.stop !== undefined) result.stop_sequences = body.stop;
    if (body.stream !== undefined) result.stream = body.stream;

    // Convert tools to Anthropic format
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      const tools = (body.tools as Array<Record<string, unknown>>).map(convertTool);
      if (promptCacheEnabled) {
        // Inject cache_control on last tool definition (Anthropic prompt caching).
        // Tool schemas are stable across requests — caching them with the system
        // prompt maximizes the cached prefix.
        tools[tools.length - 1].cache_control = { type: 'ephemeral' };
      }
      result.tools = tools;
    }

    // Convert tool_choice
    if (body.tool_choice !== undefined) {
      result.tool_choice = convertToolChoice(body.tool_choice);
    }

    // Forward thinking parameters
    if (body.thinking !== undefined) {
      result.thinking = body.thinking;
    }

    return result;
  }

  fromProviderResponse(response: Record<string, unknown>, model: string): Record<string, unknown> {
    // Convert Anthropic response to OpenAI format
    const content = response.content as Array<Record<string, unknown>> | undefined;
    let textContent = '';
    const toolCalls: Array<Record<string, unknown>> = [];

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') {
          textContent += (block.text as string) || '';
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
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

    const stopReason = mapStopReason(response.stop_reason as string);
    const usage = response.usage as Record<string, number> | undefined;

    const usageObj: Record<string, unknown> | undefined = usage
      ? {
          prompt_tokens: usage.input_tokens || 0,
          completion_tokens: usage.output_tokens || 0,
          total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        }
      : undefined;

    // Pass through Anthropic cache tokens so extractUsage() can pick them up
    if (usageObj && usage) {
      if (usage.cache_read_input_tokens)
        usageObj.cache_read_input_tokens = usage.cache_read_input_tokens;
      if (usage.cache_creation_input_tokens)
        usageObj.cache_creation_input_tokens = usage.cache_creation_input_tokens;
    }

    return {
      id: response.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: stopReason,
        },
      ],
      usage: usageObj,
    };
  }

  buildUrl(baseUrl: string, _model: string): string {
    const parsed = new URL(baseUrl);
    return parsed.origin + '/v1/messages';
  }

  buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  /**
   * Create a stateful stream converter that accumulates tool calls
   * across multiple Anthropic SSE events before emitting them.
   *
   * Anthropic tool call flow:
   *   content_block_start (type=tool_use, id, name) → start accumulating
   *   content_block_delta (input_json_delta, partial_json) → append args
   *   content_block_stop → emit complete tool_calls chunk
   */
  createStreamConverter(model: string): StreamConverter {
    // Per-request state
    let messageId = `chatcmpl-${Date.now()}`;
    const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();
    const thinkingBlocks = new Set<number>(); // Block indices that are thinking — skip their deltas
    let toolCallIndex = 0;
    // Accumulate cache tokens from message_start (emitted in message_delta's usage)
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;

    const baseChunk = () => ({
      id: messageId,
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model,
      system_fingerprint: null,
    });

    return {
      processEvent(eventData: string): string | null {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(eventData);
        } catch {
          return null;
        }

        const type = event.type as string;

        switch (type) {
          case 'message_start': {
            const msg = event.message as Record<string, unknown> | undefined;
            if (msg?.id) messageId = msg.id as string;
            // Capture cache tokens (emitted later in message_delta's usage)
            const startUsage = (msg?.usage ?? {}) as Record<string, number>;
            if (startUsage.cache_read_input_tokens)
              cacheReadTokens = startUsage.cache_read_input_tokens;
            if (startUsage.cache_creation_input_tokens)
              cacheWriteTokens = startUsage.cache_creation_input_tokens;
            return `data: ${JSON.stringify({
              ...baseChunk(),
              choices: [
                { index: 0, delta: { role: 'assistant' }, logprobs: null, finish_reason: null },
              ],
            })}\n\n`;
          }

          case 'content_block_start': {
            const block = event.content_block as Record<string, unknown> | undefined;
            const idx = event.index as number;
            if (block?.type === 'tool_use') {
              pendingToolCalls.set(idx, {
                id: (block.id as string) || `call_${Date.now()}`,
                name: (block.name as string) || '',
                args: '',
              });
            } else if (block?.type === 'thinking') {
              // Mark thinking blocks — their text deltas should be stripped
              thinkingBlocks.add(idx);
            }
            return null;
          }

          case 'content_block_delta': {
            const delta = event.delta as Record<string, unknown>;
            const idx = event.index as number;

            // Skip thinking block deltas (internal reasoning, not user-facing)
            if (thinkingBlocks.has(idx)) return null;

            if (delta?.type === 'text_delta') {
              return `data: ${JSON.stringify({
                ...baseChunk(),
                choices: [
                  { index: 0, delta: { content: delta.text }, logprobs: null, finish_reason: null },
                ],
              })}\n\n`;
            }

            if (delta?.type === 'input_json_delta') {
              // Accumulate tool argument JSON fragments
              const pending = pendingToolCalls.get(idx);
              if (pending) {
                pending.args += (delta.partial_json as string) || '';
              }
              return null;
            }
            return null;
          }

          case 'content_block_stop': {
            const idx = event.index as number;
            thinkingBlocks.delete(idx); // Clean up if it was a thinking block
            const pending = pendingToolCalls.get(idx);
            if (pending) {
              // Emit complete tool_calls chunk
              pendingToolCalls.delete(idx);
              const tcIdx = toolCallIndex++;
              return `data: ${JSON.stringify({
                ...baseChunk(),
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: tcIdx,
                          id: pending.id,
                          type: 'function',
                          function: {
                            name: pending.name,
                            arguments: pending.args,
                          },
                        },
                      ],
                    },
                    logprobs: null,
                    finish_reason: null,
                  },
                ],
              })}\n\n`;
            }
            return null;
          }

          case 'message_delta': {
            const delta = event.delta as Record<string, unknown>;
            const stopReason = mapStopReason(delta?.stop_reason as string);
            const usage = event.usage as Record<string, number> | undefined;
            const usageObj: Record<string, number> | undefined = usage
              ? {
                  prompt_tokens: usage.input_tokens || 0,
                  completion_tokens: usage.output_tokens || 0,
                  total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
                }
              : undefined;
            // Include cache tokens captured from message_start
            if (usageObj) {
              if (cacheReadTokens) usageObj.cache_read_input_tokens = cacheReadTokens;
              if (cacheWriteTokens) usageObj.cache_creation_input_tokens = cacheWriteTokens;
            }
            return `data: ${JSON.stringify({
              ...baseChunk(),
              choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: stopReason }],
              ...(usageObj ? { usage: usageObj } : {}),
            })}\n\n`;
          }

          case 'message_stop':
            return null; // Handler emits [DONE]

          default:
            return null; // ping, etc.
        }
      },

      flush(): string[] {
        // Emit any pending tool calls that weren't closed
        const results: string[] = [];
        for (const [, pending] of pendingToolCalls) {
          const tcIdx = toolCallIndex++;
          results.push(
            `data: ${JSON.stringify({
              ...baseChunk(),
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: tcIdx,
                        id: pending.id,
                        type: 'function',
                        function: { name: pending.name, arguments: pending.args },
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
        pendingToolCalls.clear();
        return results;
      },
    };
  }

  async listModels(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
    return new Promise((resolve) => {
      const parsed = new URL(baseUrl);
      const transport = parsed.protocol === 'https:' ? https : http;

      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: '/v1/models?limit=100',
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        timeout: 10000,
      };

      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            const models = parseAnthropicModels(data);
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
// Conversion helpers
// ---------------------------------------------------------------------------

function stripProviderPrefix(model: string): string {
  return model.replace(/^anthropic\//, '');
}

function convertMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { role: msg.role };

  if (typeof msg.content === 'string') {
    result.content = msg.content;
  } else if (Array.isArray(msg.content)) {
    result.content = (msg.content as Array<Record<string, unknown>>).map(convertContentBlock);
  }

  // Convert tool results (role=tool → role=user with tool_result block)
  if (msg.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        },
      ],
    };
  }

  // Convert assistant tool_calls
  if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
    const blocks: Array<Record<string, unknown>> = [];
    if (typeof msg.content === 'string' && msg.content) {
      blocks.push({ type: 'text', text: msg.content });
    }
    for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
      const fn = tc.function as Record<string, unknown>;
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: fn?.name,
        input: typeof fn?.arguments === 'string' ? JSON.parse(fn.arguments) : fn?.arguments,
      });
    }
    result.content = blocks;
  }

  return result;
}

function convertContentBlock(block: Record<string, unknown>): Record<string, unknown> {
  if (block.type === 'text') return block;
  if (block.type === 'image_url') {
    const imageUrl = block.image_url as Record<string, string>;
    return {
      type: 'image',
      source: {
        type: 'url',
        url: imageUrl?.url,
      },
    };
  }
  return block;
}

function convertTool(tool: Record<string, unknown>): Record<string, unknown> {
  const fn = tool.function as Record<string, unknown>;
  if (!fn) return tool;
  return {
    name: fn.name,
    description: fn.description,
    input_schema: fn.parameters || { type: 'object', properties: {} },
  };
}

function convertToolChoice(choice: unknown): unknown {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required' || choice === 'any') return { type: 'any' };
  if (typeof choice === 'object' && choice !== null) {
    const obj = choice as Record<string, unknown>;
    const fn = obj.function as Record<string, unknown> | undefined;
    if (fn?.name) {
      return { type: 'tool', name: fn.name };
    }
  }
  return { type: 'auto' };
}

function mapStopReason(reason: string | undefined): string {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

function parseAnthropicModels(data: {
  data?: Array<{ id: string; display_name?: string; type?: string }>;
}): DiscoveredModel[] {
  if (!data?.data || !Array.isArray(data.data)) return [];

  return data.data
    .filter((m) => m.type !== 'base' && m.id)
    .map((m) => ({
      id: m.id,
      name: m.display_name || m.id,
      provider: 'anthropic',
      capabilities: inferAnthropicCapabilities(m.id),
    }));
}

function inferAnthropicCapabilities(modelId: string): DiscoveredModel['capabilities'] {
  const lower = modelId.toLowerCase();
  const isOpus = lower.includes('opus');
  return {
    toolCalling: true,
    vision: true,
    reasoning: isOpus || lower.includes('sonnet-4') || lower.includes('opus-4'),
    contextWindow: 200000,
    maxOutput: 8192,
  };
}
