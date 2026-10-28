/**
 * The explorer's detail menu and its governance (src/ui/explore/quality-menu.ts, src/explore/quality.ts):
 * Auto and the tiers this device may run (Ultra only on a WebGPU device that allows it, never on
 * WebGL2), a choice applied at once and kept on this browser over Auto, Esc closing the menu without
 * leaving the explorer, a tier fixed by the address, and switching tiers back and forth leaving the
 * GPU's resources where they were.
 */
import { expect, test, type FrameStats, type KfHook } from '../support/fixtures';
import { JD, place, recordToasts, toasts, view, waitForUniverse } from '../support/universe';
import { NEEDS_GPU, NEEDS_REAL_FRAMES, NO_GPU, SLOW } from '../support/env';

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

test('a chosen tier applies at once (closing the menu) and is kept on this browser over Auto; Esc closes the menu, not the explorer', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('universe-detail').click();
  await page.getByTestId('universe-detail-low').check();
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'low');
  expect((await view(page))?.detail.choice).toBe('low');
  // A choice closes the menu; opened again, Esc closes it and leaves the explorer where it is.
  await expect(page.getByTestId('universe-detail')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('universe-detail').click();
  await expect(page.getByTestId('universe-detail')).toHaveAttribute('aria-expanded', 'true');
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

test('keyboard browsing of the menu applies nothing: arrows only select, Enter applies the selection once, Esc puts it back', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  // Count what reaches the explorer (the menu calls the app's command).
  await page.evaluate(() => {
    const w = window as unknown as KfHook & { kfDetailCalls: string[] };
    const app = w.__kf.app;
    const original = app.setUniverseDetail.bind(app);
    w.kfDetailCalls = [];
    app.setUniverseDetail = (choice) => {
      w.kfDetailCalls.push(choice);
      original(choice);
    };
  });
  const calls = (): Promise<string[]> => page.evaluate(() => (window as unknown as { kfDetailCalls: string[] }).kfDetailCalls);
  const before = await kf.htmlData('detail');
  await page.getByTestId('universe-detail').click();
  await expect(page.getByTestId('universe-detail-auto')).toBeFocused();
  // Down three times: past every tier on the way, applying none of them.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(400);
  expect(await calls()).toEqual([]);
  expect(await kf.htmlData('detail')).toBe(before);
  const available = (await view(page))?.detail.available ?? [];
  const expected = ['auto', ...available][3];
  // Enter applies the one selected, once, and closes the menu.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('universe-detail')).toHaveAttribute('aria-expanded', 'false');
  expect(await calls()).toEqual([expected]);
  await expect(page.locator('html')).toHaveAttribute('data-detail', expected ?? '');
  // Esc after moving the selection applies nothing and puts the selection back.
  await page.getByTestId('universe-detail').click();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('universe-detail')).toHaveAttribute('aria-expanded', 'false');
  expect(await calls()).toEqual([expected]);
  expect((await view(page))?.detail.choice).toBe(expected);
  // A click on a tier applies it at once and closes the menu.
  await recordToasts(page);
  await page.getByTestId('universe-detail').click();
  await page.getByTestId('universe-detail-auto').click();
  await expect(page.getByTestId('universe-detail')).toHaveAttribute('aria-expanded', 'false');
  expect((await calls()).at(-1)).toBe('auto');
  // Applying says what the level draws, quietly.
  await expect.poll(() => toasts(page), { timeout: 60_000 * SLOW }).toMatch(/maps/);
  expect(pageErrors).toEqual([]);
});

test('on Auto, frames that run slow cost internal resolution first, then a tier', async ({ page, kf, pageErrors }) => {
  test.skip(NO_GPU, NEEDS_REAL_FRAMES);
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const start = (await view(page))?.detail;
  expect(start?.choice).toBe('auto');
  expect(start?.renderScale).toBe(1);
  // The engine learns the display's rate from half a second of frames (src/core/cadence.ts): a burden
  // that starts before it has would be taken for a 30 Hz display, which nothing should be lowered for.
  await expect.poll(async () => (await stats(page)).seconds).toBeGreaterThan(1);
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
  test.skip(NO_GPU, NEEDS_GPU);
  test.setTimeout(420_000 * SLOW);
  // ?profile=1 holds the internal resolution still (a GPU shared with other tests would otherwise
  // lower it, resizing the scene pass's targets mid-comparison); tiers still switch on request.
  await kf.open('/universe/earth', { query: { jd: JD, profile: '1' } });
  await waitForUniverse(page);
  // A still camera: a body out of view uploads nothing, so the counts must be compared from one pose.
  await place(page, { body: 'earth', distanceKm: 40_000, azimuthDeg: 30 });
  const top = (await view(page))?.detail.available[0] ?? 'high';
  // The maps stream after a change (one upload a frame, upgrades fetched and transcoded, the ones a
  // level no longer wants dropped after the streamer's 8 s hold), so each change is given time to
  // finish: until the counts have held still for longer than that hold.
  const steady = async (quietMs = 9000): Promise<void> => {
    let last = JSON.stringify((await stats(page)).memory);
    let since = Date.now();
    const until = Date.now() + 60_000;
    while (Date.now() < until && Date.now() - since < quietMs) {
      await page.waitForTimeout(250);
      const now = JSON.stringify((await stats(page)).memory);
      if (now !== last) {
        last = now;
        since = Date.now();
      }
    }
  };
  const choose = async (tier: string): Promise<void> => {
    await page.evaluate((t) => {
      (window as unknown as KfHook).__kf.app.setUniverseDetail(t as 'low');
    }, tier);
    await expect(page.locator('html')).toHaveAttribute('data-detail', tier);
    await steady();
  };
  // Every body's first maps have arrived before anything is compared.
  await steady();
  await choose('low');
  await choose(top);
  const baseline = (await stats(page)).memory;
  for (let i = 0; i < 5; i++) {
    await choose('low');
    await choose(top);
  }
  // Back where they were (a map still on its way under a busy GPU gets the time it needs to land and settle).
  await expect.poll(async () => (await stats(page)).memory, { timeout: 30_000, intervals: [1000] }).toEqual(baseline);
  expect(pageErrors).toEqual([]);
});
