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
