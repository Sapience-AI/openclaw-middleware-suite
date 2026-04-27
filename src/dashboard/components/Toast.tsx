/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { signal } from '@preact/signals';

interface ToastItem {
  id: number;
  message: string;
  type: 'success' | 'error' | 'warning';
}

let nextId = 0;
export const toasts = signal<ToastItem[]>([]);

export function showToast(message: string, type: ToastItem['type'] = 'success') {
  const id = nextId++;
  toasts.value = [...toasts.value, { id, message, type }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 4000);
}

export function ToastContainer() {
  return (
    <div class="toast-container">
      {toasts.value.map((toast) => (
        <div key={toast.id} class={`toast ${toast.type}`}>
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
