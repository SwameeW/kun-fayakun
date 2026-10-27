/**
 * Moving among the stars (src/explore/neighbourhood/rig.ts, docs/NEIGHBOURHOOD.md), in the browser:
 * free look on the way in (the Sun moves across the screen when the camera turns, as any star does;
 * no limit on pitch), orbit round a star once flown to (it stays where it is on the screen while the
 * camera goes round it), W A S D at a speed set by the nearest star (five times with Shift), the
 * wheel toward the star under the pointer, Back to the Sun from far out, and Esc: on the way in it
 * turns round, in a burst or held it never leaves the explorer. And the names: never overlapping,
 * the one under the pointer said.
 */
import type { Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 60_000 * SLOW };
const stars = async (page: Page) => (await view(page))?.neighbourhood ?? null;
const command = (page: Page, c: unknown): Promise<void> =>
  page.evaluate((x) => {
    (window as unknown as KfHook).__kf.app.earthCommand(x as never);
  }, c);
/** The HUD's labels on screen (client px). */
const tags = (page: Page): Promise<Array<{ id: string; x: number; y: number; text: string }>> =>
  page.evaluate(() => (window as unknown as KfHook).__kf.app.hud().labels.map((l) => ({ id: l.id, x: l.x, y: l.y, text: l.text ?? '' })));
const tag = async (page: Page, id: string): Promise<{ x: number; y: number } | null> => (await tags(page)).find((t) => t.id === id) ?? null;

async function enterStars(page: Page, kf: { open: (r: string, o?: { query?: Record<string, string> }) => Promise<void> }): Promise<void> {
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('stars-open').click();
  await expect.poll(async () => (await stars(page))?.focus.name ?? null, LIVE).toBe('Sun');
  await expect.poll(async () => (await tag(page, 'star-sun')) !== null, LIVE).toBe(true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** A drag on the canvas with the mouse (button: left turns, right pans). */
async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number, button: 'left' | 'right' = 'left'): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  for (let k = 1; k <= 10; k += 1) await page.mouse.move(from.x + (dx * k) / 10, from.y + (dy * k) / 10);
  await page.mouse.up({ button });
}

test('free look: the Sun crosses the screen as the camera turns, with no limit on pitch; a pan moves across the view', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await enterStars(page, kf);
  const n = await stars(page);
  expect(n?.camera.mode).toBe('look');
  const before = await tag(page, 'star-sun');
  if (!before) throw new Error('the Sun is not named');
  // A drag of 200 px to the right: the sky follows the hand, the Sun with it, by the same 200 px (the view's own angle a pixel).
  await drag(page, { x: 300, y: 450 }, 200, 0);
  await expect.poll(async () => ((await tag(page, 'star-sun'))?.x ?? 0) - before.x, LIVE).toBeGreaterThan(180);
  const after = await tag(page, 'star-sun');
  expect((after?.x ?? 0) - before.x).toBeLessThan(220);
  expect(Math.abs((after?.y ?? 0) - before.y)).toBeLessThan(20);
  // The camera did not move: the same distance from the Sun.
  expect((await stars(page))?.fromSunPc).toBeCloseTo(n?.fromSunPc ?? 0, 9);
  // Two thousand pixels up and down: the view turns over and over, the frame stays whole.
  for (let k = 0; k < 4; k += 1) await drag(page, { x: 300, y: 200 }, 0, 500);
  const turned = await stars(page);
  expect(turned?.camera.forward.every(Number.isFinite)).toBe(true);
  expect(Math.hypot(...(turned?.camera.forward ?? [0, 0, 0]))).toBeCloseTo(1, 6);
  // A right drag pans: the camera moves across the view (its distance from the Sun changes).
  const from = (await stars(page))?.fromSunPc ?? 0;
  await drag(page, { x: 300, y: 450 }, 300, 0, 'right');
  await expect.poll(async () => Math.abs(((await stars(page))?.fromSunPc ?? 0) - from), LIVE).toBeGreaterThan(1e-3);
  expect(pageErrors).toEqual([]);
});

