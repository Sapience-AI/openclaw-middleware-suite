/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * SSE client — EventSource wrapper for /sse/logs/:source.
 */

export type LogSource = 'hitl' | 'routing' | 'context-editing' | 'guardrail' | 'pii' | 'proxy';

export function createLogStream(
  source: LogSource,
  onMessage: (record: Record<string, unknown>) => void,
  onError?: (err: Event) => void
): EventSource {
  const es = new EventSource(`/sse/logs/${source}`);

  es.onmessage = (event) => {
    try {
      const record = JSON.parse(event.data);
      onMessage(record);
    } catch {
      // non-JSON event (heartbeat, etc.) — ignore
    }
  };

  if (onError) {
    es.onerror = onError;
  }

  return es;
}
