/*
 * The real-model evaluation (docs/AI-INTELLIGENCE.md §9): one model, every case of ./cases.ts, on
 * this Mac's GPU, in Chromium with real WebGPU. Local only: it runs only in the "ai-eval" project
 * (KF_AI_EVAL=1), never in a normal run or on CI.
 *
 *   KF_AI_EVAL=1 KF_AI_EVAL_MODEL=Qwen3-4B-q4f16_1-MLC KF_AI_EVAL_MODE=pipeline npx playwright test --project=ai-eval
 *
 * - KF_AI_EVAL_MODEL: a catalogue id (src/ai/engine/catalogue.ts) whose files
 *   scripts/ai-eval/fetch-models.ts has stored and verified (scripts/ai-eval/store.ts).
 * - KF_AI_EVAL_MODE: "pipeline" (default; the shipping order, the router first) or "model" (the
 *   router bypassed through the test hook, so the model plans every case).
 * - KF_AI_EVAL_CASES: only these case ids or categories (comma-separated); KF_AI_EVAL_TAG names the
 *   results file of such a partial run (<model>-<mode>-<tag>.json).
 *
 * Nothing is downloaded. Chromium resolves every model host to nothing (the project's
 * --host-resolver-rules), and the pinned Hugging Face and jsDelivr URLs are answered from the files on
 * disk by the context's routes, so the app's real path (our worker → WebLLM → the Cache API) runs
 * unchanged but offline. Any other request to a model host fails the run. The browser profile is
 * persistent (the main checkout's .work/ai-eval/profile-<port>; the Cache API is per origin, so per
 * port), so a model's Cache API copy survives between runs.
 *
 * The model is loaded as a visitor loads it: through the panel's "Model on this device" section for
 * the visitor tiers, and through the same Intelligence.use() the panel calls for the evaluation
 * candidates the panel does not offer. No scripted engine anywhere: the engine must read back as the
 * local one with this model's id. Each case is asked through the panel's own field; what is scored
 * is what the test hook and the page show afterwards (./score.ts). Raw results, with every
 * generation's raw text and WebLLM's own usage figures, go to .work/ai-eval/results/.
 */
import { chromium, expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, release, totalmem } from 'node:os';
import { findModel, VISITOR_MODELS } from '../../src/ai/engine/catalogue';
import type { GenerationRecord, Intelligence, ModelSpec, ToolKind } from '../../src/ai/types';
import type { App, BodyId, UniverseView } from '../../src/core/types';
import { manifestVerified, modelsDir, readManifest, type ModelManifest } from '../../scripts/ai-eval/store';
import { env } from '../support/env';
import { isModelHost, mockLiveHosts } from '../support/live';
import { selectCases, type Start } from './cases';
import { score, type LabSnapshot, type Observation, type Scored, type TurnData } from './score';

const MODEL_ID = env('KF_AI_EVAL_MODEL') ?? 'Qwen3-0.6B-q4f16_1-MLC';
const MODE: 'pipeline' | 'model' = env('KF_AI_EVAL_MODE') === 'model' ? 'model' : 'pipeline';
const TAG = env('KF_AI_EVAL_TAG');
const CASE_MS = Number(env('KF_AI_EVAL_CASE_MS') ?? 300_000);
const ROOT = new URL('../../', import.meta.url).pathname;
const OUT_DIR = env('KF_AI_EVAL_OUT') ?? `${ROOT}.work/ai-eval/results`;

const mind = JSON.parse(readFileSync(new URL('../../src/i18n/en.ai.mind.json', import.meta.url), 'utf8')) as Record<string, string>;

/** window.__kf as this spec reaches it (the assistant's part with the evaluation's hook). */
interface Hook {
  __kf: {
    app: App;
    universe: { state(): UniverseView | null };
    ai: {
      start(): Promise<Intelligence & { kindOf(tool: string): ToolKind | null; clear(): void }>;
      evaluate(options: { router: 'first' | 'skip' } | null): Promise<void>;
      generations(): readonly GenerationRecord[];
    };
  };
}

const load = (): number[] => loadavg().map((x) => Math.round(x * 100) / 100);

interface Served {
  requests: number;
  bytes: number;
}

