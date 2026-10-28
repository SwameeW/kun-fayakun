/*
 * Generations that overlap, on real models (docs/AI-INTELLIGENCE.md §3 and §6), on this Mac's GPU.
 * Local only, like ./eval.spec.ts: it runs only in the ai-eval project with KF_AI_EVAL_OVERLAP=1, from
 * the models' Cache API copies in the persistent profile.
 *
 *   KF_AI_EVAL=1 KF_AI_EVAL_OVERLAP=1 KF_SKIP_BUILD=1 KF_PORT=4271 \
 *     npx playwright test --project=ai-eval tests/ai-eval/overlap.spec.ts
 *
 * A generation started while another is still under way, every way the app can start one:
 * - through the engine host (each scenario a fresh load, so one that hangs leaves nothing behind):
 *   stopped while it reads a long prompt and asked again at once; stopped while it writes and asked
 *   again; stopped as it starts (right after the page posts its request to the worker, before the
 *   worker answers that it started: a hook on the worker's postMessage stops it there) and asked again
 *   at once, three times; a second started while the first writes, and one while the first reads its
 *   prompt, without a stop; twenty asked and stopped in a row, then one left to finish; the model
 *   unloaded and another loaded while it writes; unloaded while it reads its prompt, then loaded again;
 * - through the panel, as a visitor (the model chosen with the Intelligence's use(), as the panel's
 *   model section does, and the router skipped so that every question reaches the model): Stop then a
 *   new question; a second question sent over the first (Enter twice); a suggested question pressed
 *   while it answers; the panel closed and opened again while it answers; twenty questions in a row,
 *   every other one stopped; another model chosen while it answers; the guide chosen while it answers;
 *   the model's worker ended while it answers (the watch then ends the generation, and the model is let
 *   go: the page's live region says so, the next question is the guide's, and the model answers again
 *   once it is chosen again, which asks the model server for nothing).
 * For each it writes down whether the second answer came, how long it took, the render budgets still
 * held afterwards (counted through the app's requestRenderBudget) and the explorer's detail as the test
 * hook reports it. Before and after the panel's stress the same question is asked, and its plan, at
 * temperature 0, must be the same.
 *
 * A second answer is waited for KF_AI_EVAL_OVERLAP_WAIT_MS (default 60 s); one that has not come by
 * then is written down as hung, and the page is loaded again before the next scenario. KF_AI_EVAL_MODEL
 * (default Qwen3 1.7B) and KF_AI_EVAL_SWITCH_TO (default Qwen3 0.6B) choose the models;
 * KF_AI_EVAL_OVERLAP_PARTS (engine,panel) the parts, and KF_AI_EVAL_OVERLAP_ONLY (names, or parts of
 * names, separated by |) the scenarios; KF_AI_EVAL_TAG names the results file,
 * .work/ai-eval/results/overlap-<model>[-<tag>].json. KF_AI_EVAL_OVERLAP_RECORD=1 writes the results
 * down without failing on them (to record a build that hangs).
 */
import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { findModel } from '../../src/ai/engine/catalogue';
import type { ChatMessage, ModelSpec } from '../../src/ai/types';
import { modelsDir, readManifest } from '../../scripts/ai-eval/store';
import { env, flag } from '../support/env';
import { isModelHost, mockLiveHosts } from '../support/live';
import { serveModel } from './serve';

const MODEL_ID = env('KF_AI_EVAL_MODEL') ?? 'Qwen3-1.7B-q4f16_1-MLC';
const OTHER_ID = env('KF_AI_EVAL_SWITCH_TO') ?? 'Qwen3-0.6B-q4f16_1-MLC';
const WAIT_MS = Number(env('KF_AI_EVAL_OVERLAP_WAIT_MS') ?? 60_000);
const PARTS = new Set((env('KF_AI_EVAL_OVERLAP_PARTS') ?? 'engine,panel').split(',').map((p) => p.trim()));
const ONLY = (env('KF_AI_EVAL_OVERLAP_ONLY') ?? '').split('|').map((p) => p.trim()).filter((p) => p.length > 0);
const included = (name: string): boolean => ONLY.length === 0 || ONLY.some((p) => name.includes(p));
const TAG = env('KF_AI_EVAL_TAG');
const RECORD_ONLY = flag('KF_AI_EVAL_OVERLAP_RECORD');
const ROOT = new URL('../../', import.meta.url).pathname;
const OUT_DIR = env('KF_AI_EVAL_OUT') ?? `${ROOT}.work/ai-eval/results`;

const load = (): number[] => loadavg().map((x) => Math.round(x * 100) / 100);

/** What the page's live region says when a model is let go, for the model under test. */
const MIND = JSON.parse(readFileSync(new URL('../../src/i18n/en.ai.mind.json', import.meta.url), 'utf8')) as Record<string, string>;
const LOST_SAID = (MIND['ai.mind.announce.engineLost'] ?? '?').replace('{model}', findModel(MODEL_ID)?.name ?? MODEL_ID);
/** Requests the model server has answered so far (set once it runs). */
let servedRequests = (): number => 0;

