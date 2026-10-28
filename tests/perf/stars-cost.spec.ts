/**
 * Among the stars at High (docs/NEIGHBOURHOOD.md, "Performance"): 1440x900 at two device pixels a
 * CSS pixel, ?profile=1 (the render scale held at 1): the frame rate and the slowest frames in the
 * solar system (for comparison), among the stars by default (Hipparcos's and Tycho-2's first pack),
 * with all 2.5 million stars drawn (faintest magnitude 12.5), and at five black holes (Sagittarius A*'s
 * hot ring, TON 618's disc, M87* with the survey's galaxies bent, Cygnus X-1's disc with the Sun's sky
 * stood in, Gaia BH1 from two of its radii, where every pixel is traced; the stars and points bent in
 * their vertex stage, each drawn twice). CPU time is
 * the main thread's busy time (Chrome's TaskDuration) per frame. Always logs the numbers; asserts the
 * explorer's budget (60 fps median, the slowest 1% under 20 ms) with PERF_ASSERT=1, since it only means
 * something on the reference hardware.
 * Run with: PERF=1 npx playwright test --workers=1 tests/perf/stars-cost.spec.ts --project=webgpu
 */
import type { Page } from '@playwright/test';
import type { FrameStats } from '../../src/core/perf';
import { flag } from '../support/env';
import { expect, test, type KfHook } from '../support/fixtures';
import { JD, view, waitForUniverse } from '../support/universe';

const WINDOW_S = 6;

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

interface Sample {
  label: string;
  medianFps: number;
  p99FrameMs: number;
  cpuMsPerFrame: number;
  gpuMedianMs: number;
}

const stars = async (page: Page) => (await view(page))?.neighbourhood ?? null;
const command = (page: Page, c: unknown): Promise<void> =>
  page.evaluate((x) => {
    (window as unknown as KfHook).__kf.app.earthCommand(x as never);
  }, c);

test('among the stars and at the black holes, frames stay within the explorer’s budget at High', { tag: '@perf' }, async ({ page, kf }, testInfo) => {
  test.setTimeout(600_000);
  await kf.open('/universe/earth', { query: { jd: JD, profile: '1', detail: 'high' } });
  await waitForUniverse(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const taskSeconds = async (): Promise<number> => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0;
  const samples: Sample[] = [];
  const measure = async (label: string): Promise<void> => {
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.resetFrameStats();
    });
    const start = await taskSeconds();
    await page.waitForTimeout(WINDOW_S * 1000);
    const end = await taskSeconds();
    const s = (await page.evaluate(() => (window as unknown as KfHook).__kf.frameStats())) as FrameStats;
    samples.push({ label, medianFps: s.medianFps, p99FrameMs: s.p99FrameMs, cpuMsPerFrame: s.frames > 0 ? ((end - start) * 1000) / s.frames : 0, gpuMedianMs: s.gpuMedianMs });
  };
  const arrive = async (): Promise<void> => {
    await expect.poll(async () => (await stars(page))?.travelling, { timeout: 60_000 }).toBe(false);
  };
  await measure('solar system (Earth)');
  await command(page, { kind: 'stars' });
  await expect.poll(async () => (await stars(page))?.stars.loaded ?? 0, { timeout: 60_000 }).toBeGreaterThan(400_000);
  await measure('stars, by default (faintest 8.5)');
  await command(page, { kind: 'starsLight', brightness: 1, faintest: 12.5 });
  await expect.poll(async () => (await stars(page))?.stars.far ?? 0, { timeout: 120_000 }).toBeGreaterThan(2_350_000);
  await measure('stars, all 2.5 million (faintest 12.5)');
  await command(page, { kind: 'starsLight', brightness: 1, faintest: 8.5 });
  for (const id of ['sgr-a', 'ton-618', 'm87', 'cyg-x-1', 'gaia-bh1']) {
    await command(page, { kind: 'starsPlace', place: `bh:${id}` });
    await arrive();
    if (id === 'gaia-bh1') {
      await page.mouse.move(400, 450);
      for (let k = 0; k < 100; k += 1) await page.mouse.wheel(0, -100);
    }
    await measure(`black hole ${id}${id === 'gaia-bh1' ? ' at 2 r_s' : ''}`);
  }
  for (const s of samples) {
    const line = `${s.label}: ${s.medianFps.toFixed(1)} fps median, p99 ${s.p99FrameMs.toFixed(1)} ms, CPU ${s.cpuMsPerFrame.toFixed(2)} ms/frame, GPU ${s.gpuMedianMs.toFixed(2)} ms`;
    console.log(line);
    testInfo.annotations.push({ type: 'frames', description: line });
  }
  if (flag('PERF_ASSERT'))
    for (const s of samples) {
      expect(s.medianFps, `${s.label}: median fps`).toBeGreaterThanOrEqual(58);
      expect(s.p99FrameMs, `${s.label}: p99`).toBeLessThan(20);
    }
});
