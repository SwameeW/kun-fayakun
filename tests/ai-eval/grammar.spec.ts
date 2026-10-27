/*
 * How long XGrammar takes to start for a plan's schema (WebLLM's usage.extra.grammar_init_s), for the
 * schema shapes a plan could use, on this Mac with a real model. Local only, like ./eval.spec.ts: it
 * runs only in the ai-eval project with KF_AI_EVAL_GRAMMAR=1, from the model's Cache API copy in the
 * persistent profile, or from disk through ./serve.ts.
 *
 *   KF_AI_EVAL=1 KF_AI_EVAL_GRAMMAR=1 KF_SKIP_BUILD=1 KF_PORT=4271 KF_AI_EVAL_MODEL=Qwen3-0.6B-q4f16_1-MLC \
 *     npx playwright test --project=ai-eval tests/ai-eval/grammar.spec.ts
 *
 * Writes .work/ai-eval/results/grammar-<model>.json: for each schema, its size, the grammar's start-up
 * time, the time to first token and the load average, measured twice in a row (the second shows
 * whether WebLLM reused the compiled grammar).
 */
import { chromium, expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { findModel } from '../../src/ai/engine/catalogue';
import { planSchema } from '../../src/ai/prompts';
import { allTools } from '../../src/ai/tools/index';
import type { JsonSchema, ModelSpec, ToolDefinition } from '../../src/ai/types';
import { modelsDir, readManifest } from '../../scripts/ai-eval/store';
import { serveModel } from './serve';
import { env, flag } from '../support/env';
import { isModelHost, mockLiveHosts } from '../support/live';

const MODEL_ID = env('KF_AI_EVAL_MODEL') ?? 'Qwen3-0.6B-q4f16_1-MLC';
const ROOT = new URL('../../', import.meta.url).pathname;
const OUT_DIR = env('KF_AI_EVAL_OUT') ?? `${ROOT}.work/ai-eval/results`;

const quran = JSON.parse(readFileSync(new URL('../../data/quran.json', import.meta.url), 'utf8')) as { ayat: { key: string }[] };
const hadith = JSON.parse(readFileSync(new URL('../../data/hadith.json', import.meta.url), 'utf8')) as { hadith: { id: string }[] };
const tools = allTools({ scripture: { verses: quran.ayat.map((a) => a.key as `${number}:${number}`), hadith: hadith.hadith.map((h) => h.id), withheld: [] } });
const pick = (names: readonly string[]): ToolDefinition[] => names.map((n) => tools.find((t) => t.name === n)).filter((t): t is ToolDefinition => t !== undefined);

/** Two shortlists the registry gave in the smoke run (an explorer question, a laboratory one). */
const EXPLORER = pick(['search.knowledge', 'explorer.fly', 'calc.escape_speed', 'lab.optimise', 'time.control', 'time.rate', 'calc.circular_speed', 'calc.world_facts', 'explorer.walk']);
const LAB = pick(['search.knowledge', 'explorer.fly', 'lab.experiment', 'calc.world_facts', 'lab.optimise', 'lab.state', 'calc.hohmann']);

const withoutLengths = (s: JsonSchema): JsonSchema => JSON.parse(JSON.stringify(s, (k, v: unknown) => (k === 'maxLength' ? undefined : v))) as JsonSchema;
const toolEnum = (names: readonly string[]): JsonSchema => ({
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['answer', 'act', 'clarify', 'decline'] },
    calls: { type: 'array', maxItems: 3, items: { type: 'object', properties: { tool: { type: 'string', enum: [...names] }, args: { type: 'object' } }, required: ['tool', 'args'], additionalProperties: false } },
    query: { type: 'string' },
    question: { type: 'string' },
  },
  required: ['intent', 'calls'],
  additionalProperties: false,
} as unknown as JsonSchema);

