/**
 * On foot on the Earth in the browser (src/explore/walk, src/ui/explore/walk-hud): a walk begun at the
 * point below lands on the ground (the mocked terrain is flat at MOCK_GROUND_M) with the suit's readout
 * (the ground's height, the Earth's gravity, the air's pressure at that height from the cited
 * sea-level pressure and scale height); W walks, R jumps, a drag turns; Esc goes back to orbit as it
 * was; the on-screen pad walks as the keys do; a walk at Makkah is refused, as its framing rule
 * keeps every view 25 km away; and a world chosen from the navigator ends a walk. Reduced motion, so
 * flights land at once.
 */
import type { Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { MOCK_GROUND_M } from '../support/live';
import { JD, place, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 60_000 * SLOW };

test.use({ reducedMotion: 'reduce' });

const walkView = async (page: Page) => (await view(page))?.walk ?? null;

test('on foot: landing on the ground below, the suit’s figures, walking, jumping, turning, and back to orbit', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  // Over the Sahara's middle, low enough for the Earth's surface to be the point below.
  await place(page, { body: 'earth', distanceKm: 20_000, azimuthDeg: 30, elevationDeg: 20 });
  const above = await view(page);
  await page.getByTestId('living-earth').locator(':scope > summary').click();
  await page.getByTestId('living-walk').click();
  await expect.poll(async () => (await walkView(page))?.state, LIVE).toBe('walking');
  const w = await walkView(page);
  expect(w?.groundM).toBeCloseTo(MOCK_GROUND_M, 3);
  expect(w?.feetM).toBeCloseTo(MOCK_GROUND_M, 3);
  // The Earth's GM (DE440) at its mean radius: 9.82 m/s^2; the air at 1 km, 101.4 x e^(-1 / 8.5) kPa.
  expect(w?.gravity).toBeCloseTo(9.82, 2);
  expect(w?.pressureKpa).toBeCloseTo(101.4 * Math.exp(-1 / 8.5), 2);
  await expect(page.getByTestId('walk-hud')).toBeVisible();
  await expect(page.getByTestId('walk-ground')).toContainText('1,000 m above sea level');
  await expect(page.getByTestId('walk-gravity')).toContainText('9.82 m/s²');
  await expect(page.getByTestId('walk-air')).toContainText('90.1 kPa');
  await expect(page.getByTestId('universe-readout')).toBeHidden();
  // The ground's rings fill, the camera stands 1.7 m above the ground (the eye), not in orbit.
  await expect.poll(async () => (await walkView(page))?.rings ?? 0, LIVE).toBeGreaterThan(5);
  expect((await view(page))?.altitudeKm ?? Infinity).toBeLessThan(5);

  // W walks (a second's walk is about 1.4 m), a drag turns, R jumps.
  // Keys go to the explorer from anywhere but a field: the focus leaves the button that began the walk.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const start = await walkView(page);
  // Held until it has gone half a metre: a slow machine's frames come seldom, and each advances the walker at most 0.2 s.
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await walkView(page))?.walkedM ?? 0, LIVE).toBeGreaterThan(0.5);
  await page.keyboard.up('KeyW');
  const moved = await walkView(page);
  expect(Math.hypot((moved?.lat ?? 0) - (start?.lat ?? 0), (moved?.lon ?? 0) - (start?.lon ?? 0))).toBeGreaterThan(0);
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
  }
  await expect.poll(async () => Math.abs(((await walkView(page))?.headingDeg ?? 0) - (moved?.headingDeg ?? 0)), LIVE).toBeGreaterThan(10);
  await page.keyboard.down('KeyR');
  await expect.poll(async () => ((await walkView(page))?.feetM ?? 0) - MOCK_GROUND_M, LIVE).toBeGreaterThan(0.05);
  await page.keyboard.up('KeyR');
  await expect.poll(async () => (await walkView(page))?.airborne, LIVE).toBe(false);

  // The on-screen pad walks too (held down with the mouse, as on a touch screen).
  const padded = (await walkView(page))?.walkedM ?? 0;
  const forward = await page.getByTestId('walk-forward').boundingBox();
  expect(forward).not.toBeNull();
  await page.mouse.move((forward?.x ?? 0) + (forward?.width ?? 0) / 2, (forward?.y ?? 0) + (forward?.height ?? 0) / 2);
  await page.mouse.down();
  await expect.poll(async () => ((await walkView(page))?.walkedM ?? 0) - padded, LIVE).toBeGreaterThan(0.5);
  await page.mouse.up();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // Esc: back to orbit, where the camera was.
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await view(page))?.walk, LIVE).toBeNull();
  await expect(page.getByTestId('walk-hud')).toBeHidden();
  await expect(page.getByTestId('universe-readout')).toBeVisible();
  await expect.poll(async () => (await view(page))?.altitudeKm ?? 0, LIVE).toBeGreaterThan((above?.altitudeKm ?? 0) * 0.9);
  expect(pageErrors).toEqual([]);
});

test('no walk begins at Makkah: its framing rule keeps every view 25 km away; a trip elsewhere ends a walk', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', lat: 21.4225, lon: 39.8262 });
  });
  await expect.poll(async () => (await view(page))?.walkRefused, LIVE).toBe(true);
  expect((await view(page))?.walk).toBeNull();
  await expect(page.getByTestId('walk-notice')).toContainText('not begun within 25 km of Makkah');
  // Further off, a walk begins.
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', lat: 21.9, lon: 39.8262 });
  });
  await expect.poll(async () => (await view(page))?.walk?.state, LIVE).toBe('walking');
  expect((await view(page))?.walkRefused).toBe(false);
  // A world chosen from the navigator ends the walk (the trip goes from orbit, not from the ground).
  await page.getByTestId('universe-bodies').getByRole('button', { name: 'Moon', exact: true }).click();
  await expect.poll(async () => (await view(page))?.walk, LIVE).toBeNull();
  await expect(page.getByTestId('walk-hud')).toBeHidden();
  expect(pageErrors).toEqual([]);
});
