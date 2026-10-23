/**
 * Travel in the explorer (src/explore/travel.ts through the running app), on the manual clock so
 * every frame is checked: Earth to the Moon, the Sun and Jupiter in turn, each trip within its
 * length (2.5 to 9 s), never inside a body on any frame, arriving where it said it would within 1%,
 * with data-travel saying so; Esc stopping a trip (and only a second Esc leaving); free flight from
 * the keyboard; and the light while approaching the Sun staying within the flash limit.
 */
import { expect, test, type KfHook } from '../support/fixtures';
import { fly, JD, place, step, view, waitForUniverse } from '../support/universe';

test('Earth to the Moon, the Sun and Jupiter: on time, never inside a body, arriving exactly where planned', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await step(page, 1);
  // The entry glide ends when the first trip starts; from here every frame is stepped.
  for (const to of ['moon', 'sun', 'jupiter'] as const) {
    const trip = await fly(page, to);
    expect(trip.focus, `trip to ${to}`).toBe(to);
    expect(trip.hookDuring, `trip to ${to}`).toBe('flying');
    expect(trip.hookAfter, `trip to ${to}`).toBe('arrived');
    expect(trip.seconds, `trip to ${to}`).toBeGreaterThanOrEqual(2.5 - 1 / 30);
    expect(trip.seconds, `trip to ${to}`).toBeLessThanOrEqual(9 + 1 / 30);
    // No frame inside a body: every surface stays at least the camera's floor away.
    expect(trip.lowestKm, `lowest point of the trip to ${to} (over ${trip.lowestBody})`).toBeGreaterThan(30);
    expect(Math.abs(trip.endKm - trip.plannedEndKm) / trip.plannedEndKm, `arrival at ${to}`).toBeLessThan(0.01);
    await expect(page.getByTestId('universe-readout')).toContainText(to === 'sun' ? /Sun/ : to === 'moon' ? /Moon/ : /Jupiter/);
  }
  await expect(page).toHaveURL(/#\/universe\/jupiter/);
  expect(pageErrors).toEqual([]);
});

test('Esc first stops a trip where it is, in free flight; only a second Esc leaves the explorer', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await step(page, 1);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.focusBody('saturn');
  });
  await step(page, 90);
  expect((await view(page))?.travelling).toBe(true);
  await expect(page.getByTestId('universe-trip')).toHaveClass(/is-active/);
  await page.keyboard.press('Escape');
  await step(page, 2);
  const stopped = await view(page);
  expect(stopped?.travelling).toBe(false);
  expect(stopped?.mode).toBe('flight');
  await expect(page.locator('html')).toHaveAttribute('data-travel', 'stopped');
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'universe');
  // It coasts to rest: a few seconds on, the camera hardly moves.
  await step(page, 240);
  const a = await view(page);
  await step(page, 1);
  const b = await view(page);
  expect(Math.hypot((b?.camera.x ?? 0) - (a?.camera.x ?? 0), (b?.camera.y ?? 0) - (a?.camera.y ?? 0), (b?.camera.z ?? 0) - (a?.camera.z ?? 0))).toBeLessThan(1e5);
  // The interface's "Orbit" hands back to orbiting the world it is nearest.
  await page.getByTestId('universe-orbit').click();
  await step(page, 30);
  expect((await view(page))?.mode).toBe('orbit');
  // Nothing left to stop: Esc goes back to the start.
  await page.keyboard.press('Escape');
  await step(page, 120);
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'film', { timeout: 30_000 });
  expect(pageErrors).toEqual([]);
});

test('with reduced motion, Esc during a cut is spent stopping it; only a second Esc leaves the explorer', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000);
  await kf.open('/universe/earth', { query: { jd: JD, reducedMotion: '1' } });
  await waitForUniverse(page);
  await step(page, 1);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.focusBody('saturn');
  });
  // Still dimming at the Earth (the cut has not happened yet).
  await step(page, 20);
  expect((await view(page))?.travelling).toBe(true);
  await page.keyboard.press('Escape');
  await step(page, 90);
  const after = await view(page);
  expect(after?.travelling).toBe(false);
  expect(after?.focus).toBe('earth');
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'universe');
  await expect(page.locator('html')).toHaveAttribute('data-travel', 'stopped');
  // Now there is nothing to stop: Esc goes back to the start.
  await page.keyboard.press('Escape');
  await step(page, 120);
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'film', { timeout: 30_000 });
  expect(pageErrors).toEqual([]);
});

test('free flight at rest says so ("holding still"), never "0 km/s"', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await step(page, 1);
  await place(page, { body: 'earth', distanceKm: 6378 + 3000, azimuthDeg: 20 });
  await step(page, 2);
  await page.keyboard.down('KeyS');
  await step(page, 40);
  await page.keyboard.up('KeyS');
  await expect(page.getByTestId('universe-readout')).toContainText(/Free flight, [\d,.]+\s(km|m)\/s/);
  await step(page, 600);
  await expect(page.getByTestId('universe-readout')).toContainText('Free flight, holding still');
  await expect(page.getByTestId('universe-readout')).not.toContainText(/\b0\s?km\/s/);
  expect(pageErrors).toEqual([]);
});

