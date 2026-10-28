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
 * - One generation at a time (docs/AI-INTELLIGENCE.md §3): each waits for the one before it to end,
 *   so the worker never has two (it ends a stopped one at its next token: ./generations.ts), and the
 *   worker is watched while a generation waits on it (Watch, below).
 * - Crash markers before device creation, weight upload and the first prefill (detect.ts).
 * - How the prompt is read (prefill.ts): the worker sets the loaded pipeline's prompt chunk after
 *   every load and reports what happened, which each generation's engine usage carries.
 * - The render budget (pacing.ts) is held from the weights' upload to the end of the load (the
 *   upload syncs the device for every tensor, then the shaders compile), and for each generation
 *   from when it is asked for to its end, whichever way it ends, so the scene's governors never read
 *   the model's work as the scene's.
 */
import type { ChatCompletionMessageParam, ChatCompletionRequestStreaming, InitProgressReport } from '@mlc-ai/web-llm';
import type { EngineError, GenerateRequest, GenerateResult, JsonSchema, LanguageEngine, LoadProgress, ModelSpec, PrefillReport } from '../types';
import { buildAppConfig } from './catalogue';
import { clearStage, markStage } from './detect';
import { engineError, throwIfAborted, toEngineError, type EngineFailure } from './errors';
import type { Pacer } from './pacing';
import { prefillFor, type PrefillSetting } from './prefill';
import type { FromModelWorker, ModelPiece, ToModelWorker } from './protocol';

/** A loaded WebLLM model: a LanguageEngine that also says why its last generation failed. */
export interface WebLlmEngine extends LanguageEngine {
  readonly kind: 'local';
  /** Why the last generation to end failed (device lost, say), or null when it did not. */
  readonly lastError: EngineError | null;
  /** Why it can no longer generate (its worker ended by the watch, or its GPU device lost), or null. */
  readonly lost: EngineError | null;
  /** How the model reads its prompt, as its worker set it after the load (prefill.ts). */
  readonly prefill: PrefillReport;
}

/**
 * A pattern XGrammar cannot hold a reply to as JavaScript reads it: Unicode property classes, long
 * bounded repeats, and any pattern not anchored at both ends (JSON Schema searches a pattern in the
 * text; XGrammar makes the whole string match it, so "\S", meant as "not blank", allowed one
 * character: Qwen3 4B searched for "2" and "g").
 */
const UNGRAMMATICAL = /\\p\{|\{\d+,\d{2,}\}|^(?!\^)|(?<!\$)$/u;

/**
 * The schema XGrammar is given: the plan's schema without string lengths, number ranges, or the
 * patterns it reads otherwise than JavaScript does. Measured on this Mac (tests/ai-eval/grammar.spec.ts,
 * docs/AI-EVALUATION.md):
 * - a maxLength becomes a bounded repetition in the grammar, and XGrammar's start-up for a nine-tool
 *   plan took 10.7 s with them (Qwen3 0.6B) and 66 ms without;
 * - a pattern of Unicode letters ("[\p{L}\p{N} …]") let Qwen3 4B write only "N" or "L" where a
 *   laboratory body's name was asked for, and an unanchored one ("\S") only one character;
 * - a number's range sent the number to its maximum: asked for 0.3 in 0–0.95, Qwen3 1.7B wrote
 *   0.95, and for 1e22 kg in 1e6–1e26 it wrote 1.0000000000000000476e26; without the range it wrote
 *   0.3 and 1e22 (the grammar spec's number ranges).
 * None of it is lost: every reply is validated again in JS against the full schema (lengths,
 * patterns and ranges), and the reply's tokens are capped.
 */
const LEFT_OUT: ReadonlySet<string> = new Set(['maxLength', 'minLength', 'minimum', 'maximum']);

export function grammarSchema(schema: JsonSchema): JsonSchema {
  // Only a schema's own keywords go (an object of properties may name an argument anything).
  const strip = (node: unknown, isSchema: boolean): unknown => {
    if (Array.isArray(node)) return node.map((x) => strip(x, isSchema));
    if (typeof node !== 'object' || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (isSchema && LEFT_OUT.has(key)) continue;
      if (isSchema && key === 'pattern' && typeof value === 'string' && UNGRAMMATICAL.test(value)) continue;
      // Under "properties" are argument names, each with its schema; anything else of a schema is a schema or a value.
      out[key] = isSchema && key === 'properties' && typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, strip(v, true)])) : strip(value, isSchema && (key === 'items' || key === 'anyOf'));
    }
    return out;
  };
  return strip(schema, true) as JsonSchema;
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
  /** Ends generation `stream` (without one, the one in progress) at its next token. */
  interrupt(stream?: number): void;
  /** Ends the worker at once; requests still waiting reject as aborted (or with `error`, when given). */
  terminate(error?: EngineFailure): void;
}