/** A conversation of about 3,600 tokens (as in ./prefill.spec.ts): long enough that a stop lands while it is read. */
function longConversation(): ChatMessage[] {
  const facts = [
    'The Sun holds almost all of the solar system’s mass, and its light takes about eight minutes to reach the Earth.',
    'The Moon keeps the same face towards the Earth, because its turn and its orbit take the same time.',
    'Mercury is the smallest planet and the closest to the Sun, with almost no air to hold its heat.',
    'Venus is wrapped in thick clouds of sulphuric acid, and its surface is hotter than Mercury’s.',
    'The Earth is the only world known to have liquid water on its surface and life in it.',
    'Mars is red because iron in its dust has rusted, and its thin air is mostly carbon dioxide.',
    'Jupiter is the largest planet, a ball of hydrogen and helium with a storm larger than the Earth.',
    'Saturn’s rings are made of ice and rock, from grains of dust to pieces as large as houses.',
    'Uranus spins on its side, so each of its poles has decades of daylight and then of night.',
    'Neptune has the fastest winds measured in the solar system, faster than the speed of sound on Earth.',
  ];
  const paragraph = (seed: number, sentences: number): string => Array.from({ length: sentences }, (_, i) => facts[(seed + i * 3) % facts.length]).join(' ');
  const messages: ChatMessage[] = [{ role: 'system', content: `You explain astronomy in plain words. Answer in at most two sentences, from what was said in this conversation. ${paragraph(0, 16)}` }];
  for (let turn = 0; turn < 7; turn += 1) {
    messages.push({ role: 'user', content: `Tell me more about the planets, part ${turn + 1}. ${paragraph(turn, 10)}` });
    messages.push({ role: 'assistant', content: paragraph(turn + 1, 11) });
  }
  messages.push({ role: 'user', content: 'From all of that: which planet spins on its side, and what does that do to its poles?' });
  return messages;
}

const short = (question: string): ChatMessage[] => [
  { role: 'system', content: 'You explain astronomy in plain words, in at most two sentences.' },
  { role: 'user', content: question },
];
const WRITE = (question: string): ChatMessage[] => [
  { role: 'system', content: 'You explain astronomy in plain words, in a long paragraph of at least eight sentences.' },
  { role: 'user', content: question },
];

/** One generation as the probe saw it: how it ended, and when. */
interface Gen {
  finish: string;
  /** From its start to its end (or to when it was given up on), ms. */
  wallMs: number;
  /** From its start to its first streamed text, ms (null: none came). */
  firstTextMs: number | null;
  text: string;
  promptTokens: number;
  outputTokens: number;
  /** Not settled by the time it was waited for. */
  hung: boolean;
}

interface Scenario {
  name: string;
  /** Each generation (or turn) in the order started, the last the one that had to come. */
  steps: Record<string, unknown>[];
  /** The one that had to come: whether it did, and in how long. */
  arrived: boolean;
  secondMs: number | null;
  /** Render budgets held once the scenario settled (0: released), and the most held at once. */
  holdsAfter: number;
  mostHolds: number;
  marker: string | null;
  detail: unknown;
  ms: number;
  loadavg: number[];
  note?: string;
}

/** The probe's own part of the page: a count of the render budgets held, and generations it can wait on. */
async function install(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface Engine { generate(r: unknown): Promise<{ text: string; finish: string; promptTokens: number; outputTokens: number }>; unload(): Promise<void> }
    const w = window as unknown as {
      __kf: { app: { requestRenderBudget(reason: string, b: { maxScale: number }): () => void }; universe: { state(): { detail?: unknown } | null } };
      __ov?: unknown;
    };
    const app = w.__kf.app;
    const original = app.requestRenderBudget.bind(app);
    let holds = 0;
    let most = 0;
    app.requestRenderBudget = (reason, b) => {
      const release = original(reason, b);
      holds += 1;
      most = Math.max(most, holds);
      let done = false;
      return () => {
        if (!done) {
          done = true;
          holds -= 1;
        }
        release();
      };
    };
    const sleep = (ms: number): Promise<void> =>
      new Promise((r) => {
        setTimeout(r, ms);
      });
    // The model's worker as the page posts to it: a stop can be made to land right after a request, and the worker ended.
    const post = Object.getOwnPropertyDescriptor(Worker.prototype, 'postMessage')?.value as (this: Worker, ...args: unknown[]) => void;
    let armed: (() => void) | null = null;
    /** The workers posted a model's request, the last one last. */
    const modelWorkers: Worker[] = [];
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]): void {
      post.apply(this, args);
      const type = (args[0] as { type?: unknown } | null)?.type;
      if (type === 'load' || type === 'generate' || type === 'pull') {
        const at = modelWorkers.indexOf(this);
        if (at >= 0) modelWorkers.splice(at, 1);
        modelWorkers.push(this);
      }
      if (type === 'generate' && armed) {
        const f = armed;
        armed = null;
        f();
      }
    } as typeof Worker.prototype.postMessage;
    // Every text the page's live region (src/ui/announcer.ts) is given, as it writes it.
    const said: string[] = [];
    const region = document.querySelector('div.kf-sr-only[aria-live="polite"][aria-atomic="true"]');
    if (region)
      new MutationObserver(() => {
        const text = region.textContent;
        if (text) said.push(text);
      }).observe(region, { childList: true, characterData: true, subtree: true });
    w.__ov = {
      /** The texts the live region was given since the last call. */
      said: () => said.splice(0),
      /** Calls `f` right after the page next posts a generation's request to its worker. */
      afterGenerate: (f: () => void) => {
        armed = f;
      },
      /** Ends the model's worker as a crash would (the page is not told). */
      endModelWorker: () => {
        const last = modelWorkers.at(-1);
        last?.terminate();
        return last !== undefined;
      },
      holds: () => holds,
      most: () => most,
      resetMost: () => {
        most = holds;
      },
      sleep,
      detail: () => w.__kf.universe.state()?.detail ?? null,
      marker: () => localStorage.getItem('kf.ai.crash'),
      /** Starts a generation at once; its handle can stop it and be waited on. */
      start(engine: Engine, messages: unknown[], maxTokens: number) {
        const controller = new AbortController();
        const t0 = performance.now();
        let firstText: number | null = null;
        let streamed = '';
        let settled: { text: string; finish: string; promptTokens: number; outputTokens: number } | null = null;
        let endedAt: number | null = null;
        let failed: string | null = null;
        const firstWaiters: (() => void)[] = [];
        const done = engine
          .generate({
            messages,
            format: { kind: 'text' },
            maxTokens,
            temperature: 0,
            signal: controller.signal,
            onText: (d: string) => {
              streamed += d;
              if (firstText === null) {
                firstText = performance.now() - t0;
                for (const f of firstWaiters.splice(0)) f();
              }
            },
          })
          .then(
            (r) => {
              settled = r;
              endedAt = performance.now() - t0;
            },
            (e: unknown) => {
              failed = String(e);
              endedAt = performance.now() - t0;
            },
          );
        return {
          abort: () => {
            controller.abort();
          },
          /** Resolves when its first text has come (or after `ms`). */
          firstText: (ms: number) =>
            firstText !== null
              ? Promise.resolve()
              : Promise.race([
                  new Promise<void>((r) => {
                    firstWaiters.push(r);
                  }),
                  sleep(ms),
                ]),
          /** How it ended, waited for at most `ms`. */
          async wait(ms: number) {
            await Promise.race([done, sleep(ms)]);
            const s = settled;
            const hung = s === null && failed === null;
            return {
              finish: s ? s.finish : failed !== null ? `threw: ${failed}` : 'hung',
              wallMs: Math.round(endedAt ?? performance.now() - t0),
              firstTextMs: firstText === null ? null : Math.round(firstText),
              text: s ? s.text : streamed,
              promptTokens: s?.promptTokens ?? 0,
              outputTokens: s?.outputTokens ?? 0,
              hung,
            };
          },
        };
      },
    };
  });
}

