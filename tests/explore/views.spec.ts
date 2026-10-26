/**
 * From orbit to the ground and back (ledger GR-3), and saved views (GR-4), in the browser. Walk here
 * glides the camera down over the place to the lowest orbit while the ground loads, then dips into
 * the walk; Esc dips back out and climbs back to the orbit it left. A view saved over the Moon (its place, height and
 * date) is kept across a reload and gone back to from the Earth (a trip, then a glide), with its date;
 * a view saved on foot begins the walk again where it stood, facing as it did; deleting empties the
 * list.
 */
import type { Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, place, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 60_000 * SLOW };
const walkView = async (page: Page) => (await view(page))?.walk ?? null;
const MOON_KM = 1737.4;
const UNIX_EPOCH_JD = 2440587.5;

test('the descent: Walk here glides down over the place before the walk, and Esc climbs back to the orbit it left', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/moon', { query: { jd: JD } });
  await waitForUniverse(page);
  await place(page, { body: 'moon', distanceKm: MOON_KM + 3000, azimuthDeg: 40, elevationDeg: 15 });
  await expect.poll(async () => (await view(page))?.walkHere?.world ?? null, LIVE).toBe('moon');
  const start = (await view(page))?.altitudeKm ?? 0;
  expect(start).toBeGreaterThan(2500);
  await page.getByTestId('world-walk').click();
  // Still in orbit, coming down: lower than it began, and landing (not yet walking).
  await expect.poll(async () => (await view(page))?.altitudeKm ?? Infinity, LIVE).toBeLessThan(start * 0.5);
  expect((await walkView(page))?.state).toBe('landing');
  // Then on the ground: the eye 1.7 m above it.
  await expect.poll(async () => (await walkView(page))?.state, LIVE).toBe('walking');
  await expect.poll(async () => (await view(page))?.altitudeKm ?? Infinity, LIVE).toBeLessThan(5);
  // Esc: the picture dips out of the walk, and the camera climbs back to the orbit it left.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await view(page))?.walk, LIVE).toBeNull();
  await expect.poll(async () => (await view(page))?.altitudeKm ?? 0, LIVE).toBeGreaterThan(start * 0.9);
  expect(pageErrors).toEqual([]);
});

test.describe('saved views', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a view over the Moon, kept across a reload, gone back to from the Earth with its date; deleted', async ({ page, kf, pageErrors }) => {
    test.setTimeout(300_000 * SLOW);
    await kf.open('/universe/moon', { query: { jd: JD } });
    await waitForUniverse(page);
    await place(page, { body: 'moon', distanceKm: MOON_KM + 4000, azimuthDeg: 30, elevationDeg: 10 });
    await expect.poll(async () => (await view(page))?.place?.body ?? null, LIVE).toBe('moon');
    const before = await view(page);
    const at = before?.place;
    expect(at).not.toBeNull();
    await page.getByTestId('saved-views').locator(':scope > summary').click();
    await expect(page.getByTestId('saved-empty')).toBeVisible();
    await page.getByTestId('saved-name').fill('Over the Moon');
    await page.getByTestId('saved-save').click();
    await expect(page.getByTestId('saved-list')).toContainText('Over the Moon');
    await expect(page.getByTestId('saved-list')).toContainText('Moon: ');
    await expect(page.getByTestId('saved-empty')).toBeHidden();
    // Kept across a reload (in this browser).
    await page.reload();
    await waitForUniverse(page);
    await page.getByTestId('saved-views').locator(':scope > summary').click();
    await expect(page.getByTestId('saved-list')).toContainText('Over the Moon');
    // From the Earth, a month later: back over the same place on the Moon, at the same height and date.
    await place(page, { body: 'earth', distanceKm: 30_000 });
    await page.evaluate((jd) => {
      (window as unknown as KfHook).__kf.app.universeTime({ kind: 'date', jdUtc: jd + 30 });
    }, Number(JD));
    await expect.poll(async () => (await view(page))?.focus, LIVE).toBe('earth');
    await page.getByTestId('saved-list').getByRole('button', { name: 'Go to Over the Moon' }).click();
    await expect.poll(async () => (await view(page))?.focus, LIVE).toBe('moon');
    await expect.poll(async () => {
      const p = (await view(page))?.place;
      return p ? Math.hypot(p.lat - (at?.lat ?? 0), ((p.lon - (at?.lon ?? 0) + 540) % 360) - 180) : Infinity;
    }, LIVE).toBeLessThan(1);
    expect(Math.abs(((await view(page))?.place?.altitudeKm ?? 0) - (at?.altitudeKm ?? 0)) / (at?.altitudeKm ?? 1)).toBeLessThan(0.05);
    const unixMs = (await view(page))?.unixMs ?? 0;
    expect(Math.abs(unixMs / 86_400_000 + UNIX_EPOCH_JD - Number(JD))).toBeLessThan(0.01);
    // Deleted: the list is empty again.
    await page.getByTestId('saved-list').getByRole('button', { name: 'Delete Over the Moon' }).click();
    await expect(page.getByTestId('saved-empty')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('a view saved on foot begins the walk again where it stood, facing as it did', async ({ page, kf, pageErrors }) => {
    test.setTimeout(300_000 * SLOW);
    await kf.open('/universe/moon', { query: { jd: JD } });
    await waitForUniverse(page);
    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', world: 'moon', lat: 0.67416, lon: 23.47314, headingDeg: 135, pitchDeg: -10 });
    });
    await expect.poll(async () => (await walkView(page))?.state, LIVE).toBe('walking');
    const stood = await walkView(page);
    expect(stood?.headingDeg).toBeCloseTo(135, 3);
    expect(stood?.pitchDeg).toBeCloseTo(-10, 3);
    // The navigator stays while walking (the readout from orbit hides): its saved views keep the walk.
    await page.getByTestId('saved-views').locator(':scope > summary').click();
    await page.getByTestId('saved-name').fill('Tranquillity');
    await page.getByTestId('saved-save').click();
    await expect(page.getByTestId('saved-list')).toContainText('Moon: on foot at');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await view(page))?.walk, LIVE).toBeNull();
    await page.getByTestId('saved-list').getByRole('button', { name: 'Go to Tranquillity' }).click();
    await expect.poll(async () => (await walkView(page))?.state, LIVE).toBe('walking');
    const again = await walkView(page);
    expect(Math.hypot((again?.lat ?? 0) - (stood?.lat ?? 0), (again?.lon ?? 0) - (stood?.lon ?? 0))).toBeLessThan(1e-6);
    expect(again?.headingDeg).toBeCloseTo(135, 3);
    expect(again?.pitchDeg).toBeCloseTo(-10, 3);
    expect(pageErrors).toEqual([]);
  });
});
