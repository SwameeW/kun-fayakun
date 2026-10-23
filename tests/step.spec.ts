/**
 * Deterministic stepping (__kf.step, docs/CONTRACTS.md "Test hooks"): once a test steps,
 * time moves only when it says so, by exactly the amount it asks for.
 */
import { expect, test, type KfHook } from './support/fixtures';

test('__kf.step freezes the clock and advances it by exactly frames x dt', async ({ page, kf, pageErrors }) => {
  await kf.openChapter('ch03', { t: 20, query: { tier: 'low' } });

  const start = await page.evaluate(() => {
    const kfHook = (window as unknown as KfHook).__kf;
    if (kfHook.app.paused) kfHook.app.play();
    kfHook.step();
    // Step through the chapter's title card, if it is showing, until the film runs.
    for (let i = 0; i < 200 && kfHook.app.state !== 'playing'; i += 1) kfHook.step(10, 0.1);
    return { state: kfHook.app.state, time: kfHook.app.time };
  });
  expect(start.state).toBe('playing');

  // Real time passes and frames keep rendering, but the film does not move.
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as KfHook).__kf.app.time)).toBe(start.time);

  const after = await page.evaluate(() => {
    const kfHook = (window as unknown as KfHook).__kf;
    kfHook.step(30, 0.05);
    return kfHook.app.time;
  });
  expect(after - start.time).toBeCloseTo(1.5, 9);

  // Out-of-range arguments are refused rather than silently clamped.
  const refused = await page.evaluate(() => {
    const kfHook = (window as unknown as KfHook).__kf;
    const throws = (frames: number, dt?: number): boolean => {
      try {
        kfHook.step(frames, dt);
        return false;
      } catch {
        return true;
      }
    };
    return [throws(1, 0), throws(1, 0.5), throws(-1), throws(1.5)];
  });
  expect(refused).toEqual([true, true, true, true]);
  expect(pageErrors).toEqual([]);
});
