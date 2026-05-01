/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     https://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Middleware Registry
 * Loads, initializes, and orchestrates middlewares in pipeline order.
 */

import { Middleware, MiddlewareContext, MiddlewareResult } from '../types.js';
import { logger } from './Logger.js';

export class MiddlewareRegistry {
  private middlewares: Middleware[] = [];

  register(middleware: Middleware): void {
    this.middlewares.push(middleware);
    logger.info(
      `[MiddlewareRegistry] Registered middleware: ${middleware.name} v${middleware.version}`
    );
  }

  async initializeAll(configs: Record<string, Record<string, unknown>>): Promise<void> {
    for (const mw of this.middlewares) {
      const config = configs[mw.name] ?? {};
      await mw.initialize(config);
      logger.info(`[MiddlewareRegistry] Initialized: ${mw.name}`);
    }
  }

  /**
   * Execute the before-tool-call pipeline sequentially.
   * Short-circuits if any middleware returns { block: true }.
   */
  async executePipeline(context: MiddlewareContext): Promise<MiddlewareResult> {
    let currentParams = context.params;

    for (const mw of this.middlewares) {
      if (!mw.beforeToolCall) continue;

      const status = mw.getStatus();
      if (!status.enabled) continue;

      const ctx: MiddlewareContext = { ...context, params: currentParams };
      const result = await mw.beforeToolCall(ctx);

      if (result.block) {
        return result;
      }

      if (result.modifiedParams) {
        currentParams = result.modifiedParams;
      }
    }

    return { block: false };
  }

  /**
   * Execute the after-tool-call pipeline (notification only, no blocking).
   */
  async executeAfterPipeline(context: MiddlewareContext, result: unknown): Promise<void> {
    for (const mw of this.middlewares) {
      if (!mw.afterToolCall) continue;

      const status = mw.getStatus();
      if (!status.enabled) continue;

      await mw.afterToolCall(context, result);
    }
  }

  async shutdownAll(): Promise<void> {
    for (const mw of this.middlewares) {
      if (mw.shutdown) {
        await mw.shutdown();
      }
    }
  }

  getMiddlewares(): readonly Middleware[] {
    return this.middlewares;
  }

  getMiddleware(name: string): Middleware | undefined {
    return this.middlewares.find((mw) => mw.name === name);
  }
}
