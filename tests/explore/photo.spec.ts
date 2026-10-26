/**
 * Photo mode in the browser: the picture saved (ledger CR-1), the view as drawn, a PNG named for the
 * world and the date, with a band of credits below the picture (where and when, whose imagery, the
 * app and its Sources page) and the interface left out of it; a video recorded (CR-3); the lens and
 * the exposure (CR-2), each given back on leaving.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, place, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 60_000 * SLOW };

/** Photo mode's camera settings (the lens, the exposure, a body kept in view), folded under one button until it is opened. */
async function openCamera(page: Page): Promise<void> {
  const camera = page.getByTestId('universe-photo-camera');
  await expect(camera).toBeVisible(LIVE);
  if (!(await camera.evaluate((d) => (d as HTMLDetailsElement).open))) await camera.locator('summary').click();
}

test('photo mode saves the picture with its credits below it', async ({ page, kf, pageErrors }, info) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/mars', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('universe-photo').click();
  await expect(page.getByTestId('universe-photo-save')).toBeVisible();
  await expect(page.getByTestId('universe-bodies')).toBeHidden();
  const canvas = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return { width: c?.width ?? 0, height: c?.height ?? 0 };
  });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 * SLOW }), page.getByTestId('universe-photo-save').click()]);
  expect(download.suggestedFilename()).toMatch(/^kun-fayakun-mars-2026-10-23\.png$/u);
  const path = info.outputPath('picture.png');
  await download.saveAs(path);
  const png: Uint8Array = readFileSync(new URL(`file://${encodeURI(path)}`));
  const bytes = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // A PNG: its signature ("PNG" after the first byte), and its header's size: the canvas's width, and
  // its height with the credits' band below (big-endian, at bytes 16 and 20).
  expect([png[1], png[2], png[3]]).toEqual([0x50, 0x4e, 0x47]);
  expect(bytes.getUint32(16)).toBe(canvas.width);
  expect(bytes.getUint32(20)).toBeGreaterThan(canvas.height + 40);
  // Said to a screen reader (the page's polite announcer).
  await expect(page.locator('.kf-sr-only[aria-live="polite"]').filter({ hasText: 'Picture saved, with its credits.' })).toHaveCount(1);
  // Back to the interface.
  await page.getByTestId('universe-photo-exit').click();
  await expect(page.getByTestId('universe-bodies')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('photo mode records a video of the view, with its credits, where the browser can', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/mars', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('universe-photo').click();
  const record = page.getByTestId('universe-photo-record');
  await expect(record).toBeVisible();
  await record.click();
  await expect(record).toHaveAttribute('aria-pressed', 'true');
  await expect(record).toHaveText('Stop and save the video');
  await page.waitForTimeout(2000);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 * SLOW }), record.click()]);
  expect(download.suggestedFilename()).toMatch(/^kun-fayakun-mars-2026-10-23\.(webm|mp4)$/u);
  const path = info(download);
  await download.saveAs(path.out);
  const bytes: Uint8Array = readFileSync(new URL(`file://${encodeURI(path.out)}`));
  // A WebM begins with EBML's magic number; some frames recorded.
  expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  expect(bytes.length).toBeGreaterThan(2000);
  await expect(record).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.kf-sr-only[aria-live="polite"]').filter({ hasText: 'Video saved, with its credits.' })).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('photo mode’s lens sets the camera’s field of view, and leaving gives the framing back', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/mars', { query: { jd: JD } });
  await waitForUniverse(page);
  // The camera's own field of view (the app's camera, through the test hook).
  const fov = (): Promise<number> => page.evaluate(() => (window as unknown as { __kf: { app: { camera: { fov: number } } } }).__kf.app.camera.fov);
  const framed = await fov();
  await page.getByTestId('universe-photo').click();
  await openCamera(page);
  await page.getByTestId('universe-photo-lens').selectOption('20');
  await expect.poll(async () => (await view(page))?.lensFov, LIVE).toBe(20);
  await expect.poll(fov, LIVE).toBeCloseTo(20, 6);
  // Leaving photo mode gives the explorer's own framing back.
  await page.getByTestId('universe-photo-exit').click();
  await expect.poll(async () => (await view(page))?.lensFov, LIVE).toBeNull();
  await expect.poll(fov, LIVE).toBeCloseTo(framed, 6);
  expect(pageErrors).toEqual([]);
});

