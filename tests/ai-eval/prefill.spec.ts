/*
 * The prompt's chunk on real models (src/ai/engine/prefill.ts, docs/AI-INTELLIGENCE.md §6), on this
 * Mac's GPU. Local only, like ./eval.spec.ts: it runs only in the ai-eval project with
 * KF_AI_EVAL_PREFILL=1, from the models' Cache API copies in the persistent profile.
 *
 *   KF_AI_EVAL=1 KF_AI_EVAL_PREFILL=1 KF_SKIP_BUILD=1 KF_PORT=4271 \
 *     npx playwright test --project=ai-eval tests/ai-eval/prefill.spec.ts
 *
 * Through the engine host the app uses (each load a new worker), it checks what the unit tests
 * (tests/unit/ai-prefill.spec.ts) cannot without a GPU:
 * - a long conversation near the context window (over 3,000 tokens of 4,096) is read in the
 *   setting's chunks and answered (the planet it asks about named), as it is read as compiled; at
 *   temperature 0 the two replies are written down side by side, not required to be the same: the
 *   chunks change the order of the GPU's sums, and a near tie between two tokens can go the other way.
 *   A short prompt, one chunk either way, must give the same reply;
 * - a generation stopped while the model reads that prompt ends as aborted, leaves no crash marker,
 *   and the next one gives the same reply as before the stop;
 * - a model switched to (KF_AI_EVAL_SWITCH_TO, a new pipeline) and the first model loaded again (a new
 *   worker) report the setting in effect, and answer.
 * KF_AI_EVAL_MODEL (default Qwen3-1.7B) and KF_AI_EVAL_PREFILL_CHUNK (default: the model's own
 * setting) choose the model and the chunk. Writes .work/ai-eval/results/prefill-probe-<model>.json.
 */
import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { findModel } from '../../src/ai/engine/catalogue';
import { prefillFor, type PrefillSetting } from '../../src/ai/engine/prefill';
import type { ChatMessage, GenerateResult, ModelSpec } from '../../src/ai/types';
import { modelsDir, readManifest } from '../../scripts/ai-eval/store';
import { env, flag } from '../support/env';
import { isModelHost, mockLiveHosts } from '../support/live';
import { serveModel } from './serve';

const MODEL_ID = env('KF_AI_EVAL_MODEL') ?? 'Qwen3-1.7B-q4f16_1-MLC';
const SWITCH_ID = env('KF_AI_EVAL_SWITCH_TO') ?? 'Qwen3.5-4B-q4f16_1-MLC';
const ROOT = new URL('../../', import.meta.url).pathname;
const OUT_DIR = env('KF_AI_EVAL_OUT') ?? `${ROOT}.work/ai-eval/results`;

const load = (): number[] => loadavg().map((x) => Math.round(x * 100) / 100);

/** A conversation of about 3,600 tokens: plain sentences about the solar system, six earlier turns, then the question. */
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

/** How many characters two texts share from their start (UTF-16 units). */
function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

const SHORT: ChatMessage[] = [
  { role: 'system', content: 'You explain astronomy in plain words, in at most two sentences.' },
  { role: 'user', content: 'Why is Mars red?' },
];

interface Probe {
  /** Loads `id` through the engine host with `prefill` (null: the model's own), as the app's next load would. */
  loadWith(id: string, prefill: PrefillSetting | null): Promise<{ ms: number; prefill: unknown }>;
  generate(messages: readonly ChatMessage[], abortAfterMs?: number): Promise<{ result: GenerateResult; wallMs: number; marker: string | null }>;
  unload(): Promise<void>;
}

