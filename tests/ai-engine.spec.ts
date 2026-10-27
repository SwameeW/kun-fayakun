/**
 * The assistant's engine host on the real page (src/ai/engine, docs/AI-INTELLIGENCE.md §6 and §7):
 * detection reports WebGPU from an adapter read in a worker, asks no model host for anything and
 * creates no GPUDevice beside the renderer's; a load against the mocked model hosts (404, as
 * tests/support/live.ts answers them) fails cleanly as a 'network' EngineError and an aborted one as
 * 'aborted', with the page still rendering and no crash marker left; and the render budget caps the
 * picture's scale while it is held.
 *
 * WebLLM is in the model's worker alone (src/ai/engine/webllm-worker.ts): the build has its runtime
 * in that one file, detection never fetches it, a load does, and the worker answers our own protocol
 * (src/ai/engine/protocol.ts) with failures as EngineError data even with no model loaded.
 *
 * The engine is built here on its own with the project's vite.config.ts (the app reaches it only
 * through src/ai/boot.ts) and served beside the app under /__ai-engine/, same origin, so its workers
 * start as they will in the app. Chromium also resolves every model host to nothing, so even a
 * request that escaped the routes could not download a model.
 */
import { existsSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { App } from '../src/core/types';
import type { CapabilityReport, EngineHost, LoadProgress, ModelSpec } from '../src/ai/types';
import { expect, test, type KfHook } from './support/fixtures';
import { platform, SLOW } from './support/env';
import { isModelHost, modelRequests } from './support/live';

const MODEL_HOST_RULES = ['huggingface.co', '*.huggingface.co', 'hf.co', '*.hf.co', 'cdn.jsdelivr.net', 'raw.githubusercontent.com'].map((h) => `MAP ${h} ~NOTFOUND`).join(', ');

test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-webgpu',
      ...(platform === 'linux' ? ['--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader'] : []),
      `--host-resolver-rules=${MODEL_HOST_RULES}`,
    ],
  },
});

test.describe.configure({ mode: 'serial' });

const PREFIX = '/__ai-engine/';
const ROOT = decodeURIComponent(new URL('../', import.meta.url).pathname);
let outDir = '';
let entry = '';
/** The page's side of the model (src/ai/engine/webllm.ts), built as its own entry for the protocol test. */
let clientEntry = '';
/** Built files that hold WebLLM's runtime (its engine class, its TVM runtime). */
let withRuntime: string[] = [];
const WEBLLM_MARKERS = [/\bMLCEngine\b/u, /\btvmjs\b/u];
const isModelWorker = (url: string): boolean => /\/webllm-worker-[\w-]+\.js$/u.test(new URL(url).pathname);

const TYPES: Readonly<Record<string, string>> = { js: 'text/javascript', json: 'application/json', wasm: 'application/wasm', map: 'application/json' };

interface BuiltChunk {
  type: string;
  fileName: string;
  name?: string;
  isEntry?: boolean;
  /** A chunk's code. */
  code?: string;
  /** An asset's contents (a worker is emitted as one). */
  source?: string | Uint8Array;
}

/** The model's worker, as the protocol test drives it (src/ai/engine/webllm.ts ModelWorker). */
interface ClientModule {
  startModelWorker(): {
    call(request: Record<string, unknown>): Promise<{ type: string; value?: boolean; done?: boolean }>;
    terminate(): void;
  };
}

/** The built engine module as the page imports it. */
interface EngineModule {
  createEngineHost(app: App): Omit<EngineHost, 'stored'> & {
    pacer: { gate(): Promise<void>; hold(): () => void };
    stored(): Promise<readonly { id: string; bytes: number; complete: boolean }[]>;
  };
}

