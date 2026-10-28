/**
 * On foot, pushed hard (src/explore/walk, src/ui/explore/walk-hud, src/explore/input): Esc pressed again
 * and again or held never leaves the explorer from the ground (only the walk, then nothing for a
 * second); storms of keys, drags and pad presses in one frame leave the walker on the ground with every
 * figure a number; walks begun and left over and over; the controls' sense (a drag turns the way the
 * hand moves, Space jumps without pausing time, Q and E turn, the pad steps aside and runs); the way
 * back to orbit always on screen and every control inside the window at 1280 x 800, 1440 x 900 and
 * 2000 x 1300 (the phone's sizes are tests/explore/mobile.spec's); a landing whose ground never comes
 * says so and offers Retry; a walk asked for during a trip waits for the arrival; and the horizon level
 * at any look up or down, the navigator open or folded (the light and the ground's decoding are
 * tests/explore/walk-light.spec's). Mocked flat terrain at 1,000 m.
 */
import type { Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';
import { NEEDS_REAL_FRAMES, NO_GPU, SLOW } from '../support/env';
import { MOCK_GROUND_M } from '../support/live';
import { fits } from '../support/layout';
import { JD, view, waitForUniverse } from '../support/universe';
import type { UniverseWalk } from '../../src/core/types';

const LIVE = { timeout: 60_000 * SLOW };
/** A place on the mocked flat ground (the Sahara), and its route. */
const HERE = { lat: 23.4, lon: 25 } as const;

test.use({ reducedMotion: 'reduce' });

const walkView = async (page: Page): Promise<UniverseWalk | null> => (await view(page))?.walk ?? null;

async function walkAt(page: Page, at: { lat: number; lon: number; world?: 'earth' | 'moon' | 'mars'; headingDeg?: number; pitchDeg?: number } = HERE): Promise<void> {
  await page.evaluate((a) => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', ...a });
  }, at);
  await expect.poll(async () => (await walkView(page))?.state, LIVE).toBe('walking');
  // Keys go to the explorer, not to the button that began the walk.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

const hash = (page: Page): Promise<string> => page.evaluate(() => location.hash);
const experience = (page: Page): Promise<string | null> => page.evaluate(() => document.documentElement.getAttribute('data-experience'));

/** Every number on the walk's view a finite number, the feet on or above the ground, within the tiles' latitudes. */
function sane(w: UniverseWalk | null): void {
  expect(w).not.toBeNull();
  if (!w) return;
  for (const [k, v] of Object.entries(w)) if (typeof v === 'number') expect(Number.isFinite(v), k).toBe(true);
  expect(w.feetM).toBeGreaterThanOrEqual(w.groundM - 0.01);
  expect(Math.abs(w.lat)).toBeLessThanOrEqual(85);
}

test('Esc on foot, pressed again and again or held: back to orbit and no further; a second later, one Esc still leaves', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const route = await hash(page);
  // Pressed eight times, a tenth of a second apart (the dip out takes most of a second).
  await walkAt(page);
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
  }
  await expect.poll(async () => walkView(page), LIVE).toBeNull();
  expect(await hash(page)).toBe(route);
  expect(await experience(page)).toBe('universe');
  // Held down: the key's repeats (as a held key sends them) go nowhere.
  await walkAt(page);
  const cdp = await page.context().newCDPSession(page);
  const esc = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...esc });
  for (let i = 0; i < 40; i += 1) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...esc });
    await page.waitForTimeout(30);
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...esc });
  await expect.poll(async () => walkView(page), LIVE).toBeNull();
  expect(await hash(page)).toBe(route);
  expect(await experience(page)).toBe('universe');
  // Esc while the ground is still loading (the walk asked for): the walk is dropped, nothing more.
  await page.evaluate((a) => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', ...a });
  }, HERE);
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('Escape');
  await expect.poll(async () => walkView(page), LIVE).toBeNull();
  expect(await hash(page)).toBe(route);
  // A second after the last, with nothing left to stop, one Esc leaves the explorer, as it always has.
  await page.waitForTimeout(1300);
  await page.keyboard.press('Escape');
  await expect.poll(async () => hash(page), LIVE).not.toBe(route);
  expect(pageErrors).toEqual([]);
});

test.describe('with motion', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('Esc storms through the dip and the climb back to orbit go no further than orbit', async ({ page, kf, pageErrors }) => {
    test.skip(NO_GPU, NEEDS_REAL_FRAMES);
    test.setTimeout(240_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    const route = await hash(page);
    await walkAt(page);
    // Every quarter of a second for four seconds: through the dip, and the glide back up.
    for (let i = 0; i < 16; i += 1) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
    }
    await expect.poll(async () => walkView(page), LIVE).toBeNull();
    expect(await hash(page)).toBe(route);
    expect(await experience(page)).toBe('universe');
    await expect.poll(async () => (await view(page))?.altitudeKm ?? 0, LIVE).toBeGreaterThan(100);
    expect(pageErrors).toEqual([]);
  });
});

