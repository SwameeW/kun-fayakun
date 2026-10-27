/**
 * More worlds in the explorer (src/explore/worlds, src/ui/explore/worlds-panel): the small bodies'
 * layer and its counts at each detail level, switched on and off in bursts; flying to Ceres, Pluto
 * and Triton by name (the tools' `world` command) and to Halley from the navigator's search; the
 * asteroids moving with the time machine; the shadows of a real lunar eclipse (3 March 2026) and a
 * total solar eclipse (12 August 2026) where the ephemeris puts them; and the navigator's section at
 * every window size, opened and closed in bursts.
 *
 * And what the review found: the sky dark looking at the Sun and from Mercury (the glow never lifted
 * as the exposure closes, nor seen through the solar filter); the detail level chosen while the worlds
 * come; an "off" that loads nothing; Charon's About naming Pluto; a moon's planet's notes in the
 * readout; no flashing eclipse nor strobing spin at a fast clock; the GPU's own asteroid places read
 * back against the CPU's; the asteroids arranged by orbit size showing the Kirkwood gap; Io's shadow on
 * Jupiter in pixels; the worlds hidden in an experiment, on foot, on the way down and among the stars;
 * and the detail ladder and a fast clock spammed without a leak or an error.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { UniverseView } from '../../src/core/types';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { everyInsideViewport, frames, noClippedText, noHorizontalOverflow, noOverlappingTargets, spam } from '../support/layout';
import { JD, place, step, view, waitForUniverse } from '../support/universe';
import { beltPosition, decodeRecord, type BeltManifest, type BeltRecord } from '../../src/explore/worlds/orbits';

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

/** The mean and the median of the canvas's luma (8-bit) inside a box (CSS px), the interface hidden. */
async function lumaStats(page: Page, x: number, y: number, w: number, h: number): Promise<{ mean: number; median: number }> {
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
    const luma: number[] = [];
    for (let i = 0; i < data.length; i += 4) luma.push(0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0));
    luma.sort((a, b) => a - b);
    return { mean: luma.reduce((a, b) => a + b, 0) / luma.length, median: luma[Math.floor(luma.length / 2)] ?? 0 };
  }, btoa(binary));
}

/** Waits for the worlds to have come and be shown (faded in). */
async function worldsShown(page: Page): Promise<void> {
  await expect.poll(async () => (await worlds(page))?.shown ?? 0, LIVE).toBeGreaterThan(0.99);
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
  // (Enabled again a frame after the layer is: a press before then is a disabled button's.)
  await expect(grouped).toBeEnabled();
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

test('looking at the Sun, and from Mercury, the sky stays dark: the glow never lifted as the exposure closes, nor seen through the filter', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await page.setViewportSize({ width: 1280, height: 800 });
  // The Sun's own views (its filter on close up): the filtered disc and its prominences on a black sky.
  // Before this was fixed the zodiacal light, lifted 200 times inside 0.1 au, made the whole view white
  // (mean 151 to 253; the filtered view without it: 23.5, median 6).
  await kf.open('/universe/sun', { query: { jd: JD, detail: 'high' } });
  await waitForUniverse(page);
  await worldsShown(page);
  for (const [label, pose] of [
    ['the default view', null],
    ['4 million km', { body: 'sun', distanceKm: 4e6 }],
    ['15 million km, from the side', { body: 'sun', distanceKm: 1.5e7, azimuthDeg: 90 }],
  ] as const) {
    if (pose) await place(page, pose);
    await settled(page);
    const all = await lumaStats(page, 0, 0, 1280, 800);
    expect(all.mean, `the Sun, ${label}: mean`).toBeLessThan(45);
    expect(all.median, `the Sun, ${label}: median`).toBeLessThan(15);
    // Through the filter none of the glow is drawn, and the readout does not name it.
    const v = await view(page);
    if (v?.solarFilter) expect(v.illustrative, `the Sun, ${label}`).not.toContain('sky-glow');
  }
  // From Mercury the sky beside the planet stays black (median 6 without the glow; 20 when it was lifted).
  await kf.open('/universe/mercury', { query: { jd: JD, detail: 'high' } });
  await waitForUniverse(page);
  await worldsShown(page);
  await settled(page);
  for (const [x, y] of [
    [0, 0],
    [1080, 600],
  ] as const) {
    const corner = await lumaStats(page, x, y, 200, 200);
    expect(corner.median, `Mercury's sky at ${x},${y}`).toBeLessThan(12);
  }
  expect(pageErrors).toEqual([]);
});