function probe(page: Page): Probe {
  return {
    async loadWith(id, prefill) {
      const spec = findModel(id) as ModelSpec;
      return page.evaluate(
        async ({ s, p }) => {
          const w = window as unknown as {
            __kf: { ai: { start(): Promise<{ host: { load(m: ModelSpec, onProgress: () => void, signal: AbortSignal): Promise<unknown> } }>; evaluate(o: unknown): Promise<void> } };
            __probe?: { unload(): Promise<void>; prefill: unknown } | null;
          };
          const ai = await w.__kf.ai.start();
          await w.__kf.ai.evaluate(p ? { router: 'first', prefill: p } : { router: 'first' });
          const t0 = performance.now();
          const engine = (await ai.host.load(s, () => undefined, new AbortController().signal)) as { unload(): Promise<void>; prefill: unknown };
          w.__probe = engine;
          return { ms: performance.now() - t0, prefill: engine.prefill };
        },
        { s: spec, p: prefill },
      );
    },
    generate(messages, abortAfterMs) {
      return page.evaluate(
        async ({ msgs, after }) => {
          const w = window as unknown as { __probe: { generate(r: unknown): Promise<GenerateResult> } };
          const controller = new AbortController();
          if (after !== undefined) {
            setTimeout(() => {
              controller.abort();
            }, after);
          }
          const t0 = performance.now();
          const result = await w.__probe.generate({ messages: msgs, format: { kind: 'text' }, maxTokens: 64, temperature: 0, signal: controller.signal });
          return { result, wallMs: performance.now() - t0, marker: localStorage.getItem('kf.ai.crash') };
        },
        { msgs: messages, after: abortAfterMs },
      );
    },
    async unload() {
      await page.evaluate(async () => {
        const w = window as unknown as { __probe?: { unload(): Promise<void> } | null };
        await w.__probe?.unload();
        w.__probe = null;
      });
    },
  };
}