/** Answers the pinned files from disk; anything else asked of a model host is refused and recorded. */
function modelRoute(manifest: ModelManifest, served: Served, unexpected: string[]): (route: Route) => Promise<void> {
  const files = new Map(manifest.files.map((f) => [f.url, f]));
  const dir = `${modelsDir()}/${manifest.id}`;
  return async (route) => {
    const url = route.request().url();
    const f = files.get(url);
    if (!f || route.request().method() !== 'GET') {
      unexpected.push(`${route.request().method()} ${url}`);
      await route.abort('blockedbyclient');
      return;
    }
    served.requests += 1;
    served.bytes += f.bytes;
    await route.fulfill({
      status: 200,
      path: `${dir}/${f.path}`,
      headers: {
        'access-control-allow-origin': '*',
        'content-type': f.path.endsWith('.json') ? 'application/json' : f.path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
        'content-length': String(f.bytes),
      },
    });
  };
}

/** How many of the model's files the Cache API holds (WebLLM's three caches). */
async function cached(page: Page, manifest: ModelManifest): Promise<{ stored: number; of: number }> {
  return page.evaluate(async (urls) => {
    let stored = 0;
    for (const name of ['webllm/model', 'webllm/config', 'webllm/wasm']) {
      if (!(await caches.has(name))) continue;
      const cache = await caches.open(name);
      for (const url of urls) if (await cache.match(url)) stored += 1;
    }
    return { stored, of: urls.length };
  }, manifest.files.map((f) => f.url));
}

async function ready(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 120_000 });
}

async function openPanel(page: Page): Promise<void> {
  if (await page.getByTestId('ai-panel').isVisible()) return;
  await page.getByTestId('ask').click();
  await expect(page.getByTestId('ai-panel')).toBeVisible({ timeout: 60_000 });
}

/** Loads the model as a visitor does: the panel's section for a visitor tier, Intelligence.use() (what the panel calls) for an evaluation candidate. */
async function loadModel(page: Page, spec: ModelSpec, visitor: boolean): Promise<{ ms: number; via: 'panel' | 'use' }> {
  await openPanel(page);
  const started = Date.now();
  if (visitor) {
    const section = page.getByTestId('ai-model');
    if (!(await section.evaluate((d) => (d as HTMLDetailsElement).open))) await section.locator('summary').click();
    await section.getByTestId('ai-model-select').selectOption(spec.id, { timeout: 60_000 });
    await section.getByTestId('ai-download').click();
    const metered = section.getByTestId('ai-metered-confirm');
    const done = section.getByTestId('ai-load-ready').or(section.getByTestId('ai-model-error'));
    await expect(metered.or(done)).toBeVisible({ timeout: 60_000 });
    if (await metered.isVisible()) await metered.click();
    await expect(done).toBeVisible({ timeout: 60 * 60_000 });
    await expect(section.getByTestId('ai-load-ready')).toBeVisible();
    return { ms: Date.now() - started, via: 'panel' };
  }
  await page.evaluate(async (s) => {
    const ai = await (window as unknown as Hook).__kf.ai.start();
    await ai.use(s);
  }, spec);
  return { ms: Date.now() - started, via: 'use' };
}

async function hash(page: Page, route: string): Promise<void> {
  await page.evaluate((r) => {
    if (location.hash !== r) location.hash = r;
  }, route);
}

const view = (page: Page): Promise<UniverseView | null> => page.evaluate(() => (window as unknown as Hook).__kf.universe.state());

