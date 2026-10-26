/**
 * "Each in an orbit" (docs/SPEC.md, Chapter 7): the visitor-led letter analysis opens and
 * closes by keyboard, reads the seven base letters both ways (the same sequence), holds the
 * film while it is open (no cue scrolls it away, the chapter cannot end under it), owns its
 * keys, fits desktop and both phone orientations, glides its pairs (or, with reduced motion,
 * steps them), dims the scene gently, underlines the three words without touching the verse
 * text, keeps a whole vowelled verse on screen above it, never opens late (after the visitor
 * moved on from a slow asset load), and passes axe inline and as a layer.
 */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import type { VerseKey } from '../src/core/types';
import { canvasStats } from './support/canvas';
import { chapterContent, normalizeSpace, quranByKey } from './support/data';
import { expect, test, type Kf, type KfHook } from './support/fixtures';
import { NEEDS_REAL_FRAMES, NO_GPU, SLOW } from './support/env';

const NAMES = ['kāf', 'lām', 'fāʾ', 'alif maqṣūra', 'fāʾ', 'lām', 'kāf'];
const OPEN_NAME = 'Explore the letters of this phrase';
const HELD_TEXT = 'Film held while the letter analysis is open';
const ASSET_ROUTE = '**/assets/analysis/*.json';

interface AnalysisAsset {
  verses: Array<{ key: VerseKey; tokens: number[] }>;
}
const ASSET = JSON.parse(readFileSync(new URL('../public/assets/analysis/kullun-fi-falak.json', import.meta.url), 'utf8')) as AnalysisAsset;

/**
 * The cited words of a verse as stored, at the asset's word positions: whitespace tokens that
 * keep a base letter once combining marks, tatweel and the Quranic signs are set aside
 * (scripts/lib/analysis.ts counts the same way). Code points only: no Arabic in source.
 */
function citedWords(arabic: string, tokens: readonly number[]): string[] {
  const setAside = (ch: string): boolean => {
    const cp = ch.codePointAt(0) ?? 0;
    return /\p{Mn}/u.test(ch) || cp === 0x0640 || (cp >= 0x06d6 && cp <= 0x06ed);
  };
  const words = arabic.split(/\s+/u).filter((token) => Array.from(token).some((ch) => !setAside(ch)));
  return tokens.map((position) => words[position - 1] ?? `(no word ${position})`);
}

interface Mark {
  /** The verse (data-verse), and which of its Arabic elements on the page. */
  key: string;
  element: number;
  text: string;
  /** Painted where the visitor can see it: in the viewport, inside every clipping ancestor, and on top there. */
  seen: boolean;
}

/** Every range of the kf-falak highlight, where it sits, and whether it can be seen. */
const marks = (page: Page): Promise<Mark[]> =>
  page.evaluate(() => {
    const highlight = CSS.highlights.get('kf-falak');
    const elements = [...document.querySelectorAll('[data-verse] [lang="ar"]')];
    const seen = (el: Element, rect: DOMRect): boolean => {
      if (rect.width <= 0 || rect.height <= 0) return false;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
      if (getComputedStyle(el).visibility !== 'visible') return false;
      // Hit testing skips hidden and clipped boxes (a scrolled-away card, a panel that stepped aside), but not transparent ones.
      for (let node: Element | null = el; node; node = node.parentElement) {
        if (Number(getComputedStyle(node).opacity) === 0) return false;
      }
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === el || el.contains(hit));
    };
    return [...(highlight ?? [])].flatMap((range) => {
      if (!(range instanceof Range)) return [];
      const el = range.startContainer.parentElement;
      if (!el) return [];
      const key = el.closest('[data-verse]')?.getAttribute('data-verse') ?? '';
      const same = elements.filter((e) => e.closest('[data-verse]')?.getAttribute('data-verse') === key);
      return [{ key, element: same.indexOf(el), text: range.toString(), seen: seen(el, range.getBoundingClientRect()) }];
    });
  });

/** Holds every request for the analysis asset until release() (a slow network), and counts them. */
async function delayAsset(page: Page): Promise<{ release: () => void; count: () => number }> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route(ASSET_ROUTE, async (route) => {
    requests += 1;
    await gate;
    await route.continue();
  });
  return {
    release: () => {
      release();
    },
    count: () => requests,
  };
}

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

