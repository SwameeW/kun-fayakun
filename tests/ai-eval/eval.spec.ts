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
 * - KF_AI_EVAL_PREFILL_CHUNK: how the model reads its prompt (src/ai/engine/prefill.ts), in place of
 *   its own setting: a chunk in tokens, or "compiled" for the size its library was built with; with
 *   KF_AI_EVAL_PREFILL_YIELD=1 each chunk after the first waits for the model's GPU queue. Left out:
 *   the model's own. Every generation must report that setting in effect, or the run fails.
 * - KF_AI_EVAL_FRAME_TURNS: the explorer's frames are measured over this many turns (default 1, at
 *   most 3), each a different question.
 *
 * Nothing is downloaded. Chromium resolves huggingface.co and cdn.jsdelivr.net to a local HTTPS server
 * that streams the pinned files from disk (./serve.ts; route.fulfill cannot carry a file over about
 * 75 MB), and every other model host to nothing, so the app's real path (our worker → WebLLM → the
 * Cache API) runs unchanged but offline. Any other request to a model host fails the run. The browser profile is
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
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, release, totalmem } from 'node:os';
import { findModel, VISITOR_MODELS } from '../../src/ai/engine/catalogue';
import { prefillFor, type PrefillSetting } from '../../src/ai/engine/prefill';
import type { GenerationRecord, Intelligence, ModelSpec, PrefillUsage, ToolKind } from '../../src/ai/types';
import type { App, BodyId, UniverseView } from '../../src/core/types';
import { manifestVerified, modelsDir, readManifest, type ModelManifest } from '../../scripts/ai-eval/store';
import { env } from '../support/env';
import { isModelHost, LIVE_HOSTS, mockLiveHosts } from '../support/live';
import { selectCases, type Start } from './cases';
import { score, type LabSnapshot, type Observation, type Scored, type TurnData } from './score';
import { SERVED_HOSTS, serveModel } from './serve';

const MODEL_ID = env('KF_AI_EVAL_MODEL') ?? 'Qwen3-0.6B-q4f16_1-MLC';
const MODE: 'pipeline' | 'model' = env('KF_AI_EVAL_MODE') === 'model' ? 'model' : 'pipeline';
const TAG = env('KF_AI_EVAL_TAG');
const CASE_MS = Number(env('KF_AI_EVAL_CASE_MS') ?? 300_000);
const ROOT = new URL('../../', import.meta.url).pathname;
const OUT_DIR = env('KF_AI_EVAL_OUT') ?? `${ROOT}.work/ai-eval/results`;
const PREFILL_CHUNK = env('KF_AI_EVAL_PREFILL_CHUNK');
/** The prompt's chunk asked for in place of the model's own (null: its own). */
const PREFILL: PrefillSetting | null = PREFILL_CHUNK === undefined ? null : { chunkTokens: PREFILL_CHUNK === 'compiled' ? null : Number(PREFILL_CHUNK), yieldBetween: env('KF_AI_EVAL_PREFILL_YIELD') === '1' };
/** The questions the explorer's frames are measured over, one turn each (the first is the only one before KF_AI_EVAL_FRAME_TURNS). */
const FRAME_QUESTIONS = [
  'Describe in a few sentences what the Earth looks like from here, and why its sky is blue.',
  'Why is the sky black on the Moon but blue on the Earth? Answer in a few sentences.',
  'What gives the Earth its seasons? Answer in a few sentences.',
] as const;
const FRAME_TURNS = Math.max(1, Math.min(FRAME_QUESTIONS.length, Math.floor(Number(env('KF_AI_EVAL_FRAME_TURNS') ?? 1)) || 1));

const mind = JSON.parse(readFileSync(new URL('../../src/i18n/en.ai.mind.json', import.meta.url), 'utf8')) as Record<string, string>;

/** window.__kf as this spec reaches it (the assistant's part with the evaluation's hook). */
interface Hook {
  __kf: {
    app: App;
    universe: { state(): UniverseView | null };
    ai: {
      start(): Promise<Intelligence & { kindOf(tool: string): ToolKind | null; clear(): void }>;
      evaluate(options: { router: 'first' | 'skip'; prefill?: PrefillSetting } | null): Promise<void>;
      generations(): readonly GenerationRecord[];
    };
  };
}

