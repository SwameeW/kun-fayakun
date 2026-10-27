/*
 * The page's side of the downloaded model (docs/AI-INTELLIGENCE.md §3): a client for our own worker
 * (./webllm-worker.ts), spoken to in our own small protocol (./protocol.ts). WebLLM itself (about
 * 2.2 MB gzipped) is imported by the worker alone, so it is downloaded once, with the worker, and
 * only when a visitor asks for a model (or deletes one already stored). This file only imports
 * WebLLM's types, which leave nothing in the page's code.
 *
 * - Loading: the pinned AppConfig (catalogue.ts), progress as LoadProgress, abortable (the worker's
 *   unload aborts a reload in flight; the worker is then ended), failures as EngineErrors.
 * - Generating: OpenAI-style streaming with usage, thinking off (and the empty thinking block WebLLM
 *   still streams back taken off the reply: thinkFilter), plans constrained to a JSON schema by
 *   XGrammar (without string lengths or the patterns it cannot read: grammarSchema). Each piece is pulled: the worker decodes the
 *   next one only when the page asks, and the page asks through the pacer, so decoding yields to
 *   the scene.
 * - Crash markers before device creation, weight upload and the first prefill (detect.ts).
 * - The render budget (pacing.ts) is held from the weights' upload to the end of the load (the
 *   upload syncs the device for every tensor, then the shaders compile), and for each generation, so
 *   the scene's governors never read the model's work as the scene's.
 */
import type { ChatCompletionMessageParam, ChatCompletionRequestStreaming, InitProgressReport } from '@mlc-ai/web-llm';
import type { EngineError, GenerateRequest, GenerateResult, JsonSchema, LanguageEngine, LoadProgress, ModelSpec } from '../types';
import { buildAppConfig } from './catalogue';
import { clearStage, markStage } from './detect';
import { engineError, throwIfAborted, toEngineError, type EngineFailure } from './errors';
import type { Pacer } from './pacing';
import type { FromModelWorker, ModelPiece, ToModelWorker } from './protocol';

/** A loaded WebLLM model: a LanguageEngine that also says why its last generation failed. */
export interface WebLlmEngine extends LanguageEngine {
  readonly kind: 'local';
  /** The failure behind the last finish 'error' (device lost, say), or null. */
  readonly lastError: EngineError | null;
}

/**
 * A pattern XGrammar cannot hold a reply to as JavaScript reads it: Unicode property classes, long
 * bounded repeats, and any pattern not anchored at both ends (JSON Schema searches a pattern in the
 * text; XGrammar makes the whole string match it, so "\S", meant as "not blank", allowed one
 * character: Qwen3 4B searched for "2" and "g").
 */
