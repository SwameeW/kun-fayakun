/**
 * How a loaded model reads its prompt (src/ai/engine/prefill.ts, docs/AI-INTELLIGENCE.md §6), without
 * a GPU: the chunk set on a pipeline shaped as WebLLM 0.2.86's, every way its internals could differ
 * (nothing changes, nothing throws, the report says which), a model switched to, the page's engine
 * carrying the setting and the report through loads and generations (a second one, one aborted while
 * it reads its prompt, the crash marker of the first), a long prompt cut by WebLLM's own chunking, and
 * WebLLM's file checked for the fields the setting reaches, so an upgrade that moves them is noticed.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { VISITOR_MODELS } from '../../src/ai/engine/catalogue';
import type { Pacer } from '../../src/ai/engine/pacing';
import { applyPrefill, chunkOf, MIN_CHUNK_TOKENS, NO_PREFILL_SETTING, pipelineOf, prefillFor, type PrefillSetting } from '../../src/ai/engine/prefill';
import type { ModelPiece } from '../../src/ai/engine/protocol';
import { loadWebLLM, type ModelWorker } from '../../src/ai/engine/webllm';
import type { PrefillReport } from '../../src/ai/types';

const ROOT = new URL('../../', import.meta.url);
const WEBLLM = readFileSync(new URL('node_modules/@mlc-ai/web-llm/lib/index.js', ROOT), 'utf8');
const WEBLLM_VERSION = (JSON.parse(readFileSync(new URL('node_modules/@mlc-ai/web-llm/package.json', ROOT), 'utf8')) as { version: string }).version;

/* ------------------------------------------------------------------ */
/* A pipeline and an engine shaped as WebLLM 0.2.86's                   */
/* ------------------------------------------------------------------ */

/** LLMChatPipeline as far as the setting reaches it: its chunk, its per-chunk forward and its device. */
class FakePipeline {
  prefillChunkSize: number;
  readonly log: string[] = [];
  readonly device = {
    sync: async (): Promise<void> => {
      this.log.push('sync');
      // A macrotask scheduled now runs before the next chunk only if the wait lets the event loop turn.
      setTimeout(() => this.log.push('tick'), 0);
      await Promise.resolve();
    },
  };
  constructor(compiled = 1024) {
    this.prefillChunkSize = compiled;
  }
  /** WebLLM's embedAndForward: refuses more than the chunk (its own check), reads `this`. */
  async embedAndForward(data: unknown, length: number): Promise<{ length: number }> {
    if (length > this.prefillChunkSize) throw new Error('InternalError: expect inputDataLen <= this.prefillChunkSize.');
    this.log.push(`forward ${length}`);
    await Promise.resolve(data);
    return { length };
  }
  /** WebLLM's forwardPrefill for text: the prompt cut at prefillChunkSize, one forward per chunk. */
  async prefill(tokens: number): Promise<void> {
    for (let at = 0; at < tokens; at += this.prefillChunkSize) await this.embedAndForward(null, Math.min(this.prefillChunkSize, tokens - at));
  }
  async decode(): Promise<void> {
    await this.embedAndForward(null, 1);
  }
}

/** MLCEngine as far as the setting reaches it: a reload makes a new pipeline in loadedModelIdToPipeline. */
class FakeEngine {
  readonly loadedModelIdToPipeline = new Map<string, FakePipeline>();
  reload(id: string, compiled = 1024): FakePipeline {
    this.loadedModelIdToPipeline.clear();
    const p = new FakePipeline(compiled);
    this.loadedModelIdToPipeline.set(id, p);
    return p;
  }
}

const ID = 'Qwen3.5-4B-q4f16_1-MLC';
const at = (chunkTokens: number | null, yieldBetween = false): PrefillSetting => ({ chunkTokens, yieldBetween });

/* ------------------------------------------------------------------ */
/* Setting it                                                           */
/* ------------------------------------------------------------------ */