/** What the client needs of a worker: the browser's Worker, or a test's stand-in for one. */
export interface WorkerPort {
  post(message: ToModelWorker): void;
  /** Sets what receives the worker's messages, and its failure to run. */
  listen(onMessage: (message: FromModelWorker) => void, onError: (text: string) => void): void;
  terminate(): void;
}

/** The client for a worker: numbers each request and settles it with the worker's answer. */
export function connectModelWorker(port: WorkerPort): ModelWorker {
  const waiting = new Map<number, { resolve: (a: Answer) => void; reject: (e: EngineFailure) => void; onProgress?: (report: { progress: number; text: string }) => void }>();
  let nextId = 1;
  let ended = false;
  const rejectAll = (error: EngineFailure): void => {
    for (const w of waiting.values()) w.reject(error);
    waiting.clear();
  };
  port.listen(
    (m) => {
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
    },
    (text) => {
      rejectAll(toEngineError(text || 'The model worker failed to start'));
    },
  );
  return {
    call(request, onProgress) {
      if (ended) return Promise.reject(engineError('aborted'));
      const id = nextId;
      nextId += 1;
      return new Promise<Answer>((resolve, reject) => {
        waiting.set(id, { resolve, reject, ...(onProgress ? { onProgress } : {}) });
        port.post({ ...request, id });
      });
    },
    interrupt(stream) {
      if (!ended) port.post({ type: 'interrupt', ...(stream !== undefined ? { stream } : {}) });
    },
    terminate(error) {
      if (ended) return;
      ended = true;
      port.terminate();
      rejectAll(error ?? engineError('aborted'));
    },
  };
}

/** Starts the model's worker (its script, with WebLLM in it, is fetched now). */
export function startModelWorker(): ModelWorker {
  const worker = new Worker(new URL('./webllm-worker.ts', import.meta.url), { type: 'module', name: 'kf-ai-webllm' });
  return connectModelWorker({
    post(message) {
      worker.postMessage(message);
    },
    listen(onMessage, onError) {
      worker.onmessage = (event: MessageEvent<FromModelWorker>) => {
        onMessage(event.data);
      };
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        onError(event.message);
      };
    },
    terminate() {
      worker.terminate();
    },
  });
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

/** A generation as the engine follows it: whether it was stopped, the worker's stream once started, and a wake for its waits. */
interface Run {
  interrupted: boolean;
  stream: number | null;
  /** Ends its waits (for the generation before it, or for the tab to show) at once. */
  wake(): void;
  woken: Promise<void>;
}

function newRun(): Run {
  let wake = (): void => undefined;
  const woken = new Promise<void>((resolve) => {
    wake = resolve;
  });
  return { interrupted: false, stream: null, wake, woken };
}

/**
 * How the page watches the worker while it waits on a generation's start or its next piece. A step
 * can take long (a prompt of thousands of tokens is read in one: Qwen3.5 4B read 3,618 tokens in 7.6 s
 * on this Mac), but WebLLM waits for the GPU without holding the worker's thread, so the worker
 * answers a ping at once while a step runs. Neither limit can cut a step that is making its way:
 * - `silentMs`: a ping unanswered this long means the worker has stopped (its thread ended or stuck);
 * - `stepMs`: no step takes this long (the whole context window, 4,096 tokens, read at under 14 tokens
 *   a second; the slowest model measured here, Qwen3.5 9B, read 266–330 a second).
 * Either ends the worker (the only way to stop a GPU device's work), and the generation ends with
 * finish 'error' and an EngineError that says which (lastError), and a warning in the console.
 */
export interface Watch {
  pingMs: number;
  silentMs: number;
  stepMs: number;
}

export const WATCH: Watch = { pingMs: 5000, silentMs: 30_000, stepMs: 300_000 };

