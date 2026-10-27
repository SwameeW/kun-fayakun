/*
 * The language model's own thread (docs/AI-INTELLIGENCE.md §3): WebLLM's MLCEngine behind its
 * worker handler. It creates its own GPUDevice, downloads and caches the pinned files it is told
 * to load, and answers the page's requests one message at a time. The page (./webllm.ts) pulls
 * each streamed piece, so decoding goes only as fast as the page asks.
 */
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

const handler = new WebWorkerMLCEngineHandler();

const scope = self as unknown as { onmessage: ((event: MessageEvent) => void) | null };
scope.onmessage = (event: MessageEvent) => {
  handler.onmessage(event);
};
