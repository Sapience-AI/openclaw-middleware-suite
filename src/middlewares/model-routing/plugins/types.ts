/**
 * Router Plugin System — Extension points for custom behavior.
 *
 * Combined from ClawRouter, Manifest, and iblai-openclaw-router:
 *  - onBeforeScore: modify input before scoring
 *  - onAfterScore: adjust scoring result
 *  - onBeforeForward: modify request before forwarding to provider
 *  - onAfterForward: post-response processing (telemetry, billing, etc.)
 *
 * Plugins are registered with the middleware at initialization time.
 * All hooks are optional and called in registration order.
 */

import { ScoringResult, Tier } from '../types.js';

// ---------------------------------------------------------------------------
// Plugin interface
// ---------------------------------------------------------------------------

/**
 * A router plugin can hook into the routing pipeline at four points.
 * All hooks are optional.
 */
export interface RouterPlugin {
  /** Unique plugin name */
  readonly name: string;

  /**
   * Called before scoring. Can modify the messages or body that will be scored.
   * Return the modified input, or the original to pass through.
   */
  onBeforeScore?(input: BeforeScoreInput): BeforeScoreInput | Promise<BeforeScoreInput>;

  /**
   * Called after scoring. Can adjust the scoring result (e.g., override tier).
   * Return the modified result, or the original to pass through.
   */
  onAfterScore?(
    result: ScoringResult,
    context: ScoreContext
  ): ScoringResult | Promise<ScoringResult>;

  /**
   * Called before forwarding to a provider. Can modify the request body or headers.
   * Return the modified request, or the original to pass through.
   */
  onBeforeForward?(request: BeforeForwardInput): BeforeForwardInput | Promise<BeforeForwardInput>;

  /**
   * Called after a successful response from a provider. For telemetry, billing, etc.
   * This is fire-and-forget — errors are logged but don't affect the response.
   */
  onAfterForward?(event: AfterForwardEvent): void | Promise<void>;

  /**
   * Called when the plugin system is being shut down.
   */
  onShutdown?(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook input/output types
// ---------------------------------------------------------------------------

export interface BeforeScoreInput {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  sessionId: string | null;
}

export interface ScoreContext {
  sessionId: string | null;
  requestHash: string;
  messageLength: number;
}

export interface BeforeForwardInput {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  model: string;
  tier: Tier;
  provider: string;
  url: string;
}

export interface AfterForwardEvent {
  tier: Tier;
  model: string;
  provider: string;
  status: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costEstimateUsd: number;
  cached: boolean;
  fallback: boolean;
  sessionId: string | null;
}

// ---------------------------------------------------------------------------
// Plugin registry
// ---------------------------------------------------------------------------

export class PluginRegistry {
  private plugins: RouterPlugin[] = [];

  /**
   * Register a plugin. Plugins are called in registration order.
   */
  register(plugin: RouterPlugin): void {
    // Prevent duplicate registration
    if (this.plugins.some((p) => p.name === plugin.name)) {
      throw new Error(`Router plugin "${plugin.name}" is already registered`);
    }
    this.plugins.push(plugin);
  }

  /**
   * Unregister a plugin by name.
   */
  unregister(name: string): boolean {
    const idx = this.plugins.findIndex((p) => p.name === name);
    if (idx === -1) return false;
    this.plugins.splice(idx, 1);
    return true;
  }

  /**
   * Run onBeforeScore hooks in sequence.
   */
  async runBeforeScore(input: BeforeScoreInput): Promise<BeforeScoreInput> {
    let current = input;
    for (const plugin of this.plugins) {
      if (plugin.onBeforeScore) {
        try {
          current = await plugin.onBeforeScore(current);
        } catch (err) {
          // Log but don't break the pipeline
          console.error(`[router-plugin:${plugin.name}] onBeforeScore error:`, err);
        }
      }
    }
    return current;
  }

  /**
   * Run onAfterScore hooks in sequence.
   */
  async runAfterScore(result: ScoringResult, context: ScoreContext): Promise<ScoringResult> {
    let current = result;
    for (const plugin of this.plugins) {
      if (plugin.onAfterScore) {
        try {
          current = await plugin.onAfterScore(current, context);
        } catch (err) {
          console.error(`[router-plugin:${plugin.name}] onAfterScore error:`, err);
        }
      }
    }
    return current;
  }

  /**
   * Run onBeforeForward hooks in sequence.
   */
  async runBeforeForward(input: BeforeForwardInput): Promise<BeforeForwardInput> {
    let current = input;
    for (const plugin of this.plugins) {
      if (plugin.onBeforeForward) {
        try {
          current = await plugin.onBeforeForward(current);
        } catch (err) {
          console.error(`[router-plugin:${plugin.name}] onBeforeForward error:`, err);
        }
      }
    }
    return current;
  }

  /**
   * Run onAfterForward hooks (fire-and-forget).
   */
  fireAfterForward(event: AfterForwardEvent): void {
    for (const plugin of this.plugins) {
      if (plugin.onAfterForward) {
        try {
          const result = plugin.onAfterForward(event);
          // If it returns a promise, catch errors silently
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch((err) => {
              console.error(`[router-plugin:${plugin.name}] onAfterForward error:`, err);
            });
          }
        } catch (err) {
          console.error(`[router-plugin:${plugin.name}] onAfterForward error:`, err);
        }
      }
    }
  }

  /**
   * Shut down all plugins.
   */
  async shutdown(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onShutdown) {
        try {
          await plugin.onShutdown();
        } catch (err) {
          console.error(`[router-plugin:${plugin.name}] onShutdown error:`, err);
        }
      }
    }
    this.plugins = [];
  }

  /**
   * Get registered plugin names.
   */
  getNames(): string[] {
    return this.plugins.map((p) => p.name);
  }

  /**
   * Whether any plugins are registered.
   */
  get hasPlugins(): boolean {
    return this.plugins.length > 0;
  }

  get count(): number {
    return this.plugins.length;
  }
}