const UNGRAMMATICAL = /\\p\{|\{\d+,\d{2,}\}|^(?!\^)|(?<!\$)$/u;

/**
 * The schema XGrammar is given: the plan's schema without string lengths, and without the patterns it
 * reads otherwise than JavaScript does. Measured on this Mac (tests/ai-eval/grammar.spec.ts,
 * docs/AI-EVALUATION.md):
 * - a maxLength becomes a bounded repetition in the grammar, and XGrammar's start-up for a nine-tool
 *   plan took 10.7 s with them (Qwen3 0.6B) and 66 ms without;
 * - a pattern of Unicode letters ("[\p{L}\p{N} …]") let Qwen3 4B write only "N" or "L" where a
 *   laboratory body's name was asked for, and an unanchored one ("\S") only one character.
 * Neither is lost: every reply is validated again in JS against the full schema (lengths and
 * patterns), and the reply's tokens are capped.
 */
export function grammarSchema(schema: JsonSchema): JsonSchema {
  return JSON.parse(
    JSON.stringify(schema, (key, value: unknown) => {
      if (key === 'maxLength' || key === 'minLength') return undefined;
      if (key === 'pattern' && typeof value === 'string' && UNGRAMMATICAL.test(value)) return undefined;
      return value;
    }),
  ) as JsonSchema;
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
    ...(request.format.kind === 'json' ? { response_format: { type: 'json_object' as const, schema: JSON.stringify(grammarSchema(request.format.schema)) } } : {}),
    // Qwen3's thinking is switched off: its reasoning would spend the context window and the visitor's time.
    extra_body: { enable_thinking: false },
  };
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * The reply without its thinking block. With thinking off, WebLLM 0.2.86 still puts the empty block
 * Qwen's template expects ("<think>\n\n</think>\n\n") at the start of the reply it streams back (it
 * is the assistant's prefix in its output ids), and it reached the screen on every real model's
 * answer. A block at the start, empty or not, is dropped with the whitespace after it; what follows
 * is passed on as it comes. A block never closed is all reasoning, and none of it is passed on.
 */
export interface ThinkFilter {
  /** The part of this piece that is reply text (held back while it may still be the block). */
  push(delta: string): string;
  /** What was held back and is reply text after all, at the end of the reply. */
  end(): string;
}

export function thinkFilter(): ThinkFilter {
  let state: 'start' | 'thinking' | 'after' | 'text' = 'start';
  let held = '';
  const pass = (text: string): string => {
    if (state === 'after') {
      const rest = text.replace(/^\s+/u, '');
      if (rest.length > 0) state = 'text';
      return rest;
    }
    return text;
  };
  return {
    push(delta) {
      if (state === 'text') return delta;
      if (state === 'after') return pass(delta);
      held += delta;
      if (state === 'start') {
        const lead = held.replace(/^\s+/u, '');
        if (lead.length < THINK_OPEN.length && THINK_OPEN.startsWith(lead)) return '';
        if (!lead.startsWith(THINK_OPEN)) {
          state = 'text';
          const out = held;
          held = '';
          return out;
        }
        state = 'thinking';
      }
      const close = held.indexOf(THINK_CLOSE);
      if (close < 0) return '';
      const rest = held.slice(close + THINK_CLOSE.length);
      held = '';
      state = 'after';
      return pass(rest);
    },
    end() {
      // A reply that was only the start of "<think>" was text after all; an unclosed block was not.
      const out = state === 'start' ? held : '';
      held = '';
      return out;
    },
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

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A request without its id: the client numbers it. */
type Request = ToModelWorker extends infer M ? (M extends { id: number } ? Omit<M, 'id'> : never) : never;
/** The answers a request can settle with (progress goes to its listener instead). */
type Answer = Exclude<FromModelWorker, { type: 'progress' } | { type: 'error' }>;

/** The model's worker, as the page speaks to it: numbered requests, each settled by one answer. */
export interface ModelWorker {
  /** Sends a request; resolves with its answer, rejects with an EngineError (the worker's, or its failure to run). */
  call(request: Request, onProgress?: (report: { progress: number; text: string }) => void): Promise<Answer>;
  /** Ends the generation in progress at its next token. */
  interrupt(): void;
  /** Ends the worker at once; requests still waiting reject as aborted. */
  terminate(): void;
}

/** Starts the model's worker (its script, with WebLLM in it, is fetched now). */
export function startModelWorker(): ModelWorker {
  const worker = new Worker(new URL('./webllm-worker.ts', import.meta.url), { type: 'module', name: 'kf-ai-webllm' });
  const waiting = new Map<number, { resolve: (a: Answer) => void; reject: (e: EngineFailure) => void; onProgress?: (report: { progress: number; text: string }) => void }>();
  let nextId = 1;
  let ended = false;
  const rejectAll = (error: EngineFailure): void => {
    for (const w of waiting.values()) w.reject(error);
    waiting.clear();
  };
  worker.onmessage = (event: MessageEvent<FromModelWorker>) => {
    const m = event.data;
    const w = waiting.get(m.id);
    if (!w) return;
    if (m.type === 'progress') {
      try {
        w.onProgress?.({ progress: m.progress, text: m.text });
      } catch {
        // A listener's failure must not stop the load.
      }
      return;
    }
    waiting.delete(m.id);
    if (m.type === 'error') w.reject(engineError(m.code, m.detail));
    else w.resolve(m);
  };
  worker.onerror = (event: ErrorEvent) => {
    event.preventDefault();
    rejectAll(toEngineError(event.message || 'The model worker failed to start'));
  };
  return {
    call(request, onProgress) {
      if (ended) return Promise.reject(engineError('aborted'));
      const id = nextId;
      nextId += 1;
      return new Promise<Answer>((resolve, reject) => {
        waiting.set(id, { resolve, reject, ...(onProgress ? { onProgress } : {}) });
        worker.postMessage({ ...request, id });
      });
    },
    interrupt() {
      if (!ended) worker.postMessage({ type: 'interrupt' } satisfies ToModelWorker);
    },
    terminate() {
      if (ended) return;
      ended = true;
      worker.terminate();
      rejectAll(engineError('aborted'));
    },
  };
}

/** Rejects as soon as the signal aborts; otherwise settles with `work`, its failure as an EngineError. */
function guarded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(engineError('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(toEngineError(err));
      },
    );
  });
}

/** Runs one cache request in a worker of its own, ended after it. */
async function inShortWorker(type: 'hasModelInCache' | 'deleteModelAllInfoInCache', model: ModelSpec): Promise<boolean> {
  const worker = startModelWorker();
  try {
    const answer = await worker.call({ type, appConfig: buildAppConfig([model]), model: model.id });
    return answer.type === 'result' && answer.value;
  } finally {
    worker.terminate();
  }
}

