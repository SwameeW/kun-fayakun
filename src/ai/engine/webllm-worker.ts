/*
 * The language model's own thread (docs/AI-INTELLIGENCE.md §3): WebLLM's MLCEngine, driven by our
 * own small protocol (./protocol.ts) through ./worker-handler.ts. It creates its own GPUDevice,
 * downloads and caches the pinned files it is told to load, and decodes a streamed reply one piece at
 * a time, only when the page pulls the next piece, one generation at a time. This is the only module
 * that imports WebLLM, so its runtime is in this worker's file alone and the page never downloads it.
 */
import { deleteModelAllInfoInCache, hasModelInCache, MLCEngine } from '@mlc-ai/web-llm';
import type { FromModelWorker, ToModelWorker } from './protocol';
import { createWorkerHandler } from './worker-handler';

const scope = self as unknown as { onmessage: ((event: MessageEvent<ToModelWorker>) => void) | null; postMessage(message: FromModelWorker): void };

const handle = createWorkerHandler(
  {
    createEngine: () => new MLCEngine({ logLevel: 'WARN' }),
    hasModelInCache,
    deleteModelAllInfoInCache,
  },
  (message) => {
    scope.postMessage(message);
  },
);

scope.onmessage = (event) => {
  void handle(event.data);
};