// Playwright needs the fixtures argument destructured even when none is used.
// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, workerInfo) => {
  test.setTimeout(180_000);
  test.skip(workerInfo.project.name !== 'webgpu', 'runs on the webgpu project');
  outDir = `${workerInfo.project.outputDir}/ai-engine-build-${workerInfo.workerIndex}`;
  const { build } = (await import('vite')) as unknown as { build: (config: Record<string, unknown>) => Promise<{ output: BuiltChunk[] } | Array<{ output: BuiltChunk[] }>> };
  const result = await build({
    root: ROOT,
    configFile: `${ROOT}vite.config.ts`,
    logLevel: 'error',
    publicDir: false,
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      manifest: false,
      copyPublicDir: false,
      rollupOptions: { input: { 'ai-engine': `${ROOT}src/ai/engine/index.ts`, 'ai-webllm': `${ROOT}src/ai/engine/webllm.ts` }, preserveEntrySignatures: 'exports-only' },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap((r) => r.output) : result.output;
  entry = outputs.find((c) => c.type === 'chunk' && c.isEntry === true && c.name === 'ai-engine')?.fileName ?? '';
  clientEntry = outputs.find((c) => c.type === 'chunk' && c.isEntry === true && c.name === 'ai-webllm')?.fileName ?? '';
  expect(entry).not.toBe('');
  expect(clientEntry).not.toBe('');
  const text = (c: BuiltChunk): string => c.code ?? (typeof c.source === 'string' ? c.source : new TextDecoder().decode(c.source ?? new Uint8Array()));
  withRuntime = outputs.filter((c) => c.fileName.endsWith('.js') && WEBLLM_MARKERS.some((m) => m.test(text(c)))).map((c) => c.fileName);
});

test('WebLLM is built into the model worker alone: no page chunk holds its runtime', () => {
  expect(withRuntime).toHaveLength(1);
  expect(withRuntime[0]).toMatch(/^assets\/webllm-worker-[\w-]+\.js$/u);
});

/** Serves the engine build under PREFIX and counts what the page asks of the GPU, the model hosts and the model's worker. */
async function prepare(page: Page): Promise<{ modelUrls: string[]; workerFetches: string[] }> {
  await page.route(`**${PREFIX}**`, async (route) => {
    const path = new URL(route.request().url()).pathname.slice(PREFIX.length);
    const file = `${outDir}/${path}`;
    if (path.includes('..') || !existsSync(file)) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({ status: 200, path: file, contentType: TYPES[path.split('.').at(-1) ?? ''] ?? 'application/octet-stream' });
  });
  await page.addInitScript(() => {
    const g = globalThis as unknown as {
      __kfGpu: { devices: number; adapters: number };
      GPUAdapter?: { prototype: { requestDevice: (...a: unknown[]) => Promise<unknown> } };
      GPU?: { prototype: { requestAdapter: (...a: unknown[]) => Promise<unknown> } };
    };
    g.__kfGpu = { devices: 0, adapters: 0 };
    const adapter = g.GPUAdapter?.prototype;
    if (adapter) {
      const original = adapter.requestDevice;
      adapter.requestDevice = function (this: unknown, ...args: unknown[]) {
        g.__kfGpu.devices += 1;
        return original.apply(this, args);
      };
    }
    const gpu = g.GPU?.prototype;
    if (gpu) {
      const original = gpu.requestAdapter;
      gpu.requestAdapter = function (this: unknown, ...args: unknown[]) {
        g.__kfGpu.adapters += 1;
        return original.apply(this, args);
      };
    }
  });
  const modelUrls: string[] = [];
  const workerFetches: string[] = [];
  page.on('request', (request) => {
    if (isModelHost(new URL(request.url()).hostname)) modelUrls.push(request.url());
    if (isModelWorker(request.url())) workerFetches.push(request.url());
  });
  return { modelUrls, workerFetches };
}

const gpuCounts = (page: Page): Promise<{ devices: number; adapters: number }> =>
  page.evaluate(() => ({ ...(globalThis as unknown as { __kfGpu: { devices: number; adapters: number } }).__kfGpu }));

const modelHits = (page: Page): number => [...modelRequests(page).values()].reduce((a, b) => a + b, 0);

/** Frames drawn over a short wait: the page is still rendering. */
async function framesOver(page: Page, ms: number): Promise<number> {
  const before = await page.evaluate(() => (window as unknown as KfHook).__kf.frameStats().frames);
  await page.waitForTimeout(ms);
  const after = await page.evaluate(() => (window as unknown as KfHook).__kf.frameStats().frames);
  return after - before;
}

/** Failures the mocked hosts cause on purpose: the browser logs each 404 or refused fetch. */
const unexpected = (errors: readonly string[]): string[] => errors.filter((e) => !/Failed to load resource|net::ERR_NAME_NOT_RESOLVED|ERR_FAILED/u.test(e));

