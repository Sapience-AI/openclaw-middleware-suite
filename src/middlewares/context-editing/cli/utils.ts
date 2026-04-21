import { ContextEditingStore } from '../storage/ContextEditingStore.js';

export function loadStore(): ContextEditingStore {
  const store = new ContextEditingStore();
  store.load();
  return store;
}