test(`prefill chunk on real models: ${MODEL_ID}, then ${SWITCH_ID}`, async ({ baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'ai-eval' || !flag('KF_AI_EVAL_PREFILL'), 'runs only with KF_AI_EVAL=1 KF_AI_EVAL_PREFILL=1');
  test.setTimeout(30 * 60_000);
  const spec = findModel(MODEL_ID);
  const other = findModel(SWITCH_ID);
  const manifest = readManifest(MODEL_ID);
  expect(spec && other && manifest).toBeTruthy();
  if (!spec || !other || !manifest) return;
  const asked = env('KF_AI_EVAL_PREFILL_CHUNK');
  const setting: PrefillSetting = asked === undefined ? prefillFor(spec) : { chunkTokens: Number(asked), yieldBetween: env('KF_AI_EVAL_PREFILL_YIELD') === '1' };
  expect(setting.chunkTokens, 'a chunk to compare with the compiled one').not.toBeNull();
  const compiled: PrefillSetting = { chunkTokens: null, yieldBetween: false };

  const port = new URL(baseURL ?? 'http://127.0.0.1:4173/').port;
  const profile = `${modelsDir().replace(/\/models$/u, '')}/ai-eval/profile-${port}`;
  mkdirSync(OUT_DIR, { recursive: true });
  const server = await serveModel(manifest);
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, args: server.args(testInfo.project.use.launchOptions?.args ?? []), ...(baseURL ? { baseURL } : {}) });
  await context.route((url) => isModelHost(url.hostname), (route) => route.continue());
  const pageErrors: string[] = [];
  const out: Record<string, unknown> = { model: MODEL_ID, switchTo: SWITCH_ID, setting, startedAt: new Date().toISOString(), loadavgStart: load() };
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await mockLiveHosts(page);
    await page.route((url) => isModelHost(url.hostname), (route) => route.continue());
    await page.goto('/#/');
    await page.evaluate(() => {
      localStorage.clear();
    });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 120_000 });
    const p = probe(page);
    const conversation = longConversation();

    // As compiled: the reference replies.
    const asCompiled = await p.loadWith(MODEL_ID, compiled);
    const refLong = await p.generate(conversation);
    const refShort = await p.generate(SHORT);
    await p.unload();

    // In the setting's chunks: the same replies, the long one stopped while it is read and asked again.
    const chunked = await p.loadWith(MODEL_ID, setting);
    const long = await p.generate(conversation);
    const short = await p.generate(SHORT);
    const stopped = await p.generate(conversation, 150);
    const again = await p.generate(conversation);
    await p.unload();

    // A model switched to: a new pipeline, the setting made on it.
    const switched = await p.loadWith(SWITCH_ID, setting);
    const switchedShort = await p.generate(SHORT);
    await p.unload();

    // The first model again (a new worker): the setting again.
    const reloaded = await p.loadWith(MODEL_ID, setting);
    const reloadedShort = await p.generate(SHORT);
    await p.unload();

    const view = (g: { result: GenerateResult; wallMs: number; marker: string | null }): Record<string, unknown> => ({ text: g.result.text, finish: g.result.finish, promptTokens: g.result.promptTokens, outputTokens: g.result.outputTokens, ttftMs: g.result.engineUsage?.ttftMs ?? null, prefillTokensPerS: g.result.engineUsage?.prefillTokensPerS ?? null, prefill: g.result.engineUsage?.prefill ?? null, wallMs: Math.round(g.wallMs), marker: g.marker });
    Object.assign(out, {
      asCompiled: { load: asCompiled, long: view(refLong), short: view(refShort) },
      chunked: { load: chunked, long: view(long), short: view(short), stopped: view(stopped), again: view(again) },
      switched: { load: switched, short: view(switchedShort) },
      reloaded: { load: reloaded, short: view(reloadedShort) },
      sameLong: long.result.text === refLong.result.text,
      // Where the two replies to the long conversation part, in characters (their length when the same).
      sameLongPrefixChars: commonPrefix(long.result.text, refLong.result.text),
      sameShort: short.result.text === refShort.result.text,
      sameAfterStop: again.result.text === long.result.text,
      loadavgEnd: load(),
      unexpectedRequests: server.unexpected,
      pageErrors,
    });
    writeFileSync(`${OUT_DIR}/prefill-probe-${MODEL_ID}.json`, `${JSON.stringify(out, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ sameLong: out.sameLong, sameShort: out.sameShort, sameAfterStop: out.sameAfterStop, longPrompt: long.result.promptTokens, ttftCompiled: refLong.result.engineUsage?.ttftMs, ttftChunked: long.result.engineUsage?.ttftMs, stopped: stopped.result.finish })}\n`);

    expect(refLong.result.promptTokens, 'the long conversation is near the 4,096-token window').toBeGreaterThan(3000);
    expect(long.result.promptTokens).toBe(refLong.result.promptTokens);
    expect(refLong.result.promptTokens + 64).toBeLessThanOrEqual(spec.contextTokens);
    for (const g of [refLong, refShort, long, short, again, switchedShort, reloadedShort]) expect(g.result.finish, g.result.text).toBe('stop');
    expect((asCompiled.prefill as { outcome: string }).outcome).toBe('off');
    for (const l of [chunked, switched, reloaded]) expect(l.prefill).toMatchObject({ outcome: 'set', chunkTokens: setting.chunkTokens, yieldBetween: setting.yieldBetween });
    for (const g of [long, short, stopped, again, switchedShort, reloadedShort]) expect(g.result.engineUsage?.prefill?.chunkAtGeneration ?? setting.chunkTokens).toBe(setting.chunkTokens);
    // Stopped while it read the prompt: aborted, and nothing left that would read as a crash next time.
    expect(stopped.result.finish).toBe('abort');
    for (const g of [refLong, long, stopped, again, reloadedShort]) expect(g.marker).toBeNull();
    // The long conversation is answered either way; a prompt of one chunk either way gives the same reply; a stop changes nothing after it.
    for (const g of [refLong, long, again]) expect(g.result.text, 'the planet the question is about').toContain('Uranus');
    expect(short.result.text, 'a short prompt (one chunk either way), chunked against compiled').toBe(refShort.result.text);
    expect(again.result.text, 'after a stop').toBe(long.result.text);
    expect(server.unexpected).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    writeFileSync(`${OUT_DIR}/prefill-probe-${MODEL_ID}.json`, `${JSON.stringify(out, null, 2)}\n`);
    await context.close().catch(() => undefined);
    await server.close();
  }
});
