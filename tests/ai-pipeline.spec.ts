/**
 * Kun Fayakun Intelligence end to end, on the real page, through the test hook (window.__kf.ai;
 * there is no interface yet): docs/AI-INTELLIGENCE.md §2.
 *
 * With the guide (no model): commands the router knows run the real tools against the real app and
 * report only what the app's state shows (the explorer on Mars, the date set, a date out of the
 * data's span refused with the span named); a verse is a block shown from data; numbers are facts
 * with their sources; an experiment waits for the visitor, changes the laboratory only once
 * confirmed and is undone (and Stop pressed straight after Confirm, or while it runs, never leaves
 * a change without its card and its Undo); a comparison runs in the real background worker, can be
 * cancelled, and in the laboratory shows no share link and changes no status line.
 *
 * With the scripted engine (src/ai/engine/scripted.ts, replies written here): a model's JSON plan is
 * validated and run, and its answer's citation markers become verse and fact blocks; Arabic script,
 * a made-up quotation presented as a verse, an unknown citation, banned phrasing, an unbacked number
 * and a claim no tool backs are cleaned and flagged; invalid JSON is repaired once; a reply is
 * cancelled mid-stream.
 *
 * Throughout: nothing under src/ai (nor the knowledge index) is fetched before start(), no request
 * ever goes to a model host, and the language model's worker (WebLLM) is never fetched.
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { Page, Request } from '@playwright/test';
import type { AnswerBlock, Turn } from '../src/ai/types';
import { expect, test, type KfHook } from './support/fixtures';
import { SLOW } from './support/env';
import { isModelHost, modelRequests } from './support/live';
import { waitForUniverse } from './support/universe';

test.use({ reducedMotion: 'reduce' });

/* eslint-disable-next-line no-empty-pattern -- Playwright needs the fixtures argument destructured even when none is used. */
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'webgpu' && testInfo.project.name !== 'webgl2', 'runs on the webgpu and webgl2 projects');
  test.setTimeout(240_000 * SLOW);
});

const DIST = new URL('../dist/assets/', import.meta.url);

let builtAi: readonly string[] | null = null;
/**
 * The built files that hold code from src/ai (read from their source maps, once the build the tests
 * run against exists): none may load before start().
 */
function aiFiles(): readonly string[] {
  builtAi ??= readdirSync(DIST)
    .filter((name) => name.endsWith('.js.map'))
    .filter((name) => ((JSON.parse(readFileSync(new URL(name, DIST), 'utf8')) as { sources?: string[] }).sources ?? []).some((s) => s.includes('/src/ai/')))
    .map((name) => name.slice(0, -'.map'.length));
  return builtAi;
}

const isModelWorker = (path: string): boolean => /\/webllm-worker-[\w-]+\.js$/u.test(path);
const isBatchWorker = (url: string): boolean => /\/batch-worker-[\w-]+\.js$/u.test(new URL(url).pathname);

interface Watch {
  /** Paths fetched from the app's own origin, in order. */
  paths: string[];
  /** Requests to a model host (there must be none). */
  modelHosts: string[];
}

/** Records every request the page makes, from before it loads. */
function watch(page: Page): Watch {
  const w: Watch = { paths: [], modelHosts: [] };
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    if (isModelHost(url.hostname)) w.modelHosts.push(request.url());
    else w.paths.push(url.pathname);
  });
  return w;
}

/** What the assistant has fetched so far: its code (by built file) and its knowledge index. */
const aiFetches = (w: Watch): string[] => w.paths.filter((p) => aiFiles().some((f) => p.endsWith(`/assets/${f}`)) || p.includes('/assets/ai/'));

/** No model host was asked anything and WebLLM's worker was never fetched. */
function expectNoModel(page: Page, w: Watch): void {
  expect(w.modelHosts).toEqual([]);
  expect([...modelRequests(page).values()].reduce((a, b) => a + b, 0)).toBe(0);
  expect(w.paths.filter(isModelWorker)).toEqual([]);
}