test('a smaller chunk is set on the loaded pipeline, and a prompt is then read in pieces no larger', async () => {
  const engine = new FakeEngine();
  const pipeline = engine.reload(ID);
  expect(applyPrefill(engine, ID, at(256))).toEqual({ outcome: 'set', compiled: 1024, chunkTokens: 256, yieldBetween: false });
  expect(pipeline.prefillChunkSize).toBe(256);
  expect(chunkOf(pipelineOf(engine, ID))).toBe(256);
  await pipeline.prefill(1000);
  expect(pipeline.log).toEqual(['forward 256', 'forward 256', 'forward 256', 'forward 232']);
});

test('a model switched to is a new pipeline at its compiled size: the setting is made again on it', () => {
  const engine = new FakeEngine();
  const first = engine.reload(ID);
  applyPrefill(engine, ID, at(256));
  const second = engine.reload('Qwen3-1.7B-q4f16_1-MLC');
  // Nothing carries over: WebLLM reads the library's metadata into every new pipeline.
  expect(second.prefillChunkSize).toBe(1024);
  expect(applyPrefill(engine, 'Qwen3-1.7B-q4f16_1-MLC', at(256)).outcome).toBe('set');
  expect(second.prefillChunkSize).toBe(256);
  // The report is about the model asked for: the one loaded before is no longer the engine's.
  expect(applyPrefill(engine, ID, at(256)).outcome).toBe('no-pipeline');
  expect(first.prefillChunkSize).toBe(256);
});

test('nothing is asked: no setting, a chunk too small to be one, or not a whole number', () => {
  const engine = new FakeEngine();
  const pipeline = engine.reload(ID);
  for (const setting of [NO_PREFILL_SETTING, at(MIN_CHUNK_TOKENS - 1), at(0), at(-256), at(200.5), at(Number.NaN)]) {
    expect(applyPrefill(engine, ID, setting), JSON.stringify(setting)).toEqual({ outcome: 'off', compiled: null, chunkTokens: null, yieldBetween: false });
  }
  expect(pipeline.prefillChunkSize).toBe(1024);
});

test('WebLLM internals not as 0.2.86 has them: nothing changes, nothing throws, and the report says which', () => {
  const report = (engine: unknown): PrefillReport => applyPrefill(engine, ID, at(256, true));
  // No pipeline where WebLLM keeps them.
  for (const engine of [null, undefined, 42, 'engine', {}, { loadedModelIdToPipeline: {} }, { loadedModelIdToPipeline: new Map() }, { pipelines: new Map([[ID, new FakePipeline()]]) }]) {
    expect(report(engine).outcome, JSON.stringify(engine)).toBe('no-pipeline');
  }
  // A pipeline without a whole-number chunk.
  for (const value of [undefined, '1024', Number.NaN, 0, -1, 1024.5, null]) {
    const engine = { loadedModelIdToPipeline: new Map([[ID, { prefillChunkSize: value, embedAndForward: () => undefined }]]) };
    expect(report(engine), String(value)).toEqual({ outcome: 'no-field', compiled: null, chunkTokens: null, yieldBetween: false });
    expect(engine.loadedModelIdToPipeline.get(ID)?.prefillChunkSize).toBe(value);
  }
  // A chunk the getter of which throws reads as none.
  const throwing = { loadedModelIdToPipeline: new Map([[ID, Object.defineProperty({}, 'prefillChunkSize', { get: () => { throw new Error('moved'); } })]]) };
  expect(report(throwing).outcome).toBe('no-field');
  // The map itself throws.
  const hostile = { get loadedModelIdToPipeline(): unknown { throw new Error('private'); } };
  expect(report(hostile).outcome).toBe('failed');
});

test('a value already as small or smaller is kept as it is', () => {
  for (const compiled of [256, 128, 64]) {
    const engine = new FakeEngine();
    const pipeline = engine.reload(ID, compiled);
    expect(applyPrefill(engine, ID, at(256, true))).toEqual({ outcome: 'kept', compiled, chunkTokens: compiled, yieldBetween: false });
    expect(pipeline.prefillChunkSize).toBe(compiled);
    // Nothing else is touched either: the forward is still the class's own, not a wrapper.
    expect(Object.hasOwn(pipeline, 'embedAndForward')).toBe(false);
  }
});

