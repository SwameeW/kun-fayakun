/**
 * Generations one at a time (src/ai/engine/generations.ts, worker-handler.ts and webllm.ts;
 * docs/AI-INTELLIGENCE.md §3 and §6), in Node, on WebLLM 0.2.86's own MLCEngine. Its asyncGenerate,
 * with the model's lock and its interrupt, drives a stand-in pipeline whose GPU is a queue of timed
 * work; the worker's handler runs in this process behind a port that passes messages as a worker's
 * would (copied, a task later); the page's engine is the one the app loads. The lock is WebLLM's
 * CustomLock as its file writes it (checked below).
 *
 * The worker as it was (an unfinished stream dropped when the next began) is run first: there the
 * next generation never gets its answer and its render budget stays held. Then the worker as it is:
 * stopped while the prompt is read and asked again, stopped while it writes, two at once without a
 * stop, an interrupt that lands while the prompt's wrapper waits for the device, twenty asked and
 * stopped, an unload under way, and the watch on a worker that stops answering, on a long step it must
 * not cut, and on a step that never ends.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { MLCEngine, type ChatCompletionChunk, type ChatCompletionRequestStreaming } from '@mlc-ai/web-llm';
import { buildAppConfig, VISITOR_MODELS } from '../../src/ai/engine/catalogue';
import type { Pacer } from '../../src/ai/engine/pacing';
import type { FromModelWorker, ToModelWorker } from '../../src/ai/engine/protocol';
import { connectModelWorker, loadWebLLM, toCompletionRequest, type Watch, type WebLlmEngine, type WorkerPort } from '../../src/ai/engine/webllm';
import { createWorkerHandler, type WebLlmRuntime } from '../../src/ai/engine/worker-handler';
import type { ChatMessage, GenerateResult, ModelSpec } from '../../src/ai/types';

const WEBLLM = readFileSync(new URL('../../node_modules/@mlc-ai/web-llm/lib/index.js', import.meta.url), 'utf8');

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Whether `p` settles within `ms`. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  void p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await sleep(ms);
  return settled;
}

/** WebLLM 0.2.86's CustomLock, as its file writes it (the first test checks the file still does). */
class CustomLock {
  acquired = false;
  queue: (() => void)[] = [];
  acquire(): Promise<void> {
    if (!this.acquired) {
      this.acquired = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
  release(): Promise<void> {
    if (!this.acquired) throw Error('InternalError: expect lock is acquired upon release()');
    if (this.queue.length === 0) {
      this.acquired = false;
      return Promise.resolve();
    }
    const cont = this.queue.shift();
    return new Promise((res) => {
      cont?.();
      res();
    });
  }
}

/** The stand-in GPU: work runs in the order queued; a sync settles once all of it is done. While held, nothing finishes. */
class Gpu {
  private freeAt = 0;
  private held: Promise<void> | null = null;
  private letGo: (() => void) | null = null;
  /** Syncs waiting now (the prompt's wrapper waits in one between chunks). */
  waiting = 0;
  queue(ms: number): void {
    this.freeAt = Math.max(performance.now(), this.freeAt) + ms;
  }
  async sync(): Promise<void> {
    this.waiting += 1;
    try {
      for (;;) {
        if (this.held) {
          await this.held;
          continue;
        }
        const left = this.freeAt - performance.now();
        if (left <= 0) return;
        await sleep(left);
      }
    } finally {
      this.waiting -= 1;
    }
  }
  hold(): void {
    this.held ??= new Promise((resolve) => {
      this.letGo = resolve;
    });
  }
  release(): void {
    const go = this.letGo;
    this.held = null;
    this.letGo = null;
    go?.();
  }
}

/** Times on the stand-in GPU: a chunk of 128 prompt tokens, and one token written. */
interface Timing {
  chunkMs: number;
  tokenMs: number;
}

/**
 * What MLCEngine.asyncGenerate and its stream read of a pipeline, and what the prompt's setting
 * (src/ai/engine/prefill.ts) reaches: a chunk compiled at 1,024 tokens, embedAndForward, the device's sync.
 */
class Pipeline {
  prefillChunkSize = 1024;
  artifact = undefined;
  readonly device: { sync(): Promise<void> };
  message = '';
  stoppedFlag = false;
  finish: string | undefined = undefined;
  out = 0;
  max = 16;
  promptTokens = 0;
  /** Prompt chunks forwarded, over every generation. */
  chunks = 0;
  /** Rounds (generations) whose prompt was read to the end. */
  read = 0;
  constructor(
    private readonly gpu: Gpu,
    private readonly timing: Timing,
  ) {
    this.device = { sync: () => gpu.sync() };
  }
  embedAndForward(_data: unknown, length: number): Promise<object> {
    this.gpu.queue((this.timing.chunkMs * length) / 128);
    this.chunks += 1;
    return Promise.resolve({});
  }
  token(): void {
    this.out += 1;
    this.message += this.out === 1 ? 'w1' : ` w${this.out}`;
    if (this.out >= this.max) {
      this.stoppedFlag = true;
      this.finish = 'length';
    }
  }
  stopped(): boolean {
    return this.stoppedFlag;
  }
  triggerStop(): void {
    if (this.stoppedFlag) return;
    this.stoppedFlag = true;
    this.finish = 'abort';
  }
  getMessage(): string {
    return this.message;
  }
  getFinishReason(): string | undefined {
    return this.finish;
  }
  getTokenLogprobArray(): unknown[] {
    return [];
  }
  getCurRoundCompletionTotalTokens(): number {
    return this.out;
  }
  getCurRoundDecodingTotalTokens(): number {
    return Math.max(0, this.out - 1);
  }
  getCurRoundPrefillTotalTokens(): number {
    return this.promptTokens;
  }
  getCurRoundPrefillTotalTime(): number {
    return 0.01;
  }
  getCurRoundDecodingTotalTime(): number {
    return 0.01;
  }
  getCurRoundPrefillTokensPerSec(): number {
    return 1000;
  }
  getCurRoundDecodingTokensPerSec(): number {
    return 50;
  }
  getCurRoundLatencyBreakdown(): undefined {
    return undefined;
  }
  setSeed(): void {
    /* no seed is asked */
  }
  dispose(): void {
    /* nothing to free */
  }
  sync(): Promise<void> {
    return this.gpu.sync();
  }
}

const MODEL = VISITOR_MODELS.find((m) => m.tier === 'compact') as ModelSpec;
/** Tokens a prompt counts as here: a quarter of its characters. */
const tokensOf = (request: ChatCompletionRequestStreaming): number => Math.ceil(request.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0) / 4);

/** WebLLM's own MLCEngine, with a stand-in pipeline loaded by reload() and the prompt read and tokens written on the stand-in GPU. */
function standIn(gpu: Gpu, timing: Timing): { runtime: WebLlmRuntime; pipelines: Pipeline[]; locks: CustomLock[] } {
  const pipelines: Pipeline[] = [];
  const locks: CustomLock[] = [];
  const runtime: WebLlmRuntime = {
    createEngine() {
      const engine = new MLCEngine({ logLevel: 'WARN' });
      const own = engine as unknown as {
        loadedModelIdToPipeline: Map<string, unknown>;
        loadedModelIdToChatConfig: Map<string, unknown>;
        loadedModelIdToModelType: Map<string, unknown>;
        loadedModelIdToLock: Map<string, unknown>;
        reload(id: string): Promise<void>;
        chatCompletion(request: ChatCompletionRequestStreaming): Promise<AsyncIterable<ChatCompletionChunk>>;
        prefill(request: ChatCompletionRequestStreaming, pipeline: Pipeline): Promise<void>;
        decode(pipeline: Pipeline): Promise<void>;
      };
      own.reload = (id) => {
        const pipeline = new Pipeline(gpu, timing);
        const lock = new CustomLock();
        pipelines.push(pipeline);
        locks.push(lock);
        own.loadedModelIdToPipeline.set(id, pipeline);
        own.loadedModelIdToChatConfig.set(id, {});
        own.loadedModelIdToModelType.set(id, 0);
        own.loadedModelIdToLock.set(id, lock);
        return Promise.resolve();
      };
      // WebLLM's chatCompletion checks the request against a real model's config, then (streaming) returns asyncGenerate as is.
      own.chatCompletion = (request) => {
        const [id, pipeline] = [...own.loadedModelIdToPipeline.entries()][0] ?? [];
        if (id === undefined) return Promise.reject(new Error('Model not loaded'));
        return Promise.resolve(engine.asyncGenerate(request, id, pipeline as never, {} as never, { max_tokens: request.max_tokens, temperature: request.temperature }, Date.now()));
      };
      // As WebLLM's forwardPrefill and samplePrefillStep: every chunk through embedAndForward, one sync, the first token.
      own.prefill = async (request, pipeline) => {
        pipeline.message = '';
        pipeline.stoppedFlag = false;
        pipeline.finish = undefined;
        pipeline.out = 0;
        pipeline.max = request.max_tokens ?? 16;
        const tokens = tokensOf(request);
        pipeline.promptTokens = tokens;
        for (let at = 0; at < tokens; at += pipeline.prefillChunkSize) await pipeline.embedAndForward([[0]], Math.min(pipeline.prefillChunkSize, tokens - at));
        await pipeline.device.sync();
        pipeline.read += 1;
        pipeline.token();
      };
      own.decode = async (pipeline) => {
        gpu.queue(timing.tokenMs);
        await gpu.sync();
        pipeline.token();
      };
      return engine;
    },
    hasModelInCache: () => Promise.resolve(false),
    deleteModelAllInfoInCache: () => Promise.resolve(),
  };
  return { runtime, pipelines, locks };
}

type Handler = (runtime: WebLlmRuntime, post: (m: FromModelWorker) => void) => (m: ToModelWorker) => Promise<void>;

/** The worker as it was before generations were made one at a time: an unfinished stream was dropped when the next began. */
const asTheWorkerWas: Handler = (runtime, post) => {
  let engine: MLCEngine | null = null;
  let stream: { id: number; pieces: AsyncIterator<ChatCompletionChunk> } | null = null;
  return async (m) => {
    switch (m.type) {
      case 'load':
        engine = runtime.createEngine();
        await engine.reload(m.model);
        post({ type: 'loaded', id: m.id, prefill: { outcome: 'off', compiled: null, chunkTokens: null, yieldBetween: false } });
        return;
      case 'generate': {
        if (!engine) return;
        stream = null;
        const created = await engine.chat.completions.create(m.request);
        stream = { id: m.id, pieces: created[Symbol.asyncIterator]() };
        post({ type: 'started', id: m.id });
        return;
      }
      case 'pull': {
        const current = stream;
        if (current?.id !== m.stream) {
          post({ type: 'piece', id: m.id, piece: null, done: true });
          return;
        }
        const next = await current.pieces.next();
        if (next.done === true) post({ type: 'piece', id: m.id, piece: null, done: true });
        else post({ type: 'piece', id: m.id, piece: { delta: next.value.choices[0]?.delta.content ?? '', finish: next.value.choices[0]?.finish_reason ?? null, usage: null }, done: false });
        return;
      }
      case 'interrupt':
        await engine?.interruptGenerate();
        return;
      case 'unload':
        stream = null;
        await engine?.unload();
        post({ type: 'result', id: m.id, value: true });
        return;
      default:
        if ('id' in m) post({ type: 'result', id: m.id, value: true });
    }
  };
};

/** A port to the handler in this process, passing each message as a worker does: copied, a task later. `mute` makes the worker go silent. */
function inProcess(runtime: WebLlmRuntime, handler: Handler = createWorkerHandler): WorkerPort & { readonly ended: boolean; mute(): void; readonly log: readonly (ToModelWorker | FromModelWorker)[] } {
  let deliver: ((m: FromModelWorker) => void) | null = null;
  let ended = false;
  let muted = false;
  /** Every message, in the order sent: the page's and the worker's. */
  const log: (ToModelWorker | FromModelWorker)[] = [];
  const handle = handler(runtime, (m) => {
    const copy = structuredClone(m);
    setTimeout(() => {
      if (ended || muted) return;
      log.push(copy);
      deliver?.(copy);
    }, 0);
  });
  return {
    log,
    post(message) {
      log.push(message);
      const copy = structuredClone(message);
      setTimeout(() => {
        if (!ended) void handle(copy);
      }, 0);
    },
    listen(onMessage) {
      deliver = onMessage;
    },
    terminate() {
      ended = true;
    },
    get ended() {
      return ended;
    },
    mute() {
      muted = true;
    },
  };
}

/** A pacer that counts the budgets held (the render budget, §6). */
function countingPacer(): Pacer & { readonly holds: number; readonly most: number } {
  let holds = 0;
  let most = 0;
  return {
    gate: () => Promise.resolve(),
    visible: () => Promise.resolve(),
    hold() {
      holds += 1;
      most = Math.max(most, holds);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        holds -= 1;
      };
    },
    dispose: () => undefined,
    get holds() {
      return holds;
    },
    get most() {
      return most;
    },
  };
}

