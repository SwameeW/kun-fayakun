/**
 * The scripted engine: a stand-in for a language model whose replies are written in the test, so
 * the whole pipeline runs in CI without a GPU. It is reached only through the test hook and unit
 * tests, never offered to visitors, and labelled "Test engine" on screen (kind 'scripted').
 *
 * Each reply matches on the request: the last user message (a substring, case-insensitive, or a
 * pattern, or a function of the request) and, optionally, the format asked for ('json' or 'text').
 * Replies are tried in order; a reply marked `once` is used up after it answers. A free-text reply
 * streams word by word through onText, with an optional delay between words; a request no reply
 * matches ends with finish 'error'. Token counts are estimated (characters / 3.5) so timings and
 * budgets behave plausibly. A stopped reply can be made to take a while to end, as a model's does
 * (the token or the prompt under way is finished first), and the engine counts the generations
 * under way, and the most it has had at once, so a test can see that the assistant never asks for two.
 * A reply can also end the engine, as a model whose worker ended: it ends with 'error', the engine's
 * `lost` is set, and every generation after it ends with 'error' at once.
 */
import type { EngineError, GenerateRequest, GenerateResult, LanguageEngine } from '../types';

export interface ScriptedReply {
  /** What the last user message must contain (case-insensitive), match, or satisfy. */
  match: string | RegExp | ((request: GenerateRequest, lastUser: string) => boolean);
  /** Only for this format; any format when left out. */
  format?: 'json' | 'text';
  /** The reply's text, or a function of the request. */
  reply: string | ((request: GenerateRequest) => string);
  /** How the reply ends (default 'stop'; 'length' marks it cut at the token limit). */
  finish?: 'stop' | 'length' | 'error';
  /** Used once, then skipped. */
  once?: boolean;
  /** Ends the engine instead of replying: it can no longer generate (`lost` set), as a model whose worker ended. */
  loses?: boolean;
}

export interface ScriptedOptions {
  /** Milliseconds between streamed words (default 0: as fast as the event loop allows). */
  delayMs?: number;
  /** Milliseconds a stopped reply takes to end, as a model finishes the step under way (default 0). */
  stopMs?: number;
}

/** The scripted engine, with the requests it was given (for tests to inspect). */
export interface ScriptedEngine extends LanguageEngine {
  readonly kind: 'scripted';
  readonly requests: readonly GenerateRequest[];
  /** Generations under way now (started, not yet ended). */
  readonly running: number;
  /** The most generations it has had under way at once. */
  readonly mostAtOnce: number;
  /** Adds replies after creation. */
  add(...replies: ScriptedReply[]): void;
}

function estimate(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function lastUser(request: GenerateRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const m = request.messages[i];
    if (m?.role === 'user') return m.content;
  }
  return '';
}

function matches(reply: ScriptedReply, request: GenerateRequest, user: string): boolean {
  if (reply.format && reply.format !== request.format.kind) return false;
  if (typeof reply.match === 'string') return user.toLowerCase().includes(reply.match.toLowerCase());
  if (reply.match instanceof RegExp) return reply.match.test(user);
  return reply.match(request, user);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function createScriptedEngine(script: readonly ScriptedReply[] = [], options: ScriptedOptions = {}): ScriptedEngine {
  const replies: Array<ScriptedReply & { used?: boolean }> = script.map((r) => ({ ...r }));
  const requests: GenerateRequest[] = [];
  let interrupter: AbortController | null = null;
  const delay = Math.max(0, options.delayMs ?? 0);
  const stopMs = Math.max(0, options.stopMs ?? 0);
  let running = 0;
  let mostAtOnce = 0;
  let lost: EngineError | null = null;

  async function generate(request: GenerateRequest): Promise<GenerateResult> {
    running += 1;
    mostAtOnce = Math.max(mostAtOnce, running);
    try {
      const result = await answer(request);
      // A stopped reply ends only once the step under way would have (a model's token, or its prompt).
      if (result.finish === 'abort' && stopMs > 0) {
        await new Promise((r) => {
          setTimeout(r, stopMs);
        });
      }
      return result;
    } finally {
      running -= 1;
    }
  }

  async function answer(request: GenerateRequest): Promise<GenerateResult> {
    requests.push(request);
    const started = Date.now();
    const promptTokens = request.messages.reduce((n, m) => n + estimate(m.content) + 4, 0);
    if (lost) return { text: '', finish: 'error', promptTokens: 0, outputTokens: 0, prefillMs: 0, decodeMs: 0 };
    const user = lastUser(request);
    const reply = replies.find((r) => !r.used && matches(r, request, user));
    if (!reply) return { text: '', finish: 'error', promptTokens, outputTokens: 0, prefillMs: 0, decodeMs: 0 };
    if (reply.once) reply.used = true;
    if (reply.loses) {
      lost = { code: 'unknown', messageKey: 'ai.engine.error.unknown', detail: 'The scripted engine was ended' };
      return { text: '', finish: 'error', promptTokens: 0, outputTokens: 0, prefillMs: 0, decodeMs: 0 };
    }
    const full = typeof reply.reply === 'function' ? reply.reply(request) : reply.reply;
    const local = new AbortController();
    interrupter = local;
    const onAbort = (): void => {
      local.abort();
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const prefillMs = Date.now() - started;
    const decodeStart = Date.now();
    let text = '';
    let outputTokens = 0;
    const limit = Math.max(1, request.maxTokens);
    try {
      if (request.signal?.aborted) return { text: '', finish: 'abort', promptTokens, outputTokens: 0, prefillMs, decodeMs: 0 };
      // Words with the space before them, so the pieces join back into the reply exactly.
      const pieces = full.match(/\s*\S+/gu) ?? [];
      for (const piece of pieces) {
        if (delay > 0 || request.format.kind === 'text') await wait(delay, local.signal);
        if (local.signal.aborted) return { text, finish: 'abort', promptTokens, outputTokens, prefillMs, decodeMs: Date.now() - decodeStart };
        const tokens = estimate(piece);
        if (outputTokens + tokens > limit) return { text, finish: 'length', promptTokens, outputTokens, prefillMs, decodeMs: Date.now() - decodeStart };
        text += piece;
        outputTokens += tokens;
        if (request.format.kind === 'text') request.onText?.(piece);
      }
      return { text, finish: reply.finish ?? 'stop', promptTokens, outputTokens, prefillMs, decodeMs: Date.now() - decodeStart };
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      if (interrupter === local) interrupter = null;
    }
  }

  return {
    kind: 'scripted',
    model: 'scripted',
    requests,
    get running() {
      return running;
    },
    get mostAtOnce() {
      return mostAtOnce;
    },
    get lost() {
      return lost;
    },
    generate,
    interrupt(): void {
      interrupter?.abort();
    },
    unload(): Promise<void> {
      interrupter?.abort();
      return Promise.resolve();
    },
    add(...more: ScriptedReply[]): void {
      replies.push(...more.map((r) => ({ ...r })));
    },
  };
}