test('storms in one frame: 300 pad presses, walks, ends and nonsense on the pad; 200 keys and 20 drags; the walker stays on the ground and every figure a number', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await walkAt(page);
  const paused = (await view(page))?.time.paused;
  // 300 synchronous presses and commands, seeded, within one frame.
  await page.evaluate(() => {
    let s = 12345;
    const random = (): number => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    const app = (window as unknown as KfHook).__kf.app;
    const ids = ['walk-forward', 'walk-backward', 'walk-left', 'walk-right', 'walk-jump', 'walk-run'];
    const odd = [Number.NaN, Number.POSITIVE_INFINITY, -1e9, 1e9, 0.5, -0.5];
    for (let i = 0; i < 300; i += 1) {
      const r = random();
      const id = ids[Math.floor(random() * ids.length)] ?? 'walk-forward';
      const b = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (r < 0.5 && b) {
        b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7 }));
        b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));
      } else if (r < 0.8) app.earthCommand({ kind: 'walkPad', forward: odd[i % odd.length] ?? 0, right: odd[(i + 3) % odd.length], run: i % 2 === 0, jump: i % 3 === 0 });
      else if (r < 0.9) app.earthCommand({ kind: 'walk', lat: 23.4 + random() * 0.01, lon: 25 });
      else app.earthCommand({ kind: 'walkEnd' });
    }
    app.earthCommand({ kind: 'walkPad', forward: 0, right: 0, run: false, jump: false });
    app.earthCommand({ kind: 'walk', lat: 23.4, lon: 25 });
  });
  await expect.poll(async () => (await walkView(page))?.state, LIVE).toBe('walking');
  sane(await walkView(page));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // 200 seeded keys at about ten a second's hundredth: walk, run, jump, turn, look; and 20 drags.
  const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ShiftLeft', 'KeyQ', 'KeyE'];
  let seed = 99;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 200; i += 1) {
    const key = keys[Math.floor(random() * keys.length)] ?? 'KeyW';
    await page.keyboard.down(key);
    if (random() < 0.7) await page.keyboard.up(key);
    await page.waitForTimeout(10);
  }
  for (const key of keys) await page.keyboard.up(key);
  const box = await page.locator('canvas').first().boundingBox();
  if (box) {
    for (let i = 0; i < 20; i += 1) {
      await page.mouse.move(box.x + box.width * (0.3 + random() * 0.4), box.y + box.height * (0.2 + random() * 0.3));
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * random(), box.y + box.height * random() * 0.6, { steps: 3 });
      await page.mouse.up();
    }
  }
  // Settled: still on foot, on the ground, every figure a number; Space never paused or ran time.
  await expect.poll(async () => (await walkView(page))?.airborne, LIVE).toBe(false);
  const w = await walkView(page);
  expect(w?.state).toBe('walking');
  sane(w);
  expect((await view(page))?.time.paused).toBe(paused);
  expect(await experience(page)).toBe('universe');
  expect(pageErrors).toEqual([]);
});

test('walks begun and left over and over: each lands, each leaves, nothing stuck', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  for (let i = 0; i < 6; i += 1) {
    await walkAt(page, { lat: HERE.lat + i * 0.2, lon: HERE.lon });
    await expect.poll(async () => (await walkView(page))?.rings ?? 0, LIVE).toBeGreaterThan(5);
    await expect(page.getByTestId('walk-end')).toBeVisible();
    await expect(page.getByTestId('universe-back')).toBeHidden();
    await page.getByTestId('walk-end').click();
    await expect.poll(async () => walkView(page), LIVE).toBeNull();
    await expect(page.getByTestId('universe-back')).toBeVisible();
  }
  // Ten Back to orbit clicks in a burst and a walk at once: no errors, the explorer still in orbit.
  await walkAt(page);
  await page.evaluate(() => {
    const b = document.querySelector<HTMLElement>('[data-testid="walk-end"]');
    for (let i = 0; i < 10; i += 1) b?.click();
  });
  await expect.poll(async () => walkView(page), LIVE).toBeNull();
  expect(await experience(page)).toBe('universe');
  expect(pageErrors).toEqual([]);
});