/** The page as a fresh visit finds it, with the probe installed: the start, or the explorer at the Earth. */
async function fresh(page: Page, where: 'home' | 'explorer'): Promise<void> {
  await page.goto('/#/');
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 120_000 });
  if (where === 'explorer') {
    await page.evaluate(() => {
      location.hash = '#/universe';
    });
    await expect(page.locator('html')).toHaveAttribute('data-universe-ready', 'true', { timeout: 120_000 });
  }
  await install(page);
}

/* ------------------------------------------------------------------ */
/* Through the engine host                                              */
/* ------------------------------------------------------------------ */

interface Outcome {
  steps: Record<string, unknown>[];
  arrived: boolean;
  secondMs: number | null;
  note?: string;
}

/** A generation the probe started in the page: stopped with abort(), waited on with wait(). */
interface Handle {
  abort(): void;
  /** Resolves when its first text has come (or after `ms`). */
  firstText(ms: number): Promise<void>;
  /** How it ended, waited for at most `ms`. */
  wait(ms: number): Promise<Gen>;
}

/** The page as the scenarios reach it (installed by install()). */
interface ProbeWindow {
  __ov: { sleep(ms: number): Promise<void>; start(engine: unknown, messages: readonly ChatMessage[], maxTokens: number): Handle; afterGenerate(f: () => void): void };
  __ovEngine: { unload(): Promise<void> };
  __kf: { ai: { start(): Promise<{ host: { load(m: ModelSpec, onProgress: () => void, signal: AbortSignal): Promise<{ unload(): Promise<void> }> } }> } };
}

/** Loads `id` through the engine host into window.__ovEngine (the app's own path: a new worker, the Cache API). */
async function loadEngine(page: Page, id: string): Promise<number> {
  const spec = findModel(id) as ModelSpec;
  return page.evaluate(async (s) => {
    const w = window as unknown as ProbeWindow;
    const ai = await w.__kf.ai.start();
    const t0 = performance.now();
    w.__ovEngine = await ai.host.load(s, () => undefined, new AbortController().signal);
    return Math.round(performance.now() - t0);
  }, spec);
}

interface EngineArgs {
  long: ChatMessage[];
  write: ChatMessage[];
  next: ChatMessage[];
  questions: string[];
  spec: ModelSpec;
  other: ModelSpec;
  wait: number;
}