/** Failures the page logs on purpose elsewhere are not expected here: none at all. */
const realErrors = (errors: readonly string[]): string[] => errors.filter((e) => !/Failed to load resource/u.test(e));

async function ready(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 * SLOW });
}

/** Starts the assistant (the shell's starter loads its chunk) and asks it a question. */
function ask(page: Page, question: string): Promise<Turn> {
  return page.evaluate(async (q) => {
    const ai = await (window as unknown as KfHook).__kf.ai.start();
    return ai.ask(q);
  }, question);
}

const blocksOf = <T extends AnswerBlock['type']>(turn: Turn, type: T): Extract<AnswerBlock, { type: T }>[] => turn.blocks.filter((b): b is Extract<AnswerBlock, { type: T }> => b.type === type);
const textOf = (turn: Turn): string => blocksOf(turn, 'text').map((b) => b.text).join(' ');

/* ------------------------------------------------------------------ */
/* Loading                                                              */
/* ------------------------------------------------------------------ */

test('nothing of the assistant loads before start(); start() loads it once, on the guide', async ({ page, kf, pageErrors }) => {
  // The assistant's own chunk, its later ones and its workers (the model's, the comparison's, detection's).
  expect(aiFiles().length).toBeGreaterThanOrEqual(5);
  const w = watch(page);
  await kf.open('/');
  await ready(page);
  await page.waitForTimeout(500);
  expect(aiFetches(w)).toEqual([]);
  expect(await page.evaluate(() => typeof (window as unknown as KfHook).__kf.ai.useScripted)).toBe('undefined');

  const same = await page.evaluate(async () => {
    const hook = (window as unknown as KfHook).__kf.ai;
    const a = await hook.start();
    const b = await (window as unknown as KfHook).__kf.ai.start();
    return { same: a === b, engine: a.engine(), scripted: typeof (window as unknown as KfHook).__kf.ai.useScripted };
  });
  expect(same).toEqual({ same: true, engine: { kind: 'guide', model: null, state: 'ready' }, scripted: 'function' });
  await expect(page.locator('html')).toHaveAttribute('data-ai-engine', 'guide');
  // Its own chunk came now (and the knowledge index waits for the first question).
  expect(aiFetches(w).some((p) => /\/boot-[\w-]+\.js$/u.test(p))).toBe(true);
  expect(aiFetches(w).some((p) => p.includes('/assets/ai/'))).toBe(false);
  expectNoModel(page, w);
  expect(realErrors(pageErrors)).toEqual([]);
});

/* ------------------------------------------------------------------ */
/* The guide: commands, facts and scripture                             */
/* ------------------------------------------------------------------ */

test('"fly to Mars": the explorer opens, and the outcome is done only once it shows Mars', async ({ page, kf, pageErrors }) => {
  const w = watch(page);
  await kf.open('/');
  await ready(page);
  const result = await page.evaluate(async () => {
    const kfh = (window as unknown as KfHook).__kf;
    const ai = await kfh.ai.start();
    /** Where the explorer was each time a turn event first reported the action done. */
    let focusWhenDone: string | null | undefined;
    const off = ai.events.on('turn', ({ turn }) => {
      if (focusWhenDone === undefined && turn.blocks.some((b) => b.type === 'action' && b.status === 'done')) focusWhenDone = kfh.app.universe()?.focus ?? null;
    });
    const turn = await ai.ask('fly to Mars');
    off();
    return { turn, focusWhenDone: focusWhenDone ?? 'never', focusNow: kfh.app.universe()?.focus ?? null };
  });
  expect(result.turn.state).toBe('done');
  expect(result.turn.engine).toBe('guide');
  expect(result.turn.plan).toMatchObject({ source: 'router', intent: 'act', calls: [{ tool: 'explorer.open', args: { body: 'mars' } }] });
  expect(blocksOf(result.turn, 'action')).toMatchObject([{ tool: 'explorer.open', status: 'done', undoable: true }]);
  expect(result.focusWhenDone).toBe('mars');
  expect(result.focusNow).toBe('mars');
  // The guide says what the app reported, in its own words.
  expect(textOf(result.turn)).toContain('Mars');
  await waitForUniverse(page);
  expectNoModel(page, w);
  expect(realErrors(pageErrors)).toEqual([]);
});