test('photo mode’s exposure: whole stops through the flash-safe limiter, said in the picture’s credits, given back on leaving', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/mars', { query: { jd: JD } });
  await waitForUniverse(page);
  // The engine's applied exposure and its bias (the app's, through the test hook).
  const exposure = (): Promise<{ current: number; bias: number }> =>
    page.evaluate(() => {
      const app = (window as unknown as { __kf: { app: { exposure: { current: number }; exposureBiasStops: number } } }).__kf.app;
      return { current: app.exposure.current, bias: app.exposureBiasStops };
    });
  await page.getByTestId('universe-photo').click();
  // The view settled: the explorer's own exposure, steady.
  let before = 0;
  await expect
    .poll(async () => {
      const now = (await exposure()).current;
      const steady = before > 0 && Math.abs(now / before - 1) < 0.002;
      before = now;
      return steady;
    }, LIVE)
    .toBe(true);
  // One stop brighter: twice the light, reached by the limiter's ramp, not at once.
  await openCamera(page);
  await page.getByTestId('universe-photo-exposure').selectOption('1');
  expect((await exposure()).bias).toBe(1);
  await expect.poll(async () => (await exposure()).current / before, LIVE).toBeGreaterThan(1.98);
  expect((await exposure()).current / before).toBeLessThan(2.02);
  // The picture's credits say how it was exposed.
  await page.evaluate(() => {
    const w = window as unknown as { __kf: { app: { capturePicture(lines: readonly string[]): Promise<Blob | null> } }; kfLines?: readonly string[] };
    const app = w.__kf.app;
    const capture = app.capturePicture.bind(app);
    app.capturePicture = (lines) => {
      w.kfLines = lines;
      return capture(lines);
    };
  });
  await Promise.all([page.waitForEvent('download', { timeout: 30_000 * SLOW }), page.getByTestId('universe-photo-save').click()]);
  const lines = await page.evaluate(() => (window as unknown as { kfLines?: readonly string[] }).kfLines ?? []);
  expect(lines).toContain('Exposed 1 stop brighter than the explorer’s own exposure');
  // Two stops darker, then leaving: the explorer's own exposure again.
  await page.getByTestId('universe-photo-exposure').selectOption('-2');
  await expect.poll(async () => (await exposure()).current / before, LIVE).toBeLessThan(0.26);
  await page.getByTestId('universe-photo-exit').click();
  expect((await exposure()).bias).toBe(0);
  await expect.poll(async () => Math.abs((await exposure()).current / before - 1), LIVE).toBeLessThan(0.02);
  expect(pageErrors).toEqual([]);
});