test('the detail level chosen while the worlds come is the one they draw; an "off" asks for nothing', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  // The worlds' first file held back a while, so Low is chosen before they come.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/assets/smallbodies/manifest.json', async (route) => {
    await held;
    await route.continue();
  });
  await kf.open('/universe/earth', { query: { jd: JD, detail: 'high' } });
  await waitForUniverse(page);
  await command(page, { kind: 'smallBodies', on: true });
  await page.getByTestId('universe-detail').click();
  await page.getByTestId('universe-detail-low').click();
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'low');
  release();
  await expect.poll(async () => (await worlds(page))?.asteroids, LIVE).toBe(20_000);
  // Only Low's file was fetched and decoded, not High's three.
  await page.waitForTimeout(1500);
  expect((await worlds(page))?.asteroidsLoaded).toBe(20_000);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /asteroids-[123]\.bin/u.test(e.name)).length)).toBe(0);
  await page.unroute('**/assets/smallbodies/manifest.json');

  // An "off" before they come fetches nothing: on the manual clock, nothing for a while; "on" then asks.
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await step(page, 1);
  await command(page, { kind: 'smallBodies', on: false });
  await step(page, 20);
  await page.waitForTimeout(500);
  const fetched = (): Promise<number> => page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/assets/smallbodies/')).length);
  expect(await fetched()).toBe(0);
  await command(page, { kind: 'smallBodies', on: true });
  await expect.poll(async () => {
    await step(page, 2);
    return fetched();
  }, LIVE).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test('About a moon names what it goes round: Charon and Nix Pluto; a sphere standing in for an unmeasured shape says so; Triton’s unimaged north', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD, detail: 'high' } });
  await waitForUniverse(page);
  const about = page.getByTestId('universe-about');
  const flyTo = async (name: string): Promise<void> => {
    await command(page, { kind: 'world', name });
    await expect.poll(async () => {
      const v = await view(page);
      return v?.focus === `w:${name}` && !v.travelling;
    }, LIVE).toBe(true);
    if (!(await about.evaluate((d) => (d as HTMLDetailsElement).open))) await about.locator(':scope > summary').click();
  };
  await flyTo('Charon');
  expect((await worlds(page))?.focus?.host).toBe('w:Pluto');
  await expect(about).toContainText('a moon of Pluto');
  await expect(page.getByTestId('about-day')).toHaveText('keeps one face to Pluto');
  await expect(about).not.toContainText(/of Sun|to Sun/u);
  // Its albedo, as NSSDCA's Pluto fact sheet gives it; drawn as a sphere of its mean radius, and saying so.
  await expect(page.getByTestId('about-albedo')).toContainText('0.42');
  await expect(page.getByTestId('about-size')).toContainText('drawn as a sphere');
  // A quarter of it never imaged: drawn as a grey grid, and the readout says so.
  await expect(about).toContainText('never imaged');
  await expect.poll(async () => (await view(page))?.illustrative ?? []).toContain('unimaged');
  await flyTo('Nix');
  await expect(about).toContainText('a moon of Pluto');
  // Eris's albedo is the occultation's (0.96); Pluto's NSSDCA's (0.52).
  await flyTo('Eris');
  await expect(page.getByTestId('about-albedo')).toContainText('0.96');
  await flyTo('Pluto');
  await expect(page.getByTestId('about-albedo')).toContainText('0.52');
  expect(pageErrors).toEqual([]);
});

test('at a moon, the readout keeps its planet’s notes while the planet is large in view', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/jupiter', { query: { jd: JD, detail: 'high' } });
  await waitForUniverse(page);
  await command(page, { kind: 'world', name: 'Io' });
  await expect.poll(async () => {
    const v = await view(page);
    return v?.focus === 'w:Io' && !v.travelling;
  }, LIVE).toBe(true);
  // Jupiter behind Io, its bands' drift sped up: said.
  await place(page, { body: 'w:Io', distanceKm: 9000, from: 'jupiter' });
  await expect.poll(async () => (await view(page))?.illustrative ?? []).toContain('band-drift');
  // Jupiter behind the camera: not.
  await place(page, { body: 'w:Io', distanceKm: 9000, from: 'jupiter', azimuthDeg: 180 });
  await expect.poll(async () => (await view(page))?.illustrative ?? []).not.toContain('band-drift');
  expect(pageErrors).toEqual([]);
});

