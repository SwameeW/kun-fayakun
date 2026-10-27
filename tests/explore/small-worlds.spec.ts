/**
 * More worlds in the explorer (src/explore/worlds, src/ui/explore/worlds-panel): the small bodies'
 * layer and its counts at each detail level, switched on and off in bursts; flying to Ceres, Pluto
 * and Triton by name (the tools' `world` command) and to Halley from the navigator's search; the
 * asteroids moving with the time machine; the shadows of a real lunar eclipse (3 March 2026) and a
 * total solar eclipse (12 August 2026) where the ephemeris puts them; and the navigator's section at
 * every window size, opened and closed in bursts.
 */
import type { Page } from '@playwright/test';
import type { UniverseView } from '../../src/core/types';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { everyInsideViewport, frames, noClippedText, noHorizontalOverflow, noOverlappingTargets, spam } from '../support/layout';
import { JD, place, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 60_000 * SLOW };
const HIDE_UI = 'body > :not(#scene) { visibility: hidden !important; }';
/** Greatest eclipse: the total lunar eclipse of 2026-03-03 (11:33 UT) and the total solar eclipse of 2026-08-12 (17:46 UT), as UTC Julian dates. */
const LUNAR = '2461102.98';
const SOLAR = '2461265.24';

const command = (page: Page, c: Parameters<KfHook['__kf']['app']['earthCommand']>[0]): Promise<void> => page.evaluate((x) => { (window as unknown as KfHook).__kf.app.earthCommand(x); }, c);
const worlds = async (page: Page): Promise<NonNullable<UniverseView['worlds']> | null> => (await view(page))?.worlds ?? null;

/** Mean linear-ish colour (8-bit) of the canvas inside a box (CSS px), the interface hidden. */
async function region(page: Page, x: number, y: number, w: number, h: number): Promise<{ r: number; g: number; b: number; luma: number }> {
  const png = (await page.screenshot({ style: HIDE_UI, clip: { x, y, width: w, height: h } })) as Uint8Array;
  let binary = '';
  for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D context unavailable');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i] ?? 0;
      g += data[i + 1] ?? 0;
      b += data[i + 2] ?? 0;
    }
    const n = data.length / 4;
    return { r: r / n, g: g / n, b: b / n, luma: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n };
  }, btoa(binary));
}

/** The picture has come up through its veil and the exposure has settled: the canvas's mean light steady over half a second. */
async function settled(page: Page): Promise<void> {
  let last = -1;
  await expect
    .poll(async () => {
      await page.waitForTimeout(500);
      const now = (await region(page, 0, 0, 400, 300)).luma + (await region(page, 400, 300, 400, 300)).luma;
      const steady = last > 0 && Math.abs(now - last) <= 0.01 * last;
      last = now;
      return steady;
    }, LIVE)
    .toBe(true);
}

/** Opens the navigator's Small worlds section and waits for the worlds. */
async function openSection(page: Page): Promise<void> {
  const summary = page.getByTestId('universe-worlds').locator(':scope > summary');
  await summary.scrollIntoViewIfNeeded();
  if (!(await page.getByTestId('universe-worlds').evaluate((d) => (d as HTMLDetailsElement).open))) await summary.click();
  await expect(page.getByTestId('worlds-intro')).toContainText(/asteroids? drawn/u, LIVE);
}

test('the small bodies’ layer: the detail level’s asteroids, switched on and off in bursts, coloured by group', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD, detail: 'high' } });
  await waitForUniverse(page);
  await openSection(page);
  // High draws the 250,000 largest; the groups add up to them, the main belt the most.
  await expect.poll(async () => (await worlds(page))?.asteroids, LIVE).toBe(250_000);
  const w = await worlds(page);
  expect(Object.values(w?.groups ?? {}).reduce((a, b) => a + b, 0)).toBe(250_000);
  expect(w?.groups.main ?? 0).toBeGreaterThan(200_000);
  expect(w?.groups.trojans ?? 0).toBeGreaterThan(5_000);
  expect(w?.groups.hildas ?? 0).toBeGreaterThan(1_000);
  expect(w?.groups.kuiper ?? 0).toBeGreaterThan(1_000);
  expect(w?.comets ?? 0).toBeGreaterThan(100);
  await expect(page.getByTestId('worlds-group-trojans')).not.toHaveText('0', LIVE);

  const layer = page.getByTestId('worlds-layer');
  await expect(layer).toHaveAttribute('aria-pressed', 'true');
  // 30 presses within a frame: an even number, so it ends where it began; then one more turns it off.
  await spam(layer, 30);
  await expect(layer).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await worlds(page))?.asteroids).toBe(250_000);
  await layer.click();
  await expect(layer).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await worlds(page))?.asteroids).toBe(0);
  await expect(page.getByTestId('worlds-grouped')).toBeDisabled();
  await layer.click();
  await expect.poll(async () => (await worlds(page))?.layer).toBe(true);
  const grouped = page.getByTestId('worlds-grouped');
  await spam(grouped, 11);
  await expect(grouped).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await worlds(page))?.grouped).toBe(true);

  // Each detail level its own count (the files fetched as far as it needs).
  for (const [tier, count] of [
    ['low', 20_000],
    ['medium', 80_000],
    ['high', 250_000],
  ] as const) {
    await page.getByTestId('universe-detail').click();
    await page.getByTestId(`universe-detail-${tier}`).click();
    await expect.poll(async () => (await worlds(page))?.asteroids, LIVE).toBe(count);
  }
  expect(pageErrors).toEqual([]);
});

