/**
 * On foot in the browser (src/explore/walk, src/ui/explore/walk-hud). On the Earth: a walk begun at the
 * point below lands on the ground (the mocked terrain is flat at MOCK_GROUND_M) with the suit's readout
 * (the ground's height, the Earth's gravity, the air's pressure at that height from the cited
 * sea-level pressure and scale height); W walks, R jumps, a drag turns; Esc goes back to orbit as it
 * was; the on-screen pad walks as the keys do; a walk at Makkah is refused, as its framing rule
 * keeps every view 25 km away; and a world chosen from the navigator ends a walk. On the Moon, Mars,
 * Mercury and Venus: the navigator's Walk here, the ground at Apollo 11's and Perseverance's landing
 * sites, in Rachmaninoff basin and at Venera 13's as LOLA, MOLA, MESSENGER and Magellan measured it
 * (public/assets/walk, read here as the page reads it), each world's gravity, the vacuum of the Moon
 * and Mercury, Mars's thin air and Venus's crushing one (under clouds no Sun shows through), and back
 * to orbit. Reduced motion, so flights land at once.
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
  test.setTimeout(300_000 * SLOW);
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
  // The interface follows on the next frame drawn; in software rendering (CI) the first frame back in
  // orbit compiles the globe's materials again and can take most of a minute.
  const NEXT_FRAME = { timeout: 120_000 * SLOW };
  await expect(page.getByTestId('walk-hud')).toBeHidden(NEXT_FRAME);
  await expect(page.getByTestId('universe-readout')).toBeVisible(NEXT_FRAME);
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

/**
 * The heights the walk stands on at a place, read from the world's detailed grid as the page reads it
 * (a terrarium PNG decoded in the browser, then bilinear between pixel centres): metres above the datum.
 */
type GridWorld = 'moon' | 'mars' | 'mercury' | 'venus';

const gridHeight = (page: Page, world: GridWorld, lat: number, lon: number): Promise<number> =>
  page.evaluate(
    async ([w, la, lo]) => {
      const list = (await (await fetch('assets/walk/heights.json')).json()) as { worlds: Record<string, { detail: { path: string; ppd: number; tileDeg: number } }> };
      const d = list.worlds[w]?.detail;
      if (!d) return Number.NaN;
      const col = Math.floor((((lo + 180) % 360) + 360) % 360 / d.tileDeg);
      const row = Math.floor((90 - la) / d.tileDeg);
      const blob = await (await fetch(d.path.replace('{col}', String(col)).replace('{row}', String(row)))).blob();
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return Number.NaN;
      context.drawImage(bitmap, 0, 0);
      const px = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const at = (c: number, r: number): number => {
        const i = (Math.max(0, Math.min(canvas.height - 1, r)) * canvas.width + Math.max(0, Math.min(canvas.width - 1, c))) * 4;
        return (px[i] ?? 0) * 256 + (px[i + 1] ?? 0) + (px[i + 2] ?? 0) / 256 - 32768;
      };
      const x = (lo - (-180 + col * d.tileDeg)) * d.ppd - 0.5;
      const y = (90 - row * d.tileDeg - la) * d.ppd - 0.5;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    },
    [world, lat, lon] as const,
  );