test('detection runs on the real page: WebGPU from a worker, no model host asked, no GPUDevice created', async ({ page, kf, pageErrors }) => {
  const { modelUrls, workerFetches } = await prepare(page);
  await kf.open('/', { query: { tier: 'high' } });
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 * SLOW });
  const before = await gpuCounts(page);
  const report = await page.evaluate(async (url): Promise<CapabilityReport & { offered: string[] }> => {
    const mod = (await import(url)) as EngineModule;
    const host = mod.createEngineHost((window as unknown as KfHook).__kf.app);
    const r = await host.detect();
    return { ...r, offered: host.catalogue().map((m) => m.id) };
  }, `${PREFIX}${entry}`);
  const after = await gpuCounts(page);
  test.info().annotations.push({ type: 'capability', description: JSON.stringify(report) });

  expect(report.secure).toBe(true);
  expect(report.webgpu).toBe(true);
  expect(report.platform).toBe('desktop');
  expect(report.browser).toBe('chromium');
  expect(report.limits).not.toBeNull();
  expect(['none', 'pocket', 'compact', 'standard', 'large']).toContain(report.recommended);
  // Chromium builds without Chrome's own model answer 'unavailable' (or have no Prompt API at all).
  expect(['absent', 'unavailable', 'downloadable', 'downloading', 'available']).toContain(report.browserModel);
  // The adapter was read in the worker: the page asked for none, and no device was made anywhere on it.
  expect(after.devices - before.devices).toBe(0);
  expect(after.adapters - before.adapters).toBe(0);
  expect(modelUrls).toEqual([]);
  expect(modelHits(page)).toBe(0);
  // WebLLM's worker (and so its runtime) is not fetched to detect.
  expect(workerFetches).toEqual([]);
  if (report.fallbackAdapter) {
    // GPU-less CI: SwiftShader's adapter is software, so the guide is offered and nothing to download.
    expect(report.recommended).toBe('none');
    expect(report.offered).toEqual([]);
  } else {
    expect(report.offered.length).toBe(4);
  }
  expect(unexpected(pageErrors)).toEqual([]);
});

test('a load against the mocked model hosts fails cleanly as a network error; an aborted one as aborted; the page keeps rendering', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  const { workerFetches } = await prepare(page);
  await kf.open('/', { query: { tier: 'high' } });
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 * SLOW });
  const failed = await page.evaluate(async (url) => {
    const mod = (await import(url)) as EngineModule;
    const host = mod.createEngineHost((window as unknown as KfHook).__kf.app);
    // Before detection the whole catalogue is offered; its first entry is the pocket model.
    const pocket = host.catalogue()[0] as ModelSpec;
    const phases: string[] = [];
    try {
      await host.load(pocket, (p: LoadProgress) => phases.push(p.phase), new AbortController().signal);
      return { ok: true, phases };
    } catch (err) {
      const e = err as { code?: string; messageKey?: string; detail?: string; name?: string };
      return { ok: false, code: e.code, messageKey: e.messageKey, detail: e.detail, name: e.name, phases, marker: localStorage.getItem('kf.ai.crash') };
    }
  }, `${PREFIX}${entry}`);
  test.info().annotations.push({ type: 'load', description: JSON.stringify(failed) });
  expect(failed.ok).toBe(false);
  expect(failed.code).toBe('network');
  expect(failed.messageKey).toBe('ai.engine.error.network');
  expect(failed.name).toBe('EngineError');
  expect(failed.marker).toBeNull();
  // The load fetched the model's worker (WebLLM's runtime is there, not in the page's code).
  expect(workerFetches).toHaveLength(1);
  // The mocked hosts were asked (routes reach the model's worker), and answered 404.
  expect(modelHits(page)).toBeGreaterThan(0);
  expect(await framesOver(page, 1000)).toBeGreaterThan(5);

  // A host that never answers: the visitor's cancel ends the load at once.
  await page.route(
    (u) => isModelHost(u.hostname),
    () => {
      // Never answered.
    },
  );
  const aborted = await page.evaluate(async (url) => {
    const mod = (await import(url)) as EngineModule;
    const host = mod.createEngineHost((window as unknown as KfHook).__kf.app);
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => {
      controller.abort();
    }, 500);
    try {
      await host.load(host.catalogue()[0] as ModelSpec, () => undefined, controller.signal);
      return { ok: true, ms: performance.now() - started };
    } catch (err) {
      return { ok: false, code: (err as { code?: string }).code, ms: performance.now() - started, marker: localStorage.getItem('kf.ai.crash') };
    }
  }, `${PREFIX}${entry}`);
  expect(aborted.ok).toBe(false);
  expect(aborted.code).toBe('aborted');
  expect(aborted.ms).toBeLessThan(5000);
  expect(aborted.marker).toBeNull();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  expect(await framesOver(page, 1000)).toBeGreaterThan(5);
  expect(await page.locator('html').getAttribute('data-ready')).toBe('true');
  expect(unexpected(pageErrors)).toEqual([]);
});

