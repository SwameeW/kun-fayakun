/**
 * Lessons in the orbital laboratory (ledger CR-4), in the browser: Kepler's third law (a year 2.828
 * times as long at twice the distance), escape speed (an orbit opened by a push past it), and a
 * Hohmann transfer (its first burn planned and run, the orbit's far side reaching geostationary
 * height, the autopilot's second burn planned), each set up from the start.
 */
import type { Page } from '@playwright/test';
import type { UniverseLab } from '../../src/core/types';
import { expect, test } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 60_000 * SLOW };
const lab = async (page: Page): Promise<UniverseLab | null> => (await view(page))?.lab ?? null;

test('lessons: Kepler’s third law, escape speed and a Hohmann transfer, each from the start', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('lab-open').click();
  await expect(page.getByTestId('lab-panel')).toBeVisible(LIVE);
  await page.getByTestId('lab-lessons').locator('summary').click();

  // Kepler: a star and a planet, the planet moved out to twice its distance; its year 2.828 times as long.
  await page.getByTestId('lab-lesson-kepler').click();
  await expect.poll(async () => (await lab(page))?.bodies.map((b) => b.id).join(), LIVE).toBe('star,planet');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  await expect(page.getByTestId('lab-lesson-text-0')).toContainText('The planet goes round once every');
  const before = (await lab(page))?.bodies.find((b) => b.id === 'planet')?.orbit?.periodS ?? 0;
  await page.getByTestId('lab-lesson-step-1').click();
  await expect.poll(async () => ((await lab(page))?.bodies.find((b) => b.id === 'planet')?.orbit?.periodS ?? 0) / before, LIVE).toBeCloseTo(2 ** 1.5, 3);
  await expect(page.getByTestId('lab-lesson-text-1')).toContainText('2.828 times as long');

  // Escape: a push a little past escape speed opens the orbit.
  await page.getByTestId('lab-lesson-escape').click();
  await expect.poll(async () => (await lab(page))?.bodies.find((b) => b.id === 'planet')?.orbit?.bound, LIVE).toBe(true);
  await page.getByTestId('lab-lesson-step-1').click();
  await expect.poll(async () => (await lab(page))?.bodies.find((b) => b.id === 'planet')?.orbit?.bound, LIVE).toBe(false);
  await expect(page.getByTestId('lab-lesson-text-1')).toContainText('It will not come back');

  // Hohmann: a ship at 7,000 km; the first burn planned and run; the far side at geostationary height.
  await page.getByTestId('lab-lesson-hohmann').click();
  await expect.poll(async () => (await lab(page))?.bodies.find((b) => b.ship !== null)?.ship?.fuelKg ?? 0, LIVE).toBe(18_000);
  await expect(page.getByTestId('lab-lesson-text-0')).toContainText('The transfer needs');
  await page.getByTestId('lab-lesson-step-1').click();
  await expect.poll(async () => (await lab(page))?.bodies.find((b) => b.ship !== null)?.ship?.burns.length ?? 0, LIVE).toBe(1);
  await page.getByTestId('lab-lesson-step-2').click();
  await expect.poll(async () => (await lab(page))?.bodies.find((b) => b.ship !== null)?.ship?.burns.length ?? 1, LIVE).toBe(0);
  const apo = (await lab(page))?.bodies.find((b) => b.ship !== null)?.orbit?.apoapsisKm ?? 0;
  expect(apo / 42_164).toBeGreaterThan(0.98);
  expect(apo / 42_164).toBeLessThan(1.02);
  await page.getByTestId('lab-lesson-step-3').click();
  await expect.poll(async () => (await lab(page))?.bodies.find((b) => b.ship !== null)?.ship?.burns.length ?? 0, LIVE).toBe(1);
  await expect(page.getByTestId('lab-lesson-text-3')).toContainText('The autopilot’s burn');
  await page.getByTestId('lab-lesson-end').click();
  await expect(page.getByTestId('lab-lesson')).toBeHidden();
  expect(pageErrors).toEqual([]);
});