/**
 * Downloads (if needed), compiles and readies `model` in its worker. Rejects with an EngineError:
 * aborted, network, quota, integrity, device-lost, out-of-memory, unsupported, no-webgpu or unknown.
 * `start` makes the worker (a test gives its own); `prefill` is how it reads its prompt (the model's
 * own setting unless the evaluation gives another); `watch` how the worker is watched (a test's own).
 */
export async function loadWebLLM(model: ModelSpec, onProgress: (p: LoadProgress) => void, signal: AbortSignal, pacer: Pacer, start: () => ModelWorker = startModelWorker, prefill: PrefillSetting = prefillFor(model), watch: Watch = WATCH): Promise<WebLlmEngine> {
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

  /** Generations not yet ended (under way, or waiting for the one before them): a stop or an unload reaches each. */
  const runs = new Set<Run>();
  let stopped = false;
  /** Why the worker was ended by the watch (watched, below), or null. */
  let lost: EngineFailure | null = null;
  /** The worker's unload (which ends the generation under way, aborts a reload in flight and frees its device), then the worker ends. */
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // An unload stops the generations it finds: they end as stopped, their budget let go.
    for (const run of runs) endRun(run);
    await Promise.race([worker.call({ type: 'unload' }).catch(() => undefined), delay(1500)]);
    worker.terminate();
  };
  /** Marks a generation stopped and wakes it if it waits; one under way is interrupted in the worker at its next token. */
  const endRun = (run: Run): void => {
    if (run.interrupted) return;
    run.interrupted = true;
    run.wake();
    if (run.stream !== null && !stopped) worker.interrupt(run.stream);
  };

  progress({ phase: 'download', loadedBytes: 0, totalBytes: model.downloadBytes, fraction: 0 });
  markStage('device', model.id);
  /** The render budget, from the weights' upload (or the shaders' compilation) to the load's end. */
  let release: (() => void) | null = null;
  let prefillReport: PrefillReport = { outcome: 'failed', compiled: null, chunkTokens: null, yieldBetween: false };
  try {
    const loading = worker.call({ type: 'load', appConfig: buildAppConfig([model]), model: model.id, prefill }, (report) => {
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
    const answer = await guarded(loading, signal);
    // WebLLM ends an aborted reload quietly; the signal says what happened.
    throwIfAborted(signal);
    if (answer.type === 'loaded') prefillReport = answer.prefill;
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
  let lastError: EngineError | null = null;
  /** A device lost in a generation: the model cannot generate again until it is loaded again. */
  let deviceLost: EngineError | null = null;
  /** Read through functions: the flags change in callbacks while a generation awaits. */
  const isUnloaded = (): boolean => stopped;
  const wasStopped = (run: Run): boolean => run.interrupted;
  /** Settles when the last generation asked for has ended: each waits for the one before it, so the worker never has two. */
  let tail: Promise<void> = Promise.resolve();

  /**
   * Settles with `work` (a request to the worker during a generation), unless the worker stops answering
   * pings (`watch.silentMs`) or the step outlasts `watch.stepMs`: then the worker is ended and this rejects.
   */
  const watched = <T>(work: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const began = performance.now();
      /** When the ping still unanswered was sent, or null. */
      let pinged: number | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const done = (): void => {
        settled = true;
        if (timer !== null) clearTimeout(timer);
      };
      const lose = (detail: string): void => {
        done();
        const error = engineError('unknown', detail);
        console.warn(`ai: ${detail}`);
        lost = error;
        stopped = true;
        for (const run of runs) run.wake();
        worker.terminate(error);
        reject(error);
      };
      const check = (): void => {
        if (settled) return;
        const t = performance.now();
        // Timers run late in a hidden tab; the worker's answers do not, so only a ping sent this long ago counts.
        if (pinged !== null && t - pinged > watch.silentMs) {
          lose(`The model's worker did not answer for ${Math.round(watch.silentMs / 1000)} s; it was ended`);
          return;
        }
        if (t - began > watch.stepMs) {
          lose(`One step of the model's reply took over ${Math.round(watch.stepMs / 1000)} s; its worker was ended`);
          return;
        }
        if (pinged === null) {
          const sent = t;
          pinged = sent;
          worker.call({ type: 'ping' }).then(
            () => {
              if (pinged === sent) pinged = null;
            },
            () => undefined,
          );
        }
        timer = setTimeout(check, watch.pingMs);
      };
      timer = setTimeout(check, watch.pingMs);
      work.then(
        (value) => {
          if (settled) return;
          done();
          resolve(value);
        },
        (err: unknown) => {
          if (settled) return;
          done();
          reject(toEngineError(err));
        },
      );
    });

  const generate = async (request: GenerateRequest): Promise<GenerateResult> => {
    const started = performance.now();
    let firstAt: number | null = null;
    let text = '';
    let finish: GenerateResult['finish'] = 'stop';
    let usage: ModelPiece['usage'] = null;
    const reply = thinkFilter();
    const run = newRun();
    runs.add(run);
    // One at a time: this one starts once the one before it has ended (a stopped one ends at its next
    // token; a prompt being read is finished first).
    const before = tail;
    let ended = (): void => undefined;
    const mine = new Promise<void>((resolve) => {
      ended = resolve;
    });
    tail = before.then(() => mine);
    const onAbort = (): void => {
      endRun(run);
    };
    if (request.signal?.aborted === true) endRun(run);
    request.signal?.addEventListener('abort', onAbort, { once: true });
    let firstPrefill = false;
    // The budget is taken before prefill (§6), and before waiting for the generation before, so it is
    // held throughout; it is let go on every way out below.
    const release = pacer.hold();
    try {
      await Promise.race([before, run.woken]);
      // Its listener goes once it is stopped, too (a hidden tab may stay hidden).
      await pacer.visible(run.woken);
      if (wasStopped(run)) {
        lastError = null;
        return { text, finish: 'abort', promptTokens: 0, outputTokens: 0, prefillMs: 0, decodeMs: 0 };
      }
      if (isUnloaded()) throw lost ?? engineError('unknown', 'The model was unloaded');
      firstPrefill = !prefilled;
      if (firstPrefill) markStage('prefill', model.id);
      const begun = await watched(worker.call({ type: 'generate', request: toCompletionRequest(request) }));
      if (begun.type !== 'started') throw engineError('unknown', `Unexpected answer: ${begun.type}`);
      run.stream = begun.id;
      // A stop that came while it was starting reaches the worker now: it ends the generation at the
      // pull below without starting it (./generations.ts).
      if (wasStopped(run) && !isUnloaded()) worker.interrupt(begun.id);
      for (;;) {
        // The worker decodes the next piece only now: this is where the scene gets its frames. A stopped
        // generation is still pulled to its end (the worker sends the pieces up to the stop and its usage).
        const answer = await watched(worker.call({ type: 'pull', stream: begun.id }));
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
          if (request.format.kind === 'text' && !wasStopped(run)) request.onText?.(shown);
        }
        if (piece.finish) finish = FINISH[piece.finish] ?? 'stop';
        if (piece.usage) usage = piece.usage;
        if (!wasStopped(run)) await pacer.gate();
      }
      const rest = reply.end();
      if (rest) {
        text += rest;
        if (request.format.kind === 'text' && !wasStopped(run)) request.onText?.(rest);
      }
      if (wasStopped(run)) finish = 'abort';
      lastError = null;
    } catch (err) {
      if (wasStopped(run)) {
        finish = 'abort';
        lastError = null;
      } else {
        finish = 'error';
        lastError = toEngineError(err);
        if (lastError.code === 'device-lost') deviceLost ??= lastError;
      }
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      if (firstPrefill) clearStage();
      runs.delete(run);
      ended();
      release();
    }
    const endedAt = performance.now();
    const ttft = usage ? usage.ttftMs : firstAt !== null ? firstAt - started : endedAt - started;
    const total = usage ? usage.e2eMs : endedAt - started;
    return {
      text,
      finish,
      promptTokens: usage?.promptTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      prefillMs: ttft,
      decodeMs: Math.max(0, total - ttft),
      ...(usage
        ? {
            engineUsage: {
              prefillTokensPerS: usage.prefillTokensPerS,
              decodeTokensPerS: usage.decodeTokensPerS,
              ttftMs: usage.ttftMs,
              e2eMs: usage.e2eMs,
              grammarInitMs: usage.grammarInitMs,
              prefill: { ...prefillReport, chunkAtGeneration: usage.prefillChunk },
            },
          }
        : {}),
    };
  };

  return {
    kind: 'local',
    model: model.id,
    get lastError() {
      return lastError;
    },
    get lost() {
      return lost ?? deviceLost;
    },
    prefill: prefillReport,
    generate,
    interrupt() {
      // Every generation asked for so far: the one under way, and any waiting for it.
      for (const run of runs) endRun(run);
    },
    unload: stop,
  };
}