const VARIANTS: readonly { name: string; schema: JsonSchema }[] = [
  { name: 'shipping: anyOf over the explorer shortlist (9 tools)', schema: planSchema(EXPLORER) },
  { name: 'shipping, again (same schema)', schema: planSchema(EXPLORER) },
  { name: 'shipping: anyOf over the laboratory shortlist (7 tools)', schema: planSchema(LAB) },
  { name: 'explorer shortlist without maxLength', schema: withoutLengths(planSchema(EXPLORER)) },
  { name: 'tool enum (every tool) with free args', schema: toolEnum(tools.map((t) => t.name)) },
  { name: 'tool enum (every tool) with free args, again', schema: toolEnum(tools.map((t) => t.name)) },
  { name: 'anyOf over every tool', schema: planSchema(tools) },
  { name: 'anyOf over every tool, again', schema: planSchema(tools) },
];

test(`grammar start-up: ${MODEL_ID}`, async ({ baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'ai-eval' || !flag('KF_AI_EVAL_GRAMMAR'), 'runs only with KF_AI_EVAL=1 KF_AI_EVAL_GRAMMAR=1');
  const spec = findModel(MODEL_ID);
  const manifest = readManifest(MODEL_ID);
  expect(spec && manifest).toBeTruthy();
  if (!spec || !manifest) return;
  const port = new URL(baseURL ?? 'http://127.0.0.1:4173/').port;
  const profile = `${modelsDir().replace(/\/models$/u, '')}/ai-eval/profile-${port}`;
  mkdirSync(OUT_DIR, { recursive: true });
  const use = testInfo.project.use;
  const server = await serveModel(manifest);
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, args: server.args(use.launchOptions?.args ?? []), ...(baseURL ? { baseURL } : {}) });
  await context.route((url) => isModelHost(url.hostname), (route) => route.continue());
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await mockLiveHosts(page);
    await page.route((url) => isModelHost(url.hostname), (route) => route.continue());
    await page.goto('/#/');
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 120_000 });
    const results: unknown[] = [];
    const messages = [
      { role: 'system', content: 'Reply with one JSON object: {"intent": "answer", "calls": []}.' },
      { role: 'user', content: 'Hello' },
    ];
    await page.evaluate(async (s: ModelSpec) => {
      const w = window as unknown as { __kf: { ai: { start(): Promise<{ host: { load(m: ModelSpec, p: () => void, signal: AbortSignal): Promise<unknown> } }> } }; __probe?: unknown };
      const ai = await w.__kf.ai.start();
      w.__probe = await ai.host.load(s, () => undefined, new AbortController().signal);
    }, spec);
    for (const v of VARIANTS) {
      const before = loadavg().map((x) => Math.round(x * 100) / 100);
      const r = await page.evaluate(
        async ({ schema, msgs }) => {
          const w = window as unknown as { __probe: { generate(r: unknown): Promise<{ text: string; engineUsage?: { grammarInitMs: number | null; ttftMs: number } }> } };
          const t0 = performance.now();
          const out = await w.__probe.generate({ messages: msgs, format: { kind: 'json', schema }, maxTokens: 24, temperature: 0 });
          return { wallMs: performance.now() - t0, grammarInitMs: out.engineUsage?.grammarInitMs ?? null, ttftMs: out.engineUsage?.ttftMs ?? null, text: out.text };
        },
        { schema: v.schema, msgs: messages },
      );
      results.push({ name: v.name, schemaChars: JSON.stringify(v.schema).length, ...r, loadavg: before });
      process.stdout.write(`${v.name}: grammar ${r.grammarInitMs?.toFixed(0) ?? '-'} ms, ttft ${r.ttftMs?.toFixed(0) ?? '-'} ms (load ${before.join(' ')})\n`);
    }
    writeFileSync(`${OUT_DIR}/grammar-${MODEL_ID}.json`, `${JSON.stringify({ model: MODEL_ID, at: new Date().toISOString(), results }, null, 2)}\n`);
  } finally {
    await context.close().catch(() => undefined);
    await server.close();
  }
});

/*
 * What XGrammar lets a model write for a number with a range (JSON Schema minimum and maximum): the same
 * request with and without the range, the number asked for stated in the prompt. Writes
 * .work/ai-eval/results/grammar-numbers-<model>.json.
 */
