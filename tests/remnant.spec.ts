/**
 * Chapter 6's remnant as its structure shows (src/chapters/ch06/ejecta.ts and remnant.ts), on the manual
 * clock (__kf.step), so each instant is exact:
 * - the blast wave's and the neutron star's tags come in as the debris cools, after its own tags, and go
 *   with them before the verse (39 to 41 s), never under it; the neutron star's tag is in the chapter's
 *   own words (its lazy strings, added with its chunk);
 * - with reduced motion the same tags come and go at the same times;
 * - the Discover card says what the picture is (an illustration, a composite after Cassiopeia A and the
 *   Crab, a neutron star or a black hole) and credits its sources;
 * - from the collapse to the verse (24 to 45 s) the picture never flashes: no part of it brightens and
 *   darkens again by a tenth of the scale within a second (WCAG 2.3.1's general flash, with none allowed).
 */
import type { Page } from '@playwright/test';
import { chapterContent } from './support/data';
import { NEEDS_REAL_FRAMES, NO_GPU, SLOW } from './support/env';
import { expect, test, type Kf, type KfHook } from './support/fixtures';

const LIVE = { timeout: 30_000 * SLOW };
const TAGS = ['blast-wave', 'neutron-star'] as const;
const verse = chapterContent('ch06').cues.find((c) => c.type === 'verse');
const VERSE = verse?.type === 'verse' ? { from: verse.t, to: verse.t + verse.duration } : { from: 43, to: 85 };

/** Opens the chapter on the manual clock, playing (past its title card). */
async function openStepped(page: Page, kf: Kf): Promise<void> {
  await kf.openChapter('ch06', { autoplay: true });
  await page.evaluate(() => {
    const kfHook = (window as unknown as KfHook).__kf;
    if (kfHook.app.paused) kfHook.app.play();
    kfHook.step();
    for (let i = 0; i < 200 && kfHook.app.state !== 'playing'; i += 1) kfHook.step(10, 0.1);
  });
}

/** The HUD's tags at film time `t`, by id, with their opacity. */
const tagsAt = (page: Page, t: number): Promise<Record<string, number>> =>
  page.evaluate((time) => {
    const kfHook = (window as unknown as KfHook).__kf;
    kfHook.app.seek(time);
    kfHook.step(1, 1 / 60);
    return Object.fromEntries(kfHook.app.hud().labels.map((l) => [l.id, l.opacity]));
  }, t);

/** The tags' timing, as one record per instant (so a reduced-motion run can be compared whole). */
async function tagTimeline(page: Page): Promise<Array<{ t: number; tags: Record<string, number> }>> {
  const times = [30, 33, 37.5, 39, 40, 41.2, VERSE.from - 2, VERSE.from, 50, 60, 70, VERSE.to - 1];
  const out: Array<{ t: number; tags: Record<string, number> }> = [];
  for (const t of times) out.push({ t, tags: await tagsAt(page, t) });
  return out;
}

function expectTagWindow(timeline: Array<{ t: number; tags: Record<string, number> }>): void {
  for (const { t, tags } of timeline) {
    const fe = tags['debris-fe'] ?? 0;
    for (const id of TAGS) {
      const opacity = tags[id] ?? 0;
      // Not before the debris has cooled, and none in the two seconds before the verse or under it.
      if (t <= 33 || t >= 41) expect(opacity, `${id} at ${t} s`).toBe(0);
      // Fully in once each has come, and leaving with the debris' tags.
      if (t >= 37.5 && t <= 39) expect(opacity, `${id} at ${t} s`).toBeCloseTo(1, 3);
      if (t > 39 && t < 41) expect(opacity, `${id} at ${t} s, the iron tag at ${fe}`).toBeCloseTo(fe, 3);
    }
  }
}

test('the blast wave and the neutron star are tagged while the debris is, and never under the verse', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await openStepped(page, kf);
  const timeline = await tagTimeline(page);
  expectTagWindow(timeline);
  // The tag's words come with the chapter's chunk (not its key), and the rim's are the shock wave's.
  await tagsAt(page, 38);
  await expect(page.getByTestId('hud')).toContainText('Neutron star', LIVE);
  await expect(page.getByTestId('hud')).toContainText('Shock wave', LIVE);
  await expect(page.getByTestId('hud')).not.toContainText('ch06.tag');
  expect(pageErrors).toEqual([]);
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the same tags come and go at the same times', async ({ page, kf, pageErrors }) => {
    test.setTimeout(120_000 * SLOW);
    await openStepped(page, kf);
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');
    expectTagWindow(await tagTimeline(page));
    expect(pageErrors).toEqual([]);
  });
});