/** Whether every file of a model is in this browser's cache (WebLLM's own reading, in its worker). */
export function modelInCache(model: ModelSpec): Promise<boolean> {
  return inShortWorker('hasModelInCache', model);
}

/**
 * WebLLM's deletion of a model's weights, tokenizer, library and configuration, in its worker; only
 * when its manifest is stored, so deleting never downloads anything.
 */
export async function deleteModelInWorker(model: ModelSpec): Promise<void> {
  await inShortWorker('deleteModelAllInfoInCache', model);
}

/**
 * Downloads (if needed), compiles and readies `model` in its worker. Rejects with an EngineError:
 * aborted, network, quota, integrity, device-lost, out-of-memory, unsupported, no-webgpu or unknown.
 * `start` makes the worker (a test gives its own).
 */
export async function loadWebLLM(model: ModelSpec, onProgress: (p: LoadProgress) => void, signal: AbortSignal, pacer: Pacer, start: () => ModelWorker = startModelWorker): Promise<WebLlmEngine> {
  throwIfAborted(signal);
  // A hidden tab starts nothing (§6).
  await pacer.visible();
  throwIfAborted(signal);

  const worker = start();
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

  let stopped = false;
  /** The worker's unload (which aborts a reload in flight and frees its device), then the worker ends. */
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await Promise.race([worker.call({ type: 'unload' }).catch(() => undefined), delay(1500)]);
    worker.terminate();
  };

  progress({ phase: 'download', loadedBytes: 0, totalBytes: model.downloadBytes, fraction: 0 });
  markStage('device', model.id);
  /** The render budget, from the weights' upload (or the shaders' compilation) to the load's end. */
  let release: (() => void) | null = null;
  try {
    const loading = worker.call({ type: 'load', appConfig: buildAppConfig([model]), model: model.id }, (report) => {
      if (stage === 'device' && PARAMS_TEXT.test(report.text)) {
        clearStage();
        stage = 'download';
      }
      if (stage !== 'upload' && report.text.startsWith('Loading model from cache')) {
        markStage('upload', model.id);
        stage = 'upload';
      }
      if (release === null && COMPILE_TEXT.test(report.text)) release = pacer.hold();
      progress(toLoadProgress(report, model.downloadBytes));
    });
    await guarded(loading, signal);
    // WebLLM ends an aborted reload quietly; the signal says what happened.
    throwIfAborted(signal);
  } catch (err) {
    clearStage();
    await stop();
    throw toEngineError(err);
  } finally {
    (release as (() => void) | null)?.();
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
    let usage: ModelPiece['usage'] = null;
    const reply = thinkFilter();
    interrupted = false;
    lastError = null;
    const onAbort = (): void => {
      interrupted = true;
      worker.interrupt();
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
      const begun = await worker.call({ type: 'generate', request: toCompletionRequest(request) });
      if (begun.type !== 'started') throw engineError('unknown', `Unexpected answer: ${begun.type}`);
      for (;;) {
        // The worker decodes the next piece only now: this is where the scene gets its frames.
        const answer = await worker.call({ type: 'pull', stream: begun.id });
        if (answer.type !== 'piece' || answer.done || !answer.piece) break;
        const piece = answer.piece;
        if (firstAt === null) {
          firstAt = performance.now();
          if (firstPrefill) {
            prefilled = true;
            clearStage();
          }
        }
        const shown = piece.delta ? reply.push(piece.delta) : '';
        if (shown) {
          text += shown;
          if (request.format.kind === 'text') request.onText?.(shown);
        }
        if (piece.finish) finish = FINISH[piece.finish] ?? 'stop';
        if (piece.usage) usage = piece.usage;
        await pacer.gate();
      }
      const rest = reply.end();
      if (rest) {
        text += rest;
        if (request.format.kind === 'text') request.onText?.(rest);
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
    const ttft = usage ? usage.ttftMs : firstAt !== null ? firstAt - started : ended - started;
    const total = usage ? usage.e2eMs : ended - started;
    return {
      text,
      finish,
      promptTokens: usage?.promptTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      prefillMs: ttft,
      decodeMs: Math.max(0, total - ttft),
      ...(usage
        ? { engineUsage: { prefillTokensPerS: usage.prefillTokensPerS, decodeTokensPerS: usage.decodeTokensPerS, ttftMs: usage.ttftMs, e2eMs: usage.e2eMs, grammarInitMs: usage.grammarInitMs } }
        : {}),
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
      if (!stopped) worker.interrupt();
    },
    unload: stop,
  };
}