const NUMBER_CASES: readonly { name: string; asked: string; prop: string; range: { minimum: number; maximum: number }; integer?: boolean }[] = [
  { name: 'eccentricity 0.3 in 0–0.95', asked: 'e is 0.3', prop: 'e', range: { minimum: 0, maximum: 0.95 } },
  { name: 'mass 1e22 kg in 1e6–1e26', asked: 'massKg is 1e22', prop: 'massKg', range: { minimum: 1e6, maximum: 1e26 } },
  { name: 'rate 86400 in ±2592000 (integer)', asked: 'rate is 86400', prop: 'rate', range: { minimum: -2_592_000, maximum: 2_592_000 }, integer: true },
  { name: 'days 1826 in 1–3650', asked: 'days is 1826', prop: 'days', range: { minimum: 1, maximum: 3650 } },
  { name: 'factor 1.1 in 0.01–100', asked: 'factor is 1.1', prop: 'factor', range: { minimum: 0.01, maximum: 100 } },
];

test(`grammar number ranges: ${MODEL_ID}`, async ({ baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'ai-eval' || env('KF_AI_EVAL_GRAMMAR') !== 'numbers', 'runs only with KF_AI_EVAL=1 KF_AI_EVAL_GRAMMAR=numbers');
  const spec = findModel(MODEL_ID);
  const manifest = readManifest(MODEL_ID);
  expect(spec && manifest).toBeTruthy();
  if (!spec || !manifest) return;
  const port = new URL(baseURL ?? 'http://127.0.0.1:4173/').port;
  const profile = `${modelsDir().replace(/\/models$/u, '')}/ai-eval/profile-${port}-numbers`;
  mkdirSync(OUT_DIR, { recursive: true });
  const server = await serveModel(manifest);
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, args: server.args(testInfo.project.use.launchOptions?.args ?? []), ...(baseURL ? { baseURL } : {}) });
  await context.route((url) => isModelHost(url.hostname), (route) => route.continue());
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await mockLiveHosts(page);
    await page.route((url) => isModelHost(url.hostname), (route) => route.continue());
    await page.goto('/#/');
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 120_000 });
    await page.evaluate(async (s: ModelSpec) => {
      const w = window as unknown as { __kf: { ai: { start(): Promise<{ host: { load(m: ModelSpec, p: () => void, signal: AbortSignal): Promise<unknown> } }> } }; __probe?: unknown };
      const ai = await w.__kf.ai.start();
      w.__probe = await ai.host.load(s, () => undefined, new AbortController().signal);
    }, spec);
    const results: unknown[] = [];
    for (const c of NUMBER_CASES) {
      for (const ranged of [true, false]) {
        const schema = { type: 'object', properties: { [c.prop]: { type: c.integer ? 'integer' : 'number', ...(ranged ? c.range : {}) } }, required: [c.prop], additionalProperties: false };
        const msgs = [
          { role: 'system', content: `Reply with one JSON object: {"${c.prop}": number}.` },
          { role: 'user', content: `${c.asked}.` },
        ];
        const r = await page.evaluate(
          async ({ s, m }) => {
            const w = window as unknown as { __probe: { generate(r: unknown): Promise<{ text: string; engineUsage?: { grammarInitMs: number | null } }> } };
            const out = await w.__probe.generate({ messages: m, format: { kind: 'json', schema: s }, maxTokens: 40, temperature: 0 });
            return { text: out.text, grammarInitMs: out.engineUsage?.grammarInitMs ?? null };
          },
          { s: schema, m: msgs },
        );
        results.push({ name: c.name, ranged, reply: r.text, grammarInitMs: r.grammarInitMs, loadavg: loadavg().map((x) => Math.round(x * 100) / 100) });
        process.stdout.write(`${c.name} ${ranged ? 'with' : 'without'} the range: ${r.text}\n`);
      }
    }
    writeFileSync(`${OUT_DIR}/grammar-numbers-${MODEL_ID}.json`, `${JSON.stringify({ model: MODEL_ID, at: new Date().toISOString(), results }, null, 2)}\n`);
  } finally {
    await context.close().catch(() => undefined);
    await server.close();
  }
});