test('the date: set within the span the data covers, refused outside it with the span named', async ({ page, kf, pageErrors }) => {
  const w = watch(page);
  await kf.open('/universe/earth');
  await waitForUniverse(page);
  const set = await ask(page, 'set the date to 2030-06-01');
  expect(set.state).toBe('done');
  expect(set.plan?.calls).toEqual([{ tool: 'time.date', args: { date: '2030-06-01' } }]);
  expect(blocksOf(set, 'action')).toMatchObject([{ tool: 'time.date', status: 'done' }]);
  const shown = await page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.unixMs ?? 0);
  // The clock runs on while the test reads it: within a day of midnight on the date asked.
  expect(Math.abs(shown - Date.UTC(2030, 5, 1))).toBeLessThan(86_400_000);

  const span = await page.evaluate(() => {
    const v = (window as unknown as KfHook).__kf.app.universe();
    return { startMs: v?.time.startMs ?? 0, endMs: v?.time.endMs ?? 0 };
  });
  const before = new Date(span.startMs - 400 * 86_400_000).toISOString().slice(0, 10);
  const refused = await ask(page, `set the date to ${before}`);
  expect(refused.state).toBe('done');
  expect(blocksOf(refused, 'action')).toMatchObject([{ tool: 'time.date', status: 'refused' }]);
  const text = textOf(refused);
  expect(text).toContain(new Date(span.startMs).toISOString().slice(0, 10));
  expect(text).toContain(new Date(span.endMs).toISOString().slice(0, 10));
  // Nothing moved.
  const after = await page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.unixMs ?? 0);
  expect(Math.abs(after - Date.UTC(2030, 5, 1))).toBeLessThan(86_400_000);
  expectNoModel(page, w);
  expect(realErrors(pageErrors)).toEqual([]);
});

test('a verse is a block shown from data; an escape speed and the qibla are facts with their sources', async ({ page, kf, pageErrors }) => {
  const w = watch(page);
  await kf.open('/');
  await ready(page);

  const verse = await ask(page, 'show verse 21:30');
  expect(verse.state).toBe('done');
  expect(verse.plan?.calls).toEqual([{ tool: 'cite.verse', args: { key: '21:30' } }]);
  expect(blocksOf(verse, 'verse').map((b) => b.key)).toEqual(['21:30']);
  // The block is only a key: the words come from data/quran.json, whose checksum the data store verified.
  const data = await page.evaluate(() => {
    const v = (window as unknown as KfHook).__kf.app.data.verse('21:30');
    return { translation: v.translation, verified: v.arabic.length > 0 };
  });
  const quran = JSON.parse(readFileSync(new URL('../data/quran.json', import.meta.url), 'utf8')) as { ayat: Array<{ key: string; translation: string }> };
  expect(data).toEqual({ translation: quran.ayat.find((a) => a.key === '21:30')?.translation, verified: true });
  expect(JSON.stringify(verse.blocks)).not.toContain('of one piece');

  const escape = await ask(page, 'escape speed of Mars');
  expect(escape.plan?.calls).toEqual([{ tool: 'calc.escape_speed', args: { body: 'mars' } }]);
  const facts = blocksOf(escape, 'facts').flatMap((b) => b.facts);
  const speed = facts.find((f) => f.id === 'calc.escape_speed.mars');
  expect(speed?.unit).toBe('km/s');
  expect(Number(speed?.value)).toBeCloseTo(5.03, 1);
  expect(speed?.sourceIds?.length ?? 0).toBeGreaterThan(0);
  const sources = JSON.parse(readFileSync(new URL('../data/sources.json', import.meta.url), 'utf8')) as { sources: Array<{ id: string }> };
  for (const id of speed?.sourceIds ?? []) expect(sources.sources.map((s) => s.id), id).toContain(id);

  const qibla = await ask(page, 'qibla from London');
  expect(qibla.plan?.calls).toEqual([{ tool: 'islamic.qibla', args: { lat: 51.5019, lon: -0.1187 } }]);
  const bearing = blocksOf(qibla, 'facts').flatMap((b) => b.facts).find((f) => f.id === 'qibla.bearing');
  expect(bearing?.unit).toBe('°');
  expect(Math.abs(Number(bearing?.value) - 119)).toBeLessThan(1);
  // The knowledge index came with the first question.
  expect(aiFetches(w).some((p) => p.endsWith('/assets/ai/index.json'))).toBe(true);
  expectNoModel(page, w);
  expect(realErrors(pageErrors)).toEqual([]);
});