test('orbit: flown to Sirius, the camera goes round it and it stays put on the screen; the arrows go round; O lets it go', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await enterStars(page, kf);
  await command(page, { kind: 'starsGoTo', hip: 32349 });
  await expect.poll(async () => (await stars(page))?.focus.name, LIVE).toBe('Sirius');
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  expect((await stars(page))?.camera.mode).toBe('orbit');
  await expect(page.getByTestId('stars-camera-orbit')).toHaveAttribute('aria-pressed', 'true');
  // Arrived at 30 of its radii (estimated from its light and colour, about 1.7 Suns'), not inside it.
  const at = await stars(page);
  expect(at?.focus.radiusEstimated ?? 0).toBeGreaterThan(1.4);
  expect(at?.focus.radiusEstimated ?? 0).toBeLessThan(2.1);
  const before = await tag(page, 'star-32349');
  if (!before) throw new Error('Sirius is not named');
  await drag(page, { x: 300, y: 450 }, 150, 60);
  await page.waitForTimeout(300);
  const after = await tag(page, 'star-32349');
  expect(Math.hypot((after?.x ?? 0) - before.x, (after?.y ?? 0) - before.y)).toBeLessThan(3);
  expect((await stars(page))?.cameraPc).toBeCloseTo(at?.cameraPc ?? 0, 9);
  expect((await stars(page))?.fromSunPc).not.toBeCloseTo(at?.fromSunPc ?? 0, 9);
  // The left arrow held goes round it too; + held comes in, never inside it.
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(500);
  await page.keyboard.up('ArrowLeft');
  const pc = (await stars(page))?.cameraPc ?? 0;
  await page.keyboard.down('Equal');
  await page.waitForTimeout(3000);
  await page.keyboard.up('Equal');
  const near = await stars(page);
  expect(near?.cameraPc ?? 0).toBeLessThan(pc);
  expect((near?.cameraKm ?? 0) / 695_700).toBeGreaterThanOrEqual(1.1 * (near?.focus.radiusEstimated ?? 0) - 1e-6);
  // O: free look again, the ring gone.
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await stars(page))?.camera.mode, LIVE).toBe('look');
  expect(pageErrors).toEqual([]);
});