test('flying to Ceres, Pluto and Triton by name, and to Halley from the search', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD, detail: 'high' } });
  await waitForUniverse(page);
  // Asked for before the worlds have come: flown to when they do.
  await command(page, { kind: 'world', name: 'ceres' });
  for (const [name, id, radius] of [
    ['ceres', 'w:Ceres', 470],
    ['Pluto', 'w:Pluto', 1188],
    ['Triton', 'w:Triton', 1353],
  ] as const) {
    if (name !== 'ceres') await command(page, { kind: 'world', name });
    await expect.poll(async () => {
      const v = await view(page);
      return v?.focus === id && !v.travelling;
    }, LIVE).toBe(true);
    const v = await view(page);
    // Framed at its true size: the height above it a few of its radii, its own facts in the view.
    expect(v?.worlds?.focus?.id).toBe(id);
    expect(v?.worlds?.focus?.radiusKm ?? 0).toBeGreaterThan(radius * 0.95);
    expect(v?.altitudeKm ?? 0).toBeGreaterThan(radius * 0.3);
    expect(v?.altitudeKm ?? Infinity).toBeLessThan(radius * 12);
    await expect(page.getByTestId('universe-readout')).toContainText(id.slice(2));
  }
  // Triton belongs to Neptune.
  expect((await worlds(page))?.focus?.host).toBe('neptune');
  // A name that is no world's does nothing.
  await command(page, { kind: 'world', name: 'no such world' });
  await expect.poll(async () => (await view(page))?.focus).toBe('w:Triton');

  await openSection(page);
  await page.getByTestId('worlds-search').fill('hal');
  const halley = page.getByTestId('worlds-go-1P/Halley');
  await expect(halley).toBeVisible();
  await halley.click();
  await expect.poll(async () => {
    const v = await view(page);
    return v?.focus === 'w:1P/Halley' && !v.travelling;
  }, LIVE).toBe(true);
  // The About section names it and its size.
  const about = page.getByTestId('universe-about');
  await about.locator(':scope > summary').click();
  await expect(about.locator(':scope > summary')).toContainText('1P/Halley');
  await expect(page.getByTestId('about-size')).toContainText('km');
  // Back to a body: the ten's own focus again.
  await page.evaluate(() => { (window as unknown as KfHook).__kf.app.focusBody('jupiter'); });
  await expect.poll(async () => (await view(page))?.focus, LIVE).toBe('jupiter');
  expect(pageErrors).toEqual([]);
});

test('the asteroids move with the time machine', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await page.setViewportSize({ width: 1280, height: 800 });
  await kf.open('/universe/earth', { query: { jd: JD, detail: 'medium' } });
  await waitForUniverse(page);
  await page.evaluate(() => { (window as unknown as KfHook).__kf.app.universeTime({ kind: 'toggle' }); });
  await command(page, { kind: 'smallBodies', on: true });
  await expect.poll(async () => (await worlds(page))?.asteroids, LIVE).toBe(80_000);
  // From 7 au above the Sun, the belt fills a ring of the view; a strip across it, then 100 days on.
  await place(page, { body: 'sun', distanceKm: 1.1e9, elevationDeg: 85 });
  await settled(page);
  const before = await region(page, 140, 380, 260, 40);
  expect(before.luma).toBeGreaterThan(2);
  const jd = Number(JD);
  await page.evaluate((d) => { (window as unknown as KfHook).__kf.app.universeTime({ kind: 'date', jdUtc: d }); }, jd + 100);
  await place(page, { body: 'sun', distanceKm: 1.1e9, elevationDeg: 85 });
  await frames(page, 4);
  const after = await region(page, 140, 380, 260, 40);
  // The same strip's light differs: the points have moved (the belt as a whole stays, its grain changes).
  const png1 = (await page.screenshot({ style: HIDE_UI, clip: { x: 140, y: 380, width: 260, height: 40 } })) as Uint8Array;
  await page.evaluate((d) => { (window as unknown as KfHook).__kf.app.universeTime({ kind: 'date', jdUtc: d }); }, jd);
  await place(page, { body: 'sun', distanceKm: 1.1e9, elevationDeg: 85 });
  await frames(page, 4);
  const png0 = (await page.screenshot({ style: HIDE_UI, clip: { x: 140, y: 380, width: 260, height: 40 } })) as Uint8Array;
  expect(png0.length === png1.length && png0.every((v, i) => v === png1[i])).toBe(false);
  expect(Math.abs(after.luma - before.luma)).toBeLessThan(before.luma);
  expect(pageErrors).toEqual([]);
});

