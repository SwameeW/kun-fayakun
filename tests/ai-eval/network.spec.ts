/*
 * One real download, unrouted (docs/AI-INTELLIGENCE.md §3, §9): in a fresh browser profile, the app
 * is opened, Ask is pressed, and Qwen3 0.6B (q4f16) is downloaded from Hugging Face and jsDelivr
 * exactly as a visitor would, through the panel. It checks, and records as raw JSON
 * (.work/ai-eval/results/network-<model>-<time>.json):
 * - nothing model-related (a model host, the model worker with WebLLM) is fetched before the visitor
 *   asks for a model;
 * - the panel shows the size before the download and progress during it;
 * - the model loads and answers one question (the local engine, this model);
 * - a reload uses the Cache API: the weights are not fetched again;
 * - deleting it with the panel's storage controls frees its Cache API entries, without a download.
 *
 * It reaches the real network, so it runs only when asked (KF_AI_EVAL=1 KF_AI_EVAL_NETWORK=1, the
 * ai-eval project), never in a normal run, and with the model hosts resolved normally (the project's
 * --host-resolver-rules are left out of this one browser).
 */
import { chromium, expect, test, type Page, type Request } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { findModel } from '../../src/ai/engine/catalogue';
import type { Intelligence } from '../../src/ai/types';
import { modelsDir } from '../../scripts/ai-eval/store';
import { env, flag } from '../support/env';
import { isModelHost, mockLiveHosts } from '../support/live';

const MODEL_ID = env('KF_AI_EVAL_NETWORK_MODEL') ?? 'Qwen3-0.6B-q4f16_1-MLC';
const ROOT = new URL('../../', import.meta.url).pathname;
const OUT_DIR = env('KF_AI_EVAL_OUT') ?? `${ROOT}.work/ai-eval/results`;
const ui = JSON.parse(readFileSync(new URL('../../src/i18n/en.ai.json', import.meta.url), 'utf8')) as Record<string, string>;

const load = (): number[] => loadavg().map((x) => Math.round(x * 100) / 100);

interface Seen {
  url: string;
  host: string;
  at: number;
  bytes: number | null;
  status: number | null;
  phase: string;
}

