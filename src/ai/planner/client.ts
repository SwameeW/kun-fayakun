import type { BatchRequest, BatchResult, FromWorker, ToWorker } from './batch';

/**
 * Runs a background job in the assistant's own dedicated worker (a module worker of its own chunk),
 * or in the page where workers do not exist (Node, tests). The worker is started for the job and
 * ended after it, or at once when the signal aborts.
 */

let nextId = 1;

/** An abort, by the name the DOM gives one (the engine's side need not be loaded to tell it). */
const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });

export function runInBackground(request: BatchRequest, onProgress: (fraction: number, phase: 'replay' | 'run') => void, signal: AbortSignal): Promise<BatchResult> {
  if (signal.aborted) return Promise.reject(abortError());
  // No workers (Node, tests): the same job in this thread, its code loaded only now.
  if (typeof Worker === 'undefined') return import('./batch').then(({ runBatch }) => runBatch(request, { signal, onProgress }));
  const worker = new Worker(new URL('./batch-worker.ts', import.meta.url), { type: 'module', name: 'kf-ai-batch' });
  const id = nextId;
  nextId += 1;
  return new Promise<BatchResult>((resolve, reject) => {
    const end = (): void => {
      signal.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = (): void => {
      worker.postMessage({ type: 'abort', id } satisfies ToWorker);
      end();
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const m = event.data;
      if (m.id !== id) return;
      if (m.type === 'progress') onProgress(m.fraction, m.phase);
      else if (m.type === 'done') {
        end();
        resolve(m.result);
      } else {
        end();
        reject(m.aborted ? abortError() : new Error(m.message));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      end();
      reject(new Error(event.message || 'the background worker failed'));
    };
    worker.postMessage({ type: 'run', id, request } satisfies ToWorker);
  });
}
