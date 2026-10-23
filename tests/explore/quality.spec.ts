/**
 * The explorer's detail menu and its governance (src/ui/explore/quality-menu.ts, src/explore/quality.ts):
 * Auto and the tiers this device may run (Ultra only on a WebGPU device that allows it, never on
 * WebGL2), a choice applied at once and kept on this browser over Auto, Esc closing the menu without
 * leaving the explorer, a tier fixed by the address, and switching tiers back and forth leaving the
 * GPU's resources where they were.
 */
import { expect, test, type FrameStats, type KfHook } from '../support/fixtures';
import { JD, place, view, waitForUniverse } from '../support/universe';

const stats = (page: import('@playwright/test').Page): Promise<FrameStats> => page.evaluate(() => (window as unknown as KfHook).__kf.frameStats());

test('the menu offers Auto and the tiers this device may run; Ultra only on WebGPU', async ({ page, kf, pageErrors }) => {
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const button = page.getByTestId('universe-detail');
  await expect(button).toContainText(/Auto/);
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  for (const choice of ['auto', 'high', 'medium', 'low']) await expect(page.getByTestId(`universe-detail-${choice}`)).toBeVisible();
  const backend = await kf.htmlData('backend');
  const ultra = page.getByTestId('universe-detail-ultra');
  if (backend === 'webgl2') await expect(ultra).toBeHidden();
  const state = await view(page);
  expect(state?.detail.available.includes('ultra')).toBe(backend === 'webgpu' && (await ultra.isVisible()));
  // Auto never picks Ultra on its own.
  expect(state?.detail.tier).not.toBe('ultra');
  await expect(page.getByTestId('universe-detail-auto')).toBeChecked();
  expect(pageErrors).toEqual([]);
});

test('a chosen tier applies at once and is kept on this browser over Auto; Esc closes the menu, not the explorer', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('universe-detail').click();
  await page.getByTestId('universe-detail-low').check();
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'low');
  expect((await view(page))?.detail.choice).toBe('low');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('universe-detail')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'universe');
  await expect(page.getByTestId('universe-detail')).toContainText('Low');
  // Remembered: a new visit starts at Low, not at what Auto would choose.
  await page.reload();
  await waitForUniverse(page);
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'low');
  expect((await view(page))?.detail.choice).toBe('low');
  // Back to Auto.
  await page.getByTestId('universe-detail').click();
  await page.getByTestId('universe-detail-auto').check();
  await expect.poll(async () => (await view(page))?.detail.choice).toBe('auto');
  await page.reload();
  await waitForUniverse(page);
  expect((await view(page))?.detail.choice).toBe('auto');
  expect(pageErrors).toEqual([]);
});

test('on Auto, frames that run slow cost internal resolution first, then a tier', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const start = (await view(page))?.detail;
  expect(start?.choice).toBe('auto');
  expect(start?.renderScale).toBe(1);
  // A device that cannot keep up: 30 ms of main-thread work in every frame.
  await page.evaluate(() => {
    const burn = (): void => {
      const t = performance.now();
      while (performance.now() - t < 30) {
        /* busy */
      }
      requestAnimationFrame(burn);
    };
    requestAnimationFrame(burn);
  });
  // First the scene's internal resolution (the canvas keeps its size)...
  await expect.poll(async () => (await view(page))?.detail.renderScale ?? 1, { timeout: 20_000 }).toBeLessThan(1);
  expect((await view(page))?.detail.tier).toBe(start?.tier);
  // ...and only at its floor, a tier.
  await expect.poll(async () => (await view(page))?.detail.tier, { timeout: 40_000 }).not.toBe(start?.tier);
  await expect(page.locator('html')).not.toHaveAttribute('data-detail', start?.tier ?? '');
  expect(pageErrors).toEqual([]);
});

test('?detail= fixes the tier: the governor holds still at full resolution', async ({ page, kf, pageErrors }) => {
  await kf.open('/universe/jupiter', { query: { jd: JD, detail: 'medium' } });
  await waitForUniverse(page);
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'medium');
  const state = await view(page);
  expect(state?.detail.fixed).toBe(true);
  expect(state?.detail.renderScale).toBe(1);
  await page.getByTestId('universe-detail').click();
  await expect(page.locator('.kf-nav-detail-note')).toContainText(/address/i);
  expect(pageErrors).toEqual([]);
});

test('switching between the lowest and highest tiers five times leaves the GPU resources where they were', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  // A still camera: a body out of view uploads nothing, so the counts must be compared from one pose.
  await place(page, { body: 'earth', distanceKm: 40_000, azimuthDeg: 30 });
  const top = (await view(page))?.detail.available[0] ?? 'high';
  const choose = async (tier: string): Promise<void> => {
    await page.evaluate((t) => {
      (window as unknown as KfHook).__kf.app.setUniverseDetail(t as 'low');
    }, tier);
    await expect(page.locator('html')).toHaveAttribute('data-detail', tier);
    await page.waitForTimeout(500);
  };
  await choose('low');
  await choose(top);
  const baseline = (await stats(page)).memory;
  for (let i = 0; i < 5; i++) {
    await choose('low');
    await choose(top);
  }
  expect((await stats(page)).memory).toEqual(baseline);
  expect(pageErrors).toEqual([]);
});