test('W A S D, R F and Q E fly freely at a pace set by the height, and O orbits again', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await step(page, 1);
  await place(page, { body: 'earth', distanceKm: 6378 + 3000, azimuthDeg: 20 });
  await step(page, 2);
  const start = await view(page);
  await page.keyboard.down('KeyW');
  await step(page, 60);
  const flying = await view(page);
  expect(flying?.mode).toBe('flight');
  expect(flying?.speedKmS ?? 0).toBeGreaterThan(100);
  // Forward is toward the Earth (the camera looked at it): lower, and slowing as it gets lower.
  expect(flying?.altitudeKm ?? Infinity).toBeLessThan(start?.altitudeKm ?? 0);
  await page.keyboard.down('ShiftLeft');
  await step(page, 30);
  const boosted = await view(page);
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  // Never through the surface, however hard it is driven.
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  await step(page, 300);
  const floor = await view(page);
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  expect(floor?.altitudeKm ?? 0).toBeGreaterThan(140);
  expect(boosted?.mode).toBe('flight');
  await page.keyboard.press('KeyQ');
  await page.keyboard.press('KeyO');
  await step(page, 60);
  expect((await view(page))?.mode).toBe('orbit');
  await expect(page.getByTestId('universe-readout')).toContainText(/Orbiting/);
  expect(pageErrors).toEqual([]);
});

test('approaching the Sun the light changes smoothly: no more than three flashes a second on any part of the screen', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await step(page, 1);
  // Every frame of the trip is read back as it is drawn (relative luminance per tile of a 4 x 4 grid):
  // stepped, then read inside the next animation frame, just after the app's own loop has drawn it.
  const frames = await page.evaluate(async () => {
    const kf = (window as unknown as KfHook).__kf;
    const scene = document.getElementById('scene') as HTMLCanvasElement;
    const W = 32;
    const H = 20;
    const T = 4;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) throw new Error('no 2D context');
    const lin = (v: number): number => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    const out: Array<{ t: number; tiles: number[] }> = [];
    const drawn = (): Promise<void> =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    kf.app.focusBody('sun');
    for (let i = 0; i < 60 * 8; i++) {
      kf.step(1, 1 / 60);
      await drawn();
      g.drawImage(scene, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      const tiles = new Array<number>(T * T).fill(0);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const k = (y * W + x) * 4;
          const L = 0.2126 * lin(d[k] ?? 0) + 0.7152 * lin(d[k + 1] ?? 0) + 0.0722 * lin(d[k + 2] ?? 0);
          const tile = Math.min(T - 1, Math.floor((y * T) / H)) * T + Math.min(T - 1, Math.floor((x * T) / W));
          tiles[tile] = (tiles[tile] ?? 0) + L / ((W / T) * (H / T));
        }
      }
      out.push({ t: i / 60, tiles });
      if (!kf.universe.state()?.travelling && i > 30) break;
    }
    return out;
  });
  expect(frames.length).toBeGreaterThan(120);
  // The frames were really read (the Sun and its glare are bright by the end), not blank.
  expect(Math.max(...frames.flatMap((f) => f.tiles))).toBeGreaterThan(0.05);
  // WCAG 2.3.1 general flash: a pair of opposing changes of at least 0.1 in relative luminance where
  // the darker state is under 0.8, counted per tile in any one second.
  let worst = 0;
  const tileCount = frames[0]?.tiles.length ?? 0;
  for (let k = 0; k < tileCount; k++) {
    const series = frames.map((f) => ({ t: f.t, L: f.tiles[k] ?? 0 }));
    const turns: number[] = [];
    let ref = series[0] ?? { t: 0, L: 0 };
    let dir = 0;
    for (const p of series) {
      if (dir >= 0 && p.L > ref.L) ref = p;
      if (dir <= 0 && p.L < ref.L) ref = p;
      if (dir >= 0 && ref.L - p.L >= 0.1 && Math.min(ref.L, p.L) < 0.8) {
        turns.push(ref.t);
        dir = -1;
        ref = p;
      } else if (dir <= 0 && p.L - ref.L >= 0.1 && Math.min(ref.L, p.L) < 0.8) {
        turns.push(ref.t);
        dir = 1;
        ref = p;
      }
    }
    for (const t0 of turns) worst = Math.max(worst, Math.floor(turns.filter((t) => t >= t0 && t < t0 + 1).length / 2));
  }
  test.info().annotations.push({ type: 'flashes', description: `worst tile: ${worst} flash(es) in any second over ${frames.length} frames` });
  expect(worst).toBeLessThanOrEqual(3);
  expect(pageErrors).toEqual([]);
});