test('the controls: a drag turns the way the hand moves, Space jumps (time runs on as it was), Q and E turn, the pad steps aside and runs', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await walkAt(page, { ...HERE, headingDeg: 90, pitchDeg: 0 });
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 3 };
  // 200 px to the right: about 37 degrees to the right (0.0032 rad a pixel).
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 200, at.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await walkView(page))?.headingDeg ?? 0, LIVE).toBeGreaterThan(90 + 25);
  expect((await walkView(page))?.headingDeg ?? 0).toBeLessThan(90 + 45);
  // Up looks up.
  const pitch = (await walkView(page))?.pitchDeg ?? 0;
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x, at.y - 100, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await walkView(page))?.pitchDeg ?? 0, LIVE).toBeGreaterThan(pitch + 10);
  // Space jumps; time is left as it was (Space is the page's play key elsewhere).
  const paused = (await view(page))?.time.paused;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down('Space');
  await expect.poll(async () => ((await walkView(page))?.feetM ?? 0) - MOCK_GROUND_M, LIVE).toBeGreaterThan(0.05);
  await page.keyboard.up('Space');
  expect((await view(page))?.time.paused).toBe(paused);
  // E turns right, Q left.
  const heading = (await walkView(page))?.headingDeg ?? 0;
  await page.keyboard.down('KeyE');
  await expect.poll(async () => (await walkView(page))?.headingDeg ?? 0, LIVE).toBeGreaterThan(heading + 5);
  await page.keyboard.up('KeyE');
  const turned = (await walkView(page))?.headingDeg ?? 0;
  await page.keyboard.down('KeyQ');
  await expect.poll(async () => (await walkView(page))?.headingDeg ?? 0, LIVE).toBeLessThan(turned - 5);
  await page.keyboard.up('KeyQ');
  // The pad's Step right, held: the walker moves, facing as it did.
  const before = await walkView(page);
  const right = await page.getByTestId('walk-right').boundingBox();
  if (!right) throw new Error('no Step right');
  await page.mouse.move(right.x + right.width / 2, right.y + right.height / 2);
  await page.mouse.down();
  await expect.poll(async () => ((await walkView(page))?.walkedM ?? 0) - (before?.walkedM ?? 0), LIVE).toBeGreaterThan(0.3);
  await page.mouse.up();
  expect(Math.abs(((await walkView(page))?.headingDeg ?? 0) - (before?.headingDeg ?? 0))).toBeLessThan(1);
  // Stepping right while facing east goes south: the latitude falls.
  expect((await walkView(page))?.lat ?? 0).toBeLessThan(before?.lat ?? 0);
  // Run: pressed, and the pad walks at a run.
  await page.getByTestId('walk-run').click();
  await expect(page.getByTestId('walk-run')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('walk-run').click();
  await expect(page.getByTestId('walk-run')).toHaveAttribute('aria-pressed', 'false');
  expect(pageErrors).toEqual([]);
});

test('mouse-look: a click on the view takes the pointer, the mouse turns the look, and leaving the walk lets it go (the browser’s own first Esc, which lets it go, is not modelled headless)', async ({ page, kf, pageErrors, browserName }) => {
  test.setTimeout(240_000 * SLOW);
  test.skip(browserName !== 'chromium', 'pointer lock as Chromium grants it after a click');
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await walkAt(page, { ...HERE, headingDeg: 0, pitchDeg: 0 });
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.tagName ?? null), LIVE).toBe('CANVAS');
  const heading = (await walkView(page))?.headingDeg ?? 0;
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 3, { steps: 6 });
  await expect.poll(async () => Math.abs(((await walkView(page))?.headingDeg ?? 0) - heading), LIVE).toBeGreaterThan(5);
  // Leaving the walk lets the pointer go.
  await page.getByTestId('walk-end').evaluate((b) => {
    (b as HTMLButtonElement).click();
  });
  await expect.poll(async () => walkView(page), LIVE).toBeNull();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement)).toBeNull();
  expect(pageErrors).toEqual([]);
});

