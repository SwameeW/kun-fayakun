/**
 * The small worlds' cost (src/explore/worlds), at a fixed detail level, in the views they change most:
 * the Earth by default, the asteroid belt from above, Jupiter's system, Saturn's ring plane, the Sun
 * close up and the outer solar system. Each view settles, then its frames are counted for five seconds
 * with the small bodies' layer on and again with it off: the medians and the slowest frames, both
 * recorded (testInfo annotations) and held to the explorer's targets (60 fps at High, the 99th
 * percentile frame under 20 ms; at Low, recorded for the phone's budget). Run alone:
 * PERF=1 npx playwright test tests/explore/small-worlds-perf.spec.ts --workers=1.
 */
import type { Page } from '@playwright/test';
import type { UniversePose } from '../../src/core/types';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, place, view, waitForUniverse } from '../support/universe';

// The reference display: 1440 x 900 CSS px at a pixel ratio of 2.
test.use({ deviceScaleFactor: 2 });

const VIEWS: ReadonlyArray<readonly [string, UniversePose]> = [
  ['earth', { body: 'earth', distanceKm: 26_000 }],
  ['belt from above', { body: 'sun', distanceKm: 1.1e9, elevationDeg: 85 }],
  ['jupiter system', { body: 'jupiter', distanceKm: 3.2e6, elevationDeg: 5 }],
  ['saturn ring plane', { body: 'saturn', distanceKm: 2.0e6, elevationDeg: 0.5 }],
  ['sun', { body: 'sun', distanceKm: 4e6 }],
  ['outer system', { body: 'sun', distanceKm: 7.5e9, elevationDeg: 60 }],
];

async function measure(page: Page): Promise<{ fps: number; p99: number }> {
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.resetFrameStats();
  });
  await page.waitForTimeout(5000);
  const s = await page.evaluate(() => (window as unknown as KfHook).__kf.frameStats());
  return { fps: +s.medianFps.toFixed(2), p99: +s.p99FrameMs.toFixed(2) };
}

for (const tier of ['high', 'low'] as const) {
  test(`the small worlds at ${tier}: frame rate and slowest frames in six views, the layer on and off`, { tag: '@perf' }, async ({ page, kf, pageErrors }, testInfo) => {
    test.setTimeout(300_000 * SLOW);
    await page.setViewportSize({ width: 1440, height: 900 });
    await kf.open('/universe/earth', { query: { jd: JD, detail: tier, profile: '1' } });
    await waitForUniverse(page);
    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'smallBodies', on: true });
    });
    await expect.poll(async () => (await view(page))?.worlds?.asteroids ?? 0, { timeout: 60_000 * SLOW }).toBe(tier === 'high' ? 250_000 : 20_000);
    const results: Record<string, { on: { fps: number; p99: number }; off: { fps: number; p99: number } }> = {};
    for (const [name, pose] of VIEWS) {
      await place(page, pose);
      const on = await measure(page);
      await page.evaluate(() => {
        (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'smallBodies', on: false });
      });
      const off = await measure(page);
      await page.evaluate(() => {
        (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'smallBodies', on: true });
      });
      results[name] = { on, off };
    }
    console.log(`[perf] ${testInfo.project.name} ${tier}: ${JSON.stringify(results)}`);
    testInfo.annotations.push({ type: 'perf', description: JSON.stringify({ tier, results }) });
    if (tier === 'high') {
      for (const [name, r] of Object.entries(results)) {
        expect(r.on.fps, `${name}: median frame rate with the small bodies`).toBeGreaterThanOrEqual(58);
        expect(r.on.p99, `${name}: the 99th percentile frame with the small bodies`).toBeLessThan(20);
      }
    }
    expect(pageErrors).toEqual([]);
  });
}