test('a chunk that cannot be written, or does not hold, is put back and reported as failed', () => {
  // Frozen: the write throws in a module (strict mode).
  const frozen = Object.freeze(new FakePipeline());
  expect(applyPrefill({ loadedModelIdToPipeline: new Map([[ID, frozen]]) }, ID, at(256))).toEqual({ outcome: 'failed', compiled: 1024, chunkTokens: 1024, yieldBetween: false });
  expect(frozen.prefillChunkSize).toBe(1024);
  // A setter that ignores the write.
  let value = 1024;
  const ignoring = Object.defineProperty({}, 'prefillChunkSize', { get: () => value, set: () => undefined });
  expect(applyPrefill({ loadedModelIdToPipeline: new Map([[ID, ignoring]]) }, ID, at(256)).outcome).toBe('failed');
  expect(value).toBe(1024);
  // A setter that clamps it to something else is put back.
  const clamping = Object.defineProperty({}, 'prefillChunkSize', { get: () => value, set: (v: number) => { value = Math.max(v, 512); } });
  const r = applyPrefill({ loadedModelIdToPipeline: new Map([[ID, clamping]]) }, ID, at(256));
  expect(r.outcome).toBe('failed');
  expect(value).toBe(1024);
  expect(r.chunkTokens).toBe(1024);
});

/* ------------------------------------------------------------------ */
/* The wait between chunks                                              */
/* ------------------------------------------------------------------ */

test('with the wait, each chunk after the first waits for the model’s queue and a macrotask; decoding never waits', async () => {
  const engine = new FakeEngine();
  const pipeline = engine.reload(ID);
  expect(applyPrefill(engine, ID, at(256, true))).toEqual({ outcome: 'set', compiled: 1024, chunkTokens: 256, yieldBetween: true });
  await pipeline.prefill(700);
  await pipeline.decode();
  await pipeline.decode();
  // A second generation: its first chunk follows a decode, so it does not wait.
  await pipeline.prefill(300);
  expect(pipeline.log).toEqual(['forward 256', 'sync', 'tick', 'forward 256', 'sync', 'tick', 'forward 188', 'forward 1', 'forward 1', 'forward 256', 'sync', 'tick', 'forward 44']);
});

test('the wait passes the forward its own pipeline, arguments and result, and its failure (a pipeline unloaded mid-prompt)', async () => {
  const engine = new FakeEngine();
  const pipeline = engine.reload(ID);
  applyPrefill(engine, ID, at(256, true));
  await expect(pipeline.embedAndForward('tokens', 200)).resolves.toEqual({ length: 200 });
  // The pipeline's own check still holds against the new chunk, through the wrapper.
  await expect(pipeline.embedAndForward('tokens', 300)).rejects.toThrow('expect inputDataLen <= this.prefillChunkSize');
  let calls = 0;
  const failing = new FakePipeline();
  failing.embedAndForward = async (_data: unknown, length: number): Promise<{ length: number }> => {
    calls += 1;
    await Promise.resolve();
    if (calls === 2) throw new Error('Cannot read properties of undefined (reading disposed)');
    return { length };
  };
  const other = { loadedModelIdToPipeline: new Map([[ID, failing]]) };
  applyPrefill(other, ID, at(256, true));
  await expect(failing.prefill(700)).rejects.toThrow('disposed');
});

test('a pipeline that reads its prompt through a program artifact (not embedAndForward) gets the chunk but no wait', () => {
  const pipeline = Object.assign(new FakePipeline(), { artifact: { program: {} } });
  expect(applyPrefill({ loadedModelIdToPipeline: new Map([[ID, pipeline]]) }, ID, at(256, true))).toEqual({ outcome: 'set', compiled: 1024, chunkTokens: 256, yieldBetween: false });
  expect(Object.hasOwn(pipeline, 'embedAndForward')).toBe(false);
});

