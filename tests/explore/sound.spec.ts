/**
 * Sound where there is air (src/explore/sound.ts; ledger CR-6), in the browser: none in space; on
 * Mars, the wind (its air's density from the constants, at the feet); on the Moon, only the suit's
 * fans; the visitor's choice to turn it off kept across a reload. What plays is read from the view:
 * the sound itself is the browser's.
 */
import type { Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, view, waitForUniverse } from '../support/universe';

test.use({ reducedMotion: 'reduce' });

const LIVE = { timeout: 60_000 * SLOW };
const sound = async (page: Page) => (await view(page))?.sound ?? null;
const walkOn = (page: Page, world: 'mars' | 'moon', lat: number, lon: number): Promise<void> =>
  page.evaluate(
    ([w, la, lo]) => {
      (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', world: w, lat: la, lon: lo });
    },
    [world, lat, lon] as const,
  );

test('sound only where there is air: none in space, Mars’s wind, the suit’s fans on the Moon, and off when asked', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/mars', { query: { jd: JD } });
  await waitForUniverse(page);
  // A key pressed lets sound begin (browsers ask for a touch of the page first); in space there is none.
  await page.keyboard.press('Shift');
  await expect.poll(async () => (await sound(page))?.on, LIVE).toBe(true);
  expect((await sound(page))?.playing).toBeNull();
  await expect(page.getByTestId('universe-sound')).toHaveAttribute('aria-pressed', 'true');
  // On foot in Jezero crater: the wind.
  await walkOn(page, 'mars', 18.4, 77.5);
  await expect.poll(async () => (await view(page))?.walk?.state, LIVE).toBe('walking');
  await expect.poll(async () => (await sound(page))?.playing, LIVE).toBe('wind');
  // Turned off (in the navigator, which landing folds): nothing plays.
  await page.getByTestId('universe-nav-toggle').click();
  await page.getByTestId('universe-sound').click();
  await expect(page.getByTestId('universe-sound')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await sound(page))?.playing, LIVE).toBeNull();
  // On again, and on the Moon: only the suit's fans.
  await page.getByTestId('universe-sound').click();
  await walkOn(page, 'moon', 0.674, 23.473);
  await expect.poll(async () => (await view(page))?.walk?.world, LIVE).toBe('moon');
  await expect.poll(async () => (await view(page))?.walk?.state, LIVE).toBe('walking');
  await expect.poll(async () => (await sound(page))?.playing, LIVE).toBe('suit');
  // Off (the navigator folded again by the new landing), and kept off across a reload.
  await expect(page.getByTestId('universe-nav-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('universe-nav-toggle').click();
  await page.getByTestId('universe-sound').click();
  await page.reload();
  await waitForUniverse(page);
  await expect(page.getByTestId('universe-sound')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await sound(page))?.on, LIVE).toBe(false);
  expect(pageErrors).toEqual([]);
});