/** Puts the page where a case starts, from wherever the last case left it. */
async function enter(page: Page, start: Start): Promise<void> {
  // Off foot, out of the stars, out of a descent first.
  await page.evaluate(() => {
    const { app } = (window as unknown as Hook).__kf;
    const v = app.universe();
    if (v?.walk) app.earthCommand({ kind: 'walkEnd' });
    if (v?.neighbourhood) app.earthCommand({ kind: 'starsEnd' });
    if (v?.descent) app.earthCommand({ kind: 'descentEnd' });
  });
  const until = (fn: string, timeout = 120_000): Promise<unknown> => page.waitForFunction(fn, null, { timeout });
  if (start.at === 'home') {
    await hash(page, '#/');
    await until(`window.__kf.app.experience === 'film' && window.__kf.app.chapter === null && document.documentElement.getAttribute('data-experience') !== 'universe'`);
    return;
  }
  if (start.at === 'chapter') {
    const n = Number(start.chapter.slice(2));
    await hash(page, `#/ch/${n}`);
    await expect(page.locator('html')).toHaveAttribute('data-chapter-ready', start.chapter, { timeout: 120_000 });
    await page.evaluate(({ explore, playing }) => {
      const { app } = (window as unknown as Hook).__kf;
      app.setMode(explore ? 'explore' : 'cinematic');
      if (playing) app.play();
      else app.pause();
    }, { explore: start.explore === true, playing: start.playing === true });
    await until(`window.__kf.app.mode === '${start.explore ? 'explore' : 'cinematic'}'`);
    return;
  }
  if (start.at === 'lab') {
    const v = await view(page);
    if (!v?.lab) await hash(page, '#/universe/lab');
    await until(`window.__kf.universe.state()?.lab != null`);
    await page.evaluate(() => {
      (window as unknown as Hook).__kf.app.universeLab({ kind: 'start', seed: 'solar' });
    });
    await until(`(() => { const l = window.__kf.universe.state()?.lab; return l != null && l.bodies.length >= 10 && l.interventions.length === 0; })()`);
    if (start.rename) {
      await page.evaluate((r) => {
        (window as unknown as Hook).__kf.app.universeLab({ kind: 'rename', id: r.id, name: r.name });
      }, start.rename);
      await page.waitForTimeout(500);
    }
    return;
  }
  // The explorer (and a walk, which starts there).
  const body: BodyId = start.at === 'walk' ? start.world : (start.body ?? 'earth');
  const v = await view(page);
  if (!v || v.lab) await hash(page, '#/universe');
  await expect(page.locator('html')).toHaveAttribute('data-universe-ready', 'true', { timeout: 120_000 });
  await until(`window.__kf.universe.state() != null && window.__kf.universe.state().lab == null`);
  await page.evaluate((b) => {
    const { app } = (window as unknown as Hook).__kf;
    const s = app.universe();
    app.universeTime({ kind: 'now' });
    app.universeTime({ kind: 'rate', rate: 1 });
    if (s?.time.paused) app.universeTime({ kind: 'toggle' });
    for (const layer of ['constellations', 'boundaries', 'grid', 'names'] as const) app.universeSky({ kind: 'layer', layer, on: false });
    if (s?.focus !== b) app.focusBody(b);
  }, body);
  await until(`(() => { const s = window.__kf.universe.state(); return s && s.focus === '${body}' && !s.travelling; })()`, 60_000);
  if (start.at === 'walk') {
    await page.evaluate((w) => {
      (window as unknown as Hook).__kf.app.earthCommand({ kind: 'walk', world: w.world, lat: w.lat, lon: w.lon });
    }, start);
    await until(`window.__kf.universe.state()?.walk?.state === 'walking'`, 120_000);
  }
}

async function labSnapshot(page: Page): Promise<LabSnapshot | null> {
  return page.evaluate(() => {
    const l = (window as unknown as Hook).__kf.universe.state()?.lab;
    return l ? { interventions: l.interventions.length, bodies: l.bodies.map((b) => ({ id: b.id, name: b.name, massKg: b.massKg })) } : null;
  });
}