for (const [size, scale] of [
  [{ width: 1280, height: 800 }, 1],
  [{ width: 1440, height: 900 }, 1],
  [{ width: 2000, height: 1300 }, 1],
  // A 2000 x 1300 Retina window: 1000 x 650 CSS px at two device pixels each.
  [{ width: 1000, height: 650 }, 2],
] as const) {
  test.describe(`at ${String(size.width)} x ${String(size.height)}${scale > 1 ? ` (device pixel ratio ${String(scale)})` : ''}`, () => {
    test.use({ viewport: size, deviceScaleFactor: scale });
    test('on foot the view is the world’s: the way back to orbit in reach, every control inside the window and none covered, the view taking the pointer, the navigator folded (and open again after)', async ({ page, kf, pageErrors }) => {
      test.setTimeout(240_000 * SLOW);
      await kf.open('/universe/earth', { query: { jd: JD } });
      await waitForUniverse(page);
      const navOpen = await page.getByTestId('universe-nav-toggle').getAttribute('aria-expanded');
      // What the page says to a screen reader, kept as it is said.
      await page.evaluate(() => {
        const said: string[] = [];
        (window as unknown as { said: string[] }).said = said;
        const live = document.querySelector('.kf-sr-only[aria-live="polite"]');
        if (live) new MutationObserver(() => said.push(live.textContent)).observe(live, { childList: true, characterData: true, subtree: true });
      });
      await walkAt(page);
      await expect(page.getByTestId('walk-end')).toBeVisible();
      await expect(page.getByTestId('universe-nav-toggle')).toHaveAttribute('aria-expanded', 'false');
      // The controls' card on landing, said once (the keys, with a mouse and keyboard).
      await expect(page.getByTestId('walk-help')).toBeVisible();
      await expect.poll(() => page.evaluate(() => (window as unknown as { said: string[] }).said.some((t) => t.includes('W A S D'))), LIVE).toBe(true);
      await fits(page, 'landed');
      // The view itself takes a drag anywhere the interface does not cover.
      const free = await page.evaluate(() => {
        const out: string[] = [];
        for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.3], [0.7, 0.6], [0.35, 0.4]] as const) {
          const hit = document.elementFromPoint(innerWidth * fx, innerHeight * fy);
          if (hit?.tagName !== 'CANVAS') out.push(`${String(fx)},${String(fy)}: ${hit ? `${hit.tagName}.${hit.className}` : 'nothing'}`);
        }
        return out;
      });
      expect(free).toEqual([]);
      // The interface (the header aside) covers under a quarter of the view.
      const covered = await page.evaluate(() => {
        let area = 0;
        const parts = document.querySelectorAll<HTMLElement>('.kf-walk-top > *, .kf-walk-dock > *, [data-testid="universe-bodies"]');
        for (const el of parts) {
          const r = el.getBoundingClientRect();
          if (getComputedStyle(el).display !== 'none' && r.width > 0) area += r.width * r.height;
        }
        return area / (innerWidth * innerHeight);
      });
      expect(covered).toBeLessThan(0.25);
      // The figures opened: still all inside, the pad (the rover with it) and the way back still there.
      await page.getByTestId('walk-title').click();
      await expect(page.getByTestId('walk-gravity')).toBeVisible();
      await fits(page, 'figures open');
      await expect(page.getByTestId('walk-forward')).toBeVisible();
      await expect(page.getByTestId('walk-rover')).toBeVisible();
      // Opened and folded twenty times, a frame apart: still fits.
      for (let i = 0; i < 20; i += 1) await page.getByTestId('walk-title').click();
      await fits(page, 'figures folded and opened');
      await page.getByTestId('walk-title').click();
      // Back in orbit, the navigator as it was.
      await page.getByTestId('walk-end').click();
      await expect.poll(async () => walkView(page), LIVE).toBeNull();
      await expect(page.getByTestId('universe-nav-toggle')).toHaveAttribute('aria-expanded', navOpen ?? 'true');
      expect(pageErrors).toEqual([]);
    });
  });
}

test('a landing whose ground never comes says so, with Retry and the way back; when the ground comes back, Retry lands', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  // The terrain host unreachable (its own requests fail; the console's network errors are expected here).
  let down = true;
  await page.route(/s3\.amazonaws\.com/u, async (route) => {
    if (down) await route.abort('connectionrefused');
    else await route.fallback();
  });
  await page.evaluate((a) => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', ...a });
  }, HERE);
  await expect(page.getByTestId('walk-end')).toBeVisible();
  await expect.poll(async () => (await walkView(page))?.state, { timeout: 40_000 * SLOW }).toBe('unavailable');
  await expect(page.getByTestId('walk-notice')).toContainText('did not arrive');
  await expect(page.getByTestId('walk-retry')).toBeVisible();
  await expect(page.getByTestId('walk-end')).toBeFocused();
  // The host back: Retry, and the walk lands (a back-off's own retry may land it first: then Retry has gone, and that is fine).
  down = false;
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-testid="walk-retry"]')?.click();
  });
  await expect.poll(async () => (await walkView(page))?.state, LIVE).toBe('walking');
  await expect(page.getByTestId('walk-retry')).toBeHidden();
  expect(pageErrors.filter((e) => !e.includes('net::ERR') && !e.includes('Failed to load resource'))).toEqual([]);
});

