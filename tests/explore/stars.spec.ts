/**
 * Among the stars (ledger IS-2 to IS-4, IS-7), in the browser: out of the solar system to the Sun's
 * neighbourhood, the stars nearest it, a flight to Proxima Centauri (its distance, its planets with
 * the archive's calculated values marked, drawn round it), a search that finds Sirius and flies there,
 * Esc stopping a flight and then going back to the solar system as it was. Reduced motion.
 */
import type { Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, view, waitForUniverse } from '../support/universe';

test.use({ reducedMotion: 'reduce' });

const LIVE = { timeout: 60_000 * SLOW };
const stars = async (page: Page) => (await view(page))?.neighbourhood ?? null;

test('out among the stars: the Sun’s neighbours, Proxima Centauri and its planets, Sirius found and flown to, and back', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('stars-open').click();
  await expect.poll(async () => (await stars(page))?.focus.name ?? null, LIVE).toBe('Sun');
  await expect(page.getByTestId('stars-panel')).toBeVisible(LIVE);
  // The solar system's readout and its bodies' list step aside.
  await expect(page.getByTestId('universe-readout')).toBeHidden();
  await expect(page.getByTestId('stars-nearest')).toContainText('Proxima Centauri');
  // To Proxima Centauri: 4.23 light years from the Sun, its two planets drawn round it.
  await page.getByTestId('stars-nearest').getByRole('button', { name: /Proxima Centauri/u }).click();
  await expect.poll(async () => (await stars(page))?.focus.name, LIVE).toBe('Proxima Centauri');
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  const n = await stars(page);
  expect(n?.focus.distLy ?? 0).toBeCloseTo(4.23, 2);
  expect(n?.focus.planets.length).toBeGreaterThanOrEqual(2);
  expect(n?.systemShown).toBe(true);
  await expect(page.getByTestId('stars-distance')).toContainText('4.23 light years');
  await expect(page.getByTestId('stars-planets')).toContainText('Proxima Cen b');
  await expect(page.getByTestId('stars-planets')).toContainText('(calculated)');
  // Search: Sirius, and a flight there.
  await page.getByTestId('stars-search').fill('Sirius');
  await expect(page.getByTestId('stars-results')).toContainText('Sirius');
  await page.getByTestId('stars-results').getByRole('button', { name: /Sirius/u }).click();
  await expect.poll(async () => (await stars(page))?.focus.name, LIVE).toBe('Sirius');
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  expect((await stars(page))?.focus.distLy ?? 0).toBeCloseTo(8.6, 1);
  // A flight stopped by Esc, then Esc goes back to the solar system.
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'starsGoTo', hip: null });
  });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  await page.keyboard.press('Escape');
  await expect.poll(async () => await stars(page), LIVE).toBeNull();
  await expect(page.getByTestId('universe-readout')).toBeVisible({ timeout: 120_000 * SLOW });
  expect((await view(page))?.focus).toBe('earth');
  expect(pageErrors).toEqual([]);
});

test('beyond the stars: the Milky Way from above, Andromeda’s figures, the Local Group, the survey’s galaxies, and searching a galaxy', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('stars-open').click();
  await expect.poll(async () => (await stars(page))?.focus.name ?? null, LIVE).toBe('Sun');
  const hud = (): Promise<string[]> => page.evaluate(() => (window as unknown as KfHook).__kf.app.hud().labels.map((l) => l.id));
  const go = async (id: string): Promise<void> => {
    await page.getByTestId(`stars-place-${id}`).click();
    await expect.poll(async () => (await stars(page))?.place?.id, LIVE).toBe(id);
    await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  };
  // The Milky Way from above: at the galaxy's scale, its centre, the Sun and its arms named, the model said to be one.
  await go('milky-way');
  const mw = await stars(page);
  expect(mw?.scale).toBe('galaxy');
  expect(mw?.fromSunPc ?? 0).toBeGreaterThan(40_000);
  await expect.poll(async () => (await hud()).filter((id) => id.startsWith('beyond-arm-')).length, LIVE).toBeGreaterThanOrEqual(5);
  expect(await hud()).toEqual(expect.arrayContaining(['beyond-centre', 'beyond-sun']));
  await expect(page.getByTestId('stars-scale-note')).toContainText('a model, not a picture');
  // Andromeda: the catalogue's distance and type, its magnitude marked as derived, its size SIMBAD's.
  await go('andromeda');
  await expect(page.getByTestId('stars-focus-name')).toHaveText('Andromeda Galaxy');
  await expect(page.getByTestId('stars-distance')).toContainText('2.55 million light years (783 kpc)');
  await expect(page.getByTestId('stars-galaxy-type')).toHaveText('Sb');
  await expect(page.getByTestId('stars-absolute')).toContainText('(from its brightness and distance)');
  await expect(page.getByTestId('stars-galaxy-diameter')).toContainText('45.5 kpc (148 thousand light years)');
  await expect(page.getByTestId('stars-nearest')).toBeHidden();
  await expect.poll(async () => (await hud()).includes('beyond-galaxy-Andromeda'), LIVE).toBe(true);
  // The Local Group, its galaxies named; the Milky Way by its name.
  await go('local-group');
  expect((await stars(page))?.scale).toBe('local-group');
  await expect.poll(async () => (await hud()).includes('beyond-milky-way'), LIVE).toBe(true);
  expect(await hud()).toEqual(expect.arrayContaining(['beyond-galaxy-Andromeda', 'beyond-galaxy-Triangulum']));
  // The cosmic web: the survey's galaxies fetched and drawn, the note saying what they are.
  await go('web');
  expect((await stars(page))?.scale).toBe('universe');
  await expect.poll(async () => (await stars(page))?.webGalaxies ?? 0, LIVE).toBeGreaterThan(100_000);
  await expect(page.getByTestId('stars-scale-note')).toContainText('Sloan Digital Sky Survey');
  // A galaxy found by name, and flown to.
  await page.getByTestId('stars-search').fill('Sculptor');
  await page.getByTestId('stars-results').getByRole('button', { name: /Sculptor/u }).first().click();
  await expect.poll(async () => (await stars(page))?.place?.galaxy, LIVE).toBe('Sculptor');
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  await expect(page.getByTestId('stars-focus-name')).toHaveText('Sculptor');
  await expect(page.getByTestId('stars-galaxy-group')).toHaveText('the Milky Way');
  // Back to the Sun: the stars again, and their nearest.
  await page.getByTestId('stars-sun').click();
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  await expect.poll(async () => (await stars(page))?.scale, LIVE).toBe('stars');
  await expect(page.getByTestId('stars-nearest')).toBeVisible();
  expect(pageErrors).toEqual([]);
});