const walkAt = (page: Page, world: GridWorld, lat: number, lon: number): Promise<void> =>
  page.evaluate(
    ([w, la, lo]) => {
      (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', world: w, lat: la, lon: lo });
    },
    [world, lat, lon] as const,
  );

test('on foot on the Moon: Walk here from orbit, the ground LOLA measured at Apollo 11’s landing site, a sixth of the Earth’s gravity, no air, and back to orbit', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/moon', { query: { jd: JD } });
  await waitForUniverse(page);
  // The Earth's walk is in its Living Earth; the Moon's in the navigator, once the point below is known.
  await place(page, { body: 'moon', distanceKm: 5000, azimuthDeg: 40, elevationDeg: 15 });
  await expect.poll(async () => (await view(page))?.walkHere?.world ?? null, LIVE).toBe('moon');
  await expect(page.getByTestId('world-walk')).toBeEnabled();
  await expect(page.getByTestId('world-walk-entry')).toContainText('Stand on the Moon');
  await page.getByTestId('world-walk').click();
  await expect.poll(async () => (await walkView(page))?.state, LIVE).toBe('walking');
  const w = await walkView(page);
  expect(w?.world).toBe('moon');
  // The Moon's GM (DE440) at its mean radius: 1.62 m/s^2; no air; its equator's day from the fact sheet (95 K to 390 K).
  expect(w?.gravity).toBeCloseTo(1.624, 2);
  expect(w?.pressureKpa).toBeNull();
  expect(w?.dayRangeC?.min).toBeCloseTo(95 - 273.15, 6);
  expect(w?.dayRangeC?.max).toBeCloseTo(390 - 273.15, 6);
  await expect(page.getByTestId('walk-title')).toHaveText('On foot on the Moon');
  await expect(page.getByTestId('walk-air')).toContainText('No air: a vacuum');
  await expect(page.getByTestId('walk-air')).toContainText('from −178 °C before dawn to 117 °C at noon');
  await expect(page.getByTestId('walk-ground')).toContainText('the Moon’s 1,737.4 km sphere');
  await expect(page.getByTestId('walk-credit')).toContainText('LOLA');
  await expect(page.getByTestId('world-walk-entry')).toBeHidden();
  // Apollo 11's landing site (0.674 N, 23.473 E): the ground about 1.9 km below the reference sphere, as the grid holds it.
  await walkAt(page, 'moon', 0.67416, 23.47314);
  await expect.poll(async () => Math.hypot(((await walkView(page))?.lat ?? 0) - 0.67416, ((await walkView(page))?.lon ?? 0) - 23.47314), LIVE).toBeLessThan(1e-6);
  await expect.poll(async () => (await walkView(page))?.state, LIVE).toBe('walking');
  const expected = await gridHeight(page, 'moon', 0.67416, 23.47314);
  expect(expected).toBeGreaterThan(-2000);
  expect(expected).toBeLessThan(-1850);
  expect(Math.abs(((await walkView(page))?.groundM ?? 0) - expected)).toBeLessThan(40);
  await expect(page.getByTestId('walk-ground')).toContainText(' m below the Moon’s 1,737.4 km sphere');
  // A walk forward on the Moon, then Esc: back to orbit.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await walkView(page))?.walkedM ?? 0, LIVE).toBeGreaterThan(0.5);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await view(page))?.walk, LIVE).toBeNull();
  await expect(page.getByTestId('walk-hud')).toBeHidden({ timeout: 120_000 * SLOW });
  expect(pageErrors).toEqual([]);
});

test('on foot on Mars: the ground MOLA measured in Jezero crater, its gravity, its thin air at the walker’s height, and its sky', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/mars', { query: { jd: JD } });
  await waitForUniverse(page);
  // Perseverance's landing site in Jezero crater (18.445 N, 77.451 E).
  await walkAt(page, 'mars', 18.4447, 77.4508);
  await expect.poll(async () => (await walkView(page))?.state, LIVE).toBe('walking');
  const w = await walkView(page);
  expect(w?.world).toBe('mars');
  expect(w?.gravity).toBeCloseTo(3.728, 2);
  const expected = await gridHeight(page, 'mars', 18.4447, 77.4508);
  expect(expected).toBeGreaterThan(-2650);
  expect(expected).toBeLessThan(-2450);
  expect(Math.abs((w?.groundM ?? 0) - expected)).toBeLessThan(40);
  // The air at the walker's height: the fact sheet's 0.636 kPa at the datum, rising by e every 11.0 km below it.
  expect(w?.pressureKpa ?? 0).toBeCloseTo(0.636 * Math.exp(-(w?.feetM ?? 0) / 1000 / 11), 6);
  expect(w?.pressureKpa ?? 0).toBeGreaterThan(0.75);
  expect(w?.meanTempC).toBeCloseTo(214 - 273.15, 6);
  await expect(page.getByTestId('walk-title')).toHaveText('On foot on Mars');
  await expect(page.getByTestId('walk-air')).toContainText('mostly carbon dioxide');
  await expect(page.getByTestId('walk-air')).toContainText('−59 °C (not today’s)');
  await expect(page.getByTestId('walk-ground')).toContainText(' m below Mars’s areoid');
  await expect(page.getByTestId('walk-credit')).toContainText('MOLA');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await view(page))?.walk, LIVE).toBeNull();
  expect(pageErrors).toEqual([]);
});