test('only the coarse ground loading: the walk lands on it after a while, and says so', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  // Tiles of zoom 9 and finer refused.
  await page.route(/s3\.amazonaws\.com\/elevation-tiles-prod\/terrarium\/(\d+)\//u, async (route) => {
    const z = Number(/terrarium\/(\d+)\//u.exec(route.request().url())?.[1] ?? 0);
    if (z >= 9) await route.abort('connectionrefused');
    else await route.fallback();
  });
  await page.evaluate((a) => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', ...a });
  }, HERE);
  await expect.poll(async () => (await walkView(page))?.state, { timeout: 40_000 * SLOW }).toBe('walking');
  const w = await walkView(page);
  expect(w?.coarse).toBe(true);
  expect(w?.groundZoom ?? 99).toBeLessThan(9);
  expect(w?.groundM).toBeCloseTo(MOCK_GROUND_M, 3);
  await expect(page.getByTestId('walk-notice')).toContainText('coarser');
  expect(pageErrors.filter((e) => !e.includes('net::ERR') && !e.includes('Failed to load resource'))).toEqual([]);
});

test('a walk asked for during a trip waits for the arrival (the way back shown meanwhile), then lands', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.evaluate(() => {
    const app = (window as unknown as KfHook).__kf.app;
    app.focusBody('mars');
    app.earthCommand({ kind: 'walk', world: 'mars', lat: 18.4447, lon: 77.4508 });
  });
  // Waiting: Back to orbit (not Back to the start) from the moment it is asked for.
  await expect(page.getByTestId('walk-end')).toBeVisible();
  await expect(page.getByTestId('universe-back')).toBeHidden();
  await expect.poll(async () => (await walkView(page))?.state, { timeout: 90_000 * SLOW }).toBe('walking');
  expect((await walkView(page))?.world).toBe('mars');
  expect(pageErrors).toEqual([]);
});

test('a walk waiting for a trip goes where the trip goes: Esc drops it with the trip, and another world chosen drops it', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const ask = (): Promise<void> =>
    page.evaluate(() => {
      const app = (window as unknown as KfHook).__kf.app;
      app.focusBody('mars');
      app.earthCommand({ kind: 'walk', world: 'mars', lat: 18.4447, lon: 77.4508 });
    });
  // Esc during the trip: the trip stops and the walk is dropped (it never lands on Mars with the navigator at the Earth).
  await ask();
  expect((await view(page))?.walkWaiting).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await view(page))?.travelling, LIVE).toBe(false);
  await page.waitForTimeout(4000);
  expect(await walkView(page)).toBeNull();
  expect((await view(page))?.walkWaiting).toBe(false);
  expect((await view(page))?.focus).toBe('earth');
  await expect(page.getByTestId('walk-end')).toBeHidden();
  await expect(page.getByTestId('universe-back')).toBeVisible();
  // Another world chosen during the trip: no walk on the first, the navigator at the second.
  await ask();
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.focusBody('jupiter');
  });
  await expect.poll(async () => (await view(page))?.focus, { timeout: 90_000 * SLOW }).toBe('jupiter');
  await expect.poll(async () => (await view(page))?.travelling, LIVE).toBe(false);
  await page.waitForTimeout(3000);
  expect(await walkView(page)).toBeNull();
  expect((await view(page))?.walkWaiting).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('landing (and a landing that never comes): a click on the view takes no pointer, Space stays the play key, Retry takes a click', async ({ page, kf, pageErrors, browserName }) => {
  test.setTimeout(240_000 * SLOW);
  test.skip(browserName !== 'chromium', 'pointer lock as Chromium grants it after a click');
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.route(/s3\.amazonaws\.com/u, async (route) => {
    await route.abort('connectionrefused');
  });
  await page.evaluate((a) => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', ...a });
  }, HERE);
  await expect.poll(async () => (await walkView(page))?.state, LIVE).toBe('landing');
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 3 };
  const lock = (): Promise<string | null> => page.evaluate(() => document.pointerLockElement?.tagName ?? null);
  await page.mouse.click(centre.x, centre.y);
  await page.waitForTimeout(300);
  expect(await lock()).toBeNull();
  // Space is still the play key while the camera waits in orbit.
  const paused = (await view(page))?.time.paused;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Space');
  await expect.poll(async () => (await view(page))?.time.paused, LIVE).toBe(!paused);
  await expect.poll(async () => (await walkView(page))?.state, { timeout: 40_000 * SLOW }).toBe('unavailable');
  await page.mouse.click(centre.x, centre.y);
  await page.waitForTimeout(300);
  expect(await lock()).toBeNull();
  await page.getByTestId('walk-retry').click();
  expect(await lock()).toBeNull();
  await page.getByTestId('walk-end').click();
  await expect.poll(async () => walkView(page), LIVE).toBeNull();
  expect(pageErrors.filter((e) => !e.includes('net::ERR') && !e.includes('Failed to load resource'))).toEqual([]);
});