test('a lunar eclipse and a solar eclipse where the ephemeris puts them: the Moon in the Earth’s shadow, copper; the Moon’s shadow on the Earth', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await page.setViewportSize({ width: 1280, height: 800 });
  const moonAt = async (jd: string): Promise<{ r: number; g: number; b: number; luma: number }> => {
    await kf.open('/universe/moon', { query: { jd, detail: 'high' } });
    await waitForUniverse(page);
    await page.evaluate(() => { (window as unknown as KfHook).__kf.app.universeTime({ kind: 'toggle' }); });
    await expect.poll(async () => (await worlds(page))?.list.length ?? 0, LIVE).toBeGreaterThan(10);
    await place(page, { body: 'moon', distanceKm: 12_000 });
    await settled(page);
    const v = await view(page);
    const moon = v?.bodies.find((b) => b.id === 'moon');
    const s = moon?.screen ?? { x: 640, y: 400, radiusPx: 100 };
    const half = Math.round(s.radiusPx * 0.5);
    return region(page, Math.round(s.x - half), Math.round(s.y - half), half * 2, half * 2);
  };
  const night = await moonAt(String(Number(LUNAR) - 1));
  const eclipse = await moonAt(LUNAR);
  expect((await worlds(page))?.eclipses).toContainEqual(expect.objectContaining({ on: 'moon', by: 'earth' }));
  expect((await worlds(page))?.eclipses.find((e) => e.on === 'moon')?.depth ?? 0).toBeGreaterThan(0.99);
  expect((await view(page))?.illustrative).toContain('eclipse-red');
  // In the umbra: under a tenth of the full Moon's light the night before, and copper (red well above blue).
  expect(eclipse.luma).toBeLessThan(night.luma * 0.1);
  expect(eclipse.r).toBeGreaterThan(eclipse.b * 1.5);

  await kf.open('/universe/earth', { query: { jd: SOLAR, detail: 'high' } });
  await waitForUniverse(page);
  await page.evaluate(() => { (window as unknown as KfHook).__kf.app.universeTime({ kind: 'toggle' }); });
  await expect.poll(async () => (await worlds(page))?.eclipses.find((e) => e.on === 'earth' && e.by === 'moon')?.depth ?? 0, LIVE).toBeGreaterThan(0.99);
  // An hour before the Moon's shadow reaches the Earth, none.
  await page.evaluate((d) => { (window as unknown as KfHook).__kf.app.universeTime({ kind: 'date', jdUtc: d }); }, Number(SOLAR) - 0.12);
  await expect.poll(async () => (await worlds(page))?.eclipses.some((e) => e.on === 'earth') ?? true, LIVE).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('the Small worlds section at every window size: opened and closed in bursts, searched, nothing out of place', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    const at = `${String(size.width)}x${String(size.height)}`;
    await page.setViewportSize(size);
    await frames(page, 3);
    const toggle = page.getByTestId('universe-nav-toggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    const details = page.getByTestId('universe-worlds');
    const summary = details.locator(':scope > summary');
    await summary.scrollIntoViewIfNeeded();
    if (await details.evaluate((d) => (d as HTMLDetailsElement).open)) await summary.click();
    await spam(summary, 9);
    await expect(details).toHaveAttribute('open', '');
    await expect(page.getByTestId('worlds-intro')).toContainText(/asteroids? drawn/u, LIVE);
    await page.getByTestId('worlds-search').fill(size.width < 500 ? 'io' : '');
    await frames(page, 3);
    const universe = '[data-testid="universe"]';
    expect(await everyInsideViewport(page, universe), `${at}: every control inside the window`).toEqual([]);
    expect(await noHorizontalOverflow(page), `${at}: nothing wider than the window`).toEqual([]);
    expect(await noOverlappingTargets(page, universe), `${at}: no control over another`).toEqual([]);
    expect(await noClippedText(page.getByTestId('universe')), `${at}: no text cut off`).toEqual([]);
    await spam(summary, 6);
    await summary.click();
    await expect(details).not.toHaveAttribute('open', '');
  }
  // The section's body came once, however often it was opened.
  await expect(page.getByTestId('universe-worlds').locator(':scope > .kf-about-body')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});