test('a pipeline without a device to wait on gets the chunk but no wait', () => {
  const pipeline = { prefillChunkSize: 1024, embedAndForward: (): Promise<void> => Promise.resolve() };
  const forward = pipeline.embedAndForward;
  expect(applyPrefill({ loadedModelIdToPipeline: new Map([[ID, pipeline]]) }, ID, at(256, true))).toEqual({ outcome: 'set', compiled: 1024, chunkTokens: 256, yieldBetween: false });
  expect(pipeline.embedAndForward).toBe(forward);
});

/* ------------------------------------------------------------------ */
/* WebLLM 0.2.86 itself                                                 */
/* ------------------------------------------------------------------ */

test('WebLLM 0.2.86 keeps the fields the setting reaches where prefill.ts looks for them (an upgrade must check again)', () => {
  expect(WEBLLM_VERSION).toBe('0.2.86');
  // MLCEngine's pipelines, by model id, filled by reload().
  expect(WEBLLM).toContain('this.loadedModelIdToPipeline = new Map();');
  expect(WEBLLM).toContain('this.loadedModelIdToPipeline.set(modelId, newPipeline);');
  // The chunk read from the library's metadata into each new LLMChatPipeline (and nowhere else written).
  expect(WEBLLM).toContain('this.prefillChunkSize = metadata.prefill_chunk_size;');
  expect(WEBLLM.match(/this\.prefillChunkSize = /gu)?.length).toBe(4);
  // The prompt cut at it, one forward per chunk, for text and for prompts read back (resumed).
  expect(WEBLLM).toContain('getChunkedPrefillInputData(inputData, this.prefillChunkSize, getEmbedSize);');
  expect(WEBLLM).toContain('const chunkLogits = yield this.embedAndForward(chunks[i], chunkLens[i]);');
  expect(WEBLLM).toContain('if (inputDataLen > this.prefillChunkSize) {');
  // The device the wait syncs (tvmjs: flushes its encoder, then the queue's onSubmittedWorkDone).
  expect(WEBLLM).toContain('this.device = this.tvm.webgpu();');
  expect(WEBLLM).toContain('const queueDone = this.device.queue.onSubmittedWorkDone();');
  // The KV cache is made once, at the compiled chunk, its largest: a smaller one fits in it.
  expect(WEBLLM).toContain('this.tvm.makeShapeTuple([this.prefillChunkSize]), // prefill_chunk_size');
});

/** WebLLM 0.2.86's own getChunkedPrefillInputData, read from its file (it is not exported). */
function webllmChunking(): (input: number[][], size: number) => [number[][][], number[]] {
  const start = WEBLLM.indexOf('function getChunkedPrefillInputData(');
  const end = WEBLLM.indexOf('return [chunks, chunkLens];', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const source = `${WEBLLM.slice(start, end)}return [chunks, chunkLens]; }`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- WebLLM's own code, from the pinned package on disk
  const make = new Function('PrefillChunkSizeSmallerThanImageError', `${source}; return getChunkedPrefillInputData;`) as (e: unknown) => (input: unknown[], size: number, embed: () => number) => [number[][][], number[]];
  const chunking = make(class extends Error {});
  return (input, size) => chunking(input, size, () => 0);
}

test('a long prompt near the context window (4,096 tokens) is cut by WebLLM’s own chunking into pieces no larger than the setting, in order', () => {
  const chunk = webllmChunking();
  const tokens = Array.from({ length: 4000 }, (_, i) => i);
  for (const size of [1024, 512, 256, 128]) {
    const [chunks, lengths] = chunk([tokens], size);
    expect(lengths.every((n) => n > 0 && n <= size), String(size)).toBe(true);
    expect(lengths.reduce((a, b) => a + b, 0)).toBe(4000);
    expect(chunks.length).toBe(Math.ceil(4000 / size));
    expect(chunks.flat(2)).toEqual(tokens);
  }
  // A conversation's prompt as several pieces of tokens is cut the same way.
  const [, lengths] = chunk([tokens.slice(0, 1500), tokens.slice(1500, 2600), tokens.slice(2600)], 256);
  expect(lengths).toEqual([...Array.from({ length: 15 }, () => 256), 160]);
});

/* ------------------------------------------------------------------ */
/* Through the page's engine                                            */
/* ------------------------------------------------------------------ */

const MODEL = VISITOR_MODELS.find((m) => m.tier === 'standard') ?? VISITOR_MODELS[0];
const SET: PrefillReport = { outcome: 'set', compiled: 1024, chunkTokens: 256, yieldBetween: false };

const pacer = (): Pacer & { held: () => number } => {
  let holds = 0;
  return {
    gate: () => Promise.resolve(),
    visible: () => Promise.resolve(),
    hold() {
      holds += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        holds -= 1;
      };
    },
    dispose: () => undefined,
    held: () => holds,
  };
};