/* ------------------------------------------------------------------ */
/* The laboratory                                                       */
/* ------------------------------------------------------------------ */

const sunMass = (page: Page): Promise<number | null> => page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.lab?.bodies.find((b) => b.id === 'sun')?.massKg ?? null);

test('"what if the Sun were twice as massive": a card that waits, nothing changed until confirmed, then the Sun at twice its mass, and undo', async ({ page, kf, pageErrors }) => {
  const w = watch(page);
  await kf.open('/universe/earth');
  await waitForUniverse(page);
  const opened = await ask(page, 'open the lab');
  expect(opened.plan?.calls).toEqual([{ tool: 'lab.open', args: {} }]);
  expect(blocksOf(opened, 'action')).toMatchObject([{ tool: 'lab.open', status: 'done' }]);
  await expect.poll(() => page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.lab?.bodies.length ?? 0), { timeout: 60_000 * SLOW }).toBe(10);
  const mass = await sunMass(page);
  expect(mass).toBeGreaterThan(1e30);

  const card = await ask(page, 'what if the Sun were twice as massive');
  expect(card.state).toBe('awaiting-confirmation');
  expect(card.plan?.calls).toEqual([{ tool: 'lab.experiment', args: { experiment: 'scale-mass', body: 'sun', factor: 2 } }]);
  const [action] = blocksOf(card, 'action');
  expect(action).toMatchObject({ tool: 'lab.experiment', status: 'awaiting', undoable: false });
  await expect(page.locator('html')).toHaveAttribute('data-ai-turn', 'awaiting-confirmation');
  await page.waitForTimeout(1000);
  expect(await sunMass(page)).toBe(mass);

  const confirmed = await page.evaluate(
    async ({ turnId, callId }) => {
      const ai = await (window as unknown as KfHook).__kf.ai.start();
      await ai.confirm(turnId, callId, true);
      return ai.turns().find((t) => t.id === turnId);
    },
    { turnId: card.id, callId: action?.callId ?? '' },
  );
  expect(confirmed?.state).toBe('done');
  expect(confirmed && blocksOf(confirmed, 'action')).toMatchObject([{ status: 'done', undoable: true }]);
  const doubled = (await sunMass(page)) ?? 0;
  expect(Math.abs(doubled / (mass ?? 1) - 2)).toBeLessThan(1e-6);

  const undone = await page.evaluate(
    async ({ turnId, callId }) => {
      const ai = await (window as unknown as KfHook).__kf.ai.start();
      await ai.undo(turnId, callId);
      return ai.turns().find((t) => t.id === turnId);
    },
    { turnId: card.id, callId: action?.callId ?? '' },
  );
  expect(undone?.blocks.at(-1)).toMatchObject({ type: 'notice', key: 'ai.mind.notice.undone' });
  await expect.poll(async () => Math.abs(((await sunMass(page)) ?? 0) / (mass ?? 1) - 1)).toBeLessThan(1e-9);
  expectNoModel(page, w);
  expect(realErrors(pageErrors)).toEqual([]);
});

/** Opens the laboratory on a copy of the solar system, through the assistant. */
async function openLab(page: Page): Promise<number> {
  await ask(page, 'open the lab');
  await expect.poll(() => page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.lab?.bodies.length ?? 0), { timeout: 60_000 * SLOW }).toBe(10);
  return (await sunMass(page)) ?? 0;
}

