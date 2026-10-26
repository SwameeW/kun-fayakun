/**
 * The explorer's time machine (src/explore/time, src/ui/explore/time-control) and photo mode: the
 * keys and buttons step the rate, pause, run backwards and come back to now, a date can be chosen,
 * the clock stops at the end of the data, the rate is said in words, and photo mode leaves only the
 * view until H, Esc or its button brings the interface back.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, view, waitForUniverse } from '../support/universe';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const LIVE = { timeout: 30_000 * SLOW };

/** The explorer's date now (Unix ms). */
const shown = async (page: Page): Promise<number> => (await view(page))?.unixMs ?? Number.NaN;

test('the time machine: faster, paused, backwards, a date, the end of the data and back to now', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const rate = page.getByTestId('universe-time-rate');
  await expect(rate).toHaveText('Real time');

  for (let i = 0; i < 3; i += 1) await page.keyboard.press(']');
  await expect(rate).toHaveText('10 minutes a second');
  expect((await view(page))?.time.rate).toBe(600);
  const before = await shown(page);
  await expect.poll(() => shown(page), LIVE).toBeGreaterThan(before + 60_000);

  await page.keyboard.press('Space');
  await expect(rate).toHaveText('Time paused');
  await expect(page.getByTestId('universe-time-pause')).toHaveAttribute('aria-pressed', 'true');
  const paused = await shown(page);
  await page.waitForTimeout(600);
  expect(await shown(page)).toBe(paused);

  await page.keyboard.press('\\');
  await expect(rate).toHaveText('Backwards: 10 minutes a second');
  await expect(page.getByTestId('universe-time-reverse')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => shown(page), LIVE).toBeLessThan(paused - 60_000);
  await page.keyboard.press('[');
  await expect(rate).toHaveText('Backwards: 1 minute a second');

  // A chosen day keeps the time of day; the readout's date follows.
  await page.getByTestId('universe-time-date').fill('2030-06-15');
  await expect.poll(async () => new Date(await shown(page)).toISOString().slice(0, 10), LIVE).toBe('2030-06-15');

  // At thirty days a second the Moon's table runs out: the clock stops there and says why.
  await page.getByTestId('universe-time-date').fill('2035-12-01');
  await page.getByTestId('universe-time-faster').click();
  for (let i = 0; i < 9; i += 1) await page.keyboard.press(']');
  await expect(page.getByTestId('universe-time-reverse')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('universe-time-reverse').click();
  await expect(rate).toHaveText('Time stops here: the Moon’s table ends', LIVE);
  expect((await view(page))?.time).toMatchObject({ edge: 'end', paused: true });

  await page.getByTestId('universe-time-now').click();
  await expect(rate).toHaveText('Real time');
  expect(Math.abs((await shown(page)) - Date.now())).toBeLessThan(5 * 60_000);
  const results = await new AxeBuilder({ page }).include('[data-testid="universe-time"]').withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('photo mode leaves only the view, and H, Esc or its button brings the interface back', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const nav = page.getByTestId('universe-bodies');
  await page.keyboard.press('h');
  await expect(page.locator('html')).toHaveClass(/kf-photo/);
  await expect(nav).toBeHidden();
  await expect(page.getByTestId('universe-readout')).toBeHidden();
  const exit = page.getByTestId('universe-photo-exit');
  await expect(exit).toBeFocused();
  // Esc leaves photo mode, not the explorer.
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).not.toHaveClass(/kf-photo/);
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'universe');
  await expect(nav).toBeVisible();
  await page.getByTestId('universe-photo').click();
  await expect(page.locator('html')).toHaveClass(/kf-photo/);
  await exit.click();
  await expect(page.locator('html')).not.toHaveClass(/kf-photo/);
  await expect(page.getByTestId('universe-photo')).toBeFocused();
  await page.keyboard.press('H');
  await expect(page.locator('html')).toHaveClass(/kf-photo/);
  await page.keyboard.press('H');
  await expect(page.locator('html')).not.toHaveClass(/kf-photo/);
  expect(pageErrors).toEqual([]);
});
