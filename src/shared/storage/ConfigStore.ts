/**
 * Sapience Middleware Unified ConfigStore
 * Manages synchronized access to the single sapience-ai-suite.json file.
 */

import fs from 'fs-extra';
import { existsSync, readFileSync, writeFileSync, watchFile, unwatchFile } from 'fs';
import { SAPIENCE_MW_DATA_DIR, SAPIENCE_MW_STORE_FILE, logger } from '../Logger.js';

let writeChain = Promise.resolve();

export class ConfigStore {
  // ---------------------------------------------------------------------------
  // Centralized file watcher — single fs.watchFile for all middlewares
  // ---------------------------------------------------------------------------

  private static listeners = new Map<string, Set<() => void>>();
  private static watching = false;

  /**
   * Register a callback to be invoked when the store file changes on disk.
   * `key` is a logical namespace (e.g. 'hitl', 'model_routing') used for
   * bookkeeping and unregistration; all listeners fire on any file change.
   * The watcher is started automatically on the first registration.
   */
  static onChange(key: string, callback: () => void): void {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(callback);
    this.startWatching();
  }

  /**
   * Unregister a previously registered callback.
   * Stops the watcher automatically when no listeners remain.
   */
  static offChange(key: string, callback: () => void): void {
    const set = this.listeners.get(key);
    if (set) {
      set.delete(callback);
      if (set.size === 0) this.listeners.delete(key);
    }
    if (this.listeners.size === 0) this.stopWatching();
  }

  private static startWatching(): void {
    if (this.watching) return;
    try {
      watchFile(SAPIENCE_MW_STORE_FILE, { interval: 2000 }, () => {
        logger.debug('[ConfigStore] Store file changed — notifying listeners');
        for (const [, callbacks] of this.listeners) {
          for (const cb of callbacks) {
            try {
              cb();
            } catch (err) {
              logger.error('[ConfigStore] Listener callback error', { error: err });
            }
          }
        }
      });
      this.watching = true;
    } catch {
      // watchFile may fail on some platforms; non-critical
    }
  }

  private static stopWatching(): void {
    if (!this.watching) return;
    try {
      unwatchFile(SAPIENCE_MW_STORE_FILE);
    } catch {
      /* ignore */
    }
    this.watching = false;
  }
  /**
   * Reads the entire store file.
   */
  static async read(): Promise<Record<string, any>> {
    try {
      await fs.ensureDir(SAPIENCE_MW_DATA_DIR);
      if (await fs.pathExists(SAPIENCE_MW_STORE_FILE)) {
        return await fs.readJson(SAPIENCE_MW_STORE_FILE);
      }
      return {};
    } catch (error) {
      logger.error('Failed to read config store', { error });
      return {};
    }
  }

  /**
   * Synchronously reads the store file (used for initialization/registration).
   */
  static readSync(): Record<string, any> {
    try {
      if (!existsSync(SAPIENCE_MW_DATA_DIR)) {
        fs.mkdirSync(SAPIENCE_MW_DATA_DIR, { recursive: true });
      }
      if (existsSync(SAPIENCE_MW_STORE_FILE)) {
        return JSON.parse(readFileSync(SAPIENCE_MW_STORE_FILE, 'utf-8'));
      }
      return {};
    } catch (error) {
      logger.error('Failed to read config store (sync)', { error });
      return {};
    }
  }

  /**
   * Updates a specific section in the store, avoiding race conditions.
   * Path should be a dot-separated string like 'hitl.policy' or 'context_editing'.
   */
  static async update(pathStr: string, value: any): Promise<void> {
    const op = writeChain.then(async () => {
      const data = await this.read();
      this.setNestedValue(data, pathStr, value);
      await fs.writeJson(SAPIENCE_MW_STORE_FILE, data, { spaces: 2 });
    });
    writeChain = op.catch((err) => {
      logger.error('Failed to update config store', { error: err });
    });
    return op;
  }

  /**
   * Deletes top-level keys from the store, serialized through the write chain
   * to avoid racing with concurrent update() calls.
   */
  static async deleteKeys(keys: string[]): Promise<void> {
    const op = writeChain.then(async () => {
      const data = await this.read();
      let changed = false;
      for (const key of keys) {
        if (data[key] !== undefined) {
          delete data[key];
          changed = true;
        }
      }
      if (changed) {
        await fs.writeJson(SAPIENCE_MW_STORE_FILE, data, { spaces: 2 });
      }
    });
    writeChain = op.catch((err) => {
      logger.error('Failed to delete config store keys', { error: err });
    });
    return op;
  }

  /**
   * Synchronously updates a section in the store.
   */
  static updateSync(pathStr: string, value: any): void {
    const data = this.readSync();
    this.setNestedValue(data, pathStr, value);
    writeFileSync(SAPIENCE_MW_STORE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  }

  private static setNestedValue(obj: any, pathStr: string, value: any) {
    const keys = pathStr.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
  }
}