test('at a week and at 30 days a second a moon flown to never flashes with its eclipses, and its turn is held', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await page.setViewportSize({ width: 1280, height: 800 });
  await kf.open('/universe/jupiter', { query: { jd: JD, detail: 'high' } });
  await waitForUniverse(page);
  await command(page, { kind: 'world', name: 'Io' });
  await expect.poll(async () => {
    const v = await view(page);
    return v?.focus === 'w:Io' && !v.travelling;
  }, LIVE).toBe(true);
  await place(page, { body: 'w:Io', distanceKm: 7000, from: 'sun' });
  await step(page, 30);
  for (const rate of [604_800, 2_592_000]) {
    await page.evaluate((r) => { (window as unknown as KfHook).__kf.app.universeTime({ kind: 'rate', rate: r }); }, rate);
    await step(page, 30);
    const s = (await worlds(page))?.focus?.screen ?? { x: 640, y: 400, radiusPx: 100 };
    const half = Math.round(Math.min(150, s.radiusPx * 0.6));
    // Frame by frame at 60 a second for three seconds: the disc's light.
    const series: number[] = [];
    let eclipsed = 0;
    for (let k = 0; k < 180; k += 1) {
      await step(page, 1);
      series.push((await region(page, Math.round(s.x - half), Math.round(s.y - half), half * 2, half * 2)).luma);
      if (((await worlds(page))?.focus?.eclipsed ?? 0) > 0.5) eclipsed += 1;
    }
    // Io was in Jupiter's shadow on some frames (the geometry), yet a change of a tenth or more of the
    // disc's light the other way from the last such change (a flash is two) came at most 3 times a second.
    expect(eclipsed, `${rate}: Io eclipsed on some frames`).toBeGreaterThan(0);
    const top = Math.max(...series);
    let last = 0;
    let turns = 0;
    let ref = series[0] ?? 0;
    for (const v of series) {
      const d = v - ref;
      if (Math.abs(d) >= 0.1 * top) {
        const dir = Math.sign(d);
        if (dir !== last) turns += 1;
        last = dir;
        ref = v;
      }
    }
    expect(turns / 2 / 3, `${rate}: flashes a second`).toBeLessThanOrEqual(3);
    // At a month a second Io turns 100 degrees a frame: held at an hour of its day (as the ten bodies are past 30).
    if (rate >= 2_592_000) expect((await view(page))?.time.spinHeld, `${rate}: Io's turn held`).toBe(true);
  }
  expect(pageErrors).toEqual([]);
});

test('the GPU’s own places of the asteroids, read back, are the CPU’s for the same records (float32 and the split date)', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  const manifest = JSON.parse(readFileSync(new URL('../../public/assets/smallbodies/manifest.json', import.meta.url), 'utf8')) as BeltManifest;
  const bytes = readFileSync(new URL(`../../public/assets/smallbodies/${manifest.tiers[0]?.file ?? ''}`, import.meta.url));
  const file = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  await kf.open('/universe/earth', { query: { jd: JD, detail: 'low' } });
  await waitForUniverse(page);
  await command(page, { kind: 'smallBodies', on: true });
  await expect.poll(async () => (await worlds(page))?.asteroidsLoaded, LIVE).toBe(20_000);
  // On the files' epoch and 3,000 days on (the split date's blocks in use).
  for (const jd of [Number(JD), Number(JD) + 3000]) {
    await page.evaluate((d) => { (window as unknown as KfHook).__kf.app.universeTime({ kind: 'date', jdUtc: d }); }, jd);
    await frames(page, 4);
    const probe = await page.evaluate(() => (window as unknown as KfHook).__kf.worlds?.probe(4096));
    expect(probe?.places.length).toBe(4096 * 4);
    const record: BeltRecord = { a: 0, e: 0, i: 0, node: 0, peri: 0, m0: 0, h: 0, cls: 0 };
    const cpu = [0, 0, 0];
    let worst = 0;
    for (let k = 0; k < 4096; k += 1) {
      decodeRecord(file, k, record);
      beltPosition(record, probe?.days ?? 0, cpu);
      const g = probe?.places.slice(k * 4, k * 4 + 4) ?? [];
      expect(g[3], `record ${k}'s index`).toBe(k);
      // The GPU's frame is the render frame: ecliptic (x, y, z) is (x, z, -y) there.
      const d = Math.hypot((g[0] ?? 0) - (cpu[0] ?? 0), (g[1] ?? 0) - (cpu[2] ?? 0), (g[2] ?? 0) + (cpu[1] ?? 0));
      // float32 throughout: the mean anomaly to about 1e-4 radians, so a few ten-thousandths of the orbit's size.
      worst = Math.max(worst, d / record.a);
    }
    expect(worst, `on ${jd}`).toBeLessThan(5e-4);
  }
  expect(pageErrors).toEqual([]);
});