test('a real download from Hugging Face, as a visitor: nothing before Ask, size first, progress, an answer, the cache on reload, deletion', async ({ baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'ai-eval' || !flag('KF_AI_EVAL_NETWORK'), 'reaches the real network: KF_AI_EVAL=1 KF_AI_EVAL_NETWORK=1, ai-eval project only');
  test.setTimeout(60 * 60_000);
  const spec = findModel(MODEL_ID);
  expect(spec).not.toBeNull();
  if (!spec) return;
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const profile = `${modelsDir().replace(/\/models$/u, '')}/ai-eval/network-profile-${stamp}`;
  mkdirSync(profile, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = `${OUT_DIR}/network-${MODEL_ID}-${stamp}.json`;

  // The webgpu project's Chromium and WebGPU, but with the model hosts resolved for real.
  const args = (testInfo.project.use.launchOptions?.args ?? []).filter((a) => !a.startsWith('--host-resolver-rules'));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, args, ...(baseURL ? { baseURL } : {}) });
  let phase = 'open';
  const t0 = Date.now();
  const seen: Seen[] = [];
  const workerScripts: { url: string; phase: string }[] = [];
  /** Requests seen by the request event and by the routes (the model's worker fetches reach the context's routes). */
  const track = (r: Request, via: 'event' | 'route'): void => {
    const u = new URL(r.url());
    if (isModelHost(u.hostname) && !seen.some((s) => s.url === r.url() && s.phase === phase && s.bytes === null)) seen.push({ url: r.url(), host: u.hostname, at: Date.now() - t0, bytes: null, status: null, phase });
    if (via === 'event' && /webllm-worker/u.test(u.pathname)) workerScripts.push({ url: u.pathname, phase });
  };
  const finished = async (r: Request): Promise<void> => {
    const entry = seen.findLast((s) => s.url === r.url() && s.bytes === null);
    if (!entry) return;
    const res = await r.response().catch(() => null);
    entry.status = res?.status() ?? null;
    entry.bytes = (await r.sizes().catch(() => null))?.responseBodySize ?? null;
  };
  context.on('request', (r) => {
    track(r, 'event');
  });
  context.on('requestfinished', (r) => {
    void finished(r);
  });
  const result: Record<string, unknown> = { model: MODEL_ID, name: spec.name, downloadBytes: spec.downloadBytes, startedAt: new Date().toISOString(), profile, loadavgStart: load() };
  const save = (): void => {
    writeFileSync(outFile, `${JSON.stringify({ ...result, requests: seen, workerScripts }, null, 2)}\n`);
  };
  const ai = (page: Page): Promise<{ engine: ReturnType<Intelligence['engine']>; turn: unknown }> =>
    page.evaluate(async () => {
      const kf = (window as unknown as { __kf: { ai: { start(): Promise<Intelligence> } } }).__kf;
      const a = await kf.ai.start();
      return { engine: a.engine(), turn: JSON.parse(JSON.stringify(a.turns().at(-1) ?? null)) as unknown };
    });
  const cacheCount = (page: Page): Promise<Record<string, number>> =>
    page.evaluate(
      async ({ weights, lib }) => {
        const out: Record<string, number> = {};
        for (const name of ['webllm/model', 'webllm/config', 'webllm/wasm']) {
          if (!(await caches.has(name))) {
            out[name] = 0;
            continue;
          }
          const keys = await (await caches.open(name)).keys();
          out[name] = keys.filter((k) => k.url.startsWith(weights) || k.url === lib).length;
        }
        return out;
      },
      { weights: spec.weightsUrl, lib: spec.libUrl },
    );
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await mockLiveHosts(page);
    // tests/support/live answers model hosts 404 in every test; this one lets them through to the network.
    const through = async (route: import('@playwright/test').Route): Promise<void> => {
      track(route.request(), 'route');
      await route.continue();
    };
    await page.route((url) => isModelHost(url.hostname), through);
    await context.route((url) => isModelHost(url.hostname), through);

    await page.goto('/#/');
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 120_000 });
    await page.waitForTimeout(3000);
    result.beforeAsk = { modelHostRequests: seen.length, workerScripts: workerScripts.length };
    expect(seen, 'nothing asked of a model host before Ask').toEqual([]);

    phase = 'ask';
    await page.getByTestId('ask').click();
    await expect(page.getByTestId('ai-panel')).toBeVisible({ timeout: 60_000 });
    const section = page.getByTestId('ai-model');
    await section.locator('summary').click();
    await section.getByTestId('ai-model-select').selectOption(MODEL_ID, { timeout: 60_000 });
    const sizeText = (await section.getByTestId('ai-model-size').textContent()) ?? '';
    const buttonText = (await section.getByTestId('ai-download').textContent()) ?? '';
    await page.waitForTimeout(2000);
    result.beforeDownload = { sizeText, buttonText, modelHostRequests: seen.length, workerScripts: workerScripts.length, cache: await cacheCount(page) };
    expect(sizeText).toContain(`${Math.round(spec.downloadBytes / 1e6)} MB`);
    expect(seen, 'nothing asked of a model host before Download').toEqual([]);
    expect(workerScripts, 'the model worker (WebLLM) is not fetched before Download').toEqual([]);

    // Download: the panel may ask a second time (the connection is unknown here), then shows progress.
    phase = 'download';
    const clicked = Date.now();
    const l0 = load();
    await section.getByTestId('ai-download').click();
    const metered = section.getByTestId('ai-metered-confirm');
    const asked = await metered.isVisible({ timeout: 3000 }).catch(() => false);
    const meteredText = asked ? ((await section.getByTestId('ai-metered').textContent()) ?? '') : null;
    if (asked) await metered.click();
    const samples: { ms: number; percent: string | null; text: string | null }[] = [];
    const ready = section.getByTestId('ai-load-ready');
    const failed = section.getByTestId('ai-model-error');
    for (;;) {
      if (await ready.isVisible()) break;
      if (await failed.isVisible()) throw new Error(`the download failed: ${(await failed.textContent()) ?? ''}`);
      const bar = section.getByTestId('ai-progress');
      const status = section.getByTestId('ai-load-status');
      samples.push({
        ms: Date.now() - clicked,
        percent: (await bar.isVisible()) ? await bar.getAttribute('aria-valuenow') : null,
        text: (await status.isVisible()) ? await status.textContent() : null,
      });
      if (Date.now() - clicked > 30 * 60_000) throw new Error('the download took over 30 minutes');
      await page.waitForTimeout(200);
    }
    const loadedMs = Date.now() - clicked;
    const downloadRequests = seen.filter((s) => s.phase === 'download');
    const percents = samples.map((s) => Number(s.percent)).filter((n) => Number.isFinite(n));
    result.download = {
      meteredAsked: asked,
      meteredText,
      msClickToReady: loadedMs,
      loadavg: { before: l0, after: load() },
      requests: downloadRequests.length,
      hosts: [...new Set(downloadRequests.map((s) => s.host))],
      bytesFromModelHosts: downloadRequests.reduce((a, s) => a + (s.bytes ?? 0), 0),
      progressSamples: samples.length,
      progressMax: percents.length ? Math.max(...percents) : null,
      progressMonotonic: percents.every((p, i) => i === 0 || p >= (percents[i - 1] ?? 0)),
      statusTexts: [...new Set(samples.map((s) => s.text?.replace(/\d+(?:\.\d+)?/gu, '#') ?? ''))],
      readyText: await ready.textContent(),
      samples,
      cache: await cacheCount(page),
    };
    save();
    expect(downloadRequests.length, 'the download was seen').toBeGreaterThan(0);
    expect(samples.some((s) => s.percent !== null && Number(s.percent) > 0 && Number(s.percent) < 100), 'progress was shown during the download').toBe(true);
    const loaded = await ai(page);
    expect(loaded.engine).toEqual({ kind: 'local', model: MODEL_ID, state: 'ready' });

    // One question, answered by the model on this device.
    phase = 'answer';
    const input = page.getByTestId('ai-input');
    await input.fill('How old is the universe?');
    const asking = Date.now();
    await input.press('Enter');
    const turnLi = page.getByTestId('ai-log').locator(':scope > li').last();
    await expect(turnLi).toHaveAttribute('data-state', 'done', { timeout: 300_000 });
    const answered = await ai(page);
    const label = await turnLi.locator('[data-block="text"][data-by="model"] [data-testid="ai-author"]').first().textContent();
    result.answer = { ms: Date.now() - asking, label, turn: answered.turn, modelHostRequests: seen.filter((s) => s.phase === 'answer').length };
    save();
    expect((answered.turn as { engine?: string; model?: string } | null)?.model).toBe(MODEL_ID);
    expect(label).toContain(spec.name);

    // A reload: the files come from the Cache API; nothing is fetched again.
    phase = 'reload';
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 120_000 });
    await page.getByTestId('ask').click();
    await expect(page.getByTestId('ai-panel')).toBeVisible({ timeout: 60_000 });
    await section.locator('summary').click();
    await section.getByTestId('ai-model-select').selectOption(MODEL_ID, { timeout: 60_000 });
    const stored = section.getByTestId('ai-stored').locator(`[data-model="${MODEL_ID}"]`);
    await expect(stored).toBeVisible({ timeout: 30_000 });
    const storedText = await stored.textContent();
    await expect(section.getByTestId('ai-download')).toHaveText(ui['ai.ui.model.use']?.replace('{name}', spec.name) ?? '?', { timeout: 30_000 });
    const reloadButton = await section.getByTestId('ai-download').textContent();
    const reloadClicked = Date.now();
    await section.getByTestId('ai-download').click();
    await expect(section.getByTestId('ai-load-ready')).toBeVisible({ timeout: 300_000 });
    const reloadRequests = seen.filter((s) => s.phase === 'reload');
    result.reload = { storedText, buttonText: reloadButton, msClickToReady: Date.now() - reloadClicked, modelHostRequests: reloadRequests.length, requests: reloadRequests, cache: await cacheCount(page), engine: (await ai(page)).engine };
    save();
    expect(reloadRequests, 'a reload fetches nothing from a model host').toEqual([]);

    // Delete it with the panel's storage controls: the Cache API entries go, and nothing is downloaded to do it.
    phase = 'delete';
    const beforeDelete = await cacheCount(page);
    const estimateBefore = await page.evaluate(async () => (await navigator.storage.estimate()).usage ?? null);
    await stored.getByTestId('ai-delete').click();
    await expect(section.getByTestId('ai-stored-status')).toHaveText(`${spec.name} was deleted from this browser.`, { timeout: 120_000 });
    await expect(section.getByTestId('ai-stored').locator(`[data-model="${MODEL_ID}"]`)).toHaveCount(0);
    const afterDelete = await cacheCount(page);
    const estimateAfter = await page.evaluate(async () => (await navigator.storage.estimate()).usage ?? null);
    const deleteRequests = seen.filter((s) => s.phase === 'delete');
    result.delete = { cacheBefore: beforeDelete, cacheAfter: afterDelete, usageBytesBefore: estimateBefore, usageBytesAfter: estimateAfter, modelHostRequests: deleteRequests.length, requests: deleteRequests, engineAfter: (await ai(page)).engine, inUseText: await section.getByTestId('ai-in-use').textContent() };
    result.finishedAt = new Date().toISOString();
    result.loadavgEnd = load();
    save();
    expect(Object.values(afterDelete).every((n) => n === 0), 'no Cache API entry of the model is left').toBe(true);
    expect(deleteRequests, 'deleting downloads nothing').toEqual([]);
    process.stdout.write(`results: ${outFile}\n`);
  } finally {
    save();
    await context.close();
  }
});