test('the model worker answers our protocol: failures as EngineError data, a pull of no stream is done, nothing downloaded to read or clear the cache', async ({ page, kf, pageErrors }) => {
  const { modelUrls } = await prepare(page);
  await kf.open('/', { query: { tier: 'high' } });
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 * SLOW });
  const result = await page.evaluate(
    async ({ clientUrl, engineUrl }) => {
      const client = (await import(clientUrl)) as ClientModule;
      const engine = (await import(engineUrl)) as { buildAppConfig(models: readonly ModelSpec[]): unknown; VISITOR_MODELS: readonly ModelSpec[] };
      const pocket = engine.VISITOR_MODELS[0] as ModelSpec;
      const appConfig = engine.buildAppConfig([pocket]);
      const worker = client.startModelWorker();
      const failure = (err: unknown): Record<string, unknown> => {
        const e = err as { name?: string; code?: string; messageKey?: string };
        return { name: e.name, code: e.code, messageKey: e.messageKey };
      };
      const generate = await worker.call({ type: 'generate', request: { messages: [{ role: 'user', content: 'Hello' }], stream: true } }).then((a) => a, failure);
      const pull = await worker.call({ type: 'pull', stream: 12_345 });
      const has = await worker.call({ type: 'hasModelInCache', appConfig, model: pocket.id });
      const removed = await worker.call({ type: 'deleteModelAllInfoInCache', appConfig, model: pocket.id });
      const unloaded = await worker.call({ type: 'unload' });
      worker.terminate();
      const afterEnd = await worker.call({ type: 'unload' }).then((a) => a, failure);
      return { generate, pull, has, removed, unloaded, afterEnd };
    },
    { clientUrl: `${PREFIX}${clientEntry}`, engineUrl: `${PREFIX}${entry}` },
  );
  // Asked to generate with no model: the worker's failure arrives as data, read as an EngineError.
  expect(result.generate).toEqual({ name: 'EngineError', code: 'unknown', messageKey: 'ai.engine.error.unknown' });
  expect(result.pull).toMatchObject({ type: 'piece', done: true });
  expect(result.has).toMatchObject({ type: 'result', value: false });
  // Nothing stored: WebLLM is not asked to delete (it would download the manifest to find the files).
  expect(result.removed).toMatchObject({ type: 'result', value: false });
  expect(result.unloaded).toMatchObject({ type: 'result', value: true });
  expect(result.afterEnd).toMatchObject({ code: 'aborted' });
  expect(modelUrls).toEqual([]);
  expect(unexpected(pageErrors)).toEqual([]);
});

test('the render budget caps the picture while it is held and gives it back on release', async ({ page, kf }) => {
  await prepare(page);
  await kf.open('/', { query: { tier: 'high' } });
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 * SLOW });
  const widths = await page.evaluate(async () => {
    const app = (window as unknown as KfHook).__kf.app as unknown as { requestRenderBudget(reason: string, b: { maxScale: number }): () => void };
    const canvas = document.querySelector('canvas');
    const frame = (): Promise<void> =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    await frame();
    const full = canvas?.width ?? 0;
    const release = app.requestRenderBudget('test', { maxScale: 0.7 });
    const second = app.requestRenderBudget('test', { maxScale: 0.9 });
    await frame();
    const held = canvas?.width ?? 0;
    second();
    await frame();
    const oneLeft = canvas?.width ?? 0;
    release();
    release();
    await frame();
    return { full, held, oneLeft, back: canvas?.width ?? 0 };
  });
  expect(widths.full).toBeGreaterThan(0);
  expect(Math.abs(widths.held - widths.full * 0.7)).toBeLessThanOrEqual(2);
  expect(widths.oneLeft).toBe(widths.held);
  expect(widths.back).toBe(widths.full);
});

