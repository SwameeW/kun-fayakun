/*
 * A model that stops working, on real models (docs/AI-INTELLIGENCE.md §6 and §10), on this Mac's GPU.
 * Local only, like ./eval.spec.ts: it runs only in the ai-eval project with KF_AI_EVAL_LOST=1, from the
 * models' Cache API copies in the persistent profile.
 *
 *   KF_AI_EVAL=1 KF_AI_EVAL_LOST=1 KF_SKIP_BUILD=1 KF_PORT=4271 \
 *     npx playwright test --project=ai-eval tests/ai-eval/lost.spec.ts
 *
 * Through the panel, as a visitor (the model chosen with the Intelligence's use(), as the panel's model
 * section does, and the router skipped so that every question reaches the model), each on a fresh page:
 * - the model's worker ended while idle (as a crash would: the page is not told), and the same with the
 *   question that meets it stopped and another asked at once;
 * - the model's GPU device lost while idle, and while it answers (the worker's own GPUDevice destroyed,
 *   from inside the worker: WebLLM 0.2.86 meets that as it meets any loss of its device);
 * - the GPU process ended while the model answers (DevTools' Browser.crashGpuProcess): every device the
 *   page had is lost, the renderer's with the model's.
 * For each it writes down how the turn that met it ended (its state, notices, who wrote its text, and how
 * long after the loss), the engine's state and the panel's header, every text the page's live region
 * was given, the crash marker, the next question (the guide's), and the model chosen again: the requests
 * the model server was asked meanwhile, and the question after, with the model's generations. For the
 * GPU process, the page's own error dialog and the console's errors too.
 *
 * KF_AI_EVAL_MODEL (default Qwen3 1.7B) chooses the model, KF_AI_EVAL_LOST_ONLY (names, or parts of
 * names, separated by |) the cases, and KF_AI_EVAL_TAG names the results file,
 * .work/ai-eval/results/lost-<model>[-<tag>].json. KF_AI_EVAL_LOST_RECORD=1 writes the results down
 * without failing on them (to record a build that does not let the model go).
 */
import { chromium, expect, test, type Page, type Worker as PageWorker } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { findModel } from '../../src/ai/engine/catalogue';
import type { ModelSpec } from '../../src/ai/types';
import { modelsDir, readManifest } from '../../scripts/ai-eval/store';
import { env, flag } from '../support/env';
import { isModelHost, mockLiveHosts } from '../support/live';
import { serveModel } from './serve';

const MODEL_ID = env('KF_AI_EVAL_MODEL') ?? 'Qwen3-1.7B-q4f16_1-MLC';
const ONLY = (env('KF_AI_EVAL_LOST_ONLY') ?? '').split('|').map((p) => p.trim()).filter((p) => p.length > 0);
const included = (name: string): boolean => ONLY.length === 0 || ONLY.some((p) => name.includes(p));
const TAG = env('KF_AI_EVAL_TAG');
const RECORD_ONLY = flag('KF_AI_EVAL_LOST_RECORD');
const ROOT = new URL('../../', import.meta.url).pathname;
const OUT_DIR = env('KF_AI_EVAL_OUT') ?? `${ROOT}.work/ai-eval/results`;
/** How long a turn is waited for (the watch alone takes 35 s to give up on a silent worker). */
const WAIT_MS = 90_000;