/** The camera's tilt about its view (degrees): its right against the local vertical where the walker stands. */
const roll = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const kf = (window as unknown as KfHook).__kf;
    const app = kf.app as unknown as { camera: { quaternion: { x: number; y: number; z: number; w: number } }; scene: { getObjectByName(n: string): { quaternion: { x: number; y: number; z: number; w: number } } | undefined } };
    const w = kf.universe.state()?.walk;
    const ground = app.scene.getObjectByName('explore-walk-ground');
    if (!w || !ground) return Number.NaN;
    const rotate = (q: { x: number; y: number; z: number; w: number }, v: [number, number, number]): [number, number, number] => {
      // v + 2 q.w (q x v) + 2 q x (q x v)
      const [x, y, z] = v;
      const tx = 2 * (q.y * z - q.z * y);
      const ty = 2 * (q.z * x - q.x * z);
      const tz = 2 * (q.x * y - q.y * x);
      return [x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx)];
    };
    const p = (w.lat * Math.PI) / 180;
    const l = (w.lon * Math.PI) / 180;
    const up = rotate(ground.quaternion, [Math.cos(p) * Math.cos(l), Math.sin(p), -Math.cos(p) * Math.sin(l)]);
    const right = rotate(app.camera.quaternion, [1, 0, 0]);
    return (Math.asin(Math.max(-1, Math.min(1, right[0] * up[0] + right[1] * up[1] + right[2] * up[2]))) * 180) / Math.PI;
  });

test('the horizon level on foot, looking up or down, the navigator open or folded, and while it is folded and opened over and over', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  for (const pitchDeg of [-60, -30, 0, 30, 60]) {
    await walkAt(page, { ...HERE, headingDeg: 40, pitchDeg });
    for (const open of [false, true]) {
      if ((await page.getByTestId('universe-nav-toggle').getAttribute('aria-expanded')) !== String(open)) await page.getByTestId('universe-nav-toggle').click();
      await page.evaluate(() => {
        (window as unknown as KfHook).__kf.step(30, 1 / 60);
      });
      expect(Math.abs(await roll(page)), `pitch ${String(pitchDeg)}, navigator ${open ? 'open' : 'folded'}`).toBeLessThan(0.06);
    }
  }
  // Twenty folds and openings a tenth of a second apart, looking 30 degrees up: level at every frame.
  await walkAt(page, { ...HERE, headingDeg: 40, pitchDeg: 30 });
  let worst = 0;
  for (let i = 0; i < 20; i += 1) {
    await page.getByTestId('universe-nav-toggle').click();
    for (let f = 0; f < 6; f += 1) {
      await page.evaluate(() => {
        (window as unknown as KfHook).__kf.step(1, 1 / 60);
      });
      worst = Math.max(worst, Math.abs(await roll(page)));
    }
  }
  expect(worst).toBeLessThan(0.06);
  expect(pageErrors).toEqual([]);
});

test('on the way down through Venus’s clouds: Space stays the play key (a descent has no jump), and Esc pressed again and again goes back to orbit and no further', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/venus', { query: { jd: JD } });
  await waitForUniverse(page);
  const route = await hash(page);
  await page.getByTestId('world-descent').click();
  await expect.poll(async () => (await view(page))?.descent?.world ?? null, LIVE).toBe('venus');
  // Shown: the eye on the way down (its 70 degree view in place of the navigator's).
  await expect.poll(() => page.evaluate(() => (window as unknown as KfHook).__kf.camera().fov), LIVE).toBe(70);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const paused = (await view(page))?.time.paused;
  await page.keyboard.press('Space');
  await expect.poll(async () => (await view(page))?.time.paused, LIVE).toBe(!paused);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await view(page))?.time.paused, LIVE).toBe(paused);
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
  }
  await expect.poll(async () => (await view(page))?.descent ?? null, LIVE).toBeNull();
  expect(await hash(page)).toBe(route);
  expect(await experience(page)).toBe('universe');
  expect(pageErrors).toEqual([]);
});

