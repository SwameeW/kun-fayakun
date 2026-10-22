/**
 * One smoke test per playable chapter, plus the intro disclaimer and the
 * Sources page. Expected scripture and wording are read from data/ and
 * docs/SPEC.md on disk, never typed here.
 */
import { expectVersesVerbatim } from './support/arabic';
import { expectCanvasNotBlank } from './support/canvas';
import {
  PLANCK_CREDIT,
  PLAYABLE_CHAPTERS,
  chapterContent,
  normalizeSpace,
  overlayVisibleAt,
  quranFile,
  specDisclaimer,
  visibleTime,
} from './support/data';
import type { Cue } from '../src/core/types';
import { flag } from './support/env';
import { expect, test } from './support/fixtures';

type VerseCue = Extract<Cue, { type: 'verse' }>;

const LAYERS: readonly string[] = ['layer-text', 'layer-scholarly', 'layer-science'];

/**
 * Sahih Muslim 2789 must never be referenced (docs/CONTRACTS.md, hard rule 3):
 * as a sunnah.com key or URL (muslim:2789, muslim/2789, also with a letter
 * suffix such as 2789a), a hadith id (muslim-2789) or a citation (Muslim 2789).
 */
const EXCLUDED_HADITH = /muslim[\s:/_-]*2789(?!\d)/iu;

test('renderer backend comes up and is recorded', async ({ page, kf, forceWebGL }, testInfo) => {
  await kf.open('/');
  await expect(page.locator('html')).toHaveAttribute('data-backend', /^(webgpu|webgl2)$/u, {
    timeout: 60_000,
  });
  const backend = await kf.htmlData('backend');
  const tier = await kf.htmlData('tier');
  const adapter = await page.evaluate(async () => {
    if (!('gpu' in navigator)) return 'navigator.gpu missing';
    const found = await navigator.gpu.requestAdapter();
    return found ? `${found.info.vendor} ${found.info.architecture}`.trim() : 'no adapter';
  });
  const summary = `backend=${backend ?? '?'} tier=${tier ?? '?'} webgpuAdapter=${adapter}`;
  testInfo.annotations.push({ type: 'renderer', description: summary });
  console.log(`[${testInfo.project.name}] ${summary}`);

  if (forceWebGL) expect(backend).toBe('webgl2');
  else if (flag('EXPECT_WEBGPU')) expect(backend).toBe('webgpu');
});

for (const chapter of PLAYABLE_CHAPTERS) {
  test(`${chapter.id}: renders, shows three layers in order and verses verbatim`, async ({
    page,
    kf,
    pageErrors,
  }) => {
    const content = chapterContent(chapter.id);
    const t = visibleTime(content);
    await kf.openChapter(chapter.id, { autoplay: true, t });

    await expectCanvasNotBlank(page);
    await expect(page.getByTestId('error')).toBeHidden();

    // While the Planck map is up, its DOM colour scale and credit must be too.
    if (overlayVisibleAt(content, 'cmb-legend', t)) {
      const legend = page.getByTestId('cmb-legend');
      await expect(legend, `cmb-legend shown at t=${t}`).toBeVisible();
      await expect(legend).toContainText(PLANCK_CREDIT);
    }

    await kf.ensurePanelOpen();
    const panel = page.getByTestId('panel');
    const order = await panel
      .locator('[data-testid^="layer-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''));
    expect(order.filter((id) => LAYERS.includes(id)), 'panel layer order').toEqual(LAYERS);
    for (const layer of LAYERS) await expect(panel.getByTestId(layer)).toBeVisible();

    await expectVersesVerbatim(page, content);
    const screens = ['loading', 'error'].flatMap((id) => [
      `[data-testid="${id}"][lang|="ar"]`,
      `[data-testid="${id}"] [lang|="ar"]`,
    ]);
    await expect(page.locator(screens.join(', ')), 'no scripture on loading or error screens').toHaveCount(0);
    expect(await page.content()).not.toMatch(EXCLUDED_HADITH);

    // The cinematic verse overlay renders separately from the panel: land inside
    // each verse cue and check the overlay shows that ayah whole and verbatim.
    const verseCues = content.cues.filter((cue): cue is VerseCue => cue.type === 'verse');
    for (const cue of verseCues) {
      // Via about:blank so the deep link is a fresh load, not a same-document hash change.
      await page.goto('about:blank');
      await kf.openChapter(chapter.id, { autoplay: true, t: cue.t + 1 });
      const arabic = page.getByTestId('verse-overlay').locator(`[data-verse="${cue.key}"] [lang="ar"]`);
      await expect(arabic, `verse overlay shows ${cue.key} at t=${cue.t + 1}`).toBeAttached({ timeout: 30_000 });
      await expectVersesVerbatim(page, content);
      expect(await page.content()).not.toMatch(EXCLUDED_HADITH);
    }

    expect(pageErrors).toEqual([]);
  });
}

test('intro shows the exact disclaimer', async ({ page, kf, pageErrors }) => {
  await kf.open('/');
  const intro = page.getByTestId('intro');
  await expect(intro).toBeVisible();
  await expect(intro.getByTestId('disclaimer')).toHaveText(specDisclaimer());
  expect(pageErrors).toEqual([]);
});

test('sources page shows the Tanzil copyright block, Planck credit and disclaimer', async ({
  page,
  kf,
  pageErrors,
}) => {
  await kf.open('/sources');
  const sources = page.getByTestId('sources-page');
  await expect(sources).toBeVisible();

  const text = normalizeSpace((await sources.textContent()) ?? '');
  const copyright = normalizeSpace(quranFile().meta.tanzilCopyright);
  expect(copyright.length, 'data/quran.json has a Tanzil copyright block').toBeGreaterThan(0);
  expect(text.includes(copyright), 'Tanzil copyright block shown verbatim').toBe(true);
  await expect(sources.locator('a[href*="tanzil.net"]').first()).toBeVisible();
  expect(text.includes(PLANCK_CREDIT), `credit "${PLANCK_CREDIT}" shown`).toBe(true);
  expect(text.includes(specDisclaimer()), 'disclaimer shown').toBe(true);
  expect(pageErrors).toEqual([]);
});