const MIND = JSON.parse(readFileSync(new URL('../../src/i18n/en.ai.mind.json', import.meta.url), 'utf8')) as Record<string, string>;
const UI = JSON.parse(readFileSync(new URL('../../src/i18n/en.ai.json', import.meta.url), 'utf8')) as Record<string, string>;
const CORE = JSON.parse(readFileSync(new URL('../../src/i18n/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const fill = (text: string | undefined, model: string): string => (text ?? '?').replace('{model}', model);

const load = (): number[] => loadavg().map((x) => Math.round(x * 100) / 100);

const QUESTIONS = ['Why is the sky blue on the Earth? Answer in a few sentences.', 'Why is Mars red? Answer in a few sentences.', 'What gives the Earth its seasons? Answer in a few sentences.', 'Why is Venus hotter than Mercury? Answer in a few sentences.'] as const;
/** A question whose answer takes a while to write, so that the loss comes while it is written. */
const LONG_QUESTION = 'Tell me about each planet of the solar system in turn, in a long paragraph.';

const turnItems = (page: Page): ReturnType<Page['locator']> => page.getByTestId('ai-log').locator(':scope > li');

/** Types a question and sends it with Enter; resolves to the new turn's id and when it was sent. */
async function send(page: Page, question: string): Promise<{ id: string; at: number }> {
  const before = await turnItems(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-turn') ?? ''));
  const input = page.getByTestId('ai-input');
  await input.fill(question);
  const at = Date.now();
  await input.press('Enter');
  const id = await page.waitForFunction((old) => [...document.querySelectorAll('[data-testid="ai-log"] > li')].map((li) => li.getAttribute('data-turn') ?? '').find((t) => !old.includes(t)) ?? null, before, { timeout: 10_000, polling: 20 });
  return { id: (await id.jsonValue()) ?? '', at };
}

interface Settled {
  state: string;
  /** From `from` to the turn's end, ms (null: it did not end in time). */
  ms: number | null;
  /** Who wrote its text (kind:model), or null for the guide. */
  writer: string | null;
  notices: string[];
  engine: string;
  /** The engine's errors told since the last turn settled (its events): code and detail. */
  errors: string[];
  header: string | null;
  marker: string | null;
  /** Its generations: purpose, finish. */
  generations: string[];
}

/** The turn once it has settled (or after `ms`), and where the engine stands then. */
async function settle(page: Page, id: string, from: number, ms: number): Promise<Settled> {
  let took: number | null;
  try {
    await page.waitForFunction((t) => ['done', 'failed', 'cancelled', 'awaiting-confirmation'].includes(document.querySelector(`[data-testid="ai-log"] > li[data-turn="${t}"]`)?.getAttribute('data-state') ?? ''), id, { timeout: ms, polling: 50 });
    took = Date.now() - from;
  } catch {
    took = null;
  }
  // The live region writes its text 60 ms after it is given it.
  await page.waitForTimeout(150);
  const info = await page.evaluate(async (t) => {
    const w = window as unknown as { __lost: { errors: string[] }; __kf: { ai: { start(): Promise<{ turns(): { id: string; state: string; blocks: { type: string; key?: string; writer?: { kind: string; model: string } }[] }[]; engine(): { kind: string; model: string | null; state: string } }>; generations(): { turnId: string; purpose: string; finish: string; engine: { kind: string; model: string } }[] } } };
    const ai = await w.__kf.ai.start();
    const turn = ai.turns().find((x) => x.id === t);
    const text = turn?.blocks.find((b) => b.type === 'text' && b.writer);
    const e = ai.engine();
    return {
      state: turn?.state ?? 'missing',
      writer: text?.writer ? `${text.writer.kind}:${text.writer.model}` : null,
      notices: turn?.blocks.filter((b) => b.type === 'notice').map((b) => b.key ?? '') ?? [],
      engine: `${e.kind}:${e.model ?? ''}:${e.state}`,
      errors: w.__lost.errors.splice(0),
      header: document.querySelector('[data-testid="ai-engine"]')?.textContent ?? null,
      marker: localStorage.getItem('kf.ai.crash'),
      generations: w.__kf.ai.generations().filter((g) => g.turnId === t).map((g) => `${g.purpose}:${g.finish}:${g.engine.kind}`),
    };
  }, id);
  return { ...info, ms: took };
}

/** Chooses the model as the panel's model section does (the Intelligence's use()); the engine after, and how long it took. */
async function choose(page: Page, id: string): Promise<{ engine: string; ms: number }> {
  const spec = findModel(id) as ModelSpec;
  return page.evaluate(async (s) => {
    const ai = await (window as unknown as { __kf: { ai: { start(): Promise<{ use(c: unknown): Promise<void>; engine(): { kind: string; model: string | null; state: string } }> } } }).__kf.ai.start();
    const t0 = performance.now();
    await ai.use(s);
    const e = ai.engine();
    return { engine: `${e.kind}:${e.model ?? ''}:${e.state}`, ms: Math.round(performance.now() - t0) };
  }, spec);
}

/** The page as a fresh visit finds it, in the explorer at the Earth, the router skipped, the panel open, the model chosen. */
async function fresh(page: Page): Promise<void> {
  await page.goto('/#/');
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 120_000 });
  await page.evaluate(() => {
    location.hash = '#/universe';
  });
  await expect(page.locator('html')).toHaveAttribute('data-universe-ready', 'true', { timeout: 120_000 });
  await page.evaluate(async () => {
    const w = window as unknown as {
      __kf: { ai: { start(): Promise<{ events: { on(name: 'engine', f: (e: { state: string; error?: { code: string; detail?: string } }) => void): unknown } }>; evaluate(o: unknown): Promise<void> } };
      __lost: { said: string[]; workers: Worker[]; errors: string[] };
    };
    // Every text the page's live region (src/ui/announcer.ts) is given, as it writes it.
    const said: string[] = [];
    const region = document.querySelector('div.kf-sr-only[aria-live="polite"][aria-atomic="true"]');
    if (region)
      new MutationObserver(() => {
        const text = region.textContent;
        if (text) said.push(text);
      }).observe(region, { childList: true, characterData: true, subtree: true });
    // The model's workers, as the page posts to them, the last one last.
    const workers: Worker[] = [];
    const post = Object.getOwnPropertyDescriptor(Worker.prototype, 'postMessage')?.value as (this: Worker, ...args: unknown[]) => void;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]): void {
      post.apply(this, args);
      const type = (args[0] as { type?: unknown } | null)?.type;
      if (type === 'load' || type === 'generate' || type === 'pull') {
        const at = workers.indexOf(this);
        if (at >= 0) workers.splice(at, 1);
        workers.push(this);
      }
    } as typeof Worker.prototype.postMessage;
    const errors: string[] = [];
    w.__lost = { said, workers, errors };
    // The engine's errors, as its events tell them (the engine state itself keeps only that it is one).
    (await w.__kf.ai.start()).events.on('engine', (e) => {
      if (e.state === 'error' && e.error) errors.push(`${e.error.code}: ${e.error.detail ?? ''}`.slice(0, 400));
    });
    await w.__kf.ai.evaluate({ router: 'skip' });
  });
  await page.getByTestId('ask').click();
  await expect(page.getByTestId('ai-panel')).toBeVisible({ timeout: 60_000 });
  expect((await choose(page, MODEL_ID)).engine).toBe(`local:${MODEL_ID}:ready`);
}