const usage = (prefillChunk: number | null): NonNullable<ModelPiece['usage']> => ({ promptTokens: 900, outputTokens: 2, ttftMs: 400, e2eMs: 500, prefillTokensPerS: 2250, decodeTokensPerS: 30, grammarInitMs: null, prefillChunk });

/** A worker that answers a load with `report` and streams `pieces` per generation; `firstPull` can hold a generation's first piece (its prefill). */
function fakeWorker(report: PrefillReport, options: { pieces?: () => ModelPiece[]; firstPull?: () => Promise<void>; onLoad?: (prefill: PrefillSetting) => void; onInterrupt?: () => void } = {}): ModelWorker & { loads: PrefillSetting[] } {
  const loads: PrefillSetting[] = [];
  let pieces: ModelPiece[] = [];
  let pulled = 0;
  return {
    loads,
    async call(request) {
      if (request.type === 'load') {
        loads.push(request.prefill);
        options.onLoad?.(request.prefill);
        return { type: 'loaded', id: 1, prefill: report };
      }
      if (request.type === 'generate') {
        pieces = options.pieces?.() ?? [{ delta: 'Mars ', finish: null, usage: null }, { delta: 'is red.', finish: 'stop', usage: usage(report.chunkTokens) }];
        pulled = 0;
        return { type: 'started', id: 7 };
      }
      if (request.type === 'pull') {
        if (pulled === 0 && options.firstPull) await options.firstPull();
        const piece = pieces[pulled];
        pulled += 1;
        return piece ? { type: 'piece', id: 0, piece, done: false } : { type: 'piece', id: 0, piece: null, done: true };
      }
      return { type: 'result', id: 0, value: true };
    },
    interrupt: () => {
      options.onInterrupt?.();
    },
    terminate: () => undefined,
  };
}

/** A localStorage for the crash markers (src/ai/engine/detect.ts), which Node lacks. */
function withStorage(): { get: () => string | null; restore: () => void } {
  const store = new Map<string, string>();
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
  });
  return {
    get: () => store.get('kf.ai.crash') ?? null,
    restore: () => {
      if (had) Object.defineProperty(globalThis, 'localStorage', had);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    },
  };
}

test('each load carries the model’s own setting (or the one given), and each generation reports it with the chunk the pipeline held', async () => {
  if (!MODEL) throw new Error('no model');
  const worker = fakeWorker(SET);
  const engine = await loadWebLLM(MODEL, () => undefined, new AbortController().signal, pacer(), () => worker);
  expect(worker.loads).toEqual([prefillFor(MODEL)]);
  expect(engine.prefill).toEqual(SET);
  const out = await engine.generate({ messages: [{ role: 'user', content: 'Why is Mars red?' }], format: { kind: 'text' }, maxTokens: 64 });
  expect(out.engineUsage?.prefill).toEqual({ ...SET, chunkAtGeneration: 256 });
  await engine.unload();
  // A switch to another model, or a worker started again after a failure, is a new load: the setting goes with it.
  const restarted = fakeWorker({ outcome: 'set', compiled: 1024, chunkTokens: 128, yieldBetween: true });
  const again = await loadWebLLM(MODEL, () => undefined, new AbortController().signal, pacer(), () => restarted, at(128, true));
  expect(restarted.loads).toEqual([at(128, true)]);
  expect(again.prefill.chunkTokens).toBe(128);
  await again.unload();
});