test('the Discover card says the remnant is a composite illustration, and credits it', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  const point = chapterContent('ch06').explore.points?.find((p) => p.id === 'remnant');
  expect(point?.kind).toBe('illustration');
  await kf.openChapter('ch06', { autoplay: true, t: 10 });
  await page.keyboard.press('Space');
  await page.keyboard.press('e');
  await expect(page.locator('html')).toHaveAttribute('data-state', 'explore');
  const dock = page.getByTestId('discover');
  await dock.getByTestId('discover-point-remnant').click();
  expect(await page.evaluate(() => (window as unknown as KfHook).__kf.app.exploreTime)).toBe(point?.t);
  await expect(dock.getByTestId('discover-kind')).toHaveText('An illustration');
  const text = (await dock.getByTestId('discover-text').textContent()) ?? '';
  for (const words of ['composite', 'Cassiopeia A', 'Crab Nebula', 'neutron star', 'black hole', 'not to scale']) expect(text).toContain(words);
  await expect(dock.getByTestId('discover-card').locator('.kf-cites li')).toHaveCount(point?.text.cite?.length ?? -1);
  // The scene at that moment carries its tags.
  await expect(page.getByTestId('hud')).toContainText('Neutron star', LIVE);
  expect(pageErrors).toEqual([]);
});

/** Columns and rows of the tiles the picture is judged in (each about a tenth of the field of view, or more). */
const GRID = { cols: 4, rows: 3 } as const;

/** Mean relative luminance (linear, 0 to 1) of each tile of the canvas as the screen shows it. */
async function tileLuminance(page: Page): Promise<number[]> {
  const png = (await page.locator('#scene').screenshot({ style: 'body > :not(#scene) { visibility: hidden !important; }' })) as Uint8Array;
  let binary = '';
  for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return page.evaluate(
    async ({ base64, cols, rows }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D context unavailable');
      context.drawImage(bitmap, 0, 0);
      const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const lin = Array.from({ length: 256 }, (_, v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      const sums = new Array<number>(cols * rows).fill(0);
      const counts = new Array<number>(cols * rows).fill(0);
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          const i = (y * width + x) * 4;
          const k = Math.min(rows - 1, Math.floor((y / height) * rows)) * cols + Math.min(cols - 1, Math.floor((x / width) * cols));
          sums[k] = (sums[k] ?? 0) + 0.2126 * (lin[data[i] ?? 0] ?? 0) + 0.7152 * (lin[data[i + 1] ?? 0] ?? 0) + 0.0722 * (lin[data[i + 2] ?? 0] ?? 0);
          counts[k] = (counts[k] ?? 0) + 1;
        }
      }
      return sums.map((s, k) => s / Math.max(1, counts[k] ?? 1));
    },
    { base64: btoa(binary), cols: GRID.cols, rows: GRID.rows },
  );
}

/**
 * Flashes in one tile's light, sampled every `dt` seconds: the times of each pair of opposing changes of
 * at least 0.1 (the darker side below 0.8), each change measured between the turning points of the light.
 */
function flashes(series: readonly number[], dt: number): number[] {
  const turns: Array<{ i: number; v: number }> = [];
  for (let i = 0; i < series.length; i += 1) {
    const v = series[i] ?? 0;
    const last = turns.at(-1);
    const before = turns.at(-2);
    if (!last) turns.push({ i, v });
    else if (before && Math.sign(v - last.v) === Math.sign(last.v - before.v)) turns[turns.length - 1] = { i, v };
    else if (v !== last.v) turns.push({ i, v });
  }
  const swings = turns.slice(1).map((b, k) => ({ a: turns[k] ?? b, b })).filter(({ a, b }) => Math.abs(b.v - a.v) >= 0.1 && Math.min(a.v, b.v) < 0.8);
  const out: number[] = [];
  for (let k = 1; k < swings.length; k += 1) {
    const one = swings[k - 1];
    const two = swings[k];
    if (one && two && Math.sign(one.b.v - one.a.v) !== Math.sign(two.b.v - two.a.v) && (two.b.i - one.a.i) * dt <= 1) out.push(two.b.i * dt);
  }
  return out;
}

test('from the collapse to the verse, the picture never flashes', async ({ page, kf, pageErrors }) => {
  test.skip(NO_GPU, NEEDS_REAL_FRAMES);
  test.setTimeout(300_000);
  await openStepped(page, kf);
  // Played from well before the collapse, so the eye's adaptation is the film's own, not a seek's.
  await page.evaluate(() => {
    const kfHook = (window as unknown as KfHook).__kf;
    kfHook.app.seek(14);
    kfHook.step(600, 1 / 60);
  });
  const dt = 0.1;
  const samples: number[][] = [];
  for (let t = 24; t <= 45 + 1e-9; t += dt) {
    await page.evaluate((frames) => {
      (window as unknown as KfHook).__kf.step(frames, 1 / 60);
    }, Math.round(dt * 60));
    samples.push(await tileLuminance(page));
  }
  const found = Array.from({ length: GRID.cols * GRID.rows }, (_, k) => flashes(samples.map((s) => s[k] ?? 0), dt).map((at) => `tile ${k} at ${(24 + at).toFixed(1)} s`)).flat();
  expect(found).toEqual([]);
  // The frames read were the film's, changing: the debris swelled, cooled and dimmed in them.
  const ranges = Array.from({ length: GRID.cols * GRID.rows }, (_, k) => Math.max(...samples.map((s) => s[k] ?? 0)) - Math.min(...samples.map((s) => s[k] ?? 0)));
  expect(Math.max(...ranges)).toBeGreaterThan(0.01);
  expect(pageErrors).toEqual([]);
});