/** The texts the live region was given since the last call. */
const said = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __lost: { said: string[] } }).__lost.said.splice(0));

/** Ends the model's worker from the page, as a crash would (the page is not told). */
const endWorker = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const w = (window as unknown as { __lost: { workers: Worker[] } }).__lost.workers.at(-1);
    w?.terminate();
    return w !== undefined;
  });

/** The model's worker as Playwright reaches it, with GPUDevice's createCommandEncoder made to keep the device it is called on. */
async function keepDevice(page: Page): Promise<PageWorker | null> {
  const worker = page.workers().filter((w) => /webllm-worker/u.test(w.url())).at(-1) ?? null;
  await worker?.evaluate(() => {
    const g = self as unknown as { __kept?: GPUDevice; __keeping?: boolean };
    if (g.__keeping) return;
    g.__keeping = true;
    const proto = GPUDevice.prototype as unknown as { createCommandEncoder: (this: GPUDevice, ...args: unknown[]) => GPUCommandEncoder };
    const create = proto.createCommandEncoder;
    proto.createCommandEncoder = function (this: GPUDevice, ...args: unknown[]): GPUCommandEncoder {
      g.__kept = this;
      return create.apply(this, args);
    };
  });
  return worker;
}

/** Destroys the GPUDevice the model's worker last worked on (WebLLM meets that as any loss of its device). */
const loseDevice = async (worker: PageWorker | null): Promise<boolean> =>
  (await worker?.evaluate(() => {
    const d = (self as unknown as { __kept?: GPUDevice }).__kept;
    d?.destroy();
    return d !== undefined;
  })) ?? false;