test.describe('with motion, the climb back', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('Esc during the climb back to orbit stops it where it is (and goes no further)', async ({ page, kf, pageErrors }) => {
    test.skip(NO_GPU, NEEDS_REAL_FRAMES);
    test.setTimeout(240_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    const route = await hash(page);
    // Once the explorer's own approach has settled; then from orbit over the place (a descent first), so
    // there is a climb back to make.
    await expect
      .poll(async () => {
        const a = (await view(page))?.altitudeKm ?? 0;
        await page.waitForTimeout(300);
        return Math.abs(((await view(page))?.altitudeKm ?? 0) - a) / Math.max(a, 1);
      }, LIVE)
      .toBeLessThan(0.002);
    await page.evaluate((a) => {
      (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', ...a });
    }, HERE);
    await expect.poll(async () => (await walkView(page))?.state, LIVE).toBe('walking');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    // The dip out, then the climb: rising.
    await expect.poll(async () => walkView(page), LIVE).toBeNull();
    await expect.poll(async () => (await view(page))?.altitudeKm ?? 0, LIVE).toBeGreaterThan(20);
    const rising = (await view(page))?.altitudeKm ?? 0;
    await page.keyboard.press('Escape');
    const stopped = (await view(page))?.altitudeKm ?? 0;
    expect(stopped).toBeGreaterThanOrEqual(rising);
    await page.waitForTimeout(800);
    expect(Math.abs(((await view(page))?.altitudeKm ?? 0) - stopped)).toBeLessThan(Math.max(1, stopped * 0.02));
    expect(await hash(page)).toBe(route);
    expect(await experience(page)).toBe('universe');
    expect(pageErrors).toEqual([]);
  });
});

test.describe('landing and leaving, small', () => {
  test.use({ viewport: { width: 640, height: 400 } });
  test('landing and leaving ten times: never more than three flashes in any second (WCAG 2.3.1)', async ({ page, kf, pageErrors }) => {
    test.setTimeout(400_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    await walkAt(page);
    // On the stepped clock: two frames (a thirtieth of a second) between pictures, each picture's mean luma.
    const sample = async (): Promise<number> => {
      await page.evaluate(() => {
        (window as unknown as KfHook).__kf.step(2, 1 / 60);
      });
      const png = (await page.locator('#scene').screenshot({ style: 'body > :not(#scene), body > :not(#scene) * { visibility: hidden !important; transition: none !important; }' })) as Uint8Array;
      let binary = '';
      for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
      return page.evaluate(async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const g = canvas.getContext('2d');
        if (!g) return 0;
        g.drawImage(bitmap, 0, 0);
        const { data } = g.getImageData(0, 0, bitmap.width, bitmap.height);
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
        return sum / (data.length / 4);
      }, btoa(binary));
    };
    const lumas: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      await page.evaluate(() => {
        (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walkEnd' });
      });
      for (let f = 0; f < 30 && (await walkView(page)) !== null; f += 1) lumas.push(await sample());
      await page.evaluate((a) => {
        (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', ...a });
      }, HERE);
      for (let f = 0; f < 60 && (await walkView(page))?.state !== 'walking'; f += 1) lumas.push(await sample());
      for (let f = 0; f < 12; f += 1) lumas.push(await sample());
    }
    // WCAG's general flash: a pair of opposing changes of a tenth or more in relative luminance, the darker
    // below 0.8. Each change counted where the picture turns back by a tenth from its last extreme.
    const relative = lumas.map((l) => (l / 255) ** 2.2);
    const turns: number[] = [];
    let extreme = relative[0] ?? 0;
    let direction = 0;
    relative.forEach((v, i) => {
      if (direction === 0) {
        if (Math.abs(v - extreme) >= 0.1) {
          direction = Math.sign(v - extreme);
          turns.push(i);
          extreme = v;
        }
      } else if (direction * (v - extreme) > 0) extreme = v;
      else if (Math.abs(v - extreme) >= 0.1 && Math.min(v, extreme) < 0.8) {
        direction = -direction;
        turns.push(i);
        extreme = v;
      }
    });
    // A flash is two turns; in any second (30 pictures) at most three flashes, six turns.
    let worst = 0;
    for (let i = 0; i < turns.length; i += 1) worst = Math.max(worst, turns.filter((t) => t >= (turns[i] ?? 0) && t < (turns[i] ?? 0) + 30).length);
    test.info().annotations.push({ type: 'flash', description: JSON.stringify({ pictures: lumas.length, turns: turns.length, worst }) });
    expect(lumas.length).toBeGreaterThan(200);
    // The dips are seen (the picture does go dark and back: one flash each), never more than three a second.
    expect(turns.length).toBeGreaterThanOrEqual(10);
    expect(worst).toBeLessThanOrEqual(6);
    expect(pageErrors).toEqual([]);
  });
});

test('the rover, the zoom and the look’s sense: V rides at 30 m/s, the wheel narrows the view (to 20 degrees, never under Makkah’s framing), a drag can move the scene instead', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await walkAt(page, { ...HERE, headingDeg: 0, pitchDeg: 0 });
  // A second of W with V held covers 25 m or more (walking covers 1.4, running 5).
  const before = (await walkView(page))?.walkedM ?? 0;
  await page.keyboard.down('KeyV');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1000);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('KeyV');
  expect(((await walkView(page))?.walkedM ?? 0) - before).toBeGreaterThan(25);
  // The pad's Rover, pressed and let go.
  await page.getByTestId('walk-rover').click();
  await expect(page.getByTestId('walk-rover')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('walk-rover').click();
  await expect(page.getByTestId('walk-rover')).toHaveAttribute('aria-pressed', 'false');
  // The wheel: in to 20 degrees and no further, out to 90 and no further.
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  const fov = async (): Promise<number> => (await walkView(page))?.fovDeg ?? 0;
  expect(await fov()).toBeCloseTo(70, 3);
  await page.mouse.wheel(0, -400);
  await expect.poll(fov, LIVE).toBeLessThan(70);
  for (let i = 0; i < 20; i += 1) await page.mouse.wheel(0, -400);
  await expect.poll(fov, LIVE).toBeCloseTo(20, 3);
  for (let i = 0; i < 30; i += 1) await page.mouse.wheel(0, 400);
  await expect.poll(fov, LIVE).toBeCloseTo(90, 3);
  // The look's sense: a drag to the right turns right; chosen to move the scene, it turns left (and the choice is kept).
  const drag = async (): Promise<number> => {
    const h0 = (await walkView(page))?.headingDeg ?? 0;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 3, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    return ((((await walkView(page))?.headingDeg ?? 0) - h0 + 540) % 360) - 180;
  };
  expect(await drag()).toBeGreaterThan(10);
  await page.getByTestId('walk-title').click();
  await page.getByTestId('walk-drag-scene').check();
  await page.getByTestId('walk-title').click();
  expect(await drag()).toBeLessThan(-10);
  expect(await page.evaluate(() => localStorage.getItem('kf-walk-drag-scene'))).toBe('1');
  await page.getByTestId('walk-title').click();
  await page.getByTestId('walk-drag-scene').uncheck();
  await page.getByTestId('walk-title').click();
  expect(await drag()).toBeGreaterThan(10);
  // 25.05 km north of the Kaaba (a degree of latitude 111.32 km on the explorer's Earth), facing it: the rover
  // is refused at 25 km, and the view never narrows below 30 km across there.
  const KM_PER_DEG = (6378.137 * Math.PI) / 180;
  await walkAt(page, { lat: 21.4225 + 25.05 / KM_PER_DEG, lon: 39.8261, headingDeg: 180, pitchDeg: 0 });
  // Held until it is refused (the 50 m to the line take what frames a busy machine gives them, not a fixed
  // second count), then pushed on against it for two seconds more.
  await page.keyboard.down('KeyV');
  await page.keyboard.down('KeyW');
  await expect(page.getByTestId('walk-notice')).toContainText('Makkah', LIVE);
  await page.waitForTimeout(2000);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('KeyV');
  expect((await walkView(page))?.lat ?? 0).toBeGreaterThan(21.4225 + 24.99 / KM_PER_DEG);
  for (let i = 0; i < 20; i += 1) await page.mouse.wheel(0, -400);
  await page.waitForTimeout(300);
  const kaabaKm = (((await walkView(page))?.lat ?? 0) - 21.4225) * KM_PER_DEG;
  expect(await fov()).toBeGreaterThanOrEqual(((2 * Math.atan(15 / kaabaKm)) * 180) / Math.PI - 0.5);
  expect(pageErrors).toEqual([]);
});

test('on foot the time machine runs at most an hour a second (never a strobe of day and night), and says so; back in orbit it runs as chosen', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await walkAt(page);
  await page.evaluate(() => {
    const app = (window as unknown as KfHook).__kf.app;
    app.universeTime({ kind: 'rate', rate: 30 * 86_400 });
  });
  const advance = (): Promise<number> =>
    page.evaluate(() => {
      const kf = (window as unknown as KfHook).__kf;
      const t0 = kf.universe.state()?.unixMs ?? 0;
      kf.step(60, 1 / 60);
      return ((kf.universe.state()?.unixMs ?? 0) - t0) / 1000;
    });
  // A second of frames on foot: an hour of the clock at most.
  expect(await advance()).toBeLessThanOrEqual(3600 * 1.02);
  await expect(page.getByTestId('walk-notice')).toContainText('an hour a second');
  expect((await view(page))?.time.rate).toBe(30 * 86_400);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walkEnd' });
    (window as unknown as KfHook).__kf.step(120, 1 / 60);
  });
  await expect.poll(async () => walkView(page), LIVE).toBeNull();
  expect(await advance()).toBeGreaterThan(20 * 86_400);
  expect(pageErrors).toEqual([]);
});