test('arranged by orbit size each asteroid is drawn in the ecliptic at its orbit’s size (so the Kirkwood gaps show), a diagram the readout names', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await page.setViewportSize({ width: 1280, height: 800 });
  const manifest = JSON.parse(readFileSync(new URL('../../public/assets/smallbodies/manifest.json', import.meta.url), 'utf8')) as BeltManifest;
  const bytes = readFileSync(new URL(`../../public/assets/smallbodies/${manifest.tiers[0]?.file ?? ''}`, import.meta.url));
  const file = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  await kf.open('/universe/sun', { query: { jd: JD, detail: 'high' } });
  await waitForUniverse(page);
  await command(page, { kind: 'smallBodies', on: true });
  await expect.poll(async () => (await worlds(page))?.asteroids, LIVE).toBe(250_000);
  await place(page, { body: 'sun', distanceKm: 1.1e9, elevationDeg: 85 });
  await settled(page);
  const where = (await page.screenshot({ style: HIDE_UI })) as Uint8Array;
  await openSection(page);
  const orbits = page.getByTestId('worlds-orbits');
  await expect(orbits).toBeEnabled();
  await spam(orbits, 7);
  await expect(orbits).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await worlds(page))?.arranged).toBe(true);
  await expect.poll(async () => (await view(page))?.illustrative ?? []).toContain('small-body-orbits');
  await settled(page);
  // The picture changed (the belt drawn anew), and the GPU draws each point where the diagram says:
  // in the ecliptic (the render frame's y = 0), at its orbit's semi-major axis, at its own longitude.
  const arranged = (await page.screenshot({ style: HIDE_UI })) as Uint8Array;
  expect(arranged.length === where.length && arranged.every((v, i) => v === where[i])).toBe(false);
  const record: BeltRecord = { a: 0, e: 0, i: 0, node: 0, peri: 0, m0: 0, h: 0, cls: 0 };
  const worst = async (): Promise<number> => {
    const drawn = await page.evaluate(() => (window as unknown as KfHook).__kf.worlds?.probe(4096, true));
    const orbit = await page.evaluate(() => (window as unknown as KfHook).__kf.worlds?.probe(4096));
    if (drawn?.places.length !== 4096 * 4) return Infinity;
    let most = 0;
    for (let k = 0; k < 4096; k += 1) {
      decodeRecord(file, k, record);
      const [x = 0, y = 0, z = 0] = drawn.places.slice(k * 4, k * 4 + 3);
      const [ox = 0, , oz = 0] = orbit?.places.slice(k * 4, k * 4 + 3) ?? [];
      const longitude = Math.atan2(z, x) - Math.atan2(oz, ox);
      most = Math.max(most, Math.abs(Math.hypot(x, z) / record.a - 1), Math.abs(y) / record.a, Math.abs(Math.atan2(Math.sin(longitude), Math.cos(longitude))));
    }
    return most;
  };
  // (Once the change has eased out, in a few seconds: exactly.)
  await expect.poll(worst, LIVE).toBeLessThan(1e-5);
  // Back to where they are.
  await orbits.click();
  await expect.poll(async () => (await worlds(page))?.arranged).toBe(false);
  await expect.poll(async () => (await view(page))?.illustrative ?? []).not.toContain('small-body-orbits');
  expect(pageErrors).toEqual([]);
});