test('flight: W A S D at half the nearest star’s distance a second, Shift five times faster, shown in light years a second and the speed of light', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await enterStars(page, kf);
  const hold = async (keys: string[], ms: number): Promise<number> => {
    const from = (await stars(page))?.cameraPc ?? 0;
    for (const k of keys) await page.keyboard.down(k);
    await expect(page.getByTestId('stars-speed')).toBeVisible(LIVE);
    await expect(page.getByTestId('stars-speed')).toContainText('times the speed of light');
    await page.waitForTimeout(ms);
    for (const k of [...keys].reverse()) await page.keyboard.up(k);
    return ((await stars(page))?.cameraPc ?? 0) - from;
  };
  // Backward (S), away from the Sun it looks at: the distance grows.
  const slow = await hold(['KeyS'], 400);
  expect(slow).toBeGreaterThan(0.05);
  await page.getByTestId('stars-sun').click();
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const fast = await hold(['ShiftLeft', 'KeyS'], 400);
  expect(fast).toBeGreaterThan(3 * slow);
  // Released: no speed shown, the camera still.
  await expect(page.getByTestId('stars-speed')).toBeHidden();
  // A burst of W and S, then the place is finite.
  for (let k = 0; k < 25; k += 1) {
    await page.keyboard.down('KeyW');
    await page.keyboard.up('KeyW');
    await page.keyboard.down('KeyS');
    await page.keyboard.up('KeyS');
  }
  expect(Number.isFinite((await stars(page))?.fromSunPc)).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('the wheel heads for the star under the pointer; the one under it is named; Back to the Sun from far out, pressed again and again', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await enterStars(page, kf);
  // A named star in the clear part of the view, not the Sun.
  const list = (await tags(page)).filter((t) => t.id.startsWith('star-') && t.id !== 'star-sun' && t.x > 60 && t.x < 900 && t.y > 80 && t.y < 720);
  const target = list[0];
  if (!target) throw new Error('no named star to point at');
  await page.mouse.move(target.x, target.y);
  await expect.poll(async () => (await stars(page))?.hover?.name ?? null, LIVE).toBe(target.text);
  await expect(page.getByTestId('stars-hover')).toContainText(target.text);
  const before = (await stars(page))?.hover?.distLy ?? 0;
  for (let k = 0; k < 10; k += 1) await page.mouse.wheel(0, -100);
  await page.waitForTimeout(400);
  const moved = await tag(page, target.id);
  if (moved) await page.mouse.move(moved.x, moved.y);
  await expect.poll(async () => (await stars(page))?.hover?.distLy ?? Infinity, LIVE).toBeLessThan(0.7 * before);
  // Out with the wheel past the stars, to where the galaxies are; then Back to the Sun, in a burst.
  await page.mouse.move(400, 450);
  for (let k = 0; k < 60; k += 1) await page.mouse.wheel(0, 100);
  await expect.poll(async () => (await stars(page))?.scale, LIVE).not.toBe('stars');
  for (let k = 0; k < 15; k += 1) await page.getByTestId('stars-sun').click();
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  const back = await stars(page);
  expect(back?.focus.name).toBe('Sun');
  expect(back?.cameraPc ?? 0).toBeCloseTo(3, 2);
  expect(back?.scale).toBe('stars');
  // Two hundred notches either way in a second: still a place, still among the stars' scales.
  for (let k = 0; k < 200; k += 1) await page.mouse.wheel(0, k % 2 ? 100 : -100);
  expect(Number.isFinite((await stars(page))?.fromSunPc)).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('names never overlap and keep clear of the panel; the Sun is no longer pinned to the middle', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await enterStars(page, kf);
  await expect.poll(async () => (await tags(page)).filter((t) => t.id.startsWith('star-')).length, LIVE).toBeGreaterThanOrEqual(8);
  const boxes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.kf-hud-tag')].map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
  for (let i = 0; i < boxes.length; i += 1)
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (!a || !b) continue;
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      expect(w > 1 && h > 1, `tags ${String(i)} and ${String(j)} overlap`).toBe(false);
    }
  const panel = await page.getByTestId('stars-panel').boundingBox();
  for (const t of await tags(page)) if (t.id.startsWith('star-') && panel) expect(t.x < panel.x - 4 || t.y > panel.y + panel.height, `${t.id} under the panel`).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('Esc on the way in turns round; a burst of Esc in a flight, or Esc held, never leaves the explorer', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  // Esc a moment after asking for the stars: the way in turns round, the explorer stays.
  await page.getByTestId('stars-open').click();
  await page.waitForTimeout(60);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  expect(page.url()).toContain('#/universe');
  // Then in, a flight, and eight presses in 200 ms: the flight stops, then back to the solar system, and no further.
  await page.getByTestId('stars-open').click();
  await expect.poll(async () => (await stars(page))?.focus.name ?? null, LIVE).toBe('Sun');
  await command(page, { kind: 'starsGoTo', hip: 32349 });
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let k = 0; k < 8; k += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(25);
  }
  await expect.poll(async () => await stars(page), LIVE).toBeNull();
  await page.waitForTimeout(1000);
  expect(page.url()).toContain('#/universe');
  // Esc held two seconds among the stars (its repeats): one way back, no further.
  await page.getByTestId('stars-open').click();
  await expect.poll(async () => (await stars(page))?.focus.name ?? null, LIVE).toBe('Sun');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down('Escape');
  for (let k = 0; k < 20; k += 1) {
    await page.waitForTimeout(100);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', repeat: true, bubbles: true })));
  }
  await page.keyboard.up('Escape');
  await page.waitForTimeout(800);
  expect(page.url()).toContain('#/universe');
  // Open and close twenty times quickly, pressing whichever of the two is shown at that moment (looked
  // for and pressed in one go in the page, so a fade that ends between a look and a press cannot
  // strand the press on a button just hidden): it ends in the solar system, no errors.
  const press = (ids: readonly string[]): Promise<boolean> =>
    page.evaluate((list) => {
      for (const id of list) {
        const b = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
        if (b?.checkVisibility()) {
          b.click();
          return true;
        }
      }
      return false;
    }, ids);
  let pressed = 0;
  for (let k = 0; k < 20; k += 1) {
    if (await press(['stars-open', 'stars-end'])) pressed += 1;
    await page.waitForTimeout(k % 2 ? 600 : 120);
  }
  expect(pressed).toBeGreaterThanOrEqual(10);
  // Whatever the last press began has settled; the way back, if among the stars, and it stays out.
  await page.waitForTimeout(1000);
  await expect
    .poll(async () => {
      await press(['stars-end']);
      return await stars(page);
    }, LIVE)
    .toBeNull();
  await page.waitForTimeout(1000);
  expect(await stars(page)).toBeNull();
  expect(page.url()).toContain('#/universe');
  expect(pageErrors).toEqual([]);
});
