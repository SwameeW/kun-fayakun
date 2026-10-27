/*
 * The page's side of the downloaded model (docs/AI-INTELLIGENCE.md §3): WebLLM's client for the
 * engine in ./webllm-worker.ts. WebLLM itself (about 2.3 MB gzipped) is imported inside load(), so
 * it is its own chunk, fetched only when a visitor asks for a model.
 *
 * - Loading: the pinned AppConfig (catalogue.ts), progress as LoadProgress, abortable (WebLLM's
 *   unload() aborts a reload in flight; the worker is then ended), failures as EngineErrors.
 * - Generating: OpenAI-style streaming with usage, thinking off, plans constrained to a JSON schema
 *   by XGrammar; each streamed piece is pulled through the pacer, so decoding yields to the scene.
 * - Crash markers before device creation, weight upload and the first prefill (detect.ts).
 */
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionRequestStreaming,
  InitProgressReport,
  WebWorkerMLCEngine,
} from '@mlc-ai/web-llm';
import type { EngineError, GenerateRequest, GenerateResult, LanguageEngine, LoadProgress, ModelSpec } from '../types';
import { buildAppConfig } from './catalogue';
import { clearStage, markStage } from './detect';
import { engineError, throwIfAborted, toEngineError } from './errors';
import type { Pacer } from './pacing';

/** A loaded WebLLM model: a LanguageEngine that also says why its last generation failed. */
export interface WebLlmEngine extends LanguageEngine {
  readonly kind: 'local';
  /** The failure behind the last finish 'error' (device lost, say), or null. */
  readonly lastError: EngineError | null;
}

/** The request WebLLM is given for a GenerateRequest (pure; tested in tests/unit/ai-engine.spec.ts). */
export function toCompletionRequest(request: GenerateRequest): ChatCompletionRequestStreaming {
  const messages: ChatCompletionMessageParam[] = request.messages.map((m) =>
    m.role === 'system' ? { role: 'system', content: m.content } : m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content },
  );
  return {
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: request.temperature ?? 0,
    max_tokens: request.maxTokens,
    ...(request.format.kind === 'json' ? { response_format: { type: 'json_object' as const, schema: JSON.stringify(request.format.schema) } } : {}),
    // Qwen3's thinking is switched off: its reasoning would spend the context window and the visitor's time.
    extra_body: { enable_thinking: false },
  };
}

const COMPILE_TEXT = /^(?:Loading model from cache|Loading GPU shader modules)/u;
const PARAMS_TEXT = /^(?:Start to fetch params|Fetching param cache|Loading model from cache)/u;

/** WebLLM's progress report as LoadProgress: downloaded bytes are the fraction of the model's download. */
export function toLoadProgress(report: Pick<InitProgressReport, 'progress' | 'text'>, totalBytes: number): LoadProgress {
  const fraction = Number.isFinite(report.progress) ? Math.min(1, Math.max(0, report.progress)) : 0;
  if (report.text.startsWith('Finish loading')) return { phase: 'ready', loadedBytes: totalBytes, totalBytes, fraction: 1 };
  if (COMPILE_TEXT.test(report.text)) return { phase: 'compile', loadedBytes: totalBytes, totalBytes, fraction };
  return { phase: 'download', loadedBytes: Math.round(fraction * totalBytes), totalBytes, fraction };
}

const FINISH: Readonly<Record<string, GenerateResult['finish']>> = { stop: 'stop', length: 'length', abort: 'abort', tool_calls: 'stop' };

/** Settles with `work`, or rejects as soon as the signal aborts or the worker fails. */
function guarded<T>(work: Promise<T>, signal: AbortSignal, worker: Worker): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      worker.removeEventListener('error', onError);
    };
    const onAbort = (): void => {
      cleanup();
      reject(engineError('aborted'));
    };
    const onError = (event: ErrorEvent): void => {
      cleanup();
      reject(toEngineError(event.message || 'The model worker failed to start'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('error', onError);
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err: unknown) => {
        cleanup();
        reject(toEngineError(err));
      },
    );
  });
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Downloads (if needed), compiles and readies `model` in its worker. Rejects with an EngineError:
 * aborted, network, quota, integrity, device-lost, out-of-memory, unsupported, no-webgpu or unknown.
 */
