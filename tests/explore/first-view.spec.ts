/**
 * A first view never stalls on building (src/explore/index.ts compileForFrames, warmHidden): what the
 * explorer compiles ahead (every part when it opens, the worlds' parts when they come, a detail
 * level's materials) is built for the render context the frames draw in, and what is hidden when it
 * opens is compiled too, so nothing is built the first time it shows. Before, three (r186) keyed the
 * built state by a render context one nested render shallower than the frames', so everything
 * compiled ahead was built again on its first draw: the night side's airglow and the sky's glow on the
 * first look at the night side, Uranus's rings, the Sun's limb close up (1 to 4 ms of the main thread
 * each on an M5), and a first flight from Jupiter to the Earth missed a frame in about a third of runs.
 *
 * It counts the materials the renderer builds while drawing (three's NodeManager, an internal: the
 * test says so and stops if a later three moves it).
 */
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, waitForUniverse } from '../support/universe';

interface Builds {
  __builds: string[];
}

test('the first view of a part hidden until then builds nothing while drawing', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/jupiter', { query: { jd: JD, tier: 'high' } });
  await waitForUniverse(page);
  // The worlds (and their glows, rings and tails) come a few seconds in, and compile as they come.
  await expect.poll(() => page.evaluate(() => (window as unknown as KfHook).__kf.universe.state()?.worlds?.shown ?? 0), { timeout: 60_000 * SLOW }).toBeGreaterThan(0.99);
  await page.waitForTimeout(3000);
  const hooked = await page.evaluate(() => {
    const w = window as unknown as Builds & { __kf: { app: unknown } };
    w.__builds = [];
    const gfx = (w.__kf.app as { gfx?: { handle?: { renderer?: unknown } } }).gfx;
    const nodes = (gfx?.handle?.renderer as { _nodes?: { getForRender?: (ro: unknown, useAsync?: boolean) => unknown; get?: (ro: unknown) => { nodeBuilderState?: unknown }; nodeBuilderCache?: Map<unknown, unknown> } } | undefined)?._nodes;
    if (!nodes?.getForRender || !nodes.get || !nodes.nodeBuilderCache) return false;
    const draw = nodes.getForRender.bind(nodes);
    const state = nodes.get.bind(nodes);
    const cache = nodes.nodeBuilderCache;
    nodes.getForRender = (ro: unknown, useAsync?: boolean) => {
      const o = ro as { initialCacheKey: unknown; object: { name: string; type: string } };
      // Built now, drawing (not compiling ahead): no state for this object yet, none cached for its key.
      if (!useAsync && state(ro).nodeBuilderState === undefined && !cache.has(o.initialCacheKey)) w.__builds.push(o.object.name || o.object.type);
      return draw(ro, useAsync);
    };
    return true;
  });
  test.skip(!hooked, 'three no longer exposes NodeManager.getForRender where this test reads it');
  for (const [label, pose] of [
    ['the Earth by day', { body: 'earth', distanceKm: 20_000, azimuthDeg: -20 }],
    ['the night side: the airglow and the sky’s glow', { body: 'earth', distanceKm: 30_000, azimuthDeg: 180, elevationDeg: 20 }],
    ['Uranus and its rings', { body: 'uranus', distanceKm: 100_000, azimuthDeg: 30, elevationDeg: 20 }],
    ['the Sun’s limb', { body: 'sun', distanceKm: 2_784_000, from: 'earth' }],
  ] as const) {
    await page.evaluate((p) => {
      (window as unknown as KfHook).__kf.universe.place(p);
    }, pose);
    await page.waitForTimeout(1500);
    const built = await page.evaluate(() => (window as unknown as Builds).__builds.splice(0));
    expect(built, `materials built while drawing ${label}`).toEqual([]);
  }
  expect(pageErrors).toEqual([]);
});