const WATCH: Watch = { pingMs: 20, silentMs: 200, stepMs: 10_000 };
const SHORT: ChatMessage[] = [
  { role: 'system', content: 'You explain astronomy in plain words.' },
  { role: 'user', content: 'Why is Mars red?' },
];
/** About 2,000 tokens here: eight chunks of 256. */
const LONG: ChatMessage[] = [
  { role: 'system', content: 'You explain astronomy in plain words. '.repeat(200) },
  { role: 'user', content: 'Which planet spins on its side?' },
];

interface Setup {
  engine: WebLlmEngine;
  pacer: ReturnType<typeof countingPacer>;
  port: ReturnType<typeof inProcess>;
  pipeline: () => Pipeline;
  lock: () => CustomLock;
  gpu: Gpu;
}

async function setUp(options: { handler?: Handler; timing?: Partial<Timing>; watch?: Watch } = {}): Promise<Setup> {
  const gpu = new Gpu();
  const timing: Timing = { chunkMs: 30, tokenMs: 5, ...options.timing };
  const { runtime, pipelines, locks } = standIn(gpu, timing);
  const pacer = countingPacer();
  const port = inProcess(runtime, options.handler);
  const engine = await loadWebLLM(MODEL, () => undefined, new AbortController().signal, pacer, () => connectModelWorker(port), { chunkTokens: 256, yieldBetween: true }, options.watch ?? WATCH);
  return { engine, pacer, port, gpu, pipeline: () => pipelines.at(-1) as Pipeline, lock: () => locks.at(-1) as CustomLock };
}