test('Stop straight after Confirm sends nothing; Stop while the experiment runs keeps its card and its Undo', async ({ page, kf, pageErrors }) => {
  const w = watch(page);
  await kf.open('/universe/earth');
  await waitForUniverse(page);
  const mass = await openLab(page);
  expect(mass).toBeGreaterThan(1e30);

  // Confirm, then Stop in the same task: the run never begins, and the card says it was cancelled.
  const first = await ask(page, 'What if the Sun were twice as massive?');
  const stopped = await page.evaluate(async (turnId) => {
    const ai = await (window as unknown as KfHook).__kf.ai.start();
    const confirming = ai.confirm(turnId, 'c1', true);
    ai.cancel();
    await confirming;
    return ai.turns().find((t) => t.id === turnId);
  }, first.id);
  expect(stopped?.state).toBe('cancelled');
  expect(stopped && blocksOf(stopped, 'action')).toMatchObject([{ status: 'cancelled', undoable: false }]);
  await page.waitForTimeout(1000);
  expect(await sunMass(page)).toBe(mass);

  // Stop once the command has gone: the laboratory shows the change, and its card can undo it.
  const second = await ask(page, 'What if the Sun were twice as massive?');
  const kept = await page.evaluate(async (turnId) => {
    const ai = await (window as unknown as KfHook).__kf.ai.start();
    const off = ai.events.on('turn', ({ turn }) => {
      if (turn.id !== turnId || turn.running.length === 0) return;
      off();
      // The tool has started and sent its command by the next task.
      setTimeout(() => {
        ai.cancel();
      }, 0);
    });
    await ai.confirm(turnId, 'c1', true);
    return ai.turns().find((t) => t.id === turnId);
  }, second.id);
  expect(kept?.state).toBe('cancelled');
  const [card] = kept ? blocksOf(kept, 'action') : [];
  expect(card?.status === 'done' || card?.status === 'not-confirmed', JSON.stringify(card)).toBe(true);
  expect(card?.undoable).toBe(true);
  await expect.poll(async () => ((await sunMass(page)) ?? 0) / mass, { timeout: 30_000 * SLOW }).toBeCloseTo(2, 6);
  const undone = await page.evaluate(async (turnId) => {
    const ai = await (window as unknown as KfHook).__kf.ai.start();
    await ai.undo(turnId, 'c1');
    return ai.turns().find((t) => t.id === turnId);
  }, second.id);
  expect(undone?.blocks.at(-1)).toMatchObject({ type: 'notice', key: 'ai.mind.notice.undone' });
  await expect.poll(async () => Math.abs(((await sunMass(page)) ?? 0) / mass - 1)).toBeLessThan(1e-9);
  expectNoModel(page, w);
  expect(realErrors(pageErrors)).toEqual([]);
});

test('a comparison in the laboratory changes nothing on screen: no share link, no status line', async ({ page, kf, pageErrors }) => {
  await kf.open('/universe/earth');
  await waitForUniverse(page);
  await openLab(page);
  const shown = (): Promise<{ status: unknown; share: unknown }> => page.evaluate(() => {
    const lab = (window as unknown as KfHook).__kf.app.universe()?.lab;
    return { status: lab?.status ?? null, share: lab?.share ?? null };
  });
  const before = await shown();
  const turn = await ask(page, 'compare the solar system with and without jupiter over 1 year');
  expect(turn.state).toBe('done');
  expect(turn.plan?.calls).toEqual([{ tool: 'lab.compare', args: { experiment: 'remove-body', body: 'jupiter', horizonDays: 365.25 } }]);
  expect(blocksOf(turn, 'comparison')[0]?.comparison.rows.length ?? 0).toBeGreaterThan(0);
  expect(await shown()).toEqual(before);
  await expect(page.getByTestId('lab-share-url')).toBeHidden();
  expect(realErrors(pageErrors)).toEqual([]);
});