test('a WebLLM that moved the field still loads and answers: the report says so, and the prompt is read as compiled', async () => {
  if (!MODEL) throw new Error('no model');
  const moved: PrefillReport = { outcome: 'no-field', compiled: null, chunkTokens: null, yieldBetween: false };
  const engine = await loadWebLLM(MODEL, () => undefined, new AbortController().signal, pacer(), () => fakeWorker(moved, { pieces: () => [{ delta: 'Red.', finish: 'stop', usage: usage(null) }] }), at(256));
  expect(engine.prefill).toEqual(moved);
  const out = await engine.generate({ messages: [{ role: 'user', content: 'Why is Mars red?' }], format: { kind: 'text' }, maxTokens: 64 });
  expect(out.text).toBe('Red.');
  expect(out.finish).toBe('stop');
  expect(out.engineUsage?.prefill).toEqual({ ...moved, chunkAtGeneration: null });
});

test('the first prefill’s crash marker is written while the prompt is read and cleared at the first token; a second generation writes none', async () => {
  if (!MODEL) throw new Error('no model');
  const storage = withStorage();
  try {
    const during: (string | null)[] = [];
    const worker = fakeWorker(SET, { firstPull: () => { during.push(storage.get()); return Promise.resolve(); } });
    const engine = await loadWebLLM(MODEL, () => undefined, new AbortController().signal, pacer(), () => worker);
    await engine.generate({ messages: [{ role: 'user', content: 'One' }], format: { kind: 'text' }, maxTokens: 8 });
    expect(during[0]).toContain('"stage":"prefill"');
    expect(storage.get()).toBeNull();
    const second = await engine.generate({ messages: [{ role: 'user', content: 'Two' }], format: { kind: 'text' }, maxTokens: 8 });
    expect(during[1]).toBeNull();
    expect(second.engineUsage?.prefill?.chunkAtGeneration).toBe(256);
    await engine.unload();
  } finally {
    storage.restore();
  }
});

test('a generation stopped while the model reads its prompt ends as aborted, interrupts the worker, clears the marker and lets the render budget go', async () => {
  if (!MODEL) throw new Error('no model');
  const storage = withStorage();
  try {
    let releasePrefill: () => void = () => undefined;
    let interrupts = 0;
    let held = false;
    const p = pacer();
    const worker = fakeWorker(SET, {
      // The first prefill holds its first piece until the interrupt arrives (WebLLM finishes the prompt, then stops).
      firstPull: () => {
        if (held) return Promise.resolve();
        held = true;
        return new Promise((resolve) => {
          releasePrefill = resolve;
        });
      },
      onInterrupt: () => {
        interrupts += 1;
        releasePrefill();
      },
      pieces: () => [{ delta: '', finish: 'abort', usage: usage(256) }],
    });
    const engine = await loadWebLLM(MODEL, () => undefined, new AbortController().signal, p, () => worker);
    const stop = new AbortController();
    const running = engine.generate({ messages: [{ role: 'user', content: 'A long question' }], format: { kind: 'text' }, maxTokens: 64, signal: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(p.held()).toBe(1);
    expect(storage.get()).toContain('"stage":"prefill"');
    stop.abort();
    const out = await running;
    expect(out.finish).toBe('abort');
    expect(interrupts).toBe(1);
    expect(p.held()).toBe(0);
    expect(storage.get()).toBeNull();
    // The engine answers again afterwards.
    const next = await engine.generate({ messages: [{ role: 'user', content: 'Again' }], format: { kind: 'text' }, maxTokens: 8 });
    expect(next.finish).not.toBe('error');
    await engine.unload();
  } finally {
    storage.restore();
  }
});
