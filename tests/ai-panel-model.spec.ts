/**
 * "Model on this device" in the assistant's panel (src/ai/ui/model.ts), against mocked model hosts
 * (tests/support/live answers them 404, a test's own route can leave them unanswered) that Chromium
 * also resolves to nothing, so no request could reach a real one (as tests/ai-engine.spec.ts):
 * - the model's size, licence and source are shown before anything is asked of a model host;
 * - Download asks a second time on an unknown connection, and nothing is fetched until it is answered;
 * - the download then fails in plain words, with Try again; Cancel stops one under way;
 * - models stored in the Cache API are listed with their sizes and deleted without asking a model host.
 * The device is canned (REPORT, through the test hook's useReport): CI has no GPU to detect.
 */
import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { VISITOR_MODELS } from '../src/ai/engine/catalogue';
import type { CapabilityReport } from '../src/ai/types';
import { ask, LIVE, openPanel, ready, realErrors, REPORT, s } from './support/ai';
import { platform, SLOW } from './support/env';
import { expect, test, type Kf, type KfHook } from './support/fixtures';
import { isModelHost, modelRequests } from './support/live';

/** As tests/ai-engine.spec.ts: Chromium resolves every model host to nothing, so no request could escape the routes. */
const MODEL_HOST_RULES = ['huggingface.co', '*.huggingface.co', 'hf.co', '*.hf.co', 'cdn.jsdelivr.net', 'raw.githubusercontent.com'].map((h) => `MAP ${h} ~NOTFOUND`).join(', ');

test.use({
  reducedMotion: 'reduce',
  launchOptions: { args: ['--enable-unsafe-webgpu', ...(platform === 'linux' ? ['--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader'] : []), `--host-resolver-rules=${MODEL_HOST_RULES}`] },
});

/* eslint-disable-next-line no-empty-pattern -- Playwright needs the fixtures argument destructured even when none is used. */
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'webgpu' && testInfo.project.name !== 'webgl2', 'runs on the webgpu and webgl2 projects');
  test.setTimeout(240_000 * SLOW);
});

const engineStrings = JSON.parse(readFileSync(new URL('../src/i18n/en.ai.engine.json', import.meta.url), 'utf8')) as Record<string, string>;

const COMPACT = VISITOR_MODELS.find((m) => m.id === 'Qwen3-1.7B-q4f16_1-MLC');
const POCKET = VISITOR_MODELS.find((m) => m.id === 'Qwen3-0.6B-q4f16_1-MLC');

const modelHostCount = (page: Page): number => [...modelRequests(page).values()].reduce((a, b) => a + b, 0);

async function openModelSection(page: Page, kf: Kf, report: CapabilityReport = REPORT): Promise<Locator> {
  await kf.open('/');
  await ready(page);
  await openPanel(page);
  await page.evaluate(async (r) => {
    await (window as unknown as KfHook).__kf.ai.useReport(r);
  }, report);
  const section = page.getByTestId('ai-model');
  await section.locator('summary').click();
  await expect(section.getByTestId('ai-suggested')).toHaveText(`Suggested for this device: ${COMPACT?.name ?? '?'}`);
  return section;
}

test('the model: size, licence and source before any download; a second question on an unknown connection; a 404 in plain words with Try again', async ({ page, kf, pageErrors }) => {
  const asked: string[] = [];
  page.on('request', (r) => {
    if (isModelHost(new URL(r.url()).hostname)) asked.push(r.url());
  });
  const section = await openModelSection(page, kf);
  await expect(section.getByTestId('ai-found')).toContainText(s('ai.ui.model.webgpuYes'));
  // 979,560,600 bytes of weights and 6,386,879 of compiled code (src/ai/engine/catalogue.ts).
  await expect(section.getByTestId('ai-model-size')).toHaveText('Download: 986 MB');
  const licence = section.getByTestId('ai-model-licence').locator('a');
  await expect(licence).toHaveText('Apache-2.0');
  await expect(licence).toHaveAttribute('href', COMPACT?.licence.url ?? '?');
  await expect(section.getByTestId('ai-model-source')).toContainText('huggingface.co');
  await expect(section).toContainText('Hugging Face and jsDelivr will see your IP address');
  await expect(section).toContainText(s('ai.ui.model.stays'));
  // No browser model here, so none is offered.
  await expect(section.getByTestId('ai-browser-model')).toBeHidden();
  // The limits come with it, and a larger model is offered with a warning.
  await expect(section.locator('.kf-ai-limits li').first()).toBeVisible();
  await section.getByTestId('ai-model-select').selectOption(VISITOR_MODELS.find((m) => m.tier === 'large' && m.needsF16)?.id ?? '?');
  await expect(section.getByTestId('ai-larger')).toHaveText(s('ai.ui.model.larger'));
  await section.getByTestId('ai-model-select').selectOption(COMPACT?.id ?? '?');
  await expect(section.getByTestId('ai-larger')).toHaveCount(0);
  expect(asked).toEqual([]);

  // Download: the connection is unknown, so it asks again first; still nothing asked of a model host.
  await section.getByTestId('ai-download').click();
  await expect(section.getByTestId('ai-metered')).toContainText('you may be on mobile data');
  await page.waitForTimeout(300);
  expect(asked).toEqual([]);
  await section.getByTestId('ai-metered-cancel').click();
  await expect(section.getByTestId('ai-metered')).toBeHidden();

  await section.getByTestId('ai-download').click();
  await section.getByTestId('ai-metered-confirm').click();
  const error = section.getByTestId('ai-model-error');
  await expect(error).toBeVisible({ timeout: 120_000 * SLOW });
  const errors = Object.entries(engineStrings).filter(([k]) => k.startsWith('ai.engine.error.')).map(([, v]) => v);
  expect(errors).toContain(await error.textContent());
  expect(asked.length + modelHostCount(page)).toBeGreaterThan(0);
  await expect(section.getByTestId('ai-retry')).toBeVisible();
  // The guide answers meanwhile, and says so.
  await expect(page.getByTestId('ai-engine')).toHaveText(new RegExp(`^The guide`, 'u'));
  // Try again fails the same way, again in words.
  await section.getByTestId('ai-retry').click();
  await expect(section.getByTestId('ai-model-error')).toBeVisible({ timeout: 120_000 * SLOW });
  expect(realErrors(pageErrors).filter((e) => !/webllm|model/iu.test(e))).toEqual([]);
});