test('a copy asked for as the laboratory resets is of the new run, not lost with the old one', async ({ page, kf, pageErrors }) => {
  await kf.open('/universe/earth');
  await waitForUniverse(page);
  await openLab(page);
  // The copy's request reaches the worker before the reset's scenario, so the worker answers it for the old run, whose answers are dropped.
  await page.evaluate(() => {
    const app = (window as unknown as KfHook).__kf.app;
    app.universeLab({ kind: 'copy' });
    app.universeLab({ kind: 'reset' });
  });
  const copied = (): Promise<string | null> =>
    page.evaluate(() => {
      const copy = (window as unknown as KfHook).__kf.app.universe()?.lab?.copy ?? null;
      return copy === null ? null : 'data' in copy ? 'data' : 'error';
    });
  await expect.poll(copied, { timeout: 60_000 * SLOW }).toBe('data');
  expect(realErrors(pageErrors)).toEqual([]);
});

test('a background comparison runs in the real batch worker and returns rows with energy errors', async ({ page, kf, pageErrors }) => {
  const w = watch(page);
  const workers: string[] = [];
  page.on('worker', (worker) => {
    workers.push(worker.url());
  });
  await kf.open('/');
  await ready(page);
  const turn = await ask(page, 'compare the solar system with and without jupiter over 1 year');
  expect(turn.state).toBe('done');
  expect(turn.plan?.calls).toEqual([{ tool: 'lab.compare', args: { experiment: 'remove-body', body: 'jupiter', horizonDays: 365.25 } }]);
  const [comparison] = blocksOf(turn, 'comparison');
  expect(comparison?.comparison.experiment).toBe('remove-body');
  expect(comparison?.comparison.rows.length ?? 0).toBeGreaterThan(0);
  const { baseline, variant } = comparison?.comparison.energyError ?? { baseline: NaN, variant: NaN };
  expect(Number.isFinite(baseline) && Number.isFinite(variant)).toBe(true);
  expect(Math.abs(baseline)).toBeLessThan(0.01);
  expect(workers.some(isBatchWorker)).toBe(true);
  // Nothing on screen changed: still the home screen.
  expect(await page.evaluate(() => (window as unknown as KfHook).__kf.app.universe())).toBeNull();
  expectNoModel(page, w);
  expect(realErrors(pageErrors)).toEqual([]);
});

test('cancel() during a background comparison stops it: the turn is cancelled and the worker ends', async ({ page, kf, pageErrors }) => {
  const w = watch(page);
  let started = 0;
  let ended = 0;
  page.on('worker', (worker) => {
    if (!isBatchWorker(worker.url())) return;
    started += 1;
    worker.on('close', () => {
      ended += 1;
    });
  });
  await kf.open('/');
  await ready(page);
  await page.evaluate(async () => {
    const ai = await (window as unknown as KfHook).__kf.ai.start();
    (window as unknown as { __kfTurn: Promise<Turn> }).__kfTurn = ai.ask('compare the solar system with and without jupiter over 100 years');
  });
  await expect.poll(() => started, { timeout: 60_000 * SLOW }).toBe(1);
  const turn = await page.evaluate(async () => {
    const ai = await (window as unknown as KfHook).__kf.ai.start();
    const at = performance.now();
    ai.cancel();
    const t = await (window as unknown as { __kfTurn: Promise<Turn> }).__kfTurn;
    return { ...t, ms: performance.now() - at };
  });
  expect(turn.state).toBe('cancelled');
  expect(turn.ms).toBeLessThan(2000);
  expect(blocksOf(turn, 'comparison')).toEqual([]);
  expect(turn.blocks.at(-1)).toMatchObject({ type: 'notice', key: 'ai.mind.notice.cancelled' });
  await expect.poll(() => ended).toBe(1);
  await expect(page.locator('html')).toHaveAttribute('data-ai-turn', 'cancelled');
  expectNoModel(page, w);
  expect(realErrors(pageErrors)).toEqual([]);
});

/* ------------------------------------------------------------------ */
/* The scripted engine: a model's plans and words through the guards    */
/* ------------------------------------------------------------------ */

const plan = (value: unknown): string => JSON.stringify(value);