test('what is stored is read from the Cache API and removed from it, without a download', async ({ page, kf, pageErrors }) => {
  const { modelUrls, workerFetches } = await prepare(page);
  await kf.open('/', { query: { tier: 'high' } });
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 * SLOW });
  const result = await page.evaluate(async (url) => {
    const mod = (await import(url)) as EngineModule;
    const host = mod.createEngineHost((window as unknown as KfHook).__kf.app);
    const pocket = host.catalogue()[0] as ModelSpec;
    const empty = await host.stored();
    // What WebLLM leaves after a download: the manifest, two shards and the tokenizer; the config; the library.
    const model = await caches.open('webllm/model');
    const sized = (bytes: number, type = 'application/octet-stream'): Response => new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes), 'content-type': type } });
    const manifest = JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin' }, { dataPath: 'params_shard_1.bin' }] });
    await model.put(`${pocket.weightsUrl}tensor-cache.json`, new Response(manifest, { headers: { 'content-length': String(manifest.length), 'content-type': 'application/json' } }));
    await model.put(`${pocket.weightsUrl}params_shard_0.bin`, sized(1000));
    const partial = await host.stored();
    await model.put(`${pocket.weightsUrl}params_shard_1.bin`, sized(2000));
    await model.put(`${pocket.weightsUrl}tokenizer.json`, sized(300, 'application/json'));
    await (await caches.open('webllm/config')).put(`${pocket.weightsUrl}mlc-chat-config.json`, sized(40, 'application/json'));
    await (await caches.open('webllm/wasm')).put(pocket.libUrl, sized(500, 'application/wasm'));
    const full = await host.stored();
    await host.remove(pocket.id);
    const after = await host.stored();
    const left = [
      ...(await (await caches.open('webllm/model')).keys()),
      ...(await (await caches.open('webllm/config')).keys()),
      ...(await (await caches.open('webllm/wasm')).keys()),
    ].map((r) => r.url);
    return { id: pocket.id, empty, partial, full, after, left, persisted: typeof (await host.persist()) };
  }, `${PREFIX}${entry}`);
  expect(result.empty).toEqual([]);
  expect(result.partial.map((m) => [m.id, m.complete])).toEqual([[result.id, false]]);
  expect(result.partial[0]?.bytes ?? 0).toBeGreaterThan(1000);
  expect(result.full).toEqual([{ id: result.id, bytes: 1000 + 2000 + 300 + 40 + 500 + JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin' }, { dataPath: 'params_shard_1.bin' }] }).length, complete: true }]);
  expect(result.after).toEqual([]);
  expect(result.left).toEqual([]);
  expect(result.persisted).toBe('boolean');
  // WebLLM's own deletion ran in its worker, and nothing was asked of a model host.
  expect(workerFetches).toHaveLength(1);
  expect(modelUrls).toEqual([]);
  expect(unexpected(pageErrors)).toEqual([]);
});

test('the pacer: at once when the scene is idle, a frame at a time while the visitor is moving it; its hold is the render budget', async ({ page, kf }) => {
  await prepare(page);
  await kf.open('/', { query: { tier: 'high' } });
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 * SLOW });
  const paced = await page.evaluate(async (url) => {
    const mod = (await import(url)) as EngineModule;
    const { pacer } = mod.createEngineHost((window as unknown as KfHook).__kf.app);
    let frames = 0;
    let counting = true;
    const tick = (): void => {
      if (!counting) return;
      frames += 1;
      requestAnimationFrame(tick);
    };
    const framesDuring = async (work: () => Promise<void>): Promise<number> => {
      frames = 0;
      counting = true;
      requestAnimationFrame(tick);
      await work();
      counting = false;
      return frames;
    };
    const idle = await framesDuring(async () => {
      for (let i = 0; i < 20; i++) await pacer.gate();
    });
    const moving = await framesDuring(async () => {
      for (let i = 0; i < 5; i++) {
        window.dispatchEvent(new PointerEvent('pointermove'));
        await pacer.gate();
      }
    });
    const canvas = document.querySelector('canvas');
    const full = canvas?.width ?? 0;
    const release = pacer.hold();
    await new Promise((r) => requestAnimationFrame(r));
    const held = canvas?.width ?? 0;
    release();
    release();
    await new Promise((r) => requestAnimationFrame(r));
    return { idle, moving, full, held, back: canvas?.width ?? 0 };
  }, `${PREFIX}${entry}`);
  // Twenty pulls with the scene idle take no frame at all; five while it moves take a frame each.
  expect(paced.idle).toBe(0);
  expect(paced.moving).toBeGreaterThanOrEqual(5);
  expect(Math.abs(paced.held - paced.full * 0.75)).toBeLessThanOrEqual(2);
  expect(paced.back).toBe(paced.full);
});