test('Io’s shadow on Jupiter, where the geometry puts it, is a dark spot in the pixels', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await page.setViewportSize({ width: 1280, height: 800 });
  await kf.open('/universe/jupiter', { query: { jd: JD, detail: 'high' } });
  await waitForUniverse(page);
  await worldsShown(page);
  await step(page, 1);
  // The next transit of Io's shadow in the two days after JD (an orbit is 1.77 days), and its deepest moment.
  const ioOnJupiter = (): Promise<number> => page.evaluate(() => (window as unknown as KfHook).__kf.universe.state()?.worlds?.eclipses.find((e) => e.on === 'jupiter' && e.by === 'w:Io')?.depth ?? 0);
  const at = async (jd: number): Promise<number> => {
    await page.evaluate((d) => { (window as unknown as KfHook).__kf.app.universeTime({ kind: 'date', jdUtc: d }); }, jd);
    await step(page, 1);
    return ioOnJupiter();
  };
  // (The depth is the deepest anywhere on the receiver: 1 while the shadow is on the disc at all.
  // Mid-transit is halfway between its first and last full minutes: the shadow then nearest the disc's
  // middle as the Sun sees it.)
  let found = 0;
  for (let jd = Number(JD); jd < Number(JD) + 2 && !found; jd += 1 / 48) if ((await at(jd)) > 0.99) found = jd;
  expect(found).toBeGreaterThan(0);
  const on: number[] = [];
  for (let jd = found - 2 / 24; jd <= found + 3 / 24; jd += 1 / 1440 * 4) if ((await at(jd)) > 0.99) on.push(jd);
  const best = { jd: ((on[0] ?? found) + (on[on.length - 1] ?? found)) / 2 };
  // From the Sun's side, a little off its line (so Io is not in front of its own shadow): the spot near
  // the middle of the lit disc, and three hours later (Io's shadow gone on) none there.
  const darkest = async (jd: number): Promise<{ least: number; median: number }> => {
    await at(jd);
    // (Io, between the Sun and Jupiter, is behind the camera: 300,000 km out, inside its orbit.)
    await place(page, { body: 'jupiter', distanceKm: 3e5, from: 'sun', azimuthDeg: 6 });
    await step(page, 90);
    const j = (await view(page))?.bodies.find((b) => b.id === 'jupiter')?.screen ?? { x: 640, y: 400, radiusPx: 100 };
    const r = Math.round(j.radiusPx * 0.55);
    const png = (await page.screenshot({ style: HIDE_UI, clip: { x: Math.round(j.x - r), y: Math.round(j.y - r), width: 2 * r, height: 2 * r } })) as Uint8Array;
    let binary = '';
    for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
    return page.evaluate(async (base64) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D context unavailable');
      context.drawImage(bitmap, 0, 0);
      const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const luma = (x: number, y: number): number => {
        const i = (y * width + x) * 4;
        return 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
      };
      // The darkest 3 x 3 patch, and the median, inside the disc's middle.
      const all: number[] = [];
      let least = Infinity;
      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          all.push(luma(x, y));
          let s = 0;
          for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) s += luma(x + dx, y + dy);
          least = Math.min(least, s / 9);
        }
      }
      all.sort((a, b) => a - b);
      return { least, median: all[Math.floor(all.length / 2)] ?? 0 };
    }, btoa(binary));
  };
  // In the shadow's umbra (about 8 px across here) the cloud tops are black; Jupiter's own darkest
  // features (its belts, a brown oval) are a quarter of its middle's light or more.
  const transit = await darkest(best.jd);
  const later = await darkest(best.jd + 0.125);
  expect(transit.least, JSON.stringify(transit)).toBeLessThan(0.12 * transit.median);
  expect(later.least, JSON.stringify(later)).toBeGreaterThan(0.15 * later.median);
  expect(pageErrors).toEqual([]);
});