/** Each scenario runs in the page, on the engine loaded for it (window.__ovEngine). */
const ENGINE_SCENARIOS: Record<string, (a: EngineArgs) => Promise<Outcome>> = {
  // Stopped 300 ms into a 3,600-token prompt, the next asked 50 ms later (as the review did).
  'stop while reading, ask again': async (a) => {
    const { __ov: ov, __ovEngine: e } = window as unknown as ProbeWindow;
    const A = ov.start(e, a.long, 64);
    await ov.sleep(300);
    A.abort();
    await ov.sleep(50);
    const B = ov.start(e, a.next, 64);
    const b = await B.wait(a.wait);
    const first = await A.wait(1000);
    return { steps: [{ which: 'A', ...first }, { which: 'B', ...b }], arrived: !b.hung && (b.finish === 'stop' || b.finish === 'length'), secondMs: b.hung ? null : b.wallMs };
  },
  // Stopped 300 ms after its first word, the next asked 50 ms later.
  'stop while writing, ask again': async (a) => {
    const { __ov: ov, __ovEngine: e } = window as unknown as ProbeWindow;
    const A = ov.start(e, a.write, 300);
    await A.firstText(a.wait);
    await ov.sleep(300);
    A.abort();
    await ov.sleep(50);
    const B = ov.start(e, a.next, 64);
    const b = await B.wait(a.wait);
    const first = await A.wait(1000);
    return { steps: [{ which: 'A', ...first }, { which: 'B', ...b }], arrived: !b.hung && (b.finish === 'stop' || b.finish === 'length'), secondMs: b.hung ? null : b.wallMs };
  },
  // Stopped right after the page posts its request, before the worker answers that it started; the
  // next asked at once. Three times. The stopped one must write nothing (it is never started).
  'stopped as it starts, ask again': async (a) => {
    const { __ov: ov, __ovEngine: e } = window as unknown as ProbeWindow;
    const steps: Record<string, unknown>[] = [];
    let arrived = true;
    let secondMs: number | null = null;
    for (let i = 1; i <= 3; i++) {
      let A: Handle | null = null;
      const stoppedAt = new Promise<number>((resolve) => {
        ov.afterGenerate(() => {
          A?.abort();
          resolve(performance.now());
        });
      });
      A = ov.start(e, a.write, 300);
      const at = await Promise.race([stoppedAt, ov.sleep(a.wait).then(() => null)]);
      const B = ov.start(e, a.next, 64);
      const b = await B.wait(a.wait);
      const first = await A.wait(a.wait);
      // B is started as soon as A is stopped: its time is from the stop.
      steps.push({ which: `A${i}`, landed: at !== null, ...first }, { which: `B${i}`, ...b });
      const ok = at !== null && !b.hung && (b.finish === 'stop' || b.finish === 'length') && first.finish === 'abort' && first.outputTokens === 0;
      arrived &&= ok;
      secondMs = b.hung ? null : Math.max(secondMs ?? 0, b.wallMs);
      if (b.hung) break;
    }
    return { steps, arrived, secondMs };
  },
  // No stop: a second started 200 ms after the first's first word; both must end as written.
  'two at once while writing': async (a) => {
    const { __ov: ov, __ovEngine: e } = window as unknown as ProbeWindow;
    const whole = (g: Gen): boolean => !g.hung && (g.finish === 'stop' || g.finish === 'length');
    const A = ov.start(e, a.write, 120);
    await A.firstText(a.wait);
    await ov.sleep(200);
    const B = ov.start(e, a.next, 64);
    const b = await B.wait(a.wait);
    const first = await A.wait(a.wait);
    return { steps: [{ which: 'A', ...first }, { which: 'B', ...b }], arrived: whole(b) && whole(first), secondMs: b.hung ? null : b.wallMs };
  },
  // No stop: a second started 300 ms into the first's long prompt.
  'two at once while reading': async (a) => {
    const { __ov: ov, __ovEngine: e } = window as unknown as ProbeWindow;
    const whole = (g: Gen): boolean => !g.hung && (g.finish === 'stop' || g.finish === 'length');
    const A = ov.start(e, a.long, 64);
    await ov.sleep(300);
    const B = ov.start(e, a.next, 64);
    const b = await B.wait(a.wait);
    const first = await A.wait(a.wait);
    return { steps: [{ which: 'A', ...first }, { which: 'B', ...b }], arrived: whole(b) && whole(first), secondMs: b.hung ? null : b.wallMs };
  },
  // Twenty started and stopped after 0–400 ms (every fifth on the long prompt), then one left to finish.
  'twenty asked and stopped': async (a) => {
    const { __ov: ov, __ovEngine: e } = window as unknown as ProbeWindow;
    const delays = [0, 40, 120, 250, 400];
    const ask = (q: string): ChatMessage[] => [
      { role: 'system', content: 'You explain astronomy in plain words, in at most two sentences.' },
      { role: 'user', content: q },
    ];
    const handles: Handle[] = [];
    for (let i = 0; i < 20; i++) {
      const h = ov.start(e, i % 5 === 4 ? a.long : ask(a.questions[i % a.questions.length] ?? ''), 64);
      handles.push(h);
      await ov.sleep(delays[i % delays.length] ?? 0);
      h.abort();
    }
    const last = ov.start(e, a.next, 64);
    const b = await last.wait(a.wait);
    const ended: Gen[] = [];
    for (const h of handles) ended.push(await h.wait(b.hung ? 100 : 5000));
    const finishes: Record<string, number> = {};
    for (const g of ended) finishes[g.finish] = (finishes[g.finish] ?? 0) + 1;
    return { steps: [{ which: 'the twenty', finishes, hung: ended.filter((g) => g.hung).length }, { which: 'last', ...b }], arrived: !b.hung && (b.finish === 'stop' || b.finish === 'length'), secondMs: b.hung ? null : b.wallMs };
  },
  // The model unloaded while it writes, and another loaded and asked (what use() does, without its stop first).
  'unloaded and another loaded while it writes': async (a) => {
    const w = window as unknown as ProbeWindow;
    const { __ov: ov, __ovEngine: e } = w;
    const A = ov.start(e, a.write, 300);
    await A.firstText(a.wait);
    await ov.sleep(300);
    const t0 = performance.now();
    const unloaded = e.unload().then(() => Math.round(performance.now() - t0));
    const ai = await w.__kf.ai.start();
    const other = await ai.host.load(a.other, () => undefined, new AbortController().signal);
    const loadedMs = Math.round(performance.now() - t0);
    const first = await A.wait(a.wait);
    const unloadMs = await Promise.race([unloaded, ov.sleep(a.wait).then(() => null)]);
    const B = ov.start(other, a.next, 64);
    const b = await B.wait(a.wait);
    await other.unload();
    return { steps: [{ which: 'A', ...first, unloadMs }, { which: `B (${a.other.id})`, ...b, loadedMs }], arrived: !b.hung && b.finish === 'stop' && !first.hung, secondMs: b.hung ? null : b.wallMs };
  },
  // Unloaded 300 ms into a long prompt, then loaded again and asked.
  'unloaded while it reads, loaded again': async (a) => {
    const w = window as unknown as ProbeWindow;
    const { __ov: ov, __ovEngine: e } = w;
    const A = ov.start(e, a.long, 64);
    await ov.sleep(300);
    const t0 = performance.now();
    await Promise.race([e.unload(), ov.sleep(a.wait)]);
    const unloadMs = Math.round(performance.now() - t0);
    const first = await A.wait(a.wait);
    const ai = await w.__kf.ai.start();
    const again = await ai.host.load(a.spec, () => undefined, new AbortController().signal);
    const B = ov.start(again, a.next, 64);
    const b = await B.wait(a.wait);
    await again.unload();
    return { steps: [{ which: 'A', ...first, unloadMs }, { which: 'B (loaded again)', ...b }], arrived: !b.hung && b.finish === 'stop' && !first.hung, secondMs: b.hung ? null : b.wallMs };
  },
};

