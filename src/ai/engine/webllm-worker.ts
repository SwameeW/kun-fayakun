/*
 * The language model's own thread (docs/AI-INTELLIGENCE.md §3): WebLLM's MLCEngine, driven by our
 * own small protocol (./protocol.ts). It creates its own GPUDevice, downloads and caches the pinned
 * files it is told to load, and decodes a streamed reply one piece at a time, only when the page
 * pulls the next piece. This is the only module that imports WebLLM, so its runtime is in this
 * worker's file alone and the page never downloads it.
 */
import { deleteModelAllInfoInCache, hasModelInCache, MLCEngine, type AppConfig, type ChatCompletionChunk } from '@mlc-ai/web-llm';
import { toEngineError } from './errors';
import type { FromModelWorker, ModelPiece, ToModelWorker } from './protocol';

const scope = self as unknown as { onmessage: ((event: MessageEvent<ToModelWorker>) => void) | null; postMessage(message: FromModelWorker): void };

let engine: MLCEngine | null = null;
/** The reply being streamed: its id and where its pieces come from. */
let stream: { id: number; pieces: AsyncIterator<ChatCompletionChunk> } | null = null;

const post = (message: FromModelWorker): void => {
  scope.postMessage(message);
};

/** A failure as data: its EngineError code and the words it was read from. */
const fail = (id: number, err: unknown): void => {
  const e = toEngineError(err);
  post({ type: 'error', id, code: e.code, detail: e.detail ?? e.message });
};

/** Our AppConfig is structurally WebLLM's (src/ai/engine/catalogue.ts). */
const appConfigOf = (config: unknown): AppConfig => config as AppConfig;

function pieceOf(chunk: ChatCompletionChunk): ModelPiece {
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
        }
      : null,
  };
}

async function handle(message: ToModelWorker): Promise<void> {
  switch (message.type) {
    case 'load': {
      const { id } = message;
      try {
        engine ??= new MLCEngine({ logLevel: 'WARN' });
        engine.setAppConfig(appConfigOf(message.appConfig));
        engine.setInitProgressCallback((report) => {
          post({ type: 'progress', id, progress: report.progress, text: report.text });
        });
        await engine.reload(message.model);
        post({ type: 'loaded', id });
      } catch (err) {
        fail(id, err);
      }
      return;
    }
    case 'generate': {
      const { id } = message;
      try {
        if (!engine) throw new Error('No model is loaded');
        // A reply left unfinished is dropped: one stream at a time.
        stream = null;
        const created = await engine.chat.completions.create(message.request);
        stream = { id, pieces: created[Symbol.asyncIterator]() };
        post({ type: 'started', id });
      } catch (err) {
        fail(id, err);
      }
      return;
    }
    case 'pull': {
      const { id } = message;
      const current = stream;
      if (!current || current.id !== message.stream) {
        post({ type: 'piece', id, piece: null, done: true });
        return;
      }
      try {
        // The next piece is decoded only now, when the page has asked for it.
        const next = await current.pieces.next();
        if (next.done === true) {
          if (stream === current) stream = null;
          post({ type: 'piece', id, piece: null, done: true });
        } else {
          post({ type: 'piece', id, piece: pieceOf(next.value), done: false });
        }
      } catch (err) {
        if (stream === current) stream = null;
        fail(id, err);
      }
      return;
    }
    case 'interrupt':
      await engine?.interruptGenerate();
      return;
    case 'unload': {
      const { id } = message;
      stream = null;
      try {
        // Also ends a load in flight (WebLLM aborts its reload).
        await engine?.unload();
        engine = null;
        post({ type: 'result', id, value: true });
      } catch (err) {
        fail(id, err);
      }
      return;
    }
    case 'hasModelInCache': {
      const { id } = message;
      try {
        post({ type: 'result', id, value: await hasModelInCache(message.model, appConfigOf(message.appConfig)) });
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
        const stored = await hasModelInCache(message.model, appConfig);
        if (stored) await deleteModelAllInfoInCache(message.model, appConfig);
        post({ type: 'result', id, value: stored });
      } catch (err) {
        fail(id, err);
      }
      return;
    }
  }
}

scope.onmessage = (event) => {
  void handle(event.data);
};