test('on foot on Mercury: Walk here, the ground MESSENGER measured in Rachmaninoff basin, its gravity, a vacuum and its hot sunward side', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/mercury', { query: { jd: JD } });
  await waitForUniverse(page);
  await place(page, { body: 'mercury', distanceKm: 7000, azimuthDeg: 40, elevationDeg: 15 });
  await expect.poll(async () => (await view(page))?.walkHere?.world ?? null, LIVE).toBe('mercury');
  await expect(page.getByTestId('world-walk-entry')).toContainText('Stand on Mercury');
  await page.getByTestId('world-walk').click();
  await expect.poll(async () => (await walkView(page))?.state, LIVE).toBe('walking');
  // Rachmaninoff basin's floor (27.6 N, 57.6 E).
  await walkAt(page, 'mercury', 27.6, 57.6);
  await expect.poll(async () => Math.hypot(((await walkView(page))?.lat ?? 0) - 27.6, ((await walkView(page))?.lon ?? 0) - 57.6), LIVE).toBeLessThan(1e-6);
  await expect.poll(async () => (await walkView(page))?.state, LIVE).toBe('walking');
  const w = await walkView(page);
  expect(w?.world).toBe('mercury');
  // Mercury's GM (DE440) at its mean radius: 3.70 m/s^2, as its fact sheet gives it.
  expect(w?.gravity).toBeCloseTo(3.70, 2);
  expect(w?.pressureKpa).toBeNull();
  expect(w?.meanTempC).toBeCloseTo(440 - 273.15, 6);
  const expected = await gridHeight(page, 'mercury', 27.6, 57.6);
  expect(Math.abs((w?.groundM ?? 0) - expected)).toBeLessThan(40);
  await expect(page.getByTestId('walk-title')).toHaveText('On foot on Mercury');
  await expect(page.getByTestId('walk-air')).toContainText('No air: a vacuum');
  await expect(page.getByTestId('walk-air')).toContainText('averages 167 °C, and 317 to 452 °C on the side toward the Sun');
  await expect(page.getByTestId('walk-ground')).toContainText('Mercury’s 2,439.4 km sphere');
  await expect(page.getByTestId('walk-credit')).toContainText('MESSENGER');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await view(page))?.walk, LIVE).toBeNull();
  expect(pageErrors).toEqual([]);
});

test('on foot on Venus: the ground Magellan measured at Venera 13’s landing site, its gravity, its crushing air at the walker’s height, and no Sun through the clouds', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/venus', { query: { jd: JD } });
  await waitForUniverse(page);
  // Venera 13's landing site (7.55 S, 303.69 E).
  await walkAt(page, 'venus', -7.55, -56.31);
  await expect.poll(async () => (await walkView(page))?.state, LIVE).toBe('walking');
  const w = await walkView(page);
  expect(w?.world).toBe('venus');
  expect(w?.gravity).toBeCloseTo(8.87, 2);
  const expected = await gridHeight(page, 'venus', -7.55, -56.31);
  expect(Math.abs((w?.groundM ?? 0) - expected)).toBeLessThan(40);
  // The fact sheet's 92 bar at the mean radius, falling by e every 15.9 km.
  expect(w?.pressureKpa ?? 0).toBeCloseTo(9200 * Math.exp(-(w?.feetM ?? 0) / 1000 / 15.9), 4);
  expect(w?.meanTempC).toBeCloseTo(737 - 273.15, 6);
  expect(w?.sunSeen).toBe(false);
  await expect(page.getByTestId('walk-title')).toHaveText('On foot on Venus');
  await expect(page.getByTestId('walk-air')).toContainText('mostly carbon dioxide');
  await expect(page.getByTestId('walk-air')).toContainText('464 °C (not today’s)');
  await expect(page.getByTestId('walk-ground')).toContainText('Venus’s mean radius, 6,051.8 km');
  await expect(page.getByTestId('walk-credit')).toContainText('Magellan');
  if ((w?.sunElevationDeg ?? -1) >= 0) await expect(page.getByTestId('walk-sun')).toContainText('unseen behind the clouds');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await view(page))?.walk, LIVE).toBeNull();
  expect(pageErrors).toEqual([]);
});