/* ------------------------------------------------------------------ */
/* Through the panel                                                    */
/* ------------------------------------------------------------------ */

const QUESTIONS = [
  'Why is the sky blue on the Earth? Answer in a few sentences.',
  'What gives the Earth its seasons? Answer in a few sentences.',
  'Why does the Moon show phases? Answer in a few sentences.',
  'Why is Venus hotter than Mercury? Answer in a few sentences.',
  'What are Saturn’s rings made of? Answer in a few sentences.',
  'Why is Mars red? Answer in a few sentences.',
  'How far is the Sun from the Earth? Answer in a few sentences.',
  'Why do stars twinkle? Answer in a few sentences.',
] as const;
/** Questions whose answers take a while to write, so that another model (or the guide) is chosen while one is written. */
const LONG_QUESTIONS = ['Tell me about each planet of the solar system in turn, in a long paragraph.', 'Tell me about the moons of Jupiter and Saturn, one by one, in a long paragraph.'] as const;
/** The question asked before and after the panel's stress: its plan at temperature 0 must not change. */
const REFERENCE = 'Describe in a few sentences what the Earth looks like from here, and why its sky is blue.';
/** Where the camera is put before the reference question (its distance is in the plan's prompt). */
const REFERENCE_POSE = { body: 'earth', distanceKm: 40_000 } as const;

const turnItems = (page: Page): ReturnType<Page['locator']> => page.getByTestId('ai-log').locator(':scope > li');

/** Opens the panel with Ask, if it is not open. */
async function openPanel(page: Page): Promise<void> {
  if (await page.getByTestId('ai-panel').isVisible()) return;
  await page.getByTestId('ask').click();
  await expect(page.getByTestId('ai-panel')).toBeVisible({ timeout: 60_000 });
}

/** Types a question and sends it with Enter; resolves to the new turn's id and when it was sent. */
async function send(page: Page, question: string): Promise<{ id: string; at: number }> {
  const before = await turnItems(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-turn') ?? ''));
  const input = page.getByTestId('ai-input');
  await input.fill(question);
  const at = Date.now();
  await input.press('Enter');
  const id = await page.waitForFunction(
    (old) => [...document.querySelectorAll('[data-testid="ai-log"] > li')].map((li) => li.getAttribute('data-turn') ?? '').find((t) => !old.includes(t)) ?? null,
    before,
    { timeout: 10_000, polling: 20 },
  );
  return { id: (await id.jsonValue()) ?? '', at };
}

const SETTLED = ['done', 'failed', 'cancelled', 'awaiting-confirmation'];

/** The turn's state once it has settled (or 'hung' after `ms`), how long after `from`, and who wrote its text. */
async function settle(page: Page, id: string, from: number, ms: number): Promise<{ state: string; ms: number; writer: string | null; hung: boolean }> {
  try {
    await page.waitForFunction(
      ({ t, s }) => s.includes(document.querySelector(`[data-testid="ai-log"] > li[data-turn="${t}"]`)?.getAttribute('data-state') ?? ''),
      { t: id, s: SETTLED },
      { timeout: ms, polling: 50 },
    );
  } catch {
    const state = await page.evaluate((t) => document.querySelector(`[data-testid="ai-log"] > li[data-turn="${t}"]`)?.getAttribute('data-state') ?? null, id);
    return { state: state ?? 'missing', ms: Date.now() - from, writer: null, hung: true };
  }
  const took = Date.now() - from;
  const info = await page.evaluate(async (t) => {
    const ai = await (window as unknown as { __kf: { ai: { start(): Promise<{ turns(): { id: string; state: string; blocks: { type: string; writer?: { kind: string; model: string } }[] }[] }> } } }).__kf.ai.start();
    const turn = ai.turns().find((x) => x.id === t);
    const text = turn?.blocks.find((b) => b.type === 'text' && b.writer);
    return { state: turn?.state ?? 'missing', writer: text?.writer ? `${text.writer.kind}:${text.writer.model}` : null };
  }, id);
  return { state: info.state, ms: took, writer: info.writer, hung: false };
}

/** The panel's turns state, and the engine's, once the work under way has ended (at most 15 s). */
async function quiet(page: Page): Promise<void> {
  await page
    .waitForFunction(
      async () => {
        const ai = await (window as unknown as { __kf: { ai: { start(): Promise<{ engine(): { state: string } }> } } }).__kf.ai.start();
        return ai.engine().state !== 'busy' && ai.engine().state !== 'loading' && (window as unknown as { __ov: { holds(): number } }).__ov.holds() === 0;
      },
      null,
      { timeout: 15_000, polling: 100 },
    )
    .catch(() => undefined);
}

/** Chooses a model (an id, or 'guide') as the panel's model section does, through the Intelligence's use(). */
async function choose(page: Page, id: string): Promise<string> {
  const spec = id === 'guide' ? 'guide' : (findModel(id) as ModelSpec);
  return page.evaluate(async (s) => {
    const ai = await (window as unknown as { __kf: { ai: { start(): Promise<{ use(c: unknown): Promise<void>; engine(): { kind: string; model: string | null; state: string } }> } } }).__kf.ai.start();
    await ai.use(s);
    const e = ai.engine();
    return `${e.kind}:${e.model ?? ''}:${e.state}`;
  }, spec);
}

/** The router skipped (every question reaches the model) and every generation recorded. */
async function modelMode(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as { __kf: { ai: { start(): Promise<unknown>; evaluate(o: unknown): Promise<void> } } };
    // The assistant's own chunk, once started, gives the hook its evaluate().
    await w.__kf.ai.start();
    await w.__kf.ai.evaluate({ router: 'skip' });
  });
}

