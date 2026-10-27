/// <reference lib="webworker" />
import { runBatch, type FromWorker, type ToWorker } from './batch';

/**
 * The assistant's background worker: comparisons and searches run here, headless, so the page and the
 * laboratory's own worker carry on. A thin wrapper over ./batch.ts: one job at a time per message id,
 * each abortable.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;
const running = new Map<number, AbortController>();

const post = (message: FromWorker): void => {
  scope.postMessage(message);
};

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const m = event.data;
  if (m.type === 'abort') {
    running.get(m.id)?.abort();
    return;
  }
  const control = new AbortController();
  running.set(m.id, control);
  runBatch(m.request, {
    signal: control.signal,
    onProgress: (fraction, phase) => {
      post({ type: 'progress', id: m.id, fraction, phase });
    },
  }).then(
    (result) => {
      running.delete(m.id);
      post({ type: 'done', id: m.id, result });
    },
    (err: unknown) => {
      running.delete(m.id);
      post({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err), aborted: control.signal.aborted });
    },
  );
};