/** requestAnimationFrame intervals while `during` runs (or for `ms`), ms. */
async function frames(page: Page, during: (() => Promise<void>) | number): Promise<number[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __evalFrames?: { intervals: number[]; on: boolean } };
    const state = { intervals: [] as number[], on: true };
    w.__evalFrames = state;
    let last = -1;
    const tick = (now: number): void => {
      if (last >= 0) state.intervals.push(now - last);
      last = now;
      if (state.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  if (typeof during === 'number') await page.waitForTimeout(during);
  else await during();
  return page.evaluate(() => {
    const w = window as unknown as { __evalFrames?: { intervals: number[]; on: boolean } };
    if (!w.__evalFrames) return [];
    w.__evalFrames.on = false;
    return w.__evalFrames.intervals;
  });
}

function stats(xs: readonly number[]): { n: number; p50: number | null; p95: number | null; max: number | null; meanFps: number | null } {
  if (xs.length === 0) return { n: 0, p50: null, p95: null, max: null, meanFps: null };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const r = (x: number): number => Math.round(x * 100) / 100;
  return { n: xs.length, p50: r(q(0.5)), p95: r(q(0.95)), max: r(s[s.length - 1] ?? 0), meanFps: r(1000 / mean) };
}

/** Asks through the panel's field; resolves when the turn settles (or the case's time runs out). */
async function askInPanel(page: Page, question: string): Promise<{ ms: number; timedOut: boolean }> {
  await openPanel(page);
  const log = page.getByTestId('ai-log').locator(':scope > li');
  const before = await log.count();
  const input = page.getByTestId('ai-input');
  await input.fill(question);
  const started = Date.now();
  await input.press('Enter');
  try {
    await page.waitForFunction(
      (n) => {
        const li = document.querySelectorAll('[data-testid="ai-log"] > li')[n];
        const s = li?.getAttribute('data-state');
        return s === 'done' || s === 'failed' || s === 'cancelled' || s === 'awaiting-confirmation';
      },
      before,
      { timeout: CASE_MS, polling: 100 },
    );
    return { ms: Date.now() - started, timedOut: false };
  } catch {
    await page.evaluate(async () => {
      (await (window as unknown as Hook).__kf.ai.start()).cancel();
    });
    return { ms: Date.now() - started, timedOut: true };
  }
}

/** The settled turn, the generations recorded for it, its tools' kinds, and its rendered labels. */
async function readTurn(page: Page): Promise<{ turn: TurnData; generations: GenerationRecord[]; kinds: Record<string, ToolKind | null>; dom: Observation['dom']; engine: { kind: string; model: string | null } }> {
  return page.evaluate(async () => {
    const hook = (window as unknown as Hook).__kf.ai;
    const ai = await hook.start();
    const turn = JSON.parse(JSON.stringify(ai.turns().at(-1) ?? null)) as TurnData;
    const generations = JSON.parse(JSON.stringify(hook.generations())) as GenerationRecord[];
    const kinds: Record<string, ToolKind | null> = {};
    for (const c of turn.plan?.calls ?? []) kinds[c.tool] = ai.kindOf(c.tool);
    const items = document.querySelectorAll('[data-testid="ai-log"] > li');
    const li = items[items.length - 1];
    const authors = [...(li?.querySelectorAll('[data-block="text"]') ?? [])].map((b) => ({ by: b.getAttribute('data-by') ?? '', label: b.querySelector('[data-testid="ai-author"]')?.textContent ?? '' }));
    const e = ai.engine();
    return { turn, generations, kinds, dom: { state: li?.getAttribute('data-state') ?? null, authors }, engine: { kind: e.kind, model: e.model } };
  });
}

/** Cancels the cards a case left waiting, and forgets the conversation, so the next case starts alone. */
async function tidy(page: Page, turn: TurnData | null): Promise<void> {
  await page.evaluate(async (t) => {
    const ai = await (window as unknown as Hook).__kf.ai.start();
    if (t) for (const b of t.blocks) if (b.type === 'action' && b.status === 'awaiting') await ai.confirm(t.id, b.callId, false);
    ai.cancel();
    ai.clear();
  }, turn);
}

function redact(value: unknown, words: readonly string[] | undefined): unknown {
  if (!words?.length) return value;
  let text = JSON.stringify(value);
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    text = text.replace(new RegExp(`(?<![\\w])${esc}(?![\\w])`, 'giu'), '[a narration not in data/hadith.json]');
  }
  return JSON.parse(text);
}

const timing = (g: GenerationRecord | undefined): Record<string, number | null> | null =>
  g
    ? {
        ttftMs: g.engineUsage?.ttftMs ?? g.prefillMs,
        prefillTokensPerS: g.engineUsage?.prefillTokensPerS ?? null,
        decodeTokensPerS: g.engineUsage?.decodeTokensPerS ?? null,
        grammarInitMs: g.engineUsage?.grammarInitMs ?? null,
        e2eMs: g.engineUsage?.e2eMs ?? null,
        promptTokens: g.promptTokens,
        outputTokens: g.outputTokens,
        wallMs: g.wallMs,
      }
    : null;