/** The generations recorded since the last call: purpose, finish and the plan's raw reply. */
async function generations(page: Page): Promise<{ turnId: string; purpose: string; finish: string; raw: string; messages: unknown }[]> {
  return page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __kf: { ai: { generations(): unknown[] } } }).__kf.ai.generations())) as { turnId: string; purpose: string; finish: string; raw: string; messages: unknown }[]);
}

/** Waits until the turn has reached one of `states` (or `ms` passed). */
async function reach(page: Page, id: string, states: string[], ms: number): Promise<string | null> {
  try {
    await page.waitForFunction(({ t, s }) => s.includes(document.querySelector(`[data-testid="ai-log"] > li[data-turn="${t}"]`)?.getAttribute('data-state') ?? ''), { t: id, s: states }, { timeout: ms, polling: 20 });
  } catch {
    return null;
  }
  return page.evaluate((t) => document.querySelector(`[data-testid="ai-log"] > li[data-turn="${t}"]`)?.getAttribute('data-state') ?? null, id);
}

type PanelStep = (page: Page) => Promise<Outcome>;

const PANEL_SCENARIOS: Record<string, PanelStep> = {
  'Stop, then a new question': async (page) => {
    const a = await send(page, QUESTIONS[0]);
    await page.waitForTimeout(300);
    await page.getByTestId('ai-stop').click();
    const b = await send(page, QUESTIONS[1]);
    const second = await settle(page, b.id, b.at, WAIT_MS);
    const first = await settle(page, a.id, a.at, 1000);
    return { steps: [{ which: 'first', ...first }, { which: 'second', ...second }], arrived: second.state === 'done' && second.writer?.startsWith('local:') === true, secondMs: second.hung ? null : second.ms };
  },
  'a second question over the first (Enter twice)': async (page) => {
    const a = await send(page, QUESTIONS[2]);
    await page.waitForTimeout(300);
    const b = await send(page, QUESTIONS[3]);
    const second = await settle(page, b.id, b.at, WAIT_MS);
    const first = await settle(page, a.id, a.at, 1000);
    return { steps: [{ which: 'first', ...first }, { which: 'second', ...second }], arrived: second.state === 'done' && second.writer?.startsWith('local:') === true, secondMs: second.hung ? null : second.ms };
  },
  'a suggested question while it answers': async (page) => {
    const a = await send(page, QUESTIONS[4]);
    await page.waitForTimeout(300);
    const before = await turnItems(page).count();
    const chip = page.getByTestId('ai-suggestion').first();
    const text = (await chip.textContent()) ?? '';
    const at = Date.now();
    await chip.click();
    await expect(turnItems(page)).toHaveCount(before + 1, { timeout: 10_000 });
    const id = (await turnItems(page).last().getAttribute('data-turn')) ?? '';
    const second = await settle(page, id, at, WAIT_MS);
    const first = await settle(page, a.id, a.at, 1000);
    return { steps: [{ which: 'first', ...first }, { which: 'suggestion', question: text, ...second }], arrived: second.state === 'done' && second.writer?.startsWith('local:') === true, secondMs: second.hung ? null : second.ms };
  },
  'the panel closed and opened while it answers': async (page) => {
    const a = await send(page, QUESTIONS[5]);
    await page.waitForTimeout(300);
    await page.getByTestId('ai-close').click();
    await page.waitForTimeout(1000);
    await openPanel(page);
    const first = await settle(page, a.id, a.at, WAIT_MS);
    const b = await send(page, QUESTIONS[6]);
    const second = await settle(page, b.id, b.at, WAIT_MS);
    return { steps: [{ which: 'first (not stopped)', ...first }, { which: 'second', ...second }], arrived: first.state === 'done' && second.state === 'done' && second.writer?.startsWith('local:') === true, secondMs: second.hung ? null : second.ms };
  },
  'twenty questions in a row, every other one stopped': async (page) => {
    const delays = [0, 40, 120, 250, 400];
    const sent: { id: string; at: number }[] = [];
    for (let i = 0; i < 20; i++) {
      sent.push(await send(page, QUESTIONS[i % QUESTIONS.length] ?? QUESTIONS[0]));
      await page.waitForTimeout(delays[i % delays.length] ?? 0);
      if (i % 2 === 1 && (await page.getByTestId('ai-stop').isVisible())) await page.getByTestId('ai-stop').click();
    }
    const b = await send(page, QUESTIONS[7]);
    const last = await settle(page, b.id, b.at, WAIT_MS);
    const states: Record<string, number> = {};
    for (const s of sent) {
      const st = await page.evaluate((t) => document.querySelector(`[data-testid="ai-log"] > li[data-turn="${t}"]`)?.getAttribute('data-state') ?? 'missing', s.id);
      states[st] = (states[st] ?? 0) + 1;
    }
    return { steps: [{ which: 'the twenty', states }, { which: 'last', ...last }], arrived: last.state === 'done' && last.writer?.startsWith('local:') === true, secondMs: last.hung ? null : last.ms };
  },
  'another model chosen while it answers': async (page) => {
    const a = await send(page, LONG_QUESTIONS[0]);
    const reached = await reach(page, a.id, ['answering', ...SETTLED], WAIT_MS);
    const t0 = Date.now();
    const engine = await choose(page, OTHER_ID);
    const switchMs = Date.now() - t0;
    const first = await settle(page, a.id, a.at, 1000);
    const b = await send(page, QUESTIONS[1]);
    const second = await settle(page, b.id, b.at, WAIT_MS);
    const back = await choose(page, MODEL_ID);
    return { steps: [{ which: 'first', reached, ...first }, { which: `second (${OTHER_ID})`, engine, switchMs, ...second }, { which: 'back', engine: back }], arrived: second.state === 'done' && second.writer === `local:${OTHER_ID}`, secondMs: second.hung ? null : second.ms };
  },
  'the guide chosen while it answers': async (page) => {
    const a = await send(page, LONG_QUESTIONS[1]);
    const reached = await reach(page, a.id, ['answering', ...SETTLED], WAIT_MS);
    const engine = await choose(page, 'guide');
    const first = await settle(page, a.id, a.at, 1000);
    const b = await send(page, QUESTIONS[3]);
    const second = await settle(page, b.id, b.at, WAIT_MS);
    const back = await choose(page, MODEL_ID);
    const c = await send(page, QUESTIONS[4]);
    const third = await settle(page, c.id, c.at, WAIT_MS);
    return { steps: [{ which: 'first', reached, ...first }, { which: 'second (the guide)', engine, ...second }, { which: 'third (the model again)', engine: back, ...third }], arrived: second.state === 'done' && third.state === 'done' && third.writer?.startsWith('local:') === true, secondMs: third.hung ? null : third.ms };
  },
  // The model's worker ended as a crash would, while it answers: after the watch's silence the generation
  // ends, the model is let go, the next question is the guide's, and the model answers once chosen again.
  'the model’s worker ended while it answers': async (page) => {
    const a = await send(page, LONG_QUESTIONS[0]);
    const reached = await reach(page, a.id, ['answering', ...SETTLED], WAIT_MS);
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as unknown as { __ov: { said(): string[] } }).__ov.said());
    const t0 = Date.now();
    const ended = await page.evaluate(() => (window as unknown as { __ov: { endModelWorker(): boolean } }).__ov.endModelWorker());
    const first = await settle(page, a.id, t0, WAIT_MS);
    // The live region writes its text 60 ms after it is given it.
    await page.waitForTimeout(150);
    const heard = await page.evaluate(() => (window as unknown as { __ov: { said(): string[] } }).__ov.said());
    const engine = await page.evaluate(async () => {
      const ai = await (window as unknown as { __kf: { ai: { start(): Promise<{ engine(): { kind: string; model: string | null; state: string }; turns(): { id: string; blocks: { type: string; key?: string }[] }[] }> } } }).__kf.ai.start();
      const e = ai.engine();
      return { engine: `${e.kind}:${e.model ?? ''}:${e.state}`, notices: ai.turns().flatMap((t) => t.blocks.filter((b) => b.type === 'notice').map((b) => `${t.id}:${b.key ?? ''}`)) };
    });
    const b = await send(page, QUESTIONS[2]);
    const second = await settle(page, b.id, b.at, WAIT_MS);
    const served = servedRequests();
    const back = await choose(page, MODEL_ID);
    const requests = servedRequests() - served;
    const c = await send(page, QUESTIONS[3]);
    const third = await settle(page, c.id, c.at, WAIT_MS);
    const told = heard.some((t) => t.includes(LOST_SAID));
    return {
      steps: [{ which: 'first (its worker ended)', ended, reached, ...first, ...engine, heard, told }, { which: 'second (the guide)', ...second }, { which: 'third (the model chosen again)', engine: back, requests, ...third }],
      arrived: ended && first.state === 'done' && engine.engine === `local:${MODEL_ID}:error` && told && second.state === 'done' && second.writer === null && requests === 0 && third.state === 'done' && third.writer === `local:${MODEL_ID}`,
      secondMs: second.hung ? null : second.ms,
    };
  },
};

