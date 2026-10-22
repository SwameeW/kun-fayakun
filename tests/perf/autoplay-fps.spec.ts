/**
 * Spec section 8: median fps over a 60-second auto-play. Always logs the
 * numbers; asserts thresholds only with PERF_ASSERT=1, because they only mean
 * something on the reference hardware (M1 / RTX 3060 laptop at High; Pixel 7
 * or iPhone 13 at Low). Run with: PERF=1 npx playwright test --workers=1
 */
import type { QualityTier } from '../../src/core/types';
import { flag } from '../support/env';
import { expect, test, type FrameStats, type KfHook } from '../support/fixtures';

const PLAY_SECONDS = 60;

/**
 * Spec thresholds per tier. The spec sets none for Mid; it gets Low's floor.
 * 0.5 fps of slack absorbs vsync jitter when a 60 Hz display caps the median.
 */
const THRESHOLDS: Record<QualityTier, { medianFps: number; onePercentLowFps: number | null }> = {
  high: { medianFps: 60 - 0.5, onePercentLowFps: 45 },
  mid: { medianFps: 30, onePercentLowFps: null },
  low: { medianFps: 30, onePercentLowFps: null },
};

function isTier(value: string): value is QualityTier {
  return value === 'high' || value === 'mid' || value === 'low';
}

test('60 s auto-play from Chapter 0 holds its frame rate', { tag: '@perf' }, async ({
  page,
  kf,
}, testInfo) => {
  test.setTimeout((PLAY_SECONDS + 150) * 1000);
  await kf.openChapter('ch00', { autoplay: true });
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.resetFrameStats();
  });
  await page.waitForTimeout(PLAY_SECONDS * 1000);

  const stats: FrameStats = await page.evaluate(() => (window as unknown as KfHook).__kf.frameStats());
  const backend = (await kf.htmlData('backend')) ?? 'unknown';
  const tier = (await kf.htmlData('tier')) ?? 'unknown';
  const chapter = (await kf.htmlData('chapter')) ?? 'none';
  const report = { project: testInfo.project.name, backend, tier, endedIn: chapter, ...stats };

  console.log(
    `[perf] ${report.project}: median ${stats.medianFps.toFixed(1)} fps, 1% low ` +
      `${stats.onePercentLowFps.toFixed(1)} fps, p99 ${stats.p99FrameMs.toFixed(1)} ms, ` +
      `${stats.frames} frames / ${stats.seconds.toFixed(1)} s, backend ${backend}, tier ${tier}`,
  );
  await testInfo.attach('frame-stats.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  testInfo.annotations.push({ type: 'perf', description: JSON.stringify(report) });

  if (!flag('PERF_ASSERT')) return;
  expect(stats.seconds, 'frame stats cover the auto-play').toBeGreaterThan(PLAY_SECONDS * 0.9);
  expect(isTier(tier), `data-tier is a known tier (got ${tier})`).toBe(true);
  if (!isTier(tier)) return;
  const threshold = THRESHOLDS[tier];
  expect(stats.medianFps, `median fps at ${tier}`).toBeGreaterThanOrEqual(threshold.medianFps);
  if (threshold.onePercentLowFps !== null) {
    expect(stats.onePercentLowFps, `1% low fps at ${tier}`).toBeGreaterThanOrEqual(
      threshold.onePercentLowFps,
    );
  }
});