test(`real model: ${MODEL_ID}, ${MODE}`, async ({ baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'ai-eval', 'the real-model evaluation runs only in the ai-eval project (KF_AI_EVAL=1)');
  const spec = findModel(MODEL_ID);
  expect(spec, `${MODEL_ID} is not in src/ai/engine/catalogue.ts`).not.toBeNull();
  if (!spec) return;
  const manifest = readManifest(MODEL_ID);
  expect(manifest && manifestVerified(manifest), `${MODEL_ID} is not on disk and verified: run node --import tsx scripts/ai-eval/fetch-models.ts ${MODEL_ID}`).toBe(true);
  if (!manifest) return;
  // The panel offers the visitor tiers; the evaluation candidates are loaded by the call the panel makes.
  const visitor = VISITOR_MODELS.some((m) => m.id === MODEL_ID);
  const cases = selectCases(env('KF_AI_EVAL_CASES'));
  expect(cases.length).toBeGreaterThan(0);

  const port = new URL(baseURL ?? 'http://127.0.0.1:4173/').port;
  const profile = `${modelsDir().replace(/\/models$/u, '')}/ai-eval/profile-${port}`;
  mkdirSync(profile, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = `${OUT_DIR}/${MODEL_ID}-${MODE}${TAG ? `-${TAG}` : ''}.json`;

  const use = testInfo.project.use;
  const context: BrowserContext = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: use.viewport ?? { width: 1280, height: 800 },
    args: use.launchOptions?.args ?? [],
    ...(baseURL ? { baseURL } : {}),
  });
  const served: Served = { requests: 0, bytes: 0 };
  const unexpected: string[] = [];
  const handler = modelRoute(manifest, served, unexpected);
  await context.route((url) => isModelHost(url.hostname), handler);
  const pageErrors: string[] = [];
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (e) => pageErrors.push(e.message));
    // The live services answered in the browser (as every test does); the model hosts by the routes above.
    await mockLiveHosts(page);
    await page.route((url) => isModelHost(url.hostname), handler);

    // A clean start: nothing kept from an earlier run but the Cache API (no crash markers, no memory, default settings).
    await page.goto('/#/');
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();
    await ready(page);
    const adapter = await page.evaluate(async () => {
      const gpu = (navigator as { gpu?: GPU }).gpu;
      const a = await gpu?.requestAdapter();
      return a ? { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description, f16: a.features.has('shader-f16'), userAgent: navigator.userAgent } : null;
    });
    expect(adapter?.f16 === true || !spec.needsF16, 'this build needs shader-f16').toBe(true);

    // First, the files into the Cache API through the routes (only when they are not there yet).
    const before = await cached(page, manifest);
    let routedLoad: { ms: number; via: string; requests: number; bytes: number; loadavg: number[] } | null = null;
    if (before.stored < before.of) {
      const l0 = load();
      const r = await loadModel(page, spec, visitor);
      routedLoad = { ...r, requests: served.requests, bytes: served.bytes, loadavg: l0 };
    }
    const afterFirst = await cached(page, manifest);
    expect(afterFirst.stored, 'every pinned file is in the Cache API').toBe(afterFirst.of);

    // Then the load a returning visitor gets: a fresh page, the files from the Cache API.
    const servedBefore = { ...served };
    await page.reload();
    await ready(page);
    const l1 = load();
    const cachedLoad = await loadModel(page, spec, visitor);
    const engine = await page.evaluate(async () => (await (window as unknown as Hook).__kf.ai.start()).engine());
    expect(engine).toEqual({ kind: 'local', model: MODEL_ID, state: 'ready' });
    await expect(page.locator('html')).toHaveAttribute('data-ai-engine', 'local');
    const load2 = { ...cachedLoad, loadavg: l1, routeRequests: served.requests - servedBefore.requests, routeBytes: served.bytes - servedBefore.bytes };

    await page.evaluate(async (router) => {
      await (window as unknown as Hook).__kf.ai.evaluate({ router });
    }, MODE === 'model' ? ('skip' as const) : ('first' as const));

    const run = {
      model: MODEL_ID,
      name: spec.name,
      mode: MODE,
      tag: TAG ?? null,
      startedAt: new Date().toISOString(),
      machine: { cpu: cpus()[0]?.model ?? null, memoryBytes: totalmem(), os: `darwin ${release()}`, arch: arch(), adapter },
      catalogue: { weightsUrl: spec.weightsUrl, libUrl: spec.libUrl, downloadBytes: spec.downloadBytes, vramMBEstimate: spec.vramMB, contextTokens: spec.contextTokens },
      load: { routed: routedLoad, cached: load2 },
      gpuMemory: { reported: null, note: 'WebLLM 0.2.86 reports no GPU memory figure at run time; vramMBEstimate is its prebuilt estimate' },
      loadavgStart: load(),
      cases: [] as unknown[],
      frames: null as unknown,
      unexpectedRequests: unexpected,
      pageErrors,
      finishedAt: null as string | null,
    };
    const save = (): void => {
      writeFileSync(outFile, `${JSON.stringify(run, null, 2)}\n`);
    };
    save();

    for (const c of cases) {
      const loadBefore = load();
      let record: Record<string, unknown>;
      try {
        await enter(page, c.start);
        const now = await page.evaluate(async () => (await (window as unknown as Hook).__kf.ai.start()).engine());
        if (now.kind !== 'local' || now.model !== MODEL_ID) {
          // The model was unloaded (an error, a lost device): load it again, and say so in the record.
          await loadModel(page, spec, visitor);
        }
        await page.evaluate(async () => {
          (await (window as unknown as Hook).__kf.ai.start()).clear();
          (window as unknown as Hook).__kf.ai.generations();
        });
        const labBefore = await labSnapshot(page);
        const asked = await askInPanel(page, c.question);
        const read = await readTurn(page);
        const labAfter = await labSnapshot(page);
        const walking = (await view(page))?.walk != null;
        const obs: Observation = {
          turn: read.turn,
          kinds: read.kinds,
          generations: read.generations,
          dom: read.dom,
          lab: { before: labBefore, after: labAfter },
          walking,
          modelName: spec.name,
          clarifyText: mind['ai.mind.clarify.convention'] ?? '',
          declineText: mind['ai.mind.guide.decline'] ?? '',
        };
        const scored: Scored = score(c, obs);
        const plan = read.generations.find((g) => g.purpose === 'plan');
        const repair = read.generations.find((g) => g.purpose === 'repair');
        const answer = read.generations.find((g) => g.purpose === 'answer');
        record = {
          id: c.id,
          category: c.category,
          tag: c.tag,
          start: c.start,
          question: c.question,
          pass: scored.pass && !asked.timedOut,
          timedOut: asked.timedOut,
          state: read.turn.state,
          engine: { turn: { kind: read.turn.engine, model: read.turn.model }, after: read.engine, writers: read.turn.blocks.flatMap((b) => (b.type === 'text' && b.writer ? [b.writer] : [])) },
          scored,
          turn: read.turn,
          // What the scorer read besides the turn and the generations, so scripts/ai-eval/rescore.ts can score again without a model.
          observed: { kinds: obs.kinds, dom: obs.dom, lab: obs.lab, walking: obs.walking, modelName: obs.modelName },
          timings: { totalMs: asked.ms, turn: read.turn.timings, plan: timing(plan), repair: timing(repair), answer: timing(answer) },
          generations: read.generations,
          loadavg: { before: loadBefore, after: load() },
        };
        await tidy(page, read.turn);
      } catch (err) {
        record = { id: c.id, category: c.category, tag: c.tag, start: c.start, question: c.question, pass: false, error: err instanceof Error ? err.message.slice(0, 2000) : String(err), loadavg: { before: loadBefore, after: load() } };
        await tidy(page, null).catch(() => undefined);
      }
      const kept = redact(record, c.redact) as Record<string, unknown>;
      run.cases.push(kept);
      save();
      process.stdout.write(`${c.id}: ${kept.pass === true ? 'pass' : 'fail'}${typeof kept.error === 'string' ? ` (error: ${kept.error.split('\n')[0] ?? ''})` : ''}\n`);
    }

    // Frame times in the explorer: idle with the model loaded, then while it plans and writes an answer.
    await enter(page, { at: 'explorer', body: 'earth' });
    await page.waitForTimeout(2000);
    const idleLoad = load();
    const idle = await frames(page, 8000);
    await page.evaluate(async () => {
      await (window as unknown as Hook).__kf.ai.evaluate({ router: 'skip' });
    });
    const genLoad = load();
    let genMs = 0;
    const generating = await frames(page, async () => {
      const r = await askInPanel(page, 'Describe in a few sentences what the Earth looks like from here, and why its sky is blue.');
      genMs = r.ms;
    });
    const genRecords = await page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as Hook).__kf.ai.generations())) as GenerationRecord[]);
    run.frames = {
      where: 'explorer, the Earth in view, the scene at rest',
      idle: { ...stats(idle), ms: 8000, loadavg: idleLoad },
      generating: { ...stats(generating), ms: genMs, generations: genRecords.map((g) => ({ purpose: g.purpose, outputTokens: g.outputTokens, wallMs: g.wallMs, decodeTokensPerS: g.engineUsage?.decodeTokensPerS ?? null })), loadavg: genLoad },
      raw: { idle, generating },
    };
    run.finishedAt = new Date().toISOString();
    save();
    process.stdout.write(`results: ${outFile}\n`);
  } finally {
    await context.close();
  }
  expect(unexpected, 'requests to a model host that are not pinned files').toEqual([]);
});
