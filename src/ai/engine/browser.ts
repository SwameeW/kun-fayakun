/*
 * The browser's own model, where there is one (docs/AI-INTELLIGENCE.md §3): Chrome's Prompt API
 * (the global LanguageModel, desktop Chrome 148+). Nothing is downloaded by us. It is optional and
 * never required; Brave, Safari and Firefox do not have it.
 *
 * - availability() is asked with exactly the options create() is later given, so the answer is
 *   the one that applies.
 * - create() runs only inside a visitor's gesture (Chrome may start a multi-gigabyte download of its
 *   own model from it, and requires the gesture for that).
 * - Plans go through responseConstraint (the same JSON schema, validated again afterwards); prose
 *   streams through the pacer like the downloaded model's.
 */
import type { CapabilityReport, EngineError, GenerateRequest, GenerateResult, JsonSchema, LanguageEngine, LoadProgress } from '../types';
import { engineError, throwIfAborted, toEngineError } from './errors';
import type { Pacer } from './pacing';

/* The Prompt API as far as it is used here (it is not in TypeScript's DOM types yet). */

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface Expected {
  type: 'text';
  languages: readonly string[];
}

interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface CreateOptions {
  expectedInputs: readonly Expected[];
  expectedOutputs: readonly Expected[];
  initialPrompts?: readonly PromptMessage[];
  signal?: AbortSignal;
  monitor?: (monitor: EventTarget) => void;
}

interface PromptOptions {
  signal?: AbortSignal;
  responseConstraint?: JsonSchema;
}

interface Session {
  prompt(input: string, options?: PromptOptions): Promise<string>;
  promptStreaming(input: string, options?: PromptOptions): ReadableStream<string>;
  destroy(): void;
  /** Tokens used so far (named inputUsage before Chrome 14x, contextUsage after). */
  readonly contextUsage?: number;
  readonly inputUsage?: number;
}

interface LanguageModelStatic {
  availability(options: CreateOptions): Promise<Availability>;
  create(options: CreateOptions): Promise<Session>;
}

/** The browser's model as a LanguageEngine that also says why its last generation failed. */
export interface BrowserEngine extends LanguageEngine {
  readonly kind: 'browser';
  readonly lastError: EngineError | null;
}

/** The options availability() and create() are both given. */
export const PROMPT_OPTIONS: CreateOptions = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

function api(): LanguageModelStatic | null {
  if (!('LanguageModel' in globalThis)) return null;
  const lm = (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel;
  return lm && typeof lm.availability === 'function' && typeof lm.create === 'function' ? lm : null;
}

/** The browser model's availability for English text, or 'absent' where there is no Prompt API. */
export async function browserModelAvailability(): Promise<CapabilityReport['browserModel']> {
  const lm = api();
  if (!lm) return 'absent';
  try {
    return await lm.availability(PROMPT_OPTIONS);
  } catch {
    return 'unavailable';
  }
}

const usageOf = (s: Session): number => s.contextUsage ?? s.inputUsage ?? 0;

/**
 * Creates the browser's model session (call from a visitor's gesture). The browser may download its
 * own model first: its progress is passed on as a fraction (it gives no byte counts).
 */
export async function loadBrowserModel(onProgress: (p: LoadProgress) => void, signal: AbortSignal, pacer: Pacer): Promise<BrowserEngine> {
  const lm = api();
  if (!lm) throw engineError('unsupported', 'No Prompt API in this browser');
  throwIfAborted(signal);
  const availability = await browserModelAvailability();
  if (availability === 'unavailable' || availability === 'absent') throw engineError('unsupported', `Prompt API: ${availability}`);
  const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
  if (availability !== 'available' && activation?.isActive === false) throw engineError('unsupported', 'The browser model can only be fetched from a click or a key press');

  const report = (fraction: number, phase: LoadProgress['phase']): void => {
    try {
      onProgress({ phase, loadedBytes: 0, totalBytes: 0, fraction });
    } catch {
      // A listener's failure must not stop the load.
    }
  };
  let base: Session;
  try {
    base = await lm.create({
      ...PROMPT_OPTIONS,
      signal,
      monitor(m) {
        m.addEventListener('downloadprogress', (event) => {
          const loaded = (event as Event & { loaded?: number }).loaded;
          report(typeof loaded === 'number' ? Math.min(1, Math.max(0, loaded)) : 0, 'download');
        });
      },
    });
  } catch (err) {
    throwIfAborted(signal);
    throw toEngineError(err);
  }
  report(1, 'ready');

  let current: AbortController | null = null;
  let destroyed = false;
  let lastError: EngineError | null = null;

  const generate = async (request: GenerateRequest): Promise<GenerateResult> => {
    const started = performance.now();
    const controller = new AbortController();
    current = controller;
    const onAbort = (): void => {
      controller.abort();
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) controller.abort();
    // The Prompt API keeps a conversation in its session; a fresh one per request takes the
    // system message and the earlier turns as its initial prompts, so every call is stateless.
    const messages = [...request.messages];
    const last = messages.at(-1);
    const input = last?.role === 'user' ? (messages.pop()?.content ?? '') : '';
    const release = pacer.hold();
    let text = '';
    let firstAt: number | null = null;
    let finish: GenerateResult['finish'] = 'stop';
    let session: Session | null = null;
    let promptTokens = 0;
    lastError = null;
    try {
      if (destroyed) throw engineError('unknown', 'The browser model was unloaded');
      await pacer.visible();
      session = await lm.create({ ...PROMPT_OPTIONS, initialPrompts: messages.map((m) => ({ role: m.role, content: m.content })), signal: controller.signal });
      if (request.format.kind === 'json') {
        text = await session.prompt(input, { signal: controller.signal, responseConstraint: request.format.schema });
        firstAt = performance.now();
      } else {
        const reader = session.promptStreaming(input, { signal: controller.signal }).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          firstAt ??= performance.now();
          text += value;
          request.onText?.(value);
          await pacer.gate();
        }
      }
      promptTokens = usageOf(session);
    } catch (err) {
      finish = controller.signal.aborted ? 'abort' : 'error';
      if (finish === 'error') lastError = toEngineError(err);
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      session?.destroy();
      if (current === controller) current = null;
      release();
    }
    const ended = performance.now();
    const ttft = (firstAt ?? ended) - started;
    // The Prompt API reports only how much of its context the session has used (prompts and reply
    // together): that is given as promptTokens, and output tokens are not reported.
    return { text, finish, promptTokens, outputTokens: 0, prefillMs: ttft, decodeMs: Math.max(0, ended - started - ttft) };
  };

  return {
    kind: 'browser',
    model: 'browser',
    get lastError() {
      return lastError;
    },
    generate,
    interrupt() {
      current?.abort();
    },
    unload() {
      destroyed = true;
      current?.abort();
      base.destroy();
      return Promise.resolve();
    },
  };
}
