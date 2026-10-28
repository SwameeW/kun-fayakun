/*
 * What the language model's worker does with each message (./protocol.ts; the worker itself is
 * ./webllm-worker.ts, the only module that imports WebLLM). WebLLM's runtime is given to it, so the
 * same handling runs in tests on WebLLM's own MLCEngine with a stand-in pipeline
 * (tests/unit/ai-generations.spec.ts).
 *
 * It creates its own GPUDevice (through WebLLM), downloads and caches the pinned files it is told to
 * load, and decodes a streamed reply one piece at a time, only when the page pulls the next piece. One
 * generation at a time (./generations.ts): a new one first ends the one under way, so WebLLM's lock on
 * the model is always let go.
 */
import type { AppConfig, ChatCompletionChunk, MLCEngine } from '@mlc-ai/web-llm';
import { toEngineError } from './errors';
import { createGenerations } from './generations';
import { applyPrefill, chunkOf, pipelineOf } from './prefill';
import type { PrefillReport } from '../types';
import type { FromModelWorker, ModelPiece, ToModelWorker } from './protocol';

/** The parts of WebLLM the worker uses. */
export interface WebLlmRuntime {
  createEngine(): MLCEngine;
  hasModelInCache(model: string, appConfig: AppConfig): Promise<boolean>;
  deleteModelAllInfoInCache(model: string, appConfig: AppConfig): Promise<void>;
}

/** How long an unload waits for the generation under way to end before it frees the model anyway, ms (the page ends the worker after 1.5 s). */
const UNLOAD_WAIT_MS = 1000;

/** Our AppConfig is structurally WebLLM's (src/ai/engine/catalogue.ts). */
const appConfigOf = (config: unknown): AppConfig => config as AppConfig;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Returns the worker's message handler; `post` sends a message back to the page. */
export function createWorkerHandler(runtime: WebLlmRuntime, post: (message: FromModelWorker) => void): (message: ToModelWorker) => Promise<void> {
  let engine: MLCEngine | null = null;
  /** The model loaded last (its pipeline's prompt chunk is read into each reply's usage). */
  let loaded: string | null = null;
  const generations = createGenerations({
    create(request) {
      if (!engine) return Promise.reject(new Error('No model is loaded'));
      return engine.chat.completions.create(request);
    },
    interrupt: () => engine?.interruptGenerate(),
  });

  /** A failure as data: its EngineError code and the words it was read from. */
  const fail = (id: number, err: unknown): void => {
    const e = toEngineError(err);
    post({ type: 'error', id, code: e.code, detail: e.detail ?? e.message });
  };

  /** The loaded pipeline's prompt chunk now (./prefill.ts), null where WebLLM holds none; never throws. */
  const prefillChunk = (): number | null => {
    try {
      return loaded === null ? null : chunkOf(pipelineOf(engine, loaded));
    } catch {
      return null;
    }
  };

  const pieceOf = (chunk: ChatCompletionChunk): ModelPiece => {
    const choice = chunk.choices[0];
    const usage = chunk.usage;
    return {
      delta: choice?.delta.content ?? '',
      finish: choice?.finish_reason ?? null,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            ttftMs: usage.extra.time_to_first_token_s * 1000,
            e2eMs: usage.extra.e2e_latency_s * 1000,
            prefillTokensPerS: usage.extra.prefill_tokens_per_s,
            decodeTokensPerS: usage.extra.decode_tokens_per_s,
            grammarInitMs: usage.extra.grammar_init_s !== undefined ? usage.extra.grammar_init_s * 1000 : null,
            prefillChunk: prefillChunk(),
          }
        : null,
    };
  };

  return async function handle(message: ToModelWorker): Promise<void> {
    switch (message.type) {
      case 'load': {
        const { id } = message;
        try {
          // A generation of the model before ends first (the page loads each model in a worker of its own).
          await generations.end();
          engine ??= runtime.createEngine();
          engine.setAppConfig(appConfigOf(message.appConfig));
          engine.setInitProgressCallback((report) => {
            post({ type: 'progress', id, progress: report.progress, text: report.text });
          });
          loaded = null;
          await engine.reload(message.model);
          loaded = message.model;
          // Each load makes a new pipeline: the prompt's chunk is set on it every time. applyPrefill never
          // throws; were it to, the model is still loaded, as compiled, and the report says so.
          let prefill: PrefillReport;
          try {
            prefill = applyPrefill(engine, message.model, message.prefill);
          } catch {
            prefill = { outcome: 'failed', compiled: null, chunkTokens: prefillChunk(), yieldBetween: false };
          }
          post({ type: 'loaded', id, prefill });
        } catch (err) {
          fail(id, err);
        }
        return;
      }
      case 'generate': {
        const { id } = message;
        try {
          if (!engine) throw new Error('No model is loaded');
          // Starts once the generation under way has ended (and let WebLLM's lock go).
          await generations.start(id, message.request);
          post({ type: 'started', id });
        } catch (err) {
          fail(id, err);
        }
        return;
      }
      case 'pull': {
        const { id } = message;
        try {
          // The next piece is decoded only now, when the page has asked for it.
          const chunk = await generations.pull(message.stream);
          post(chunk === null ? { type: 'piece', id, piece: null, done: true } : { type: 'piece', id, piece: pieceOf(chunk), done: false });
        } catch (err) {
          fail(id, err);
        }
        return;
      }
      case 'interrupt':
        try {
          await generations.interrupt(message.stream);
        } catch {
          // Nothing to stop.
        }
        return;
      case 'ping':
        post({ type: 'result', id: message.id, value: true });
        return;
      case 'unload': {
        const { id } = message;
        try {
          // The generation under way ends first, so its step does not run on a freed model; not for long.
          await Promise.race([generations.end(), delay(UNLOAD_WAIT_MS)]);
          // Also ends a load in flight (WebLLM aborts its reload).
          await engine?.unload();
          engine = null;
          loaded = null;
          post({ type: 'result', id, value: true });
        } catch (err) {
          fail(id, err);
        }
        return;
      }
      case 'hasModelInCache': {
        const { id } = message;
        try {
          post({ type: 'result', id, value: await runtime.hasModelInCache(message.model, appConfigOf(message.appConfig)) });
        } catch (err) {
          fail(id, err);
        }
        return;
      }
      case 'deleteModelAllInfoInCache': {
        const { id } = message;
        try {
          // WebLLM reads the model's manifest to know its files, and would download it if it were
          // not stored: without it here there is nothing for WebLLM to delete (the page sweeps the rest).
          const appConfig = appConfigOf(message.appConfig);
          const stored = await runtime.hasModelInCache(message.model, appConfig);
          if (stored) await runtime.deleteModelAllInfoInCache(message.model, appConfig);
          post({ type: 'result', id, value: stored });
        } catch (err) {
          fail(id, err);
        }
        return;
      }
    }
  };
}
