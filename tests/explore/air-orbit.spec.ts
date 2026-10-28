/**
 * The Earth's air and the night sky's glows seen from orbit (src/explore/bodies/atmosphere.ts,
 * src/explore/render/air.ts, src/explore/worlds/glow.ts, the explorer's NIGHT_SKY):
 *
 * - over the sunglint from 8,000 km the cloud tops stay white to the limb under the haze; before, the
 *   shell's dimming was taken back by at most 3 times where it needs hundreds, and a cream band with a
 *   pink line ran along the limb (red less blue about 25 to 31 levels);
 * - with a crescent filling the exposure the sky beside the Sun is black (it was a flat beige plateau
 *   of about 80 levels: the zodiacal light, which a camera exposed for the day side does not record),
 *   and the readout names no glow; from the night side, the eye adapted to the dark, the glow is shown.
 *
 * The views are the visual captures' own (tests/visual/capture.spec.ts), on the manual clock.
 */
import type { Page } from '@playwright/test';
import type { UniversePose } from '../../src/core/types';
import { expect, test } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, place, step, view, waitForUniverse } from '../support/universe';

const HIDE_UI = 'body > :not(#scene) { visibility: hidden !important; }';
const LIVE = { timeout: 60_000 * SLOW };

test.use({ viewport: { width: 1440, height: 900 } });

/** The canvas's pixels (RGBA, 8-bit) in a box (CSS px), the interface hidden. */
async function pixels(page: Page, x: number, y: number, w: number, h: number): Promise<number[]> {
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
    return Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data);
  }, btoa(binary));
}

/** Opens the Earth and waits for the worlds (and so the glows) to be shown, on the real clock. */
async function open(page: Page, kf: { open(route: string, options?: { query?: Record<string, string> }): Promise<void> }): Promise<void> {
  await kf.open('/universe/earth', { query: { jd: JD, detail: 'high', tier: 'high' } });
  await waitForUniverse(page);
  await expect.poll(async () => (await view(page))?.worlds?.shown ?? 0, LIVE).toBeGreaterThan(0.99);
}

/** Places the camera, lets the eased values settle on the manual clock and the maps for the place arrive. */
async function settle(page: Page, pose: UniversePose): Promise<void> {
  await place(page, pose);
  await step(page, 180);
  await page.waitForTimeout(4000);
  await step(page, 120);
}

test('from orbit the cloud tops at the limb are white under the haze, not reddened', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await open(page, kf);
  await settle(page, { body: 'earth', distanceKm: 8000, azimuthDeg: 0, elevationDeg: 0 });
  // Columns across the top of the disc: below the first bright pixel (the cloud at the limb), the next eight rows.
  const top = 100;
  const data = await pixels(page, 560, top, 320, 160);
  let columns = 0;
  for (let x = 0; x < 320; x += 20) {
    let limb = -1;
    for (let y = 0; y < 150 && limb < 0; y += 1) {
      const i = (y * 320 + x) * 4;
      if (0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0) > 150) limb = y;
    }
    if (limb < 0 || limb + 9 >= 160) continue;
    columns += 1;
    let warm = 0;
    for (let y = limb + 1; y <= limb + 8; y += 1) {
      const i = (y * 320 + x) * 4;
      warm += ((data[i] ?? 0) - (data[i + 2] ?? 0)) / 8;
    }
    expect(warm, `red less blue below the limb at x = ${560 + x}, y = ${top + limb}`).toBeLessThan(12);
  }
  expect(columns, 'cloud at the limb in enough columns').toBeGreaterThanOrEqual(5);
  expect(pageErrors).toEqual([]);
});

test('the night sky’s glows: none beside the Sun while a crescent sets the exposure, shown from the night side', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await open(page, kf);
  // The crescent from 45,000 km, the Sun at the left of the view: the sky between them.
  await settle(page, { body: 'earth', distanceKm: 45_000, azimuthDeg: 145, elevationDeg: 5 });
  const sky = await pixels(page, 290, 350, 20, 20);
  let luma = 0;
  for (let i = 0; i < sky.length; i += 4) luma += (0.2126 * (sky[i] ?? 0) + 0.7152 * (sky[i + 1] ?? 0) + 0.0722 * (sky[i + 2] ?? 0)) / (sky.length / 4);
  expect(luma, 'the sky beside the Sun, beside a crescent').toBeLessThan(10);
  expect((await view(page))?.illustrative ?? []).not.toContain('sky-glow');
  // The night side from 30,000 km, the eye adapted to the dark: the zodiacal light about the Sun shows.
  await settle(page, { body: 'earth', distanceKm: 30_000, azimuthDeg: 180, elevationDeg: 20 });
  await expect.poll(async () => (await view(page))?.illustrative ?? [], LIVE).toContain('sky-glow');
  expect(pageErrors).toEqual([]);
});