const load = (): number[] => loadavg().map((x) => Math.round(x * 100) / 100);

/**
 * The machine beside the load average: the GPU processes of other browsers running now (other agents'
 * Chromium suites, say) and their CPU share, apart from this run's own (its profile is in its command
 * line). The load average alone did not show GPU contention (docs/AI-EVALUATION.md).
 */
function gpuClients(profile: string): { others: number; othersCpu: number; ownCpu: number | null } {
  try {
    const rows = execFileSync('ps', ['-axo', 'pcpu=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      .split('\n')
      .filter((l) => l.includes('--type=gpu-process'))
      .map((l) => ({ cpu: Number(l.trim().split(/\s+/u)[0] ?? 0), own: l.includes(profile) }));
    const others = rows.filter((r) => !r.own);
    const own = rows.find((r) => r.own);
    return { others: others.length, othersCpu: Math.round(others.reduce((a, r) => a + r.cpu, 0) * 10) / 10, ownCpu: own ? own.cpu : null };
  } catch {
    return { others: -1, othersCpu: -1, ownCpu: null };
  }
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

/** A model that did not load: the engine's own error (its code and the words WebLLM gave), and what the panel said. */
class LoadFailure extends Error {
  constructor(readonly detail: { code: string | null; detail: string | null; panel: string | null; via: 'panel' | 'use'; ms: number }) {
    super(`the model did not load: ${detail.code ?? '?'}: ${detail.detail ?? detail.panel ?? ''}`);
  }
}

/** Records the engine's next error event in the page (window.__evalLoadError). */
async function watchLoadError(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as Hook & { __evalLoadError?: { code: string; detail: string | null } | null; __evalWatching?: boolean };
    w.__evalLoadError = null;
    if (w.__evalWatching) return;
    w.__evalWatching = true;
    const ai = await w.__kf.ai.start();
    ai.events.on('engine', (e) => {
      if (e.state === 'error') w.__evalLoadError = { code: e.error?.code ?? 'unknown', detail: e.error?.detail ?? null };
    });
  });
}

const loadError = (page: Page): Promise<{ code: string; detail: string | null } | null> =>
  page.evaluate(() => (window as unknown as { __evalLoadError?: { code: string; detail: string | null } | null }).__evalLoadError ?? null);

/** Loads the model as a visitor does: the panel's section for a visitor tier, Intelligence.use() (what the panel calls) for an evaluation candidate. */
async function loadModel(page: Page, spec: ModelSpec, visitor: boolean): Promise<{ ms: number; via: 'panel' | 'use' }> {
  await openPanel(page);
  await watchLoadError(page);
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
    if (!(await section.getByTestId('ai-load-ready').isVisible())) {
      const e = await loadError(page);
      throw new LoadFailure({ code: e?.code ?? null, detail: e?.detail ?? null, panel: await section.getByTestId('ai-model-error').textContent(), via: 'panel', ms: Date.now() - started });
    }
    return { ms: Date.now() - started, via: 'panel' };
  }
  const state = await page.evaluate(async (s) => {
    const ai = await (window as unknown as Hook).__kf.ai.start();
    await ai.use(s);
    return ai.engine().state;
  }, spec);
  if (state !== 'ready') {
    const e = await loadError(page);
    throw new LoadFailure({ code: e?.code ?? null, detail: e?.detail ?? null, panel: null, via: 'use', ms: Date.now() - started });
  }
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

/** requestAnimationFrame intervals while `during` runs (or for `ms`), ms, and when each frame came (performance.now()). */
async function frames(page: Page, during: (() => Promise<void>) | number): Promise<{ intervals: number[]; at: number[] }> {
  await page.evaluate(() => {
    const w = window as unknown as { __evalFrames?: { intervals: number[]; at: number[]; on: boolean } };
    const state = { intervals: [] as number[], at: [] as number[], on: true };
    w.__evalFrames = state;
    let last = -1;
    const tick = (now: number): void => {
      if (last >= 0) {
        state.intervals.push(now - last);
        state.at.push(now);
      }
      last = now;
      if (state.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  if (typeof during === 'number') await page.waitForTimeout(during);
  else await during();
  return page.evaluate(() => {
    const w = window as unknown as { __evalFrames?: { intervals: number[]; at: number[]; on: boolean } };
    if (!w.__evalFrames) return { intervals: [], at: [] };
    w.__evalFrames.on = false;
    return { intervals: w.__evalFrames.intervals, at: w.__evalFrames.at };
  });
}

/** Frames over 50 ms, each set against the generations of the turn: in a prefill (before its first token), in a decode, or between them. */
function longFrames(f: { intervals: number[]; at: number[] }, gens: readonly GenerationRecord[]): { ms: number; at: number; phase: string }[] {
  const out: { ms: number; at: number; phase: string }[] = [];
  f.intervals.forEach((ms, i) => {
    if (ms <= 50) return;
    const end = f.at[i] ?? 0;
    const start = end - ms;
    const g = gens.find((x) => x.startedMs !== undefined && start < x.startedMs + x.wallMs && end > x.startedMs);
    let phase = 'between';
    if (g?.startedMs !== undefined) {
      const first = g.startedMs + (g.engineUsage?.ttftMs ?? g.prefillMs);
      phase = `${g.purpose} ${start < first ? 'prefill' : 'decode'}`;
    }
    out.push({ ms: Math.round(ms), at: Math.round(end), phase });
  });
  return out;
}

function stats(xs: readonly number[]): { n: number; p50: number | null; p95: number | null; max: number | null; meanFps: number | null } {
  if (xs.length === 0) return { n: 0, p50: null, p95: null, max: null, meanFps: null };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const r = (x: number): number => Math.round(x * 100) / 100;
  return { n: xs.length, p50: r(q(0.5)), p95: r(q(0.95)), max: r(s[s.length - 1] ?? 0), meanFps: r(1000 / mean) };
}

/**
 * Asks through the panel's field; resolves when the turn settles (or the case's time runs out). The
 * turn is followed by its own item (a turn id not in the log before): the panel keeps only its last
 * 50 turns, so after 50 cases a position in the log no longer names the new one.
 */
async function askInPanel(page: Page, question: string): Promise<{ ms: number; timedOut: boolean }> {
  await openPanel(page);
  const before = await page.evaluate(() => [...document.querySelectorAll('[data-testid="ai-log"] > li')].map((li) => li.getAttribute('data-turn') ?? ''));
  const input = page.getByTestId('ai-input');
  await input.fill(question);
  const started = Date.now();
  await input.press('Enter');
  try {
    await page.waitForFunction(
      (old) => {
        const li = [...document.querySelectorAll('[data-testid="ai-log"] > li')].find((x) => !old.includes(x.getAttribute('data-turn') ?? ''));
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
  if (PREFILL?.chunkTokens != null) expect(Number.isInteger(PREFILL.chunkTokens) && PREFILL.chunkTokens > 0, `KF_AI_EVAL_PREFILL_CHUNK=${PREFILL_CHUNK ?? ''}: a whole number of tokens, or "compiled"`).toBe(true);
  /** The setting the model's loads use: the one under test, else the model's own. */
  const prefillSetting: PrefillSetting = PREFILL ?? prefillFor(spec);
  const evaluation = (router: 'first' | 'skip'): { router: 'first' | 'skip'; prefill?: PrefillSetting } => ({ router, ...(PREFILL ? { prefill: PREFILL } : {}) });
  /** How the model read its prompt: asked (the setting under test, null for the model's own), the setting in effect, and what each generation reported. */
  const runPrefill = { asked: PREFILL, setting: prefillSetting, seen: [] as ({ case?: string; frames?: number; purpose: string } & PrefillUsage)[] };

  const port = new URL(baseURL ?? 'http://127.0.0.1:4173/').port;
  const profile = `${modelsDir().replace(/\/models$/u, '')}/ai-eval/profile-${port}`;
  mkdirSync(profile, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = `${OUT_DIR}/${MODEL_ID}-${MODE}${TAG ? `-${TAG}` : ''}.json`;

  const use = testInfo.project.use;
  const server = await serveModel(manifest);
  const { served, unexpected } = server;
  const context: BrowserContext = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: use.viewport ?? { width: 1280, height: 800 },
    args: server.args(use.launchOptions?.args ?? []),
    ...(baseURL ? { baseURL } : {}),
  });
  // The model hosts go to the network, which resolves them to the local server above.
  const toServer = (url: URL): boolean => isModelHost(url.hostname);
  await context.route(toServer, (route) => route.continue());
  // Every request the browser makes, whatever answers it: a model host the local server does not serve
  // (resolved to nothing, so it never reaches the server's own log) fails the run; any other host off this
  // origin is counted and written down.
  const origin = new URL(baseURL ?? 'http://127.0.0.1:4173/').host;
  const externalHosts: Record<string, number> = {};
  const unservedModelHosts: string[] = [];
  context.on('request', (r) => {
    let u: URL;
    try {
      u = new URL(r.url());
    } catch {
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (u.host === origin || (LIVE_HOSTS as readonly string[]).includes(u.hostname) || (SERVED_HOSTS as readonly string[]).includes(u.hostname)) return;
    if (isModelHost(u.hostname)) unservedModelHosts.push(`${r.method()} ${u.origin}${u.pathname}`);
    else externalHosts[u.hostname] = (externalHosts[u.hostname] ?? 0) + 1;
  });
  const pageErrors: string[] = [];
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (e) => pageErrors.push(e.message));
    // The live services answered in the browser (as every test does); the model hosts by the server.
    await mockLiveHosts(page);
    await page.route(toServer, (route) => route.continue());

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

    // A model that does not load (out of memory, an operator or shader WebGPU will not run) is a
    // result too: its exact error is written down in place of the cases, never skipped.
    const failedLoad = (err: LoadFailure, stage: 'first' | 'cached', l: number[]): void => {
      const file = { model: MODEL_ID, name: spec.name, mode: MODE, tag: TAG ?? null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), machine: { cpu: cpus()[0]?.model ?? null, memoryBytes: totalmem(), os: `darwin ${release()}`, arch: arch(), adapter }, catalogue: { weightsUrl: spec.weightsUrl, libUrl: spec.libUrl, downloadBytes: spec.downloadBytes, vramMBEstimate: spec.vramMB, contextTokens: spec.contextTokens }, load: null, loadError: { stage, ...err.detail, loadavg: l, served: { ...served } }, gpuMemory: { reported: null }, loadavgStart: l, cases: [], frames: null, unexpectedRequests: unexpected, pageErrors };
      writeFileSync(outFile, `${JSON.stringify(file, null, 2)}\n`);
      process.stdout.write(`load failed (${stage}): ${err.message}\nresults: ${outFile}\n`);
    };

    // First, the files into the Cache API through the local server (only when they are not there yet).
    const before = await cached(page, manifest);
    let routedLoad: { ms: number; via: string; requests: number; bytes: number; loadavg: number[] } | null = null;
    if (before.stored < before.of) {
      const l0 = load();
      try {
        const r = await loadModel(page, spec, visitor);
        routedLoad = { ...r, requests: served.requests, bytes: served.bytes, loadavg: l0 };
      } catch (err) {
        if (!(err instanceof LoadFailure)) throw err;
        failedLoad(err, 'first', l0);
        return;
      }
    }
    const afterFirst = await cached(page, manifest);
    expect(afterFirst.stored, 'every pinned file is in the Cache API').toBe(afterFirst.of);

    // Then the load a returning visitor gets: a fresh page, the files from the Cache API.
    const servedBefore = { requests: served.requests, bytes: served.bytes };
    await page.reload();
    await ready(page);
    // How the model reads its prompt is set when it loads: the setting under test goes in first (the
    // assistant's own chunk, started here, gives the hook its evaluate()).
    await page.evaluate(async (o) => {
      await (window as unknown as Hook).__kf.ai.start();
      await (window as unknown as Hook).__kf.ai.evaluate(o);
    }, evaluation(MODE === 'model' ? 'skip' : 'first'));
    const l1 = load();
    let cachedLoad: { ms: number; via: 'panel' | 'use' };
    try {
      cachedLoad = await loadModel(page, spec, visitor);
    } catch (err) {
      if (!(err instanceof LoadFailure)) throw err;
      failedLoad(err, 'cached', l1);
      return;
    }
    const engine = await page.evaluate(async () => (await (window as unknown as Hook).__kf.ai.start()).engine());
    expect(engine).toEqual({ kind: 'local', model: MODEL_ID, state: 'ready' });
    await expect(page.locator('html')).toHaveAttribute('data-ai-engine', 'local');
    const load2 = { ...cachedLoad, loadavg: l1, routeRequests: served.requests - servedBefore.requests, routeBytes: served.bytes - servedBefore.bytes };

    await page.evaluate(async (o) => {
      await (window as unknown as Hook).__kf.ai.evaluate(o);
    }, evaluation(MODE === 'model' ? 'skip' : 'first'));

    const run = {
      model: MODEL_ID,
      name: spec.name,
      mode: MODE,
      tag: TAG ?? null,
      startedAt: new Date().toISOString(),
      machine: { cpu: cpus()[0]?.model ?? null, memoryBytes: totalmem(), os: `darwin ${release()}`, arch: arch(), adapter },
      catalogue: { weightsUrl: spec.weightsUrl, libUrl: spec.libUrl, downloadBytes: spec.downloadBytes, vramMBEstimate: spec.vramMB, contextTokens: spec.contextTokens },
      load: { routed: routedLoad, cached: load2 },
      // How the model read its prompt: asked (the setting under test, or null for the model's own) and in effect (null: the model's own).
      prefill: runPrefill,
      gpuMemory: { reported: null, note: 'WebLLM 0.2.86 reports no GPU memory figure at run time; vramMBEstimate is its prebuilt estimate' },
      loadavgStart: load(),
      cases: [] as unknown[],
      frames: null as unknown,
      unexpectedRequests: unexpected,
      unservedModelHosts,
      externalHosts,
      gpuClientsStart: gpuClients(profile),
      pageErrors,
      finishedAt: null as string | null,
    };
    const save = (): void => {
      writeFileSync(outFile, `${JSON.stringify(run, null, 2)}\n`);
    };
    save();

    for (const c of cases) {
      const loadBefore = load();
      const gpuBefore = gpuClients(profile);
      let record: Record<string, unknown>;
      let reloaded: { reason: string; ms: number } | null = null;
      try {
        await enter(page, c.start);
        const now = await page.evaluate(async () => (await (window as unknown as Hook).__kf.ai.start()).engine());
        if (now.kind !== 'local' || now.model !== MODEL_ID) {
          // The model was unloaded (an error, a lost device): load it again, and say so in the record.
          const r = await loadModel(page, spec, visitor);
          reloaded = { reason: `engine was ${now.kind}/${now.model ?? '-'} (${now.state})`, ms: r.ms };
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
          sideBySideText: mind['ai.mind.guard.sideBySide'] ?? '',
          modelId: MODEL_ID,
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
          ...(reloaded ? { reloaded } : {}),
          timings: { totalMs: asked.ms, turn: read.turn.timings, plan: timing(plan), repair: timing(repair), answer: timing(answer) },
          generations: read.generations,
          loadavg: { before: loadBefore, after: load(), gpuClients: gpuBefore },
        };
        await tidy(page, read.turn);
      } catch (err) {
        record = { id: c.id, category: c.category, tag: c.tag, start: c.start, question: c.question, pass: false, error: err instanceof Error ? err.message.slice(0, 2000) : String(err), ...(reloaded ? { reloaded } : {}), loadavg: { before: loadBefore, after: load(), gpuClients: gpuBefore } };
        await tidy(page, null).catch(() => undefined);
      }
      const gens = Array.isArray(record.generations) ? (record.generations as GenerationRecord[]) : [];
      run.prefill.seen.push(...gens.flatMap((g) => (g.engineUsage?.prefill ? [{ case: c.id, purpose: g.purpose, ...g.engineUsage.prefill }] : [])));
      const kept = redact(record, c.redact) as Record<string, unknown>;
      run.cases.push(kept);
      save();
      process.stdout.write(`${c.id}: ${kept.pass === true ? 'pass' : 'fail'}${typeof kept.error === 'string' ? ` (error: ${kept.error.split('\n')[0] ?? ''})` : ''}\n`);
    }

    // Frame times in the explorer: idle with the model loaded, then while it plans and writes an answer
    // (one turn, or KF_AI_EVAL_FRAME_TURNS turns, each a different question from the Earth at rest).
    await enter(page, { at: 'explorer', body: 'earth' });
    await page.waitForTimeout(2000);
    const idleLoad = load();
    const idleGpu = gpuClients(profile);
    const idle = await frames(page, 8000);
    await page.evaluate(async (o) => {
      const hook = (window as unknown as Hook).__kf.ai;
      await hook.evaluate(o);
      hook.generations();
    }, evaluation('skip'));
    const turns: Record<string, unknown>[] = [];
    const rawTurns: { intervals: number[]; at: number[] }[] = [];
    for (let i = 0; i < FRAME_TURNS; i += 1) {
      if (i > 0) {
        await tidy(page, null);
        await enter(page, { at: 'explorer', body: 'earth' });
        await page.waitForTimeout(2000);
        await page.evaluate(() => {
          (window as unknown as Hook).__kf.ai.generations();
        });
      }
      const genLoad = load();
      const genGpu = gpuClients(profile);
      let genMs = 0;
      const generating = await frames(page, async () => {
        const r = await askInPanel(page, FRAME_QUESTIONS[i] ?? FRAME_QUESTIONS[0]);
        genMs = r.ms;
      });
      const genRecords = await page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as Hook).__kf.ai.generations())) as GenerationRecord[]);
      run.prefill.seen.push(...genRecords.flatMap((g) => (g.engineUsage?.prefill ? [{ frames: i, purpose: g.purpose, ...g.engineUsage.prefill }] : [])));
      turns.push({
        question: i,
        ...stats(generating.intervals),
        ms: genMs,
        generations: genRecords.map((g) => ({ purpose: g.purpose, promptTokens: g.promptTokens, outputTokens: g.outputTokens, wallMs: g.wallMs, startedMs: g.startedMs ?? null, ttftMs: g.engineUsage?.ttftMs ?? null, prefillTokensPerS: g.engineUsage?.prefillTokensPerS ?? null, decodeTokensPerS: g.engineUsage?.decodeTokensPerS ?? null, prefillChunk: g.engineUsage?.prefill?.chunkAtGeneration ?? null })),
        loadavg: genLoad,
        gpuClients: genGpu,
        // Every frame over 50 ms, when it came and in which generation's prefill or decode.
        long: longFrames(generating, genRecords),
      });
      rawTurns.push(generating);
    }
    const first = rawTurns[0] ?? { intervals: [], at: [] };
    run.frames = {
      where: 'explorer, the Earth in view, the scene at rest',
      idle: { ...stats(idle.intervals), ms: 8000, loadavg: idleLoad, gpuClients: idleGpu, long: longFrames(idle, []) },
      generating: turns[0],
      ...(turns.length > 1 ? { turns } : {}),
      raw: { idle: idle.intervals, generating: first.intervals, generatingAt: first.at, ...(rawTurns.length > 1 ? { turns: rawTurns } : {}) },
    };
    run.finishedAt = new Date().toISOString();
    save();
    process.stdout.write(`results: ${outFile}\n`);
  } finally {
    // A browser that has already gone (a crash) must not hide the error that ended the run.
    await context.close().catch(() => undefined);
    await server.close();
  }
  expect(unexpected, 'requests to a model host that are not pinned files').toEqual([]);
  // The prompt was read as asked (src/ai/engine/prefill.ts): a WebLLM whose pipeline moved fails here.
  const seen = runPrefill.seen;
  expect(seen.length, 'generations reporting how the prompt was read').toBeGreaterThan(0);
  for (const p of seen) {
    const asked = runPrefill.setting.chunkTokens;
    if (asked === null) {
      expect(p.outcome, 'no chunk asked for').toBe('off');
      continue;
    }
    const expected = p.compiled !== null && p.compiled <= asked ? 'kept' : 'set';
    expect(p.outcome, `the prompt's chunk (${asked}) set on WebLLM's pipeline`).toBe(expected);
    expect(p.chunkAtGeneration, 'the chunk the pipeline held at the generation').toBe(expected === 'set' ? asked : p.compiled);
    expect(p.yieldBetween, 'the wait between chunks').toBe(expected === 'set' && runPrefill.setting.yieldBetween);
  }
  expect(unservedModelHosts, 'requests to a model host the local server does not serve').toEqual([]);
});
