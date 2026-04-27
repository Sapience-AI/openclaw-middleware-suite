/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [preact()],
  root: __dirname,
  base: '/dashboard/',
  publicDir: resolve(__dirname, 'public'),
  build: {
    outDir: resolve(__dirname, '../../dist/dashboard'),
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['preact', 'preact/hooks', '@preact/signals'],
          charts: ['uplot'],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:9000',
      '/sse': 'http://127.0.0.1:9000',
    },
  },
});