test('a model plan in JSON is validated and run, and its answer cites a verse and a fact, shown as blocks', async ({ page, kf, pageErrors }) => {
  const w = watch(page);
  await kf.open('/');
  await ready(page);
  const script = [
    { format: 'json' as const, match: 'hard to leave', reply: plan({ intent: 'answer', query: 'escape speed mars', calls: [{ tool: 'calc.escape_speed', args: { body: 'mars' } }] }) },
    { format: 'text' as const, match: 'hard to leave', reply: 'Leaving Mars takes about 5.027 km/s [[fact:calc.escape_speed.mars]]. The film shows a verse about the heavens [[verse:21:30]].' },
  ];
  const turn = await page.evaluate(async (s) => {
    const hook = (window as unknown as KfHook).__kf.ai;
    await hook.start();
    await (window as unknown as KfHook).__kf.ai.useScripted(s);
    const ai = await hook.start();
    return ai.ask('Why is Mars hard to leave?');
  }, script);
  await expect(page.locator('html')).toHaveAttribute('data-ai-engine', 'scripted');
  expect(turn.state).toBe('done');
  expect(turn.engine).toBe('scripted');
  expect(turn.model).toBe('scripted');
  expect(turn.plan).toMatchObject({ source: 'model', intent: 'answer', calls: [{ tool: 'calc.escape_speed', args: { body: 'mars' } }] });
  const [text] = blocksOf(turn, 'text');
  expect(text?.knowledge).toBe('explanation');
  expect(text?.text).toContain('Leaving Mars takes about 5.027 km/s.');
  expect(text?.text).not.toContain('[[');
  expect(text?.flags ?? []).toEqual([]);
  expect(blocksOf(turn, 'verse').map((b) => b.key)).toEqual(['21:30']);
  expect(blocksOf(turn, 'facts').flatMap((b) => b.facts).some((f) => f.id === 'calc.escape_speed.mars')).toBe(true);
  expectNoModel(page, w);
  expect(realErrors(pageErrors)).toEqual([]);
});

test('a scripted answer is cleaned and flagged: Arabic, a made-up verse, an unknown citation, "proves", an unbacked number, a false claim', async ({ page, kf, pageErrors }) => {
  const w = watch(page);
  await kf.open('/');
  await ready(page);
  // Arabic script is written by code point: no Arabic in this repository's sources.
  const arabic = String.fromCodePoint(0x0627, 0x0644, 0x0645, 0x0631, 0x064a, 0x062e);
  const answer =
    'Leaving Mars takes about 5.027 km/s [[fact:calc.escape_speed.mars]]. ' +
    `Its old name was ${arabic} in some books. ` +
    'As the Quran says, “the red star was set in the sky to guide the lost travellers home”. ' +
    'See also [[verse:99:99]] and [[hadith:not-real-1]]. ' +
    'This proves the planets were made weak. ' +
    'Its day lasts 31.7 hours. ' +
    'I have flown you to Jupiter.';
  const script = [
    { format: 'json' as const, match: 'leave mars', reply: plan({ intent: 'answer', query: 'escape speed mars', calls: [{ tool: 'calc.escape_speed', args: { body: 'mars' } }] }) },
    { format: 'text' as const, match: 'leave mars', reply: answer },
  ];
  const turn = await page.evaluate(async (s) => {
    const hook = (window as unknown as KfHook).__kf.ai;
    const ai = await hook.start();
    await (window as unknown as KfHook).__kf.ai.useScripted(s);
    return ai.ask('How hard is it to leave Mars, really?');
  }, script);
  expect(turn.state).toBe('done');
  expect(turn.engine).toBe('scripted');
  const [text] = blocksOf(turn, 'text');
  expect(text?.flags).toEqual(expect.arrayContaining(['arabic-removed', 'scripture-quote', 'unknown-citation', 'banned-phrase', 'unchecked-number', 'action-claim']));
  const shown = text?.text ?? '';
  expect(shown).toContain('Leaving Mars takes about 5.027 km/s.');
  expect(Array.from(shown, (c) => c.codePointAt(0) ?? 0).some((cp) => cp >= 0x600 && cp <= 0x6ff)).toBe(false);
  expect(shown).not.toContain('red star');
  expect(shown).not.toContain('99:99');
  expect(shown).not.toContain('not-real');
  expect(shown).not.toMatch(/\bproves\b/u);
  expect(shown).toContain('31.7 hours (not checked)');
  expect(shown).not.toContain('Jupiter');
  expect(shown).not.toContain('[[');
  // The unknown citations became no blocks; the explorer was never opened.
  expect(blocksOf(turn, 'verse')).toEqual([]);
  expect(blocksOf(turn, 'hadith')).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as KfHook).__kf.app.universe())).toBeNull();
  expectNoModel(page, w);
  expect(realErrors(pageErrors)).toEqual([]);
});

