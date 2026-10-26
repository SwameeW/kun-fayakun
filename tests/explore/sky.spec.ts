/**
 * The explorer's sky in the browser (src/explore/sky, src/ui/explore/sky-panel): the real stars are
 * drawn (the detail's share of the catalogue, brightest first), and each switch shows or hides its
 * layer: constellations with their names on the sky, star names, boundaries, the grid.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, view, waitForUniverse } from '../support/universe';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const LIVE = { timeout: 30_000 * SLOW };

const hudLabels = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as KfHook).__kf.app.hud().labels.map((l) => l.id));

test('the real stars, and the sky’s layers switched on and off', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  expect((await view(page))?.sky.stars).toBeGreaterThanOrEqual(3500);
  const panel = page.getByTestId('universe-sky');
  await panel.locator('summary').click();
  await expect(page.getByTestId('sky-intro')).toContainText(/The [\d,]+ brightest stars of the Bright Star Catalogue/);

  const constellations = page.getByTestId('sky-constellations');
  await constellations.click();
  await expect(constellations).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await view(page))?.sky.layers.constellations).toBe(true);
  // Some constellation's name is always somewhere in a view this wide.
  await expect.poll(async () => (await hudLabels(page)).some((id) => id.startsWith('sky-con-')), LIVE).toBe(true);
  for (const layer of ['names', 'boundaries', 'grid'] as const) {
    await page.getByTestId(`sky-${layer}`).click();
    await expect.poll(async () => (await view(page))?.sky.layers[layer]).toBe(true);
  }
  const results = await new AxeBuilder({ page }).include('[data-testid="universe-sky"]').withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  await constellations.click();
  await expect(constellations).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await hudLabels(page)).some((id) => id.startsWith('sky-con-')), LIVE).toBe(false);
  expect(pageErrors).toEqual([]);
});
