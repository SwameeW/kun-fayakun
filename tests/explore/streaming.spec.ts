/**
 * Texture streaming never hitches the explorer (src/explore/assets/streaming.ts, ./upload): while the
 * Earth's High maps arrive (five 4096 files, 11 to 21 MiB each with their mip levels, uploaded in
 * byte-budgeted row bands), no frame takes longer than 1.5 times the median frame; going back to the
 * Earth after its hold has long passed uploads nothing (its upgrade is kept while the budget allows).
 *
 * Frame times only mean something on a real GPU, so this runs with the perf specs (PERF=1), on
 * WebGPU and WebGL2 alike.
 */
import type { Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';

const JD = '2461336.75';
const UNIVERSE_TIMEOUT = 90_000;
/** No frame longer than this many medians while the maps arrive. */
const WORST_OVER_MEDIAN = 1.5;

/** Frame deltas (ms) over `ms`, recorded in the page from requestAnimationFrame. */
async function frameDeltas(page: Page, ms: number, during: () => Promise<void>): Promise<number[]> {
  const recording = page.evaluate(
    (span) =>
      new Promise<number[]>((resolve) => {
        const deltas: number[] = [];
        let last = 0;
        let end = Infinity;
        const tick = (now: number): void => {
          if (last > 0) deltas.push(now - last);
          else end = now + span;
          last = now;
          if (now < end) requestAnimationFrame(tick);
          else resolve(deltas);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
  await during();
  return recording;
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const textures = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as KfHook).__kf.frameStats().memory.textures);

test('the Earth’s High maps arrive without a hitch, and going back uploads nothing', { tag: '@perf' }, async ({ page, kf, pageErrors }, testInfo) => {
  test.setTimeout(240_000);
  // Opened on Jupiter, so the Earth's floors are all that is resident for it.
  await kf.open('/universe/jupiter', { query: { jd: JD, tier: 'high' } });
  await expect(page.locator('html')).toHaveAttribute('data-universe-ready', 'true', { timeout: UNIVERSE_TIMEOUT });
  await page.waitForTimeout(7000);
  const before = await textures(page);

  const arriving = await frameDeltas(page, 7000, () =>
    page.evaluate(() => {
      (window as unknown as KfHook).__kf.universe.place({ body: 'earth', distanceKm: 20_000, azimuthDeg: -20 });
    }),
  );
  const raised = await textures(page);
  // Each upgrade replaced nothing (the floors stay): the Earth gained its High maps.
  expect(raised, 'the Earth’s High maps arrived').toBeGreaterThan(before);

  // Away for longer than the hold, and back: nothing to fetch or upload.
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.universe.place({ body: 'jupiter', distanceKm: 300_000, azimuthDeg: -10 });
  });
  await page.waitForTimeout(10_000);
  const returning = await frameDeltas(page, 3000, () =>
    page.evaluate(() => {
      (window as unknown as KfHook).__kf.universe.place({ body: 'earth', distanceKm: 20_000, azimuthDeg: -20 });
    }),
  );
  expect(await textures(page), 'nothing re-uploaded on the way back').toBe(raised);

  const report = (deltas: number[]): { median: number; worst: number; frames: number } => ({
    median: +median(deltas).toFixed(2),
    worst: +Math.max(...deltas).toFixed(2),
    frames: deltas.length,
  });
  const result = { arriving: report(arriving), returning: report(returning) };
  console.log(`[perf] ${testInfo.project.name}: streaming ${JSON.stringify(result)}`);
  testInfo.annotations.push({ type: 'perf', description: JSON.stringify(result) });
  for (const [name, deltas] of [['arriving', arriving], ['returning', returning]] as const) {
    expect(deltas.length, `${name}: frames recorded`).toBeGreaterThan(30);
    expect(Math.max(...deltas), `${name}: the worst frame against ${WORST_OVER_MEDIAN} x the median (${median(deltas).toFixed(1)} ms)`).toBeLessThanOrEqual(
      WORST_OVER_MEDIAN * median(deltas),
    );
  }
  expect(pageErrors).toEqual([]);
});
