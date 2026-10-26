/**
 * The explorer's readout (src/ui/explore): on a wide screen and on a phone (390 x 844) the focus's
 * imagery is credited in one short line that is fully visible (nothing clipped or overflowing), the
 * credits in full (and the Earth's epochs) open from it, OPAL's CC BY credit is shown whole, what the
 * view draws that is illustrative is named, and the readout stays a few lines tall.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test, type Kf, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';

const JD = '2461336.75';
const UNIVERSE_TIMEOUT = 90_000 * SLOW;

async function openOn(page: Page, kf: Kf, body: string): Promise<void> {
  await kf.open(`/universe/${body}`, { query: { jd: JD } });
  await expect(page.locator('html')).toHaveAttribute('data-universe-ready', 'true', { timeout: UNIVERSE_TIMEOUT });
  await expect(page.getByTestId('universe-readout')).toBeVisible();
}

/** Nothing of the element is clipped: its content fits its box, and its box lies inside the viewport. */
async function expectUnclipped(element: Locator, page: Page): Promise<void> {
  await expect(element).toBeVisible();
  const box = await element.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
  expect(box.scrollHeight, 'no clipped lines').toBeLessThanOrEqual(box.clientHeight + 1);
  expect(box.scrollWidth, 'no clipped width').toBeLessThanOrEqual(box.clientWidth + 1);
  const viewport = page.viewportSize();
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual((viewport?.width ?? 0) + 0.5);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(viewport?.height ?? 0);
}

/** Lines the readout spans (its height over its line height). */
const readoutLines = (page: Page): Promise<number> =>
  page.getByTestId('universe-readout').evaluate((el) => {
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || 18;
    return (el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / line;
  });

for (const [label, viewport] of [
  ['wide screen', { width: 1280, height: 800 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test.describe(label, () => {
    test.use({ viewport });

    test('the Earth’s imagery is credited in one short, unclipped line, with the credits in full a click away', async ({ page, kf, pageErrors }) => {
      await openOn(page, kf, 'earth');
      const imagery = page.getByTestId('universe-imagery');
      await expect(imagery).toContainText(/Imagery: NASA Blue Marble/);
      await expect(imagery).toContainText(/NOAA ETOPO/);
      await expectUnclipped(imagery, page);
      // The full credits (with the epochs' caption) open over the view from the imagery line.
      const credits = page.getByTestId('universe-credits');
      await credits.locator('summary').click();
      await expect(credits).toHaveAttribute('open', '');
      await expect(credits).toContainText(/composite of several epochs/i);
      await expect(credits).toContainText(/Blue Marble: Next Generation/);
      await expect(credits).toContainText(/Made with Natural Earth/);
      await expectUnclipped(credits.locator('.kf-universe-credits-panel'), page);
      // A few lines, never a wall of credits.
      expect(await readoutLines(page)).toBeLessThanOrEqual(label === 'phone' ? 6 : 10);
      expect(pageErrors).toEqual([]);
    });

    test('Jupiter shows OPAL’s credit whole, and says its bands’ drift is illustrative', async ({ page, kf, pageErrors }) => {
      await openOn(page, kf, 'jupiter');
      const imagery = page.getByTestId('universe-imagery');
      await expect(imagery).toContainText('NASA, ESA, A. Simon (NASA GSFC) and the OPAL team');
      await expectUnclipped(imagery, page);
      await expect(page.getByTestId('universe-illustrative')).toContainText(/band drift/);
      expect(pageErrors).toEqual([]);
    });

    test('the Sun’s readout names what is illustrative and stays legible over its disc', async ({ page, kf, pageErrors }) => {
      await openOn(page, kf, 'sun');
      await page.evaluate(() => {
        (window as unknown as KfHook).__kf.universe.place({ body: 'sun', distanceKm: 1_400_000, azimuthDeg: 60 });
      });
      await expect(page.getByTestId('universe-illustrative')).toContainText(/prominences/);
      await expect(page.getByTestId('universe-imagery')).toBeHidden();
      // The readout's backdrop is nearly opaque, whatever lies behind it (polled: it eases in).
      const backdrop = (): Promise<number> =>
        page.getByTestId('universe-readout').evaluate((el) => {
          const style = getComputedStyle(el);
          // The least opaque stop of the backdrop (a gradient's, or the plain colour's).
          const source = style.backgroundImage !== 'none' ? style.backgroundImage : style.backgroundColor;
          const alphas = [...source.matchAll(/rgba?\(([^)]*)\)/g)].map((m) => {
            const parts = (m[1] ?? '').split(/[\s,/]+/).filter(Boolean);
            return parts.length >= 4 ? Number(parts[3]) : 1;
          });
          return alphas.length > 0 ? Math.min(...alphas) : 0;
        });
      await expect.poll(backdrop, { timeout: 5000 * SLOW }).toBeGreaterThanOrEqual(0.7);
      expect(pageErrors).toEqual([]);
    });
  });
}