test('invalid JSON from the model, then a repair the registry accepts, run against the app', async ({ page, kf, pageErrors }) => {
  const w = watch(page);
  await kf.open('/universe/earth');
  await waitForUniverse(page);
  const script = [
    { format: 'json' as const, match: 'biggest planet', reply: 'Sure! I will fly you there.', once: true },
    { format: 'json' as const, match: 'cannot be used', reply: plan({ intent: 'act', calls: [{ tool: 'explorer.fly', args: { body: 'jupiter' } }] }) },
  ];
  const turn = await page.evaluate(async (s) => {
    const ai = await (window as unknown as KfHook).__kf.ai.start();
    await (window as unknown as KfHook).__kf.ai.useScripted(s);
    return ai.ask('Take me to the biggest planet');
  }, script);
  expect(turn.state).toBe('done');
  expect(turn.plan).toMatchObject({ source: 'model', intent: 'act', calls: [{ tool: 'explorer.fly', args: { body: 'jupiter' } }] });
  expect(blocksOf(turn, 'action')).toMatchObject([{ tool: 'explorer.fly', status: 'done' }]);
  // The first reply was no plan: no fallback notice, because the repair was accepted.
  expect(turn.blocks.some((b) => b.type === 'notice' && b.key === 'ai.mind.notice.planFallback')).toBe(false);
  expect(await page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.focus)).toBe('jupiter');
  expectNoModel(page, w);
  expect(realErrors(pageErrors)).toEqual([]);
});

test('cancel stops a scripted reply mid-stream', async ({ page, kf, pageErrors }) => {
  const w = watch(page);
  await kf.open('/');
  await ready(page);
  const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
  const script = [
    { format: 'json' as const, match: 'long story', reply: plan({ intent: 'answer', query: 'stars', calls: [] }) },
    { format: 'text' as const, match: 'long story', reply: long },
  ];
  await page.evaluate(async (s) => {
    const hook = (window as unknown as KfHook).__kf;
    const ai = await hook.ai.start();
    await hook.ai.useScripted(s, { delayMs: 40 });
    (window as unknown as { __kfTurn: Promise<Turn> }).__kfTurn = ai.ask('Tell me a long story about the stars');
  }, script);
  await expect(page.locator('html')).toHaveAttribute('data-ai-turn', 'answering', { timeout: 30_000 * SLOW });
  const turn = await page.evaluate(async () => {
    const ai = await (window as unknown as KfHook).__kf.ai.start();
    // Let a few words arrive, then stop.
    await new Promise((resolve) => setTimeout(resolve, 400));
    ai.cancel();
    return (window as unknown as { __kfTurn: Promise<Turn> }).__kfTurn;
  });
  expect(turn.state).toBe('cancelled');
  expect(turn.engine).toBe('scripted');
  const shown = textOf(turn);
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.length).toBeLessThan(long.length);
  expect(turn.blocks.at(-1)).toMatchObject({ type: 'notice', key: 'ai.mind.notice.cancelled' });
  await expect(page.locator('html')).toHaveAttribute('data-ai-turn', 'cancelled');
  expectNoModel(page, w);
  expect(realErrors(pageErrors)).toEqual([]);
});
