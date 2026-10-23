/**
 * "Each in an orbit" (docs/SPEC.md, Chapter 7): the visitor-led letter analysis opens and
 * closes by keyboard, reads the seven base letters both ways (the same sequence), holds the
 * film while it is open (no cue scrolls it away, the chapter cannot end under it), owns its
 * keys, fits desktop and both phone orientations, glides its pairs (or, with reduced motion,
 * steps them), dims the scene gently, underlines the three words without touching the verse
 * text, and passes axe inline and as a layer.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { canvasStats } from './support/canvas';
import { chapterContent, normalizeSpace, quranByKey } from './support/data';
import { expect, test, type Kf, type KfHook } from './support/fixtures';

const NAMES = ['kāf', 'lām', 'fāʾ', 'alif maqṣūra', 'fāʾ', 'lām', 'kāf'];
const OPEN_NAME = 'Explore the letters of this phrase';
const HELD_TEXT = 'Film held while the letter analysis is open';

interface Snapshot {
  time: number;
  state: string;
  chapter: string | null;
  held: boolean;
  paused: boolean;
  mode: string;
  scrollTop: number;
}

const snapshot = (page: Page): Promise<Snapshot> =>
  page.evaluate(() => {
    const { app } = (window as unknown as KfHook).__kf;
    const body = document.querySelector('[data-testid="panel"] .kf-panel-body');
    return { time: app.time, state: app.state, chapter: app.chapter, held: app.held, paused: app.paused, mode: app.mode, scrollTop: body?.scrollTop ?? -1 };
  });

/** Opens Chapter 7 at t, opens the panel and then the analysis; resolves once it has faded in. */
async function openAnalysis(page: Page, kf: Kf, t: number): Promise<Locator> {
  await kf.openChapter('ch07', { autoplay: true, t });
  await kf.ensurePanelOpen();
  const opener = page.getByRole('button', { name: OPEN_NAME });
  await opener.scrollIntoViewIfNeeded();
  await opener.click();
  const region = page.getByTestId('discovery');
  await expect(region).toHaveClass(/is-open/);
  await expect(region).toBeVisible();
  // Faded in fully (axe measures contrast through opacity).
  await expect.poll(() => region.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  return region;
}

test('the letter analysis opens by keyboard, reads both ways and closes with Escape', async ({ page, kf }) => {
  const content = chapterContent('ch07');
  await kf.openChapter('ch07', { autoplay: true, t: 150 });
  await kf.ensurePanelOpen();
  const opener = page.getByRole('button', { name: OPEN_NAME });
  await opener.scrollIntoViewIfNeeded();
  await opener.focus();
  await page.keyboard.press('Enter');
  const region = page.getByTestId('discovery');
  await expect(region).toBeVisible();
  await expect(opener).toHaveAttribute('aria-expanded', 'true');

  // Seven tiles, each named with its position and its mirrored partner; real DOM text.
  const tiles = region.locator('.kf-discovery-tile');
  await expect(tiles).toHaveCount(7);
  await expect(tiles.nth(0)).toBeFocused();
  await expect(tiles.nth(0)).toHaveAttribute('aria-label', 'kāf, letter 1 of 7, pairs with letter 7');
  await expect(tiles.nth(3)).toHaveAttribute('aria-label', 'alif maqṣūra, letter 4 of 7, the centre');
  for (const letter of await region.locator('.kf-discovery-letter').all()) {
    await expect(letter).toHaveAttribute('lang', 'ar');
    await expect(letter).toHaveAttribute('dir', 'rtl');
    await expect(letter).toHaveAttribute('translate', 'no');
  }

  // Arrow keys move the one light (Left is the next letter: the tiles run right to left) and focus with it.
  await page.keyboard.press('ArrowLeft');
  await expect(tiles.nth(1)).toBeFocused();
  await expect(tiles.nth(1)).toHaveClass(/is-lit/);
  await expect(region.locator('.kf-discovery-live')).toHaveText('Letter 2 of 7: lām.');
  await page.keyboard.press('End');
  await expect(tiles.nth(6)).toBeFocused();

  // Both readings are listed as letter names, and they are the same sequence.
  const readings = region.locator('.kf-discovery-readings dd');
  await expect(readings.nth(0)).toHaveText(NAMES.join(', '));
  await expect(readings.nth(1)).toHaveText([...NAMES].reverse().join(', '));
  const readLtr = region.getByRole('button', { name: 'Read left to right' });
  await readLtr.click();
  await expect(region.locator('.kf-discovery-live')).toContainText('Left to right');
  // The automatic reading never takes focus from where the visitor left it.
  await page.waitForTimeout(1500);
  await expect(readLtr).toBeFocused();

  // The analysis is labelled as such.
  await expect(region).toContainText('This is not the Quranic text as written.');

  // The verses in the text layer are untouched while it runs.
  const ayat = quranByKey();
  for (const key of ['36:40', '21:33'] as const) {
    const entry = ayat.get(key);
    const article = page.locator(`[data-verse="${key}"] [lang="ar"]`).first();
    if ((await article.count()) > 0 && entry) await expect(article).toHaveText(normalizeSpace(entry.arabic));
  }
  expect(content.panel.discovery).toBe('kullun-fi-falak');

  // Escape closes it and returns focus to the button that opened it.
  await tiles.nth(0).focus();
  await page.keyboard.press('Escape');
  await expect(region).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(opener).toHaveAttribute('aria-expanded', 'false');
});

test('the letter analysis has no accessibility violations', async ({ page, kf }) => {
  await openAnalysis(page, kf, 150);
  const results = await new AxeBuilder({ page }).include('[data-testid="discovery"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});

test('the film is held while the analysis is open: no cue scrolls it away and the chapter cannot end', async ({ page, kf }) => {
  test.setTimeout(180_000);
  // Across the science panel cue at t=162.
  const region = await openAnalysis(page, kf, 157);
  await expect(page.getByTestId('film-held')).toHaveText(HELD_TEXT);
  const before = await snapshot(page);
  expect(before.held).toBe(true);
  expect(before.time, 'the hold began before the panel cue at 162 s').toBeLessThan(161.5);
  await page.waitForTimeout(6000);
  const during = await snapshot(page);
  expect(during.time).toBeCloseTo(before.time, 1);
  expect(during.state).toBe('playing');
  expect(during.scrollTop).toBe(before.scrollTop);
  expect(await region.evaluate((el) => el.isConnected)).toBe(true);
  await expect(region).toBeVisible();

  // Closing lets the film go on, from where it was held.
  await region.getByRole('button', { name: 'Close' }).click();
  await expect(region).toBeHidden();
  await expect(page.getByTestId('film-held')).toHaveText('');
  await expect.poll(async () => (await snapshot(page)).time, { timeout: 10_000 }).toBeGreaterThan(before.time + 0.5);

  // Across the chapter's end at t=172: no outro starts and the next chapter never loads.
  const end = await openAnalysis(page, kf, 167);
  const nearEnd = await snapshot(page);
  expect(nearEnd.time, 'the hold began before the end at 172 s').toBeLessThan(171.5);
  await page.waitForTimeout(6000);
  const after = await snapshot(page);
  expect(after.state).not.toBe('outro');
  expect(after.chapter).toBe('ch07');
  expect(after.time).toBeCloseTo(nearEnd.time, 1);
  await expect(page.locator('html')).toHaveAttribute('data-state', 'playing');
  await expect(end).toBeVisible();
});

test('an explicit seek or collapsing the panel closes the analysis and releases the film', async ({ page, kf }) => {
  const region = await openAnalysis(page, kf, 150);
  expect((await snapshot(page)).held).toBe(true);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.seek(120);
  });
  await expect(region).toBeHidden();
  expect((await snapshot(page)).held).toBe(false);
  await expect(page.getByRole('button', { name: OPEN_NAME })).toHaveAttribute('aria-expanded', 'false');

  const opener = page.getByRole('button', { name: OPEN_NAME });
  await opener.scrollIntoViewIfNeeded();
  await opener.click();
  await expect(region).toHaveClass(/is-open/);
  expect((await snapshot(page)).held).toBe(true);
  await page.getByTestId('panel-toggle').click();
  await expect(region).toBeHidden();
  expect((await snapshot(page)).held).toBe(false);
});

test('keys pressed inside the analysis never reach the film shortcuts', async ({ page, kf }) => {
  const region = await openAnalysis(page, kf, 150);
  const before = await snapshot(page);
  await region.getByRole('button', { name: 'Read right to left' }).focus();
  for (const key of ['p', 'ArrowRight', 'e', 'Shift+ArrowRight', 'ArrowLeft']) await page.keyboard.press(key);
  await page.waitForTimeout(800);
  const after = await snapshot(page);
  // P showed the pairs here instead of toggling the panel; the arrows moved the light, not the chapter.
  await expect(page.getByTestId('layer-text')).toBeVisible();
  expect(after.chapter).toBe('ch07');
  expect(after.mode).toBe('cinematic');
  expect(after.paused).toBe(before.paused);
  expect(after.time).toBeCloseTo(before.time, 1);
  await expect(page.locator('html')).toHaveAttribute('data-chapter', 'ch07');
  await expect(region).toBeVisible();
});

test('the mirrored pairs glide toward the centre and meet it with a soft ring', async ({ page, kf }) => {
  const region = await openAnalysis(page, kf, 150);
  const tiles = region.locator('.kf-discovery-tile');
  const rest = await tiles.nth(0).evaluate((el) => getComputedStyle(el).transform);
  await region.getByRole('button', { name: 'Show the mirrored pairs' }).click();
  await expect(tiles.nth(0)).toHaveClass(/is-gliding/);
  await expect(region.locator('.kf-discovery-live')).toHaveText('Letters 1 and 7 are both kāf.');
  // Mid-glide the transform is neither where it started nor (yet) still.
  await page.waitForTimeout(250);
  const mid = await tiles.nth(0).evaluate((el) => getComputedStyle(el).transform);
  await page.waitForTimeout(200);
  const later = await tiles.nth(0).evaluate((el) => getComputedStyle(el).transform);
  expect(mid).not.toBe(rest);
  expect(later).not.toBe(mid);
  // Both letters of the pair move, toward each other.
  const x = (m: string): number => Number(/matrix\(([^)]+)\)/u.exec(m)?.[1]?.split(',')[4] ?? Number.NaN);
  const partner = await tiles.nth(6).evaluate((el) => getComputedStyle(el).transform);
  expect(Math.abs(x(later))).toBeLessThan(Math.abs(x(rest)));
  expect(x(partner)).toBeLessThan(0);
  // The meeting ring is eased over at least 0.6 s, at low intensity.
  const centre = tiles.nth(3);
  await expect(centre).toHaveClass(/is-meeting/, { timeout: 3000 });
  const ring = await centre.evaluate((el) => {
    const style = getComputedStyle(el, '::after');
    return { duration: Number.parseFloat(style.transitionDuration), opacity: Number.parseFloat(style.opacity) };
  });
  expect(ring.duration).toBeGreaterThanOrEqual(0.6);
  expect(ring.opacity).toBeLessThanOrEqual(0.8);
  // After the three pairs, the centre is named.
  await expect(region.locator('.kf-discovery-live')).toHaveText('Letter 4, alif maqṣūra, is the centre.', { timeout: 10_000 });
});

test('opening the analysis dims the scene gently, never in a step', async ({ page, kf }) => {
  test.setTimeout(180_000);
  // The young Sun in its lit disk: the brightest wide view of the chapter.
  await kf.openChapter('ch07', { autoplay: true, t: 30 });
  await kf.ensurePanelOpen();
  const opener = page.getByRole('button', { name: OPEN_NAME });
  await opener.scrollIntoViewIfNeeded();
  // Let the chapter's own fade-in finish (it rises at a limited rate from black) before measuring.
  let initial = 0;
  await expect(async () => {
    const a = (await canvasStats(page)).meanLuma;
    await page.waitForTimeout(400);
    const b = (await canvasStats(page)).meanLuma;
    expect(b).toBeGreaterThan(1);
    expect(Math.abs(b - a)).toBeLessThanOrEqual(Math.max(0.2, b * 0.02));
    initial = b;
  }).toPass({ timeout: 30_000 });
  await opener.click();
  const start = Date.now();
  const samples: Array<{ ms: number; luma: number }> = [];
  while (Date.now() - start < 3500) {
    const stats = await canvasStats(page);
    samples.push({ ms: Date.now() - start, luma: stats.meanLuma });
  }
  const final = samples.at(-1)?.luma ?? initial;
  const drop = initial - final;
  expect(drop, `the scene dims: ${JSON.stringify({ initial, samples })}`).toBeGreaterThan(initial * 0.15);
  const settled = samples.find((s) => s.luma <= final + 0.1 * drop);
  expect(settled?.ms ?? 0, `time to 90% of the dim: ${JSON.stringify(samples)}`).toBeGreaterThanOrEqual(500);
});

test('the three words are underlined in place and the verse text stays byte-identical', async ({ page, kf }) => {
  const region = await openAnalysis(page, kf, 150);
  const ayat = quranByKey();
  const marked = await page.evaluate(() => {
    const highlight = CSS.highlights.get('kf-falak');
    return highlight ? [...highlight].map((range) => (range instanceof Range ? range.toString() : '')) : [];
  });
  // Three words in each of the two verses, in the panel (and on a stage card, if one shows).
  expect(marked.length).toBeGreaterThanOrEqual(6);
  for (const word of marked) expect(word).toMatch(/^\S+$/u);
  for (const key of ['21:33', '36:40'] as const) {
    const entry = ayat.get(key);
    if (!entry) throw new Error(`no ${key} in data/quran.json`);
    const texts = await page.locator(`[data-verse="${key}"] [lang="ar"]`).evaluateAll((els) => els.map((el) => el.textContent));
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text).toBe(entry.arabic);
    const words = entry.arabic.split(/\s+/u);
    expect(marked.filter((w) => words.includes(w)).length).toBeGreaterThanOrEqual(3);
  }
  await region.getByRole('button', { name: 'Close' }).click();
  await expect(region).toBeHidden();
  expect(await page.evaluate(() => CSS.highlights.has('kf-falak'))).toBe(false);
});