test('photo mode keeps a body in its place in the frame as it moves round the world in view', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  // The Earth in view, the Moon beside it a little behind (100,000 km out, turned 12 degrees off the line to it).
  await place(page, { body: 'earth', distanceKm: 100_000, from: 'moon', azimuthDeg: 12, elevationDeg: 3 });
  // The Moon on screen relative to the Earth (photo mode frees the screen, and the Earth eases to its middle).
  const moonOnScreen = async (): Promise<{ x: number; y: number; inView: boolean; unixMs: number; earthX: number }> => {
    const v = await view(page);
    const m = v?.bodies.find((b) => b.id === 'moon')?.screen;
    const e = v?.bodies.find((b) => b.id === 'earth')?.screen;
    return { x: (m?.x ?? Number.NaN) - (e?.x ?? 0), y: (m?.y ?? Number.NaN) - (e?.y ?? 0), inView: m?.inView ?? false, unixMs: v?.unixMs ?? 0, earthX: e?.x ?? 0 };
  };
  const rate = (r: number): Promise<void> =>
    page.evaluate((x) => {
      (window as unknown as { __kf: { app: { universeTime(c: { kind: 'rate'; rate: number }): void } } }).__kf.app.universeTime({ kind: 'rate', rate: x });
    }, r);
  await page.getByTestId('universe-photo').click();
  await openCamera(page);
  await page.getByTestId('universe-photo-track').selectOption('moon');
  await expect.poll(async () => (await view(page))?.tracking, LIVE).toBe('moon');
  // The framing settled after the interface left.
  let lastX = Number.NaN;
  await expect
    .poll(async () => {
      const x = (await moonOnScreen()).earthX;
      const settled = Math.abs(x - lastX) < 0.5;
      lastX = x;
      return settled;
    }, LIVE)
    .toBe(true);
  const from = await moonOnScreen();
  expect(from.inView).toBe(true);
  // Two days at a day a second: the Moon goes some 26 degrees round the Earth, and keeps its place in the frame.
  await rate(86_400);
  await expect.poll(async () => (await moonOnScreen()).unixMs - from.unixMs, LIVE).toBeGreaterThan(2 * 86_400_000);
  await rate(0);
  const held = await moonOnScreen();
  expect(held.inView).toBe(true);
  // Within a few pixels (the Moon's distance and the tilt of its orbit change a little in two days).
  expect(Math.hypot(held.x - from.x, held.y - from.y)).toBeLessThan(15);
  // Kept no longer: two more days and it has gone its own way across the view.
  await page.getByTestId('universe-photo-track').selectOption('');
  await expect.poll(async () => (await view(page))?.tracking, LIVE).toBeNull();
  await rate(86_400);
  await expect.poll(async () => (await moonOnScreen()).unixMs - held.unixMs, LIVE).toBeGreaterThan(2 * 86_400_000);
  await rate(0);
  const free = await moonOnScreen();
  expect(!free.inView || Math.hypot(free.x - held.x, free.y - held.y) > 100).toBe(true);
  // Leaving photo mode ends it.
  await page.getByTestId('universe-photo-track').selectOption('moon');
  await page.getByTestId('universe-photo-exit').click();
  await expect.poll(async () => (await view(page))?.tracking, LIVE).toBeNull();
  expect(pageErrors).toEqual([]);
});

test.describe('the saved views as keyframes', () => {
  test.use({ reducedMotion: 'reduce' });

  test('photo mode flies through the saved views in the order they were saved, resting at each, and stops at the end', async ({ page, kf, pageErrors }) => {
    test.setTimeout(240_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    // Two views over the Earth, a quarter of the way round from each other, saved in turn.
    const saveHere = async (pose: Parameters<typeof place>[1], name: string): Promise<{ lat: number; lon: number }> => {
      await place(page, pose);
      await expect.poll(async () => (await view(page))?.place?.body ?? null, LIVE).toBe('earth');
      const at = (await view(page))?.place;
      await page.getByTestId('saved-name').fill(name);
      await page.getByTestId('saved-save').click();
      await expect(page.getByTestId('saved-list')).toContainText(name);
      return { lat: at?.lat ?? Number.NaN, lon: at?.lon ?? Number.NaN };
    };
    await page.getByTestId('saved-views').locator(':scope > summary').click();
    const a = await saveHere({ body: 'earth', distanceKm: 26_000, azimuthDeg: 10, elevationDeg: 15 }, 'First');
    const b = await saveHere({ body: 'earth', distanceKm: 26_000, azimuthDeg: 100, elevationDeg: -10 }, 'Second');
    const near = async (to: { lat: number; lon: number }): Promise<boolean> => {
      const p = (await view(page))?.place;
      return p !== null && p !== undefined && Math.abs(p.lat - to.lat) < 1 && Math.abs(((p.lon - to.lon + 540) % 360) - 180) < 1;
    };
    expect(await near(b)).toBe(true);
    // In photo mode: off to the first, a rest there, then the second, and the flight is over.
    await page.getByTestId('universe-photo').click();
    const tour = page.getByTestId('universe-photo-tour');
    await expect(tour).toBeVisible(LIVE);
    await tour.click();
    await expect(tour).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => near(a), LIVE).toBe(true);
    await expect.poll(() => near(b), LIVE).toBe(true);
    await expect(tour).toHaveAttribute('aria-pressed', 'false', LIVE);
    await expect(page.locator('.kf-sr-only[aria-live="polite"]').filter({ hasText: 'The flight through the saved views is over.' })).toHaveCount(1);
    expect(pageErrors).toEqual([]);
  });
});

const info = (download: { suggestedFilename(): string }): { out: string } => ({ out: test.info().outputPath(download.suggestedFilename()) });
