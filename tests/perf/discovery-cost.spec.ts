/**
 * Spec section 3 (Chapter 7, Performance): opening the letter analysis adds at most 0.5 ms GPU
 * and 1 ms CPU per frame on High. Measures Chapter 7 at one moment with the film held
 * throughout, so the scene is alike in every window: twice without the analysis (the second
 * shows how much the numbers move on their own), then with it open and resting, then while the
 * mirrored pairs glide (the busiest it gets). GPU time comes from timestamp queries
 * (?profile=1; 0 where the backend has none); CPU time is the main thread's busy time (Chrome's
 * TaskDuration) per frame. Always logs the numbers; asserts the budget only with PERF_ASSERT=1,
 * since it only means something on the reference hardware at High.
 * Run with: PERF=1 npx playwright test --workers=1 tests/perf/discovery-cost.spec.ts
 */
import type { Page } from '@playwright/test';
// The engine's own stats type: it carries the GPU timings the fixtures' narrower one leaves out.
import type { FrameStats } from '../../src/core/perf';
import { flag } from '../support/env';
import { expect, test, type KfHook } from '../support/fixtures';

/** Each window; the pairs take 3 × 2.4 s, so theirs is a little shorter. */
const WINDOW_S = 8;
const PAIRS_S = 7;

interface Sample {
  gpuMedianMs: number;
  cpuMsPerFrame: number;
  medianFps: number;
  frames: number;
}

async function measure(page: Page, seconds: number, taskSeconds: () => Promise<number>): Promise<Sample> {
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.resetFrameStats();
  });
  const start = await taskSeconds();
  await page.waitForTimeout(seconds * 1000);
  const end = await taskSeconds();
  const stats = (await page.evaluate(() => (window as unknown as KfHook).__kf.frameStats())) as FrameStats;
  return {
    gpuMedianMs: stats.gpuMedianMs,
    cpuMsPerFrame: stats.frames > 0 ? ((end - start) * 1000) / stats.frames : 0,
    medianFps: stats.medianFps,
    frames: stats.frames,
  };
}

const signed = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(3)}`;

test('opening the letter analysis stays within its frame budget', { tag: '@perf' }, async ({ page, kf }, testInfo) => {
  test.setTimeout(240_000);
  await kf.openChapter('ch07', { autoplay: true, t: 150, query: { profile: '1', tier: 'high' } });
  await kf.ensurePanelOpen();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const taskSeconds = async (): Promise<number> => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0;
  };

  // The film held as it will be with the analysis open (the analysis takes its own hold too).
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.holdFilm('perf');
  });
  await page.waitForTimeout(3000);
  const closedA = await measure(page, WINDOW_S, taskSeconds);
  const closedB = await measure(page, WINDOW_S, taskSeconds);

  const opener = page.getByRole('button', { name: 'Explore the letters of this phrase' });
  await opener.scrollIntoViewIfNeeded();
  await opener.click();
  await expect(page.getByTestId('discovery')).toHaveClass(/is-open/);
  // Past the dim's easing.
  await page.waitForTimeout(3000);
  const resting = await measure(page, WINDOW_S, taskSeconds);
  await page.getByRole('button', { name: 'Show the mirrored pairs' }).click();
  const pairs = await measure(page, PAIRS_S, taskSeconds);

  const closed = {
    gpuMedianMs: (closedA.gpuMedianMs + closedB.gpuMedianMs) / 2,
    cpuMsPerFrame: (closedA.cpuMsPerFrame + closedB.cpuMsPerFrame) / 2,
  };
  const added = (s: Sample): { gpuMs: number; cpuMs: number } => ({ gpuMs: s.gpuMedianMs - closed.gpuMedianMs, cpuMs: s.cpuMsPerFrame - closed.cpuMsPerFrame });
  const noise = { gpuMs: Math.abs(closedB.gpuMedianMs - closedA.gpuMedianMs), cpuMs: Math.abs(closedB.cpuMsPerFrame - closedA.cpuMsPerFrame) };
  const backend = (await kf.htmlData('backend')) ?? 'unknown';
  const tier = (await kf.htmlData('tier')) ?? 'unknown';
  const report = { project: testInfo.project.name, backend, tier, closedA, closedB, resting, pairs, noise, added: { resting: added(resting), pairs: added(pairs) } };
  const line = (name: string, s: Sample): string =>
    `${name} GPU ${s.gpuMedianMs.toFixed(3)} ms (${signed(added(s).gpuMs)}), CPU ${s.cpuMsPerFrame.toFixed(3)} ms/frame (${signed(added(s).cpuMs)}), ${s.medianFps.toFixed(1)} fps`;
  console.log(
    `[perf] ${report.project} discovery (${backend}, ${tier}): closed GPU ${closedA.gpuMedianMs.toFixed(3)} / ${closedB.gpuMedianMs.toFixed(3)} ms, ` +
      `CPU ${closedA.cpuMsPerFrame.toFixed(3)} / ${closedB.cpuMsPerFrame.toFixed(3)} ms/frame; ${line('resting', resting)}; ${line('pairs', pairs)}`,
  );
  await testInfo.attach('discovery-cost.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  testInfo.annotations.push({ type: 'perf', description: JSON.stringify(report) });

  if (!flag('PERF_ASSERT')) return;
  expect(tier).toBe('high');
  for (const [name, s] of [['resting', resting], ['pairs', pairs]] as const) {
    expect(added(s).gpuMs, `GPU time the analysis adds per frame (${name})`).toBeLessThanOrEqual(0.5);
    expect(added(s).cpuMs, `CPU time the analysis adds per frame (${name})`).toBeLessThanOrEqual(1);
  }
});