/** The page's error dialog (src/ui/status.ts): its message, or null when it is not shown. */
const errorDialog = (page: Page): Promise<string | null> => page.evaluate(() => (document.documentElement.classList.contains('kf-error-open') ? (document.querySelector('[data-testid="error"] .kf-error-message')?.textContent ?? '') : null));

interface Case {
  name: string;
  /** The loss was made as it should be (a worker found, a device kept, the GPU process ended). */
  made: boolean;
  /** The turn that met it, timed from the loss (from its question, for a loss while idle). */
  met: Settled;
  /** What the live region was given from the loss to that turn's end. */
  heard: string[];
  next: Settled;
  again: { engine: string; ms: number; requests: number };
  after: Settled;
  dialog?: string | null;
  loadavg: number[];
  ok: boolean;
  why: string[];
}

test(`a model that stops working, on a real model: ${MODEL_ID}`, async ({ baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'ai-eval' || !flag('KF_AI_EVAL_LOST'), 'runs only with KF_AI_EVAL=1 KF_AI_EVAL_LOST=1');
  test.setTimeout(60 * 60_000);
  const spec = findModel(MODEL_ID);
  const manifest = readManifest(MODEL_ID);
  expect(spec && manifest).toBeTruthy();
  if (!spec || !manifest) return;
  const lostText = fill(MIND['ai.mind.announce.engineLost'], spec.name);
  const header = fill(UI['ai.ui.engine.error'], spec.name);

  const port = new URL(baseURL ?? 'http://127.0.0.1:4173/').port;
  const profile = `${modelsDir().replace(/\/models$/u, '')}/ai-eval/profile-${port}`;
  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = `${OUT_DIR}/lost-${MODEL_ID}${TAG ? `-${TAG}` : ''}.json`;
  const server = await serveModel(manifest);
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, args: server.args(testInfo.project.use.launchOptions?.args ?? []), ...(baseURL ? { baseURL } : {}) });
  await context.route((url) => isModelHost(url.hostname), (route) => route.continue());
  const cases: Case[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const out: Record<string, unknown> = { model: MODEL_ID, tag: TAG ?? null, only: ONLY, startedAt: new Date().toISOString(), loadavgStart: load(), cases, consoleErrors, pageErrors };
  const save = (): void => {
    writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  };
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (e) => pageErrors.push(`${e.message} ${(e.stack ?? '').split('\n').slice(1, 6).map((l) => l.trim()).join(' | ')}`));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
    });
    await mockLiveHosts(page);
    await page.route((url) => isModelHost(url.hostname), (route) => route.continue());

    /** Runs one case on a fresh page: `lose` makes the loss and resolves to the turn that meets it. */
    const run = async (name: string, lose: () => Promise<{ made: boolean; id: string; from: number }>, gpuProcess = false): Promise<void> => {
      if (!included(name)) return;
      const l = load();
      await fresh(page);
      await said(page);
      const { made, id, from } = await lose();
      const met = await settle(page, id, from, WAIT_MS);
      const heard = await said(page);
      const dialog = gpuProcess ? await errorDialog(page) : undefined;
      const b = await send(page, QUESTIONS[1]);
      const next = await settle(page, b.id, b.at, WAIT_MS);
      await said(page);
      const before = server.served.requests;
      const chosen = await choose(page, MODEL_ID);
      const again = { ...chosen, requests: server.served.requests - before };
      const c = await send(page, QUESTIONS[2]);
      const after = await settle(page, c.id, c.at, WAIT_MS);
      const why: string[] = [];
      if (!made) why.push('the loss was not made');
      if (met.state !== 'done' || met.writer !== null || !met.notices.includes('ai.mind.notice.engineError')) why.push('the turn that met it did not end with the guide and the engine-error notice');
      if (met.engine !== `local:${MODEL_ID}:error`) why.push(`the model was not let go (${met.engine})`);
      if (met.header !== header) why.push(`the header read ${JSON.stringify(met.header)}`);
      if (!heard.some((t) => t.includes(lostText))) why.push('the live region was not given that the model stopped working');
      if (next.state !== 'done' || next.writer !== null || next.generations.length > 0) why.push('the next question was not the guide’s alone');
      if (again.engine !== `local:${MODEL_ID}:ready` || again.requests !== 0) why.push(`chosen again: ${again.engine}, ${again.requests} requests`);
      if (after.state !== 'done' || !after.generations.some((g) => g.endsWith(':stop:local'))) why.push('chosen again, the model did not answer');
      if (met.marker !== null || after.marker !== null) why.push('a crash marker was left');
      if (gpuProcess && dialog !== (CORE['ui.error.deviceLost'] ?? '?')) why.push(`the renderer's dialog: ${JSON.stringify(dialog)}`);
      const s: Case = { name, made, met, heard, next, again, after, ...(gpuProcess ? { dialog } : {}), loadavg: l, ok: why.length === 0, why };
      cases.push(s);
      save();
      process.stdout.write(`${name}: ${s.ok ? 'ok' : why.join('; ')}; met in ${met.ms ?? '?'} ms, next ${next.ms ?? '?'} ms, chosen again ${again.ms} ms (${again.requests} requests), then ${after.ms ?? '?'} ms\n`);
    };

    await run('its worker ended while idle', async () => {
      const ended = await endWorker(page);
      const a = await send(page, QUESTIONS[0]);
      return { made: ended, id: a.id, from: a.at };
    });

    // The question that meets it stopped a second in, and another asked at once: that one is the one timed.
    await run('its worker ended while idle, the question stopped and another asked', async () => {
      const ended = await endWorker(page);
      await send(page, QUESTIONS[0]);
      await page.waitForTimeout(1000);
      await page.getByTestId('ai-stop').click();
      const b = await send(page, QUESTIONS[3]);
      return { made: ended, id: b.id, from: b.at };
    });

    await run('its GPU device lost while idle', async () => {
      const worker = await keepDevice(page);
      const a = await send(page, QUESTIONS[3]);
      await settle(page, a.id, a.at, WAIT_MS);
      await said(page);
      const lost = await loseDevice(worker);
      await page.waitForTimeout(500);
      const b = await send(page, QUESTIONS[0]);
      return { made: lost, id: b.id, from: b.at };
    });

    await run('its GPU device lost while it answers', async () => {
      const worker = await keepDevice(page);
      const a = await send(page, LONG_QUESTION);
      await page.waitForFunction((t) => document.querySelector(`[data-testid="ai-log"] > li[data-turn="${t}"]`)?.getAttribute('data-state') === 'answering', a.id, { timeout: WAIT_MS, polling: 20 });
      await page.waitForTimeout(800);
      const lost = await loseDevice(worker);
      return { made: lost, id: a.id, from: Date.now() };
    });

    await run(
      'the GPU process ended while it answers',
      async () => {
        const a = await send(page, LONG_QUESTION);
        await page.waitForFunction((t) => document.querySelector(`[data-testid="ai-log"] > li[data-turn="${t}"]`)?.getAttribute('data-state') === 'answering', a.id, { timeout: WAIT_MS, polling: 20 });
        await page.waitForTimeout(800);
        let made = true;
        try {
          const cdp = await context.newCDPSession(page);
          await cdp.send('Browser.crashGpuProcess' as never);
          await cdp.detach().catch(() => undefined);
        } catch {
          made = false;
        }
        return { made, id: a.id, from: Date.now() };
      },
      true,
    );

    Object.assign(out, { finishedAt: new Date().toISOString(), loadavgEnd: load(), unexpectedRequests: server.unexpected });
    save();
    process.stdout.write(`results: ${outFile}\n`);
    if (RECORD_ONLY) return;
    for (const s of cases) expect(s.why, s.name).toEqual([]);
    expect(server.unexpected).toEqual([]);
  } finally {
    save();
    await context.close().catch(() => undefined);
    await server.close();
  }
});