/** A generation through the page's engine, with its own stop. */
function ask(engine: WebLlmEngine, messages: readonly ChatMessage[], maxTokens = 16): { result: Promise<GenerateResult>; stop(): void; streamed: () => string } {
  const controller = new AbortController();
  let streamed = '';
  const result = engine.generate({
    messages,
    format: { kind: 'text' },
    maxTokens,
    temperature: 0,
    signal: controller.signal,
    onText: (d) => {
      streamed += d;
    },
  });
  return {
    result,
    stop: () => {
      controller.abort();
    },
    streamed: () => streamed,
  };
}

test('the stand-in is WebLLM 0.2.86’s own: asyncGenerate takes the model’s lock on its first step and lets it go only in its finally, and CustomLock is as written here', () => {
  const generator = WEBLLM.slice(WEBLLM.indexOf('    asyncGenerate(request, model, pipeline, chatConfig, genConfig, timeReceived, journal) {'), WEBLLM.indexOf('    interruptGenerate() {'));
  expect(generator).toMatch(/const lock = this\.loadedModelIdToLock\.get\(model\);\s+yield __await\(lock\.acquire\(\)\);/u);
  expect(generator).toMatch(/finally \{[\s\S]*yield __await\(lock\.release\(\)\);/u);
  expect(generator).toContain('this.interruptSignal = false;');
  const lock = WEBLLM.slice(WEBLLM.indexOf('class CustomLock {'), WEBLLM.indexOf('class CustomLock {') + 1400).replace(/\s+/gu, ' ');
  for (const line of ['if (!this.acquired) { // If lock is free, directly return this.acquired = true; }', 'this.queue.push(resolve);', 'if (this.queue.length === 0) { // No one is waiting for the lock, so we free it this.acquired = false; return; }', 'const cont = this.queue.shift(); return new Promise((res) => { cont(); res(); });']) {
    expect(lock).toContain(line);
  }
  // The interrupt is read only between tokens: a prompt being read is finished first.
  expect(WEBLLM).toMatch(/while \(!pipeline\.stopped\(\)\) \{\s+if \(this\.interruptSignal\) \{\s+pipeline\.triggerStop\(\);\s+break;/u);
});

test('WebLLM’s lock: a stream left at a yield keeps it, so the next generation waits for good; returned, it lets it go', async () => {
  const gpu = new Gpu();
  const { runtime, locks } = standIn(gpu, { chunkMs: 5, tokenMs: 2 });
  const engine = runtime.createEngine();
  await engine.reload(MODEL.id);
  const first = (await engine.chat.completions.create(toCompletionRequest({ messages: SHORT, format: { kind: 'text' }, maxTokens: 16 })))[Symbol.asyncIterator]();
  await first.next();
  expect(locks[0]?.acquired).toBe(true);
  const second = (await engine.chat.completions.create(toCompletionRequest({ messages: SHORT, format: { kind: 'text' }, maxTokens: 16 })))[Symbol.asyncIterator]();
  const waiting = second.next();
  expect(await settlesWithin(waiting, 300)).toBe(false);
  await first.return?.(undefined);
  expect(await settlesWithin(waiting, 300)).toBe(true);
  await second.return?.(undefined);
  expect(locks[0]?.acquired).toBe(false);
});

/**
 * The protocol as the page used it before: a generation's first piece asked for (its prompt being
 * read), a stop, then the next question at once without waiting for the first to end. Whether the
 * second's first piece comes within 1.5 s.
 */
async function askedOver(handler: Handler): Promise<boolean> {
  const gpu = new Gpu();
  const { runtime } = standIn(gpu, { chunkMs: 30, tokenMs: 5 });
  const worker = connectModelWorker(inProcess(runtime, handler));
  const request = (messages: readonly ChatMessage[]): ChatCompletionRequestStreaming => toCompletionRequest({ messages, format: { kind: 'text' }, maxTokens: 16 });
  try {
    await worker.call({ type: 'load', appConfig: buildAppConfig([MODEL]), model: MODEL.id, prefill: { chunkTokens: 256, yieldBetween: true } });
    const a = await worker.call({ type: 'generate', request: request(LONG) });
    void worker.call({ type: 'pull', stream: a.id }).catch(() => undefined);
    await sleep(60);
    worker.interrupt(a.id);
    const b = await worker.call({ type: 'generate', request: request(SHORT) });
    return await settlesWithin(worker.call({ type: 'pull', stream: b.id }), 1500);
  } finally {
    worker.terminate();
  }
}

test('as the worker was (an unfinished stream dropped when the next began), a question asked over a stopped one never gets its first piece; as it is, it does', async () => {
  expect(await askedOver(asTheWorkerWas)).toBe(false);
  expect(await askedOver(createWorkerHandler)).toBe(true);
});

test('stopped while it reads its prompt and asked again at once: the prompt is finished, then the second answer comes; nothing is held after', async () => {
  const s = await setUp();
  const a = ask(s.engine, LONG);
  await sleep(60);
  a.stop();
  await sleep(10);
  const started = performance.now();
  const b = ask(s.engine, SHORT);
  const [first, second] = await Promise.all([a.result, b.result]);
  expect(first.finish).toBe('abort');
  expect(second.finish).toBe('length');
  expect(second.text).toBe(Array.from({ length: 16 }, (_, i) => `w${i + 1}`).join(' '));
  // The first's prompt was read to its end before the second began (WebLLM reads an interrupt between tokens).
  expect(s.pipeline().read).toBe(2);
  expect(performance.now() - started).toBeGreaterThan(100);
  // The stopped one wrote nothing to the screen after its stop.
  expect(a.streamed()).toBe('');
  expect(s.pacer.holds).toBe(0);
  expect(s.lock().acquired).toBe(false);
  // Its usage still came: the setting in effect, as every generation reports it.
  expect(first.engineUsage?.prefill).toMatchObject({ outcome: 'set', chunkTokens: 256, yieldBetween: true, chunkAtGeneration: 256 });
});

test('stopped while it writes and asked again: it ends at its next token, the second answers', async () => {
  const s = await setUp();
  const a = ask(s.engine, SHORT, 400);
  await expect.poll(() => a.streamed().length).toBeGreaterThan(10);
  a.stop();
  const b = ask(s.engine, SHORT);
  const [first, second] = await Promise.all([a.result, b.result]);
  expect(first.finish).toBe('abort');
  expect(first.outputTokens).toBeLessThan(400);
  expect(second.finish).toBe('length');
  expect(s.pacer.holds).toBe(0);
  expect(s.lock().acquired).toBe(false);
});

test('two at once without a stop: the second waits for the first, which is written to its end, not cut', async () => {
  const s = await setUp();
  const a = ask(s.engine, SHORT, 60);
  await expect.poll(() => a.streamed().length).toBeGreaterThan(5);
  const b = ask(s.engine, SHORT, 20);
  const [first, second] = await Promise.all([a.result, b.result]);
  expect(first.finish).toBe('length');
  expect(first.outputTokens).toBe(60);
  expect(first.text.split(' ')).toHaveLength(60);
  expect(second.finish).toBe('length');
  expect(second.outputTokens).toBe(20);
  // The budget was held throughout, and once per generation at most two at a time (the second's taken while it waited).
  expect(s.pacer.most).toBe(2);
  expect(s.pacer.holds).toBe(0);
  // The page asked for the second only once the worker had said the first was done.
  const log = s.port.log;
  const starts = log.flatMap((m, i) => (m.type === 'generate' ? [i] : []));
  expect(starts).toHaveLength(2);
  const firstDone = log.findIndex((m) => m.type === 'piece' && m.done);
  expect(firstDone).toBeGreaterThan(-1);
  expect(firstDone).toBeLessThan(starts[1] ?? -1);
});

test('an interrupt that lands while the prompt’s wrapper waits for the device: no deadlock; the prompt is finished, the next starts once the device lets go', async () => {
  const s = await setUp();
  s.gpu.hold();
  const a = ask(s.engine, LONG);
  // Between the first chunk and the second, the wrapper waits for the device (prefill.ts).
  await expect.poll(() => s.gpu.waiting).toBe(1);
  expect(s.pipeline().chunks).toBe(1);
  a.stop();
  const b = ask(s.engine, SHORT);
  expect(await settlesWithin(Promise.race([a.result, b.result]), 300)).toBe(false);
  s.gpu.release();
  const [first, second] = await Promise.all([a.result, b.result]);
  expect(first.finish).toBe('abort');
  expect(second.finish).toBe('length');
  // Every chunk of the first prompt was read (eight of 256), and the second's (one).
  expect(s.pipeline().chunks).toBe(Math.ceil(tokensOf(toCompletionRequest({ messages: LONG, format: { kind: 'text' }, maxTokens: 16 })) / 256) + 1);
  expect(s.pacer.holds).toBe(0);
  expect(s.lock().acquired).toBe(false);
});

test('twenty asked and stopped in a row, then one left to finish: it does, every one ends, nothing is held', async () => {
  const s = await setUp();
  const asked: ReturnType<typeof ask>[] = [];
  const delays = [0, 5, 20, 60, 120];
  for (let i = 0; i < 20; i++) {
    const g = ask(s.engine, i % 5 === 4 ? LONG : SHORT, 40);
    asked.push(g);
    await sleep(delays[i % delays.length] ?? 0);
    g.stop();
  }
  const last = ask(s.engine, SHORT);
  const final = await last.result;
  expect(final.finish).toBe('length');
  const ended = await Promise.all(asked.map((g) => g.result));
  expect(ended.every((r) => r.finish === 'abort' || r.finish === 'length')).toBe(true);
  expect(ended.filter((r) => r.finish === 'abort').length).toBeGreaterThan(10);
  expect(s.pacer.holds).toBe(0);
  expect(s.lock().acquired).toBe(false);
});

test('unloaded while it reads its prompt: it and the one waiting for it end as stopped, and the budget is let go', async () => {
  const s = await setUp();
  const a = ask(s.engine, LONG);
  await sleep(40);
  const b = ask(s.engine, SHORT);
  await sleep(20);
  await s.engine.unload();
  const [first, second] = await Promise.all([a.result, b.result]);
  expect(first.finish).toBe('abort');
  expect(second.finish).toBe('abort');
  expect(s.pacer.holds).toBe(0);
  expect(s.port.ended).toBe(true);
  // Afterwards a generation fails at once, as before.
  const after = await ask(s.engine, SHORT).result;
  expect(after.finish).toBe('error');
  expect(s.pacer.holds).toBe(0);
});

test('a worker that stops answering: the watch ends it and says so, the generation ends with that error, the budget is let go', async () => {
  const s = await setUp();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  try {
    const a = ask(s.engine, SHORT, 400);
    await expect.poll(() => a.streamed().length).toBeGreaterThan(5);
    s.port.mute();
    const started = performance.now();
    const result = await a.result;
    expect(result.finish).toBe('error');
    expect(performance.now() - started).toBeLessThan(WATCH.silentMs + 4 * WATCH.pingMs + 200);
    expect(s.engine.lastError?.detail).toMatch(/did not answer for/u);
    expect(warnings.some((w) => /did not answer/u.test(w))).toBe(true);
    expect(s.port.ended).toBe(true);
    expect(s.pacer.holds).toBe(0);
    const next = await ask(s.engine, SHORT).result;
    expect(next.finish).toBe('error');
    expect(s.engine.lastError?.detail).toMatch(/did not answer for/u);
  } finally {
    console.warn = warn;
  }
});

test('a long step is not cut: a prompt read for three times the silence the watch allows, the worker answering its pings, ends as written', async () => {
  // About 2,000 tokens at 80 ms a chunk of 256 (in eight chunks, with the wait between them): over 600 ms in one step.
  const s = await setUp({ timing: { chunkMs: 40 } });
  const started = performance.now();
  const result = await ask(s.engine, LONG).result;
  expect(performance.now() - started).toBeGreaterThan(3 * WATCH.silentMs);
  expect(result.finish).toBe('length');
  expect(s.port.ended).toBe(false);
  expect(s.pacer.holds).toBe(0);
});

test('a step that never ends, the worker still answering, is ended after the step’s limit, and says so', async () => {
  const s = await setUp({ watch: { pingMs: 20, silentMs: 200, stepMs: 600 } });
  s.gpu.hold();
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const result = await ask(s.engine, LONG).result;
    expect(result.finish).toBe('error');
    expect(s.engine.lastError?.detail).toMatch(/took over/u);
    expect(s.port.ended).toBe(true);
    expect(s.pacer.holds).toBe(0);
  } finally {
    console.warn = warn;
    s.gpu.release();
  }
});