test('the worlds are hidden in an experiment, on foot, on the way down and among the stars, and come back after', async ({ page, kf, pageErrors }) => {
  test.setTimeout(360_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await worldsShown(page);
  const hidden = async (what: string): Promise<void> => {
    await expect.poll(async () => (await worlds(page))?.shown ?? 1, { ...LIVE, message: what }).toBe(0);
  };
  const back = async (): Promise<void> => {
    await expect.poll(async () => (await worlds(page))?.shown ?? 0, LIVE).toBeGreaterThan(0.99);
  };
  // An experiment.
  await page.getByTestId('lab-open').click();
  await expect.poll(async () => (await view(page))?.lab !== null, LIVE).toBe(true);
  await hidden('in an experiment');
  await page.getByTestId('lab-back').click();
  await expect.poll(async () => (await view(page))?.lab, LIVE).toBeNull();
  await back();
  // On foot.
  await page.evaluate(() => { (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', lat: 21.9, lon: 39.8262 }); });
  await expect.poll(async () => (await view(page))?.walk?.state, LIVE).toBe('walking');
  await hidden('on foot');
  await page.evaluate(() => { (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walkEnd' }); });
  await expect.poll(async () => (await view(page))?.walk, LIVE).toBeNull();
  await back();
  // On the way down into Jupiter.
  await page.evaluate(() => { (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'descent', world: 'jupiter' }); });
  await expect.poll(async () => (await view(page))?.descent !== null, LIVE).toBe(true);
  await hidden('on the way down');
  await page.evaluate(() => { (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'descentEnd' }); });
  await expect.poll(async () => (await view(page))?.descent, LIVE).toBeNull();
  await back();
  // Among the stars the solar system is not drawn: no world's name either.
  await page.evaluate(() => { (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'stars' }); });
  await expect.poll(async () => (await view(page))?.neighbourhood !== null, LIVE).toBe(true);
  await page.waitForTimeout(1500);
  const names = (await worlds(page))?.list.map((w) => w.name) ?? [];
  const tags = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.kf-hud-tag')].filter((t) => Number(t.style.opacity || '1') > 0.05).map((t) => t.textContent));
  expect(tags.filter((t) => names.includes(t))).toEqual([]);
  await page.evaluate(() => { (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'starsEnd' }); });
  await expect.poll(async () => (await view(page))?.neighbourhood, LIVE).toBeNull();
  await back();
  expect(pageErrors).toEqual([]);
});

test('the detail ladder spammed and a 30-days-a-second clock pressed in bursts: the right count, no leak, no error', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/jupiter', { query: { jd: JD, detail: 'high' } });
  await waitForUniverse(page);
  await command(page, { kind: 'smallBodies', on: true });
  await expect.poll(async () => (await worlds(page))?.asteroids, LIVE).toBe(250_000);
  const choose = async (tier: string): Promise<void> => {
    await page.getByTestId('universe-detail').click();
    await page.getByTestId(`universe-detail-${tier}`).click();
  };
  const memory = async (): Promise<{ geometries: number; textures: number; worlds: { maps: number; asteroidSlots: number } }> => ({
    ...(await page.evaluate(() => (window as unknown as KfHook).__kf.frameStats().memory)),
    worlds: (await worlds(page))?.gpu ?? { maps: -1, asteroidSlots: -1 },
  });
  // The ladder as this backend offers it (WebGL2 has no Ultra), Low last.
  const available = (await view(page))?.detail.available ?? [];
  const ladder = [...['low', 'medium', 'high', 'ultra'].filter((t) => (available as readonly string[]).includes(t)), 'low'];
  // Round the ladder twice to reach a steady set (every map and file the levels use), then five more times.
  for (let round = 0; round < 2; round += 1) for (const tier of ladder) await choose(tier);
  await expect.poll(async () => (await worlds(page))?.asteroids, LIVE).toBe(20_000);
  await page.waitForTimeout(3000);
  const before = await memory();
  for (let round = 0; round < 5; round += 1) for (const tier of ladder) await choose(tier);
  await expect.poll(async () => (await worlds(page))?.asteroids, LIVE).toBe(20_000);
  await page.waitForTimeout(3000);
  const after = await memory();
  // What the worlds hold is level: their maps (one size or the other, let go when unseen) and the
  // asteroids' slots; and no texture more in all. (The explorer's own geometries can grow by a few over
  // such a spam on WebGL2, as at the commit before the worlds: that is not the worlds'.)
  expect(after.textures, 'textures').toBeLessThanOrEqual(before.textures);
  expect(after.worlds.maps, 'the worlds’ maps').toBeLessThanOrEqual(before.worlds.maps);
  expect(after.worlds.asteroidSlots, 'the asteroids’ slots').toBe(before.worlds.asteroidSlots);
  // A month a second, then bursts of Faster, Slower and back, the clock reversed and on again.
  await page.evaluate(() => { (window as unknown as KfHook).__kf.app.universeTime({ kind: 'rate', rate: 2_592_000 }); });
  for (let k = 0; k < 6; k += 1) {
    await page.evaluate(() => {
      const t = (window as unknown as KfHook).__kf.app;
      for (const kind of ['faster', 'faster', 'slower', 'reverse', 'slower', 'reverse', 'faster'] as const) t.universeTime({ kind });
    });
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => { (window as unknown as KfHook).__kf.app.universeTime({ kind: 'rate', rate: 2_592_000 }); });
  await page.waitForTimeout(3000);
  const v = await view(page);
  expect(v?.worlds?.asteroids).toBe(20_000);
  expect(Number.isFinite(v?.jdTdb ?? NaN)).toBe(true);
  expect(pageErrors).toEqual([]);
});
