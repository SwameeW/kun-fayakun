/**
 * The laboratory's frame budget (docs/SANDBOX-ROADMAP.md 5.2, W1.0): at High, 1440 x 900 at a device
 * pixel ratio of 2, a ring of 2,000 particles about the Earth and a belt of 2,000 about the Sun (4,000,
 * the most an experiment holds) while a Mars breaks up on the Earth with its fireball, debris and plume:
 * 60 frames a second with the 99th percentile frame under 20 ms; and the same at Low. Then the lab
 * without its effects' cost: the median frame rate with everything within 15 per cent of a quiet
 * experiment's, and of the same experiment with its effects switched off (the A/B switches,
 * window.__kf.universe.labEffects), the GPU's geometry and texture counts and the JavaScript heap after a
 * forced collection level over three round trips (no leak).
 * Always logs the numbers (they are recorded in docs/LAB.md); asserts the budget only with
 * PERF_ASSERT=1, since it only means something on the reference hardware.
 * Run with: PERF=1 PERF_ASSERT=1 npx playwright test --workers=1 tests/explore/lab-perf.spec.ts --project=webgpu
 */
import type { Page } from '@playwright/test';
import type { FrameStats } from '../../src/core/perf';
import type { LabCommand, UniverseLab } from '../../src/core/types';
import { flag } from '../support/env';
import { expect, test, type KfHook } from '../support/fixtures';
import { JD, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 120_000 };
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, labSlow: true });

const lab = async (page: Page): Promise<UniverseLab | null> => (await view(page))?.lab ?? null;
const command = (page: Page, c: LabCommand): Promise<unknown> => page.evaluate((x) => (window as unknown as KfHook).__kf.universe.lab?.(x), c);
const stats = async (page: Page, seconds: number): Promise<FrameStats> => {
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.resetFrameStats();
  });
  await page.waitForTimeout(seconds * 1000);
  return (await page.evaluate(() => (window as unknown as KfHook).__kf.frameStats())) as FrameStats;
};

for (const detail of ['high', 'low'] as const) {
  test(`4,000 particles and a breakup at ${detail}: the frame rate held`, { tag: '@perf' }, async ({ page, kf }, testInfo) => {
    test.setTimeout(300_000);
    await kf.open('/universe/earth', { query: { jd: JD, detail, profile: '1' } });
    await waitForUniverse(page);
    await page.getByTestId('lab-open').click();
    await expect.poll(async () => (await lab(page))?.bodies.length ?? 0, LIVE).toBe(10);
    await command(page, { kind: 'reset' });
    await expect.poll(async () => (await lab(page))?.elapsedS, LIVE).toBe(0);
    const quiet = await stats(page, 6);
    // 2,000 test particles about the Earth (1.5 to 2.5 radii) and 2,000 in the main belt.
    await command(page, { kind: 'addSwarm', primary: 'earth', name: 'ring', count: 2000, innerKm: 9_600, outerKm: 16_000, eccentricity: 0, inclinationDeg: 0, plane: 'equator' });
    await command(page, { kind: 'addSwarm', primary: 'sun', name: 'belt', count: 2000, innerKm: 3.08e8, outerKm: 4.89e8, eccentricity: 0.2, inclinationDeg: 15, plane: 'orbit' });
    await expect.poll(async () => (await lab(page))?.particlesDrawn, LIVE).toBeGreaterThan(1900);
    await command(page, { kind: 'aim', target: 'earth', impactor: 'mars', vInfKmS: 20, angleDeg: 80, leadS: 4 * 86_400, site: [0.6, -0.5, 0.62], heading: [0, 0, 1] });
    await expect.poll(async () => (await lab(page))?.aim?.status, LIVE).toBe('ready');
    await command(page, { kind: 'throw' });
    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.app.universeTime({ kind: 'rate', rate: 86_400 });
    });
    const ringed = await stats(page, 3);
    // A/B: the same experiment with its effects switched off (and their work skipped), then on again.
    await page.evaluate(() => (window as unknown as KfHook).__kf.universe.labEffects?.({ rocks: false, dust: false, fire: false, bands: false }));
    const bare = await stats(page, 3);
    expect(await page.evaluate(() => (window as unknown as KfHook).__kf.universe.labEffects?.({ rocks: true, dust: true, fire: true, bands: true }))).toEqual({ rocks: true, dust: true, fire: true, bands: true });
    // Through the breakup: slowing, fireball, debris, plume, the ring's particles lit and shadowed.
    await expect.poll(async () => (await lab(page))?.events.some((e) => e.kind === 'fragment'), LIVE).toBe(true);
    const breakup = await stats(page, 8);
    const drawn = (await page.evaluate(() => (window as unknown as KfHook).__kf.universe.labDraw?.())) as { dust: { particles: number } } | null;
    const numbers = { detail, quiet: { fps: quiet.medianFps, p99: quiet.p99FrameMs }, bare: { fps: bare.medianFps, p99: bare.p99FrameMs }, ringed: { fps: ringed.medianFps, p99: ringed.p99FrameMs }, breakup: { fps: breakup.medianFps, p99: breakup.p99FrameMs, gpuMs: breakup.gpuMedianMs, frames: breakup.frames }, particles: drawn?.dust.particles };
    console.log(JSON.stringify(numbers));
    testInfo.annotations.push({ type: 'perf', description: JSON.stringify(numbers) });
    if (flag('PERF_ASSERT')) {
      expect(breakup.medianFps).toBeGreaterThanOrEqual(58);
      expect(breakup.p99FrameMs).toBeLessThan(20);
      expect(ringed.medianFps).toBeGreaterThanOrEqual(0.85 * quiet.medianFps);
      expect(ringed.medianFps).toBeGreaterThanOrEqual(0.85 * bare.medianFps);
    }
    // Round trips: out of the laboratory and back three times; the GPU's resources level, and the heap after a forced collection.
    const cdp = await page.context().newCDPSession(page);
    const heap = async (): Promise<number> => {
      await cdp.send('HeapProfiler.collectGarbage');
      return (await cdp.send('Runtime.getHeapUsage')).usedSize;
    };
    const heaps: number[] = [];
    const memory: Array<{ geometries: number; textures: number }> = [];
    for (let k = 0; k < 3; k += 1) {
      await page.getByTestId('lab-back').click();
      await expect.poll(async () => (await view(page))?.lab ?? null, LIVE).toBeNull();
      await page.getByTestId('lab-open').click();
      await expect.poll(async () => (await lab(page))?.bodies.length ?? 0, LIVE).toBe(10);
      await page.waitForTimeout(1500);
      memory.push((await page.evaluate(() => (window as unknown as KfHook).__kf.frameStats())).memory);
      heaps.push(await heap());
    }
    console.log(JSON.stringify({ memory, heapMb: heaps.map((x) => Math.round(x / 1e5) / 10) }));
    // Level: the third no more than the first by 8 MB (what a frame's garbage and the caches' warm-up leave).
    expect(heaps[2] ?? 0).toBeLessThanOrEqual((heaps[0] ?? 0) + 8e6);
    expect(memory[2]?.geometries).toBeLessThanOrEqual((memory[0]?.geometries ?? 0) + 2);
    expect(memory[2]?.textures).toBeLessThanOrEqual((memory[0]?.textures ?? 0) + 2);
  });
}