for (const viewport of [
  { width: 1280, height: 800, layer: false },
  { width: 390, height: 844, layer: true },
  { width: 844, height: 390, layer: true },
]) {
  test.describe(`at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('the arc fits: every tile inside the region, no horizontal overflow, 44 px targets', async ({ page, kf }) => {
      const region = await openAnalysis(page, kf, 150);
      await expect(region).toHaveClass(viewport.layer ? /is-layer/ : /^(?!.*is-layer)/);
      await page.waitForTimeout(500);
      const layout = await region.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const tiles = [...el.querySelectorAll('.kf-discovery-tile')].map((t) => t.getBoundingClientRect());
        const orbit = el.querySelector('.kf-discovery-orbit');
        const body = document.querySelector('.kf-panel-body');
        const header = document.querySelector('.kf-header')?.getBoundingClientRect();
        const timeline = document.querySelector('[data-testid="timeline"]')?.getBoundingClientRect();
        return {
          box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
          tiles: tiles.map((t) => ({ left: t.left, right: t.right, top: t.top, bottom: t.bottom, width: t.width, height: t.height })),
          region: { scroll: el.scrollWidth, client: el.clientWidth },
          orbit: { scroll: orbit?.scrollWidth ?? 0, client: orbit?.clientWidth ?? 0 },
          body: { scroll: body?.scrollWidth ?? 0, client: body?.clientWidth ?? 0 },
          page: { scroll: document.documentElement.scrollWidth, client: window.innerWidth },
          header: header?.bottom ?? 0,
          timeline: timeline?.top ?? 0,
        };
      });
      expect(layout.region.scroll).toBeLessThanOrEqual(layout.region.client);
      expect(layout.orbit.scroll).toBeLessThanOrEqual(layout.orbit.client);
      expect(layout.body.scroll).toBeLessThanOrEqual(layout.body.client);
      expect(layout.page.scroll).toBeLessThanOrEqual(layout.page.client);
      layout.tiles.forEach((t, i) => {
        expect(t.left, `tile ${i + 1} left`).toBeGreaterThanOrEqual(layout.box.left - 0.5);
        expect(t.right, `tile ${i + 1} right`).toBeLessThanOrEqual(layout.box.right + 0.5);
        expect(t.top, `tile ${i + 1} top`).toBeGreaterThanOrEqual(layout.box.top - 0.5);
        expect(t.bottom, `tile ${i + 1} bottom`).toBeLessThanOrEqual(layout.box.bottom + 0.5);
        expect(t.width).toBeGreaterThanOrEqual(43.9);
        expect(t.height).toBeGreaterThanOrEqual(43.9);
        // Right to left in reading order, never overlapping.
        const next = layout.tiles[i + 1];
        if (next) expect(next.right, `tiles ${i + 1} and ${i + 2} do not overlap`).toBeLessThanOrEqual(t.left + 0.5);
      });
      if (viewport.layer) {
        // A layer of its own between header and timeline, with the timeline down to its transport row.
        expect(layout.box.top).toBeGreaterThanOrEqual(layout.header - 1);
        expect(layout.box.bottom).toBeLessThanOrEqual(layout.timeline + 1);
        expect(layout.box.right - layout.box.left).toBeGreaterThanOrEqual(viewport.width - 1);
        await expect(page.locator('.kf-tl-track')).toBeHidden();
        await expect(page.getByTestId('film-held')).toHaveText(HELD_TEXT);
        // Translucent, so the slowed orbits stay visible behind the letters.
        const alpha = await region.evaluate((el) => Number(/rgba?\([^)]*,\s*([\d.]+)\)/u.exec(getComputedStyle(el).backgroundColor)?.[1] ?? 1));
        expect(alpha).toBeLessThan(0.7);
      }
    });

    if (viewport.layer) {
      test('the layer passes axe, and a tap or a swipe moves the light', async ({ page, kf }) => {
        const region = await openAnalysis(page, kf, 150);
        await page.waitForTimeout(500);
        const results = await new AxeBuilder({ page }).include('[data-testid="discovery"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        expect(results.violations.map((v) => v.id)).toEqual([]);

        const tiles = region.locator('.kf-discovery-tile');
        await tiles.nth(4).click();
        await expect(tiles.nth(4)).toHaveClass(/is-lit/);
        await expect(tiles.nth(4)).toBeFocused();
        // A swipe to the left reads on by one letter.
        const box = await tiles.nth(4).boundingBox();
        if (!box) throw new Error('no tile');
        const y = box.y + box.height / 2;
        await page.mouse.move(box.x + box.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 - 70, y, { steps: 4 });
        await page.mouse.up();
        await expect(tiles.nth(5)).toHaveClass(/is-lit/);
        await expect(region.locator('.kf-discovery-live')).toHaveText('Letter 6 of 7: lām.');
      });
    }
  });
}

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('pairs and readings advance only when stepped, with no gliding or travelling light', async ({ page, kf }) => {
    const region = await openAnalysis(page, kf, 150);
    const tiles = region.locator('.kf-discovery-tile');
    const live = region.locator('.kf-discovery-live');
    await expect(region.locator('.kf-discovery-light')).toBeHidden();
    const property = await tiles.nth(0).evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(property).not.toContain('transform');

    await tiles.nth(0).focus();
    await page.keyboard.press('p');
    await expect(live).toHaveText('Letters 1 and 7 are both kāf.');
    await expect(tiles.nth(0)).toHaveClass(/is-pair/);
    await expect(tiles.nth(6)).toHaveClass(/is-pair/);
    await expect(tiles.nth(0)).not.toHaveClass(/is-gliding/);
    await page.waitForTimeout(3000);
    await expect(live).toHaveText('Letters 1 and 7 are both kāf.');
    await page.keyboard.press('p');
    await expect(live).toHaveText('Letters 2 and 6 are both lām.');
    await page.keyboard.press('p');
    await expect(live).toHaveText('Letters 3 and 5 are both fāʾ.');
    await page.keyboard.press('p');
    await expect(live).toHaveText('Letter 4, alif maqṣūra, is the centre.');
    // After the centre the pairs start again from the outside.
    await page.keyboard.press('p');
    await expect(live).toHaveText('Letters 1 and 7 are both kāf.');

    // A reading steps one letter per press, never on its own.
    const read = region.getByRole('button', { name: 'Read right to left' });
    await read.click();
    await expect(tiles.nth(0)).toHaveClass(/is-lit/);
    await expect(tiles.nth(0)).not.toHaveClass(/is-pair/);
    await page.waitForTimeout(2000);
    await expect(tiles.nth(0)).toHaveClass(/is-lit/);
    await expect(tiles.nth(1)).not.toHaveClass(/is-lit/);
    await read.click();
    await expect(tiles.nth(1)).toHaveClass(/is-lit/);
    await expect(live).toHaveText('Letter 2 of 7: lām.');
  });
});