test('the model: Cancel stops a download under way; the guide answers again', async ({ page, kf, pageErrors }) => {
  // Model hosts that never answer: the download waits until it is cancelled.
  await page.route((url) => isModelHost(url.hostname), () => undefined);
  const section = await openModelSection(page, kf);
  await section.getByTestId('ai-download').click();
  await section.getByTestId('ai-metered-confirm').click();
  const bar = section.getByTestId('ai-progress');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('role', 'progressbar');
  await expect(bar).toHaveAttribute('aria-valuenow', '0');
  await expect(section.getByTestId('ai-load-status')).toContainText(`Downloading ${COMPACT?.name ?? '?'}`);
  await expect(page.getByTestId('ai-engine')).toHaveText(`The guide, while ${COMPACT?.name ?? '?'} loads`);
  await section.getByTestId('ai-download-cancel').click();
  await expect(section.getByTestId('ai-load-cancelled')).toHaveText(s('ai.ui.model.cancelled'), LIVE);
  await expect(page.getByTestId('ai-engine')).toHaveText(s('ai.ui.engine.guide'));
  await section.getByTestId('ai-use-guide').click();
  await expect(section.getByTestId('ai-in-use')).toHaveText(s('ai.ui.model.usingGuide'));
  // And the guide answers.
  await page.getByTestId('ai-input').focus();
  const turn = await ask(page, 'Escape speed of Mars');
  await expect(turn.locator('[data-fact="calc.escape_speed.mars"]')).toBeVisible();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  expect(realErrors(pageErrors).filter((e) => !/webllm|model/iu.test(e))).toEqual([]);
});

test('stored models: those in the Cache API are listed with their sizes, and deleted without asking a model host', async ({ page, kf, pageErrors }) => {
  await kf.open('/');
  await ready(page);
  await page.evaluate(
    async ({ base }) => {
      const cache = await caches.open('webllm/model');
      const json = JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin' }] });
      await cache.put(new Request(`${base}tensor-cache.json`), new Response(json, { headers: { 'content-type': 'application/json', 'content-length': String(json.length) } }));
      await cache.put(new Request(`${base}params_shard_0.bin`), new Response(new Uint8Array(16), { headers: { 'content-length': '346000000' } }));
    },
    { base: POCKET?.weightsUrl ?? '?' },
  );
  const before = modelHostCount(page);
  await openPanel(page);
  const section = page.getByTestId('ai-model');
  await section.locator('summary').click();
  const item = section.getByTestId('ai-stored').locator(`[data-model="${POCKET?.id ?? '?'}"]`);
  await expect(item).toContainText(`${POCKET?.name ?? '?'}: 346 MB`);
  await item.getByTestId('ai-delete').click();
  await expect(section.getByTestId('ai-stored-status')).toHaveText(`${POCKET?.name ?? '?'} was deleted from this browser.`, LIVE);
  await expect(section.getByTestId('ai-stored').locator('li')).toHaveCount(0);
  const left = await page.evaluate(async (base) => {
    if (!(await caches.has('webllm/model'))) return 0;
    return (await (await caches.open('webllm/model')).keys()).filter((r) => r.url.startsWith(base)).length;
  }, POCKET?.weightsUrl ?? '?');
  expect(left).toBe(0);
  expect(modelHostCount(page)).toBe(before);
  // Asking the browser to keep stored models says what it answered.
  await section.getByTestId('ai-persist').click();
  await expect(section.locator('p', { hasText: /The browser (agreed|did not agree)/u })).toBeVisible();
  expect(realErrors(pageErrors)).toEqual([]);
});

test('the browser’s own model is offered only where detection finds it, with a warning when the browser would download it', async ({ page, kf, pageErrors }) => {
  const section = await openModelSection(page, kf, { ...REPORT, browserModel: 'downloadable' });
  const offer = section.getByTestId('ai-browser-model');
  await expect(offer).toBeVisible();
  await expect(offer).toContainText(s('ai.ui.model.browserTitle'));
  await expect(offer).toContainText(engineStrings['ai.engine.browser.downloadable'] ?? '?');
  await expect(offer.getByTestId('ai-use-browser')).toBeVisible();
  expect(realErrors(pageErrors)).toEqual([]);
});