export async function loadWebLLM(model: ModelSpec, onProgress: (p: LoadProgress) => void, signal: AbortSignal, pacer: Pacer): Promise<WebLlmEngine> {
  throwIfAborted(signal);
  // A hidden tab starts nothing (§6).
  await pacer.visible();
  throwIfAborted(signal);
  let webllm: typeof import('@mlc-ai/web-llm');
  try {
    webllm = await import('@mlc-ai/web-llm');
  } catch (err) {
    throw toEngineError(err);
  }
  throwIfAborted(signal);

  const worker = new Worker(new URL('./webllm-worker.ts', import.meta.url), { type: 'module', name: 'kf-ai-webllm' });
  let readySent = false;
  /** Where the load is: the device is made before the first params report, uploads begin with "Loading model from cache". */
  let stage: 'device' | 'download' | 'upload' = 'device';
  const progress = (p: LoadProgress): void => {
    if (p.phase === 'ready') {
      if (readySent) return;
      readySent = true;
    }
    try {
      onProgress(p);
    } catch {
      // A listener's failure must not stop the load.
    }
  };
  const engine: WebWorkerMLCEngine = new webllm.WebWorkerMLCEngine(worker, {
    appConfig: buildAppConfig([model]),
    logLevel: 'WARN',
    initProgressCallback: (report) => {
      if (stage === 'device' && PARAMS_TEXT.test(report.text)) {
        clearStage();
        stage = 'download';
      }
      if (stage !== 'upload' && report.text.startsWith('Loading model from cache')) {
        markStage('upload', model.id);
        stage = 'upload';
      }
      progress(toLoadProgress(report, model.downloadBytes));
    },
  });

  let stopped = false;
  /** WebLLM's unload (which aborts a reload in flight and frees its device), then the worker ends. */
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await Promise.race([engine.unload().catch(() => undefined), delay(1500)]);
    worker.terminate();
  };

  progress({ phase: 'download', loadedBytes: 0, totalBytes: model.downloadBytes, fraction: 0 });
  markStage('device', model.id);
  try {
    await guarded(engine.reload(model.id), signal, worker);
    // WebLLM ends an aborted reload quietly; the signal says what happened.
    throwIfAborted(signal);
  } catch (err) {
    clearStage();
    await stop();
    throw toEngineError(err);
  }
  clearStage();
  progress({ phase: 'ready', loadedBytes: model.downloadBytes, totalBytes: model.downloadBytes, fraction: 1 });

  let prefilled = false;
  let interrupted = false;
  let lastError: EngineError | null = null;
  /** Read through functions: the flags change in callbacks while a generation awaits. */
  const wasStopped = (): boolean => stopped;
  const wasInterrupted = (request: GenerateRequest): boolean => interrupted || request.signal?.aborted === true;

  const generate = async (request: GenerateRequest): Promise<GenerateResult> => {
    const started = performance.now();
    let firstAt: number | null = null;
    let text = '';
    let finish: GenerateResult['finish'] = 'stop';
    let usage: ChatCompletionChunk['usage'];
    interrupted = false;
    lastError = null;
    const onAbort = (): void => {
      interrupted = true;
      engine.interruptGenerate();
    };
    const firstPrefill = !prefilled;
    // The budget is taken before prefill (§6) and kept until the last piece.
    const release = pacer.hold();
    try {
      await pacer.visible();
      if (wasStopped()) throw engineError('unknown', 'The model was unloaded');
      if (wasInterrupted(request)) return { text, finish: 'abort', promptTokens: 0, outputTokens: 0, prefillMs: 0, decodeMs: 0 };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      if (firstPrefill) markStage('prefill', model.id);
      const stream = await engine.chat.completions.create(toCompletionRequest(request));
      for await (const chunk of stream) {
        if (firstAt === null) {
          firstAt = performance.now();
          if (firstPrefill) {
            prefilled = true;
            clearStage();
          }
        }
        const choice = chunk.choices[0];
        const delta = choice?.delta.content ?? '';
        if (delta) {
          text += delta;
          if (request.format.kind === 'text') request.onText?.(delta);
        }
        if (choice?.finish_reason) finish = FINISH[choice.finish_reason] ?? 'stop';
        if (chunk.usage) usage = chunk.usage;
        // The next piece is decoded only when it is pulled: this is where the scene gets its frames.
        await pacer.gate();
      }
      if (wasInterrupted(request)) finish = 'abort';
    } catch (err) {
      if (wasInterrupted(request)) finish = 'abort';
      else {
        finish = 'error';
        lastError = toEngineError(err);
      }
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      if (firstPrefill) clearStage();
      release();
    }
    const ended = performance.now();
    const ttft = usage ? usage.extra.time_to_first_token_s * 1000 : firstAt !== null ? firstAt - started : ended - started;
    const total = usage ? usage.extra.e2e_latency_s * 1000 : ended - started;
    return {
      text,
      finish,
      promptTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      prefillMs: ttft,
      decodeMs: Math.max(0, total - ttft),
    };
  };

  return {
    kind: 'local',
    model: model.id,
    get lastError() {
      return lastError;
    },
    generate,
    interrupt() {
      interrupted = true;
      if (!stopped) engine.interruptGenerate();
    },
    unload: stop,
  };
}