/** Asks REFERENCE through the panel and returns its plan as the model wrote it (null: no plan was recorded). */
async function referencePlan(page: Page): Promise<{ raw: string; messages: unknown; state: string } | null> {
  // The same prompt each time: no earlier turns (they are in a plan's prompt), the camera in the same
  // place (the plans of the questions between may move it), and nothing recorded before.
  await page.evaluate(async (pose) => {
    const w = window as unknown as { __kf: { universe: { place(p: unknown): void }; ai: { start(): Promise<{ clear(): void }> } } };
    (await w.__kf.ai.start()).clear();
    w.__kf.universe.place(pose);
  }, REFERENCE_POSE);
  await page.waitForTimeout(500);
  await generations(page);
  const r = await send(page, REFERENCE);
  const settled = await settle(page, r.id, r.at, WAIT_MS * 2);
  const plan = (await generations(page)).find((g) => g.turnId === r.id && g.purpose === 'plan');
  return plan ? { raw: plan.raw, messages: plan.messages, state: settled.state } : null;
}

test(`overlapping generations on real models: ${MODEL_ID}`, async ({ baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'ai-eval' || !flag('KF_AI_EVAL_OVERLAP'), 'runs only with KF_AI_EVAL=1 KF_AI_EVAL_OVERLAP=1');
  test.setTimeout(90 * 60_000);
  const spec = findModel(MODEL_ID);
  const other = findModel(OTHER_ID);
  const manifest = readManifest(MODEL_ID);
  expect(spec && other && manifest).toBeTruthy();
  if (!spec || !other || !manifest) return;

  const port = new URL(baseURL ?? 'http://127.0.0.1:4173/').port;
  const profile = `${modelsDir().replace(/\/models$/u, '')}/ai-eval/profile-${port}`;
  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = `${OUT_DIR}/overlap-${MODEL_ID}${TAG ? `-${TAG}` : ''}.json`;
  const server = await serveModel(manifest);
  servedRequests = () => server.served.requests;
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, args: server.args(testInfo.project.use.launchOptions?.args ?? []), ...(baseURL ? { baseURL } : {}) });
  await context.route((url) => isModelHost(url.hostname), (route) => route.continue());
  const pageErrors: string[] = [];
  const scenarios: (Scenario & { part: 'engine' | 'panel' })[] = [];
  const out: Record<string, unknown> = { model: MODEL_ID, other: OTHER_ID, waitMs: WAIT_MS, tag: TAG ?? null, only: ONLY, startedAt: new Date().toISOString(), loadavgStart: load(), scenarios };
  const save = (): void => {
    writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  };
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await mockLiveHosts(page);
    await page.route((url) => isModelHost(url.hostname), (route) => route.continue());

    /** Runs one scenario and writes it down; the page is loaded again after one whose answer never came. */
    const record = async (part: 'engine' | 'panel', name: string, step: () => Promise<{ steps: Record<string, unknown>[]; arrived: boolean; secondMs: number | null; note?: string }>): Promise<boolean> => {
      const t0 = Date.now();
      const l = load();
      await page.evaluate(() => {
        (window as unknown as { __ov: { resetMost(): void } }).__ov.resetMost();
      });
      let result: { steps: Record<string, unknown>[]; arrived: boolean; secondMs: number | null; note?: string };
      try {
        result = await step();
      } catch (err) {
        result = { steps: [], arrived: false, secondMs: null, note: `the probe failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (part === 'panel' && result.arrived) await quiet(page);
      const after = await page.evaluate(() => {
        const ov = (window as unknown as { __ov: { holds(): number; most(): number; detail(): unknown; marker(): string | null } }).__ov;
        return { holds: ov.holds(), most: ov.most(), detail: ov.detail(), marker: ov.marker() };
      });
      const s: Scenario & { part: 'engine' | 'panel' } = { part, name, ...result, holdsAfter: after.holds, mostHolds: after.most, marker: after.marker, detail: after.detail, ms: Date.now() - t0, loadavg: l };
      scenarios.push(s);
      save();
      process.stdout.write(`${part} | ${name}: ${s.arrived ? `arrived in ${s.secondMs ?? '?'} ms` : 'did not arrive'}; budgets held after: ${s.holdsAfter}\n`);
      return s.arrived;
    };

    if (PARTS.has('engine')) {
      const args: EngineArgs = { long: longConversation(), write: WRITE('Tell me about the planets of the solar system, one by one.'), next: short('Why is Mars red?'), questions: ['Why is Mars red?', 'What are Saturn’s rings made of?', 'Why is Venus so hot?', 'Why does the Moon show one face?'], spec, other, wait: WAIT_MS };
      await fresh(page, 'explorer');
      for (const [name, scenario] of Object.entries(ENGINE_SCENARIOS)) {
        if (!included(name)) continue;
        await loadEngine(page, MODEL_ID);
        const ok = await record('engine', name, () => page.evaluate(scenario, args));
        // The engine is unloaded either way (again, for those that did); after one that hung, the page too (its worker with it).
        await page.evaluate(async () => {
          const e = (window as unknown as { __ovEngine?: { unload(): Promise<void> } }).__ovEngine;
          await Promise.race([e?.unload(), new Promise((r) => setTimeout(r, 5000))]);
        });
        if (!ok) await fresh(page, 'explorer');
      }
    }

    if (PARTS.has('panel')) {
      const setUp = async (): Promise<void> => {
        await fresh(page, 'explorer');
        await modelMode(page);
        await openPanel(page);
        expect(await choose(page, MODEL_ID)).toBe(`local:${MODEL_ID}:ready`);
      };
      await setUp();
      const before = await referencePlan(page);
      out.referenceBefore = before;
      save();
      for (const [name, step] of Object.entries(PANEL_SCENARIOS)) {
        if (!included(name)) continue;
        const ok = await record('panel', name, () => step(page));
        if (!ok) await setUp();
      }
      const after = await referencePlan(page);
      out.referenceAfter = after;
      out.samePlanAfterStress = before !== null && after !== null && JSON.stringify(before.messages) === JSON.stringify(after.messages) && before.raw === after.raw;
      out.samePlanMessages = before !== null && after !== null && JSON.stringify(before.messages) === JSON.stringify(after.messages);
    }

    Object.assign(out, { finishedAt: new Date().toISOString(), loadavgEnd: load(), unexpectedRequests: server.unexpected, pageErrors });
    save();
    process.stdout.write(`results: ${outFile}\n`);
    if (RECORD_ONLY) return;
    for (const s of scenarios) {
      expect(s.arrived, `${s.part} | ${s.name}: the answer that had to come (${JSON.stringify(s.steps)}; ${s.note ?? ''})`).toBe(true);
      expect(s.holdsAfter, `${s.part} | ${s.name}: the render budget let go`).toBe(0);
      expect(s.marker, `${s.part} | ${s.name}: no crash marker left`).toBeNull();
    }
    if (PARTS.has('panel')) {
      expect(out.samePlanMessages, 'the reference question asked the same way after the stress').toBe(true);
      expect(out.samePlanAfterStress, 'the same plan after the stress, at temperature 0').toBe(true);
    }
    expect(server.unexpected).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    save();
    await context.close().catch(() => undefined);
    await server.close();
  }
});