test('while verse 21:33 plays, an invitation under it opens the analysis; so does a button under that verse in the notes', async ({ page, kf }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.openChapter('ch07', { autoplay: true, t: 123 });
  // Through the verse's cue (t 126) on the manual clock, so it holds on any machine.
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.step(300, 1 / 60);
  });
  const invite = page.getByTestId('discovery-invite');
  await expect(invite).toHaveClass(/is-shown/);
  await invite.click();
  const region = page.getByTestId('discovery');
  await expect(region).toHaveClass(/is-open/);
  await page.keyboard.press('Escape');
  await expect(region).not.toHaveClass(/is-open/);
  // In the notes, a button right under 21:33 (the last verse it reads, as the notes order them).
  const inline = page.getByTestId('discovery-inline');
  await expect(inline).toHaveCount(1);
  expect(await inline.evaluate((el) => el.previousElementSibling?.getAttribute('data-verse'))).toBe('21:33');
  await inline.scrollIntoViewIfNeeded();
  await inline.click();
  await expect(region).toHaveClass(/is-open/);
});

test('the letter analysis has no accessibility violations', async ({ page, kf }) => {
  await openAnalysis(page, kf, 150);
  const results = await new AxeBuilder({ page }).include('[data-testid="discovery"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});

test('the film is held while the analysis is open: no cue scrolls it away and the chapter cannot end', async ({ page, kf }) => {
  test.setTimeout(180_000 * SLOW);
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
  await expect.poll(async () => (await snapshot(page)).time, { timeout: 10_000 * SLOW }).toBeGreaterThan(before.time + 0.5);

  // Across the chapter's end: no outro starts and the next chapter never loads.
  const chapterEnd = chapterContent('ch07').duration;
  const end = await openAnalysis(page, kf, chapterEnd - 5);
  const nearEnd = await snapshot(page);
  expect(nearEnd.time, `the hold began before the end at ${String(chapterEnd)} s`).toBeLessThan(chapterEnd - 0.5);
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

test('the cues a seek replays do not scroll the panel before the analysis closes', async ({ page, kf }) => {
  test.setTimeout(180_000 * SLOW);
  const region = await openAnalysis(page, kf, 150);
  // Neither recent reader activity nor focus in the panel may be what keeps it still: only the open analysis.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.waitForTimeout(8500);
  const scroll = await page.evaluate(async () => {
    const body = document.querySelector('[data-testid="panel"] .kf-panel-body');
    const before = body?.scrollTop ?? -1;
    // Past the science panel cue at 162 s: the seek replays it before its 'seek' event closes the analysis.
    (window as unknown as KfHook).__kf.app.seek(165);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const open = document.querySelector('[data-testid="discovery"]')?.classList.contains('is-open') ?? false;
    return { before, after: body?.scrollTop ?? -1, open };
  });
  expect(scroll.open).toBe(false);
  expect(scroll.after).toBe(scroll.before);
  await expect(region).toBeHidden();
});

test('an opening still waiting for the asset never opens after the visitor moved on', async ({ page, kf }) => {
  test.setTimeout(180_000 * SLOW);
  const opener = page.getByRole('button', { name: OPEN_NAME });

  // (1) The next chapter loads while the asset is still on its way.
  await kf.openChapter('ch07', { autoplay: true, t: 150 });
  await kf.ensurePanelOpen();
  let asset = await delayAsset(page);
  await opener.scrollIntoViewIfNeeded();
  await opener.click();
  await expect.poll(asset.count).toBe(1);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.next();
  });
  await kf.waitForChapterReady('ch08');
  asset.release();
  await page.waitForTimeout(1000);
  let now = await snapshot(page);
  expect(now.chapter).toBe('ch08');
  expect(now.held).toBe(false);
  await expect(page.getByTestId('film-held')).toHaveText('');
  await expect(page.locator('.kf-discovery.is-open')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveClass(/kf-discovery-layer-open/);
  await expect.poll(async () => (await snapshot(page)).time, { message: 'the next chapter runs on', timeout: 20_000 * SLOW }).toBeGreaterThan(0.5);

  // (2) The panel is collapsed while the asset is on its way.
  await page.unroute(ASSET_ROUTE);
  await kf.openChapter('ch07', { autoplay: true, t: 150 });
  await kf.ensurePanelOpen();
  asset = await delayAsset(page);
  await opener.scrollIntoViewIfNeeded();
  await opener.click();
  await expect.poll(asset.count).toBe(1);
  await page.getByTestId('panel-toggle').click();
  asset.release();
  await page.waitForTimeout(1000);
  now = await snapshot(page);
  expect(now.held).toBe(false);
  const region = page.getByTestId('discovery');
  await expect(region).toBeHidden();
  await expect(region).not.toHaveClass(/is-open/);
  await expect(page.getByTestId('film-held')).toHaveText('');
  // (The collapsed panel is inert, so the button is out of the accessibility tree: found by its class.)
  await expect(page.locator('.kf-discovery-open')).toHaveAttribute('aria-expanded', 'false');
});

test('a double click while the asset loads fetches it once and builds the tiles once', async ({ page, kf }) => {
  await kf.openChapter('ch07', { autoplay: true, t: 150 });
  await kf.ensurePanelOpen();
  const asset = await delayAsset(page);
  const opener = page.getByRole('button', { name: OPEN_NAME });
  await opener.scrollIntoViewIfNeeded();
  await opener.dblclick();
  await page.waitForTimeout(300);
  asset.release();
  const region = page.getByTestId('discovery');
  await expect(region).toHaveClass(/is-open/);
  const tiles = region.locator('.kf-discovery-tile');
  await expect(tiles).toHaveCount(7);
  // Not rebuilt under the open analysis: the first tile keeps focus and the light.
  await page.waitForTimeout(500);
  await expect(tiles.nth(0)).toBeFocused();
  await expect(region.locator('.kf-discovery-tile.is-lit')).toHaveCount(1);
  expect(asset.count()).toBe(1);
  expect((await snapshot(page)).held).toBe(true);
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
  test.skip(NO_GPU, NEEDS_REAL_FRAMES);
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
  await expect(centre).toHaveClass(/is-meeting/, { timeout: 3000 * SLOW });
  const ring = await centre.evaluate((el) => {
    const style = getComputedStyle(el, '::after');
    return { duration: Number.parseFloat(style.transitionDuration), opacity: Number.parseFloat(style.opacity) };
  });
  expect(ring.duration).toBeGreaterThanOrEqual(0.6);
  expect(ring.opacity).toBeLessThanOrEqual(0.8);
  // After the three pairs, the centre is named.
  await expect(region.locator('.kf-discovery-live')).toHaveText('Letter 4, alif maqṣūra, is the centre.', { timeout: 10_000 * SLOW });
});

test('opening the analysis dims the scene gently, never in a step', async ({ page, kf }) => {
  test.skip(NO_GPU, NEEDS_REAL_FRAMES);
  test.setTimeout(180_000 * SLOW);
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
  }).toPass({ timeout: 30_000 * SLOW });
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

test('the three words are underlined in place, in view, and the verse text stays byte-identical', async ({ page, kf }) => {
  const region = await openAnalysis(page, kf, 150);
  const ayat = quranByKey();
  // The whole verse sits above the analysis and is brought into view with it, underline and all.
  await expect(region.locator('[data-verse="21:33"] [lang="ar"]')).toBeVisible();
  await expect
    .poll(async () => (await marks(page)).filter((m) => m.key === '21:33' && m.seen).length, { message: 'the underline can be seen' })
    .toBe(3);

  const marked = await marks(page);
  expect(marked.every((m) => ASSET.verses.some((v) => v.key === m.key) && m.element >= 0)).toBe(true);
  // For each verse element on the page (the text layer card, the card above the analysis, a stage
  // card if one shows): exactly the words at the asset's positions, in order, and nothing else.
  for (const { key, tokens } of ASSET.verses) {
    const entry = ayat.get(key);
    if (!entry) throw new Error(`no ${key} in data/quran.json`);
    const expected = citedWords(entry.arabic, tokens);
    for (const word of expected) expect(word).toMatch(/^\S+$/u);
    const texts = await page.locator(`[data-verse="${key}"] [lang="ar"]`).evaluateAll((els) => els.map((el) => el.textContent));
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text).toBe(entry.arabic);
    texts.forEach((_, element) => {
      const words = marked.filter((m) => m.key === key && m.element === element).map((m) => m.text);
      expect(words, `${key}, Arabic element ${element + 1}`).toEqual(expected);
    });
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
      // A whole vowelled verse stays on screen above the analysis, its three words underlined where they can be seen.
      const verse = region.locator('[data-verse="21:33"] [lang="ar"]');
      await expect(verse).toBeVisible();
      await expect
        .poll(async () => (await marks(page)).filter((m) => m.key === '21:33' && m.seen).length, { message: 'the underline can be seen' })
        .toBe(3);
      const verseBox = await verse.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, visibility: getComputedStyle(el).visibility };
      });
      expect(verseBox.visibility).toBe('visible');
      expect(verseBox.top).toBeGreaterThanOrEqual(layout.header - 1);
      expect(verseBox.bottom).toBeLessThanOrEqual(Math.min(layout.timeline, viewport.height) + 1);
      expect(verseBox.left).toBeGreaterThanOrEqual(-0.5);
      expect(verseBox.right).toBeLessThanOrEqual(viewport.width + 0.5);
      // Above the letters (on a phone held sideways the letters sit beside it instead).
      if (viewport.height > 500) expect(verseBox.bottom).toBeLessThanOrEqual(Math.min(...layout.tiles.map((t) => t.top)));

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
