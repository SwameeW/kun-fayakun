/**
 * The film's overlay figures read the constants (data/constants.json), which on a first visit arrive
 * after the interface is built: opened cold at their cue, they show the measured values, never "not
 * available" or an empty chart.
 */
import { expect, test } from './support/fixtures';
import { SLOW } from './support/env';

test('opened cold at its cue, the decay chain gives both half-lives', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.openChapter('ch06', { autoplay: true, t: 106 });
  const figure = page.getByTestId('overlay-decay-chain');
  await expect(figure).toBeVisible({ timeout: 30_000 * SLOW });
  await expect(figure.locator('.kf-decay-life')).toHaveCount(3);
  await expect(figure).not.toContainText('not available');
  await expect(figure.locator('.kf-decay-life').first()).toContainText(/\d/u);
  expect(pageErrors).toEqual([]);
});

test('opened cold at its cue, the Hubble tension chart has its measurements', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.openChapter('ch04', { autoplay: true, t: 67 });
  const figure = page.getByTestId('overlay-hubble-tension');
  await expect(figure).toBeVisible({ timeout: 30_000 * SLOW });
  // A dot per measurement, and its value written beside the chart.
  await expect.poll(() => figure.locator('.kf-hubble-dot').count()).toBeGreaterThanOrEqual(2);
  await expect(figure.locator('.kf-hubble-value').first()).toContainText(/\d/u);
  expect(pageErrors).toEqual([]);
});
