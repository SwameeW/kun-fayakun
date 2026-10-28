/**
 * The laboratory's light, frame by frame, with motion as a visitor has it (not reduced): CONTRACTS rule 6
 * and WCAG 2.2 SC 2.3.1, read back every requestAnimationFrame (docs/SANDBOX-ROADMAP.md W1.11, W1.13,
 * W1.14, W1.7):
 * - every fireball's light (src/explore/lab-fx: after the flash guard) changes by at most a thirtieth of
 *   its peak a frame at 60 frames a second (by its frame's time), coming and going; its peak over its
 *   whole life (one begun as the watch would end is watched on until it has gone);
 * - the canvas itself, read back each frame (downsampled), flashes no more than three times a second in
 *   any tile of 10 degrees of the field (341 x 256 CSS px at 1024 wide, scaled); fireballs rise at most
 *   three a second;
 * - through a thrown Mars striking the Earth, two Ceres-sized bodies striking one face of the Moon a
 *   fraction of a second apart (one tile), and ten stones striking the Moon at once;
 * - the Mars is flagged three seconds and more ahead; within a second either side of the contact the run
 *   goes no faster than 40 s a second; the Earth is then drawn at the experiment's radius; the time
 *   machine's row and the rates line say the slowed rate, and the event card's numbers agree;
 * - with reduced motion, through a torn Moon, the camera never turns more than half a degree a frame.
 */
import type { Page } from '@playwright/test';
import type { LabCommand, LabEditResult, UniverseLab } from '../../src/core/types';
import { expect, test, type KfHook } from '../support/fixtures';
import { NEEDS_REAL_FRAMES, NO_GPU, SLOW } from '../support/env';
import { fireballSteps } from '../support/fireball-light';
import { JD, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 90_000 * SLOW };
test.use({ viewport: { width: 1440, height: 900 } });
// Frame-by-frame timing and read-back: on machines with a GPU (CI renders in software, a few frames a second).
test.skip(NO_GPU, NEEDS_REAL_FRAMES);

/** A Mars thrown at the Earth (as tests/explore/lab-effects.spec.ts throws it). */
const AIM: LabCommand = { kind: 'aim', target: 'earth', impactor: 'mars', vInfKmS: 20, angleDeg: 80, leadS: 10 * 86_400, site: [0.6, -0.5, 0.62], heading: [0, 0, 1] };

interface Frame {
  t: number;
  /** The effects' own clock (s): how far they were advanced, frame by frame. */
  fx: number;
  /** Each fireball drawn: its key, its own light (after the guard, before its body's limb hides any) and how much of it shows past the limb. */
  fire: Array<[string, number, number]>;
  /** The canvas's tiles' mean relative luminance. */
  tiles: number[];
  events: number;
  /** The drawn clock (s since the fork). */
  shown: number;
  slow: number | null;
  inS: number | null;
  cam: [number, number, number] | null;
  trip: boolean;
  /** Past the window asked for: watched on only to see every fireball begun in it through to its end. */
  extra: boolean;
}

const lab = async (page: Page): Promise<UniverseLab | null> => (await view(page))?.lab ?? null;
const command = (page: Page, c: LabCommand): Promise<LabEditResult> =>
  page.evaluate(async (x) => {
    const answer = await (window as unknown as KfHook).__kf.universe.lab?.(x);
    if (!answer) throw new Error('the laboratory is not loaded');
    return answer;
  }, c);
const run = (page: Page, rate: number): Promise<void> =>
  page.evaluate((r) => {
    (window as unknown as KfHook).__kf.app.universeTime({ kind: 'rate', rate: r });
  }, rate);

async function openLab(page: Page): Promise<void> {
  await page.getByTestId('lab-open').click();
  await expect(page.getByTestId('lab-panel')).toBeVisible(LIVE);
  await expect.poll(async () => (await lab(page))?.bodies.length ?? 0, LIVE).toBe(10);
  await expect.poll(async () => page.evaluate(() => ((window as unknown as KfHook).__kf.universe.labDraw?.() as { tier?: string } | null)?.tier ?? null), LIVE).not.toBeNull();
}

async function fork(page: Page): Promise<void> {
  await command(page, { kind: 'reset' });
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  await expect.poll(async () => (await lab(page))?.elapsedS, LIVE).toBe(0);
}

/**
 * Every frame for up to `seconds` (or `after` seconds past the first impact): the fireballs' light, the
 * canvas's tiles (read back downsampled), the laboratory's rate and slowing, the camera's direction. Then on
 * (at most `seconds` in all), the frames `extra`, until every fireball drawn by the end of that window has
 * gone: its whole light seen, its peak known (one begun in the window's last frames is still rising then).
 */
const watch = (page: Page, seconds: number, after: number): Promise<Frame[]> =>
  page.evaluate(
    ({ seconds, after }) =>
      new Promise<Frame[]>((resolve) => {
        const kf = (window as unknown as KfHook).__kf;
        const el = document.querySelector('#scene');
        const canvas = el instanceof HTMLCanvasElement ? el : (el?.querySelector('canvas') ?? null);
        const W = 240;
        const H = Math.max(1, Math.round((W * window.innerHeight) / window.innerWidth));
        const off = new OffscreenCanvas(W, H);
        const g = off.getContext('2d', { willReadFrequently: true });
        // A tile: 341 x 256 CSS px at 1024 wide, scaled with the viewport, in the downsampled picture's pixels.
        const tw = ((341 * window.innerWidth) / 1024) * (W / window.innerWidth);
        const th = ((256 * window.innerWidth) / 1024) * (H / window.innerHeight);
        const cols = Math.ceil(W / tw);
        const rows = Math.ceil(H / th);
        const lin = new Float32Array(256);
        for (let c = 0; c < 256; c += 1) {
          const v = c / 255;
          lin[c] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        }
        const frames: Frame[] = [];
        let start = -1;
        let hit = -1;
        /** The fireballs drawn by the end of the window asked for (null until it ends). */
        let pending: Set<string> | null = null;
        const tick = (now: number): void => {
          if (start < 0) start = now;
          const t = (now - start) / 1000;
          const r = kf.universe.labDraw?.() as { fireballs: Array<{ key: string; emitted: number; seen: number }>; camera: { x: number; y: number; z: number } | null; clock: { shownS: number; fxS: number } } | null;
          const v = kf.universe.state();
          const l = v?.lab;
          const tiles = new Array<number>(cols * rows).fill(0);
          if (g && canvas) {
            g.drawImage(canvas, 0, 0, W, H);
            const { data } = g.getImageData(0, 0, W, H);
            const counts = new Array<number>(cols * rows).fill(0);
            for (let y = 0; y < H; y += 1)
              for (let x = 0; x < W; x += 1) {
                const i = (y * W + x) * 4;
                const k = Math.floor(y / th) * cols + Math.floor(x / tw);
                tiles[k] = (tiles[k] ?? 0) + 0.2126 * (lin[data[i] ?? 0] ?? 0) + 0.7152 * (lin[data[i + 1] ?? 0] ?? 0) + 0.0722 * (lin[data[i + 2] ?? 0] ?? 0);
                counts[k] = (counts[k] ?? 0) + 1;
              }
            for (let k = 0; k < tiles.length; k += 1) tiles[k] = (tiles[k] ?? 0) / Math.max(1, counts[k] ?? 1);
          }
          const events = l?.events.filter((e) => e.kind === 'fragment' || e.kind === 'merge').length ?? 0;
          if (events > 0 && hit < 0) hit = t;
          const fire = (r?.fireballs ?? []).map((f): [string, number, number] => [f.key, f.emitted, f.seen]);
          frames.push({ t, fx: r?.clock.fxS ?? 0, fire, tiles, events, shown: r?.clock.shownS ?? 0, slow: l?.slow.active?.rate ?? null, inS: l?.slow.active?.inS ?? null, cam: r?.camera ? [r.camera.x, r.camera.y, r.camera.z] : null, trip: v?.trip !== null && v?.trip !== undefined, extra: pending !== null });
          if (pending === null && hit >= 0 && t - hit > after) pending = new Set(frames.flatMap((f) => f.fire.map((x) => x[0])));
          const waiting = pending !== null && fire.some(([key]) => pending?.has(key) === true);
          if ((pending !== null && !waiting) || t > seconds) resolve(frames);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { seconds, after },
  );

/**
 * Every fireball's light by frame: never more than a thirtieth of its peak a 60th of a second (coming, going,
 * held back or let go by the guard), by the time the effects were advanced between two samples (their own
 * clock: a sample a frame late or early is not a frame of change). Each fireball begun in the window is
 * watched whole (watch goes on for it), so its peak is its own, not the part of its rise the window saw; and
 * how much of it shows past its body's limb, apart, never changing faster than all of it over half a second
 * (tests/support/fireball-light).
 */
function expectSmooth(frames: readonly Frame[]): number {
  let worst = 0;
  for (const s of fireballSteps(frames)) {
    if (!s.extra) expect(s.whole, `${s.key}: watched from before it was drawn until it had gone`).toBe(true);
    if (!s.whole) continue;
    worst = Math.max(worst, s.worst);
    expect(s.worst, `${s.key} at ${s.t.toFixed(3)} s: ${s.before} to ${s.now} (peak ${s.peak})`).toBeLessThanOrEqual(1 + 1e-6);
    expect(s.seenWorst, `${s.key} at ${s.seenT.toFixed(3)} s: how much shows past the limb`).toBeLessThanOrEqual(1 + 1e-6);
  }
  return worst;
}

/** The canvas's flashes: per tile, opposing changes of a tenth or more from the last turn, the darker below 0.8; the most in any second. */
function worstFlashTurns(frames: readonly Frame[]): number {
  const n = Math.max(0, ...frames.map((f) => f.tiles.length));
  let worst = 0;
  for (let k = 0; k < n; k += 1) {
    const turns: number[] = [];
    let extreme = frames[0]?.tiles[k] ?? 0;
    let direction = 0;
    for (const f of frames) {
      const v = f.tiles[k] ?? 0;
      if (direction === 0) {
        if (Math.abs(v - extreme) >= 0.1 && Math.min(v, extreme) < 0.8) {
          direction = Math.sign(v - extreme);
          turns.push(f.t);
          extreme = v;
        }
      } else if (direction * (v - extreme) > 0) extreme = v;
      else if (Math.abs(v - extreme) >= 0.1 && Math.min(v, extreme) < 0.8) {
        direction = -direction;
        turns.push(f.t);
        extreme = v;
      }
    }
    for (const t of turns) worst = Math.max(worst, turns.filter((x) => x >= t && x < t + 1).length);
  }
  return worst;
}

/** Fireballs coming in: new keys, the most in any second. */
function worstRises(frames: readonly Frame[]): number {
  const seen = new Set<string>();
  const rises: number[] = [];
  for (const f of frames)
    for (const [key] of f.fire)
      if (!seen.has(key)) {
        seen.add(key);
        rises.push(f.t);
      }
  return Math.max(0, ...rises.map((t) => rises.filter((x) => x >= t && x < t + 1).length));
}

test.describe('impacts as a visitor sees them (motion on, slowing on)', () => {
  test.use({ labSlow: true });

  test('a thrown Mars striking the Earth: flagged seconds ahead, no faster than 40 s a second about the contact, the fireball smooth frame by frame, the canvas never flashing, the Earth at the experiment’s radius, the slowed rate said', async ({ page, kf, pageErrors }) => {
    test.setTimeout(360_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    await openLab(page);
    await fork(page);
    await command(page, AIM);
    await expect.poll(async () => (await lab(page))?.aim?.status, LIVE).toBe('ready');
    expect((await command(page, { kind: 'throw' })).ok).toBe(true);
    await run(page, 86_400);
    // The time machine's row and the rates line say the slowed rate (the one set beside it), once slowing.
    await expect(page.getByTestId('lab-slowed')).toBeVisible(LIVE);
    await expect(page.getByTestId('lab-slowed-text')).toContainText('Slowed:');
    await expect(page.getByTestId('lab-slowed-text')).toContainText('(set: 1 day)');
    await expect(page.getByTestId('universe-time-rate')).toBeHidden();
    await expect(page.getByTestId('lab-rates')).toContainText('Slowed for the impact: running at');
    const frames = await watch(page, 90, 6);
    const hitAt = frames.findIndex((f) => f.events > 0);
    expect(hitAt).toBeGreaterThan(0);
    const at = frames[hitAt]?.t ?? 0;
    // Flagged (the slowing under way, the contact still ahead) three seconds and more before it.
    const flagged = frames.find((f) => f.inS !== null && f.inS > 0);
    expect(at - (flagged?.t ?? at)).toBeGreaterThanOrEqual(3);
    // Within a second either side of it, the experiment's clock went no faster than 40 s a second (as drawn: the run is ahead of it by a frame or two).
    const near = frames.filter((f) => Math.abs(f.t - at) <= 1);
    expect(near.length).toBeGreaterThan(30);
    const first = near[0];
    const last = near.at(-1);
    expect(((last?.shown ?? 0) - (first?.shown ?? 0)) / ((last?.t ?? 1) - (first?.t ?? 0))).toBeLessThanOrEqual(40);
    // The fireball, frame by frame; the canvas's tiles; fireballs rising.
    expectSmooth(frames);
    // Drawn: its own light where it shows past the limb.
    expect(Math.max(0, ...frames.flatMap((f) => f.fire.map((x) => x[1] * x[2])))).toBeGreaterThan(0.05);
    expect(worstFlashTurns(frames)).toBeLessThanOrEqual(6);
    expect(worstRises(frames)).toBeLessThanOrEqual(3);
    // The Earth drawn at the experiment's radius (within half a per cent, its ease done).
    const l = await lab(page);
    const earth = l?.bodies.find((b) => b.id === 'earth');
    const drawn = await page.evaluate(() => ((window as unknown as KfHook).__kf.universe.labDraw?.() as { scale: Record<string, number> } | null)?.scale.earth ?? 0);
    expect(Math.abs((drawn * (earth?.baseline?.radiusKm ?? 6371)) / (earth?.radiusKm ?? 1) - 1)).toBeLessThan(0.005);
    // The event card: its own radius after, and what its pieces falling back made of it said apart.
    await expect(page.getByTestId('lab-event-card')).toBeVisible();
    const card = await page.getByTestId('lab-event-facts').innerText();
    const own = /radius went from ([\d,]+)\skm to ([\d,]+)\skm/u.exec(card);
    expect(own).not.toBeNull();
    const num = (x: string | undefined): number => Number((x ?? '').replace(/,/gu, ''));
    // Erosion: the target lost mass (the card says by how much); a remnant larger for it is said to be at the two bodies' mixed density.
    const latest = (await lab(page))?.latest;
    if (latest?.regime === 'erosion') {
      expect(latest.massAfterKg ?? 0).toBeLessThan(latest.massBeforeKg ?? 0);
      expect(card).toContain('mass went from');
      if (num(own?.[2]) > num(own?.[1])) expect(card).toContain('mixed density');
    }
    const later = /radius is now ([\d,]+)\skm/u.exec(card);
    if (later) expect(card).toMatch(/fallen back/u);
    // A screen reader hears a piece falling back as that alone, not the card again.
    if ((latest?.later ?? 0) > 0) await expect(page.getByTestId('lab-announce')).toHaveText(/^Since then/u);
    // The impact's heat on the Earth and its bodies, gone with it on undo (it glows again only if it comes again).
    const heatOf = (): Promise<{ marks: number; bodies: number }> => page.evaluate(() => ((window as unknown as KfHook).__kf.universe.labDraw?.() as { heat: { marks: number; bodies: number } } | null)?.heat ?? { marks: -1, bodies: -1 });
    await command(page, { kind: 'undo' });
    await expect.poll(async () => (await lab(page))?.events.some((e) => e.kind === 'fragment') ?? true, LIVE).toBe(false);
    await expect.poll(async () => (await heatOf()).marks, LIVE).toBe(0);
    expect((await heatOf()).bodies).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test('two Ceres-sized bodies striking one face of the Moon a fraction of a second apart (one tile): each fireball smooth frame by frame, held back or let go by the guard', async ({ page, kf, pageErrors }) => {
    test.setTimeout(300_000 * SLOW);
    await kf.open('/universe/moon', { query: { jd: JD } });
    await waitForUniverse(page);
    await openLab(page);
    // At the rate set throughout (the slowing off), as the review's reproduction ran.
    await page.getByTestId('lab-slow-toggle').uncheck();
    await fork(page);
    // From the camera's side of the Moon (render frame to the scenario's: x, -z, y), falling straight in.
    const toCamera = await page.evaluate(() => {
      const c = ((window as unknown as KfHook).__kf.universe.labDraw?.() as { camera: { x: number; y: number; z: number } | null } | null)?.camera;
      return c ? [-c.x, c.z, -c.y] : [1, 0, 0];
    });
    const tilt = (d: readonly number[], a: number): [number, number, number] => {
      const u = [d[1] ?? 0, -(d[0] ?? 0), 0];
      const n = Math.hypot(...u) || 1;
      const x = [(d[0] ?? 0) + (u[0] ?? 0) * (a / n), (d[1] ?? 0) + (u[1] ?? 0) * (a / n), (d[2] ?? 0) + (u[2] ?? 0) * (a / n)];
      const m = Math.hypot(...x);
      return [(x[0] ?? 0) / m, (x[1] ?? 0) / m, (x[2] ?? 0) / m];
    };
    // Apart (never touching each other), striking half a second apart: two fireballs, not one joined.
    for (const [k, distance, angle] of [[0, 3200, 0.2], [1, 4100, -0.2]] as const) {
      const d = tilt(toCamera, angle);
      const out = await command(page, { kind: 'addState', relativeTo: 'moon', posKm: [d[0] * distance, d[1] * distance, d[2] * distance], velKmS: [-d[0] * 3, -d[1] * 3, -d[2] * 3], massKg: 9.4e20, radiusKm: 470, name: `ceres ${k}` });
      expect(out.ok).toBe(true);
    }
    await run(page, 600);
    const frames = await watch(page, 60, 5);
    expect(frames.some((f) => f.events >= 2)).toBe(true);
    // Both on the Moon (neither struck the other: their pieces may fall back after), two fireballs at least.
    const struck = (await lab(page))?.events.filter((e) => e.survivor === 'moon').map((e) => e.absorbed) ?? [];
    expect(new Set(struck.filter((id) => /^body-\d+$/u.test(id))).size).toBe(2);
    expect(new Set(frames.flatMap((f) => f.fire.map((x) => x[0]))).size).toBeGreaterThanOrEqual(2);
    expectSmooth(frames);
    expect(worstFlashTurns(frames)).toBeLessThanOrEqual(6);
    expect(pageErrors).toEqual([]);
  });

  test('ten stones striking the Moon at once: fireballs rise at most three a second, each smooth frame by frame, and no tile of the canvas flashes more than three times a second', async ({ page, kf, pageErrors }) => {
    test.setTimeout(300_000 * SLOW);
    await kf.open('/universe/moon', { query: { jd: JD } });
    await waitForUniverse(page);
    await openLab(page);
    await fork(page);
    for (let k = 0; k < 10; k += 1) {
      const d = 2000 + 100 * k;
      const a = (k / 10) * 2 * Math.PI;
      const out = await command(page, { kind: 'addState', relativeTo: 'moon', posKm: [d * Math.cos(a), d * Math.sin(a), 300], velKmS: [-3 * Math.cos(a), -3 * Math.sin(a), -0.4], massKg: 1.5e12, radiusKm: 0.5, name: `stone ${k}` });
      expect(out.ok).toBe(true);
    }
    await run(page, 60);
    const frames = await watch(page, 40, 8);
    await expect.poll(async () => (await lab(page))?.bodies.filter((b) => b.id.startsWith('body-')).length, LIVE).toBe(0);
    expect(worstRises(frames)).toBeLessThanOrEqual(3);
    expectSmooth(frames);
    const worst = worstFlashTurns(frames);
    test.info().annotations.push({ type: 'flash', description: JSON.stringify({ frames: frames.length, worst }) });
    expect(worst).toBeLessThanOrEqual(6);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a torn Moon with reduced motion: the camera never turns more than half a degree a frame (a cut aside)', async ({ page, kf, pageErrors }) => {
    test.setTimeout(240_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    await openLab(page);
    await fork(page);
    expect((await command(page, { kind: 'elements', id: 'moon', aKm: 15_000, e: 0, iDeg: 5, nodeDeg: 0, periapsisArgDeg: 0, trueAnomalyDeg: 0 })).ok).toBe(true);
    await command(page, { kind: 'select', id: 'moon' });
    await run(page, 3600);
    const frames = await watch(page, 12, 6);
    // Torn apart meanwhile.
    expect((await lab(page))?.bodies.filter((b) => b.id.startsWith('moon-piece-')).length).toBe(8);
    let worst = 0;
    for (let k = 1; k < frames.length; k += 1) {
      const a = frames[k - 1];
      const b = frames[k];
      if (!a?.cam || !b?.cam || a.trip || b.trip) continue;
      const cos = a.cam[0] * b.cam[0] + a.cam[1] * b.cam[1] + a.cam[2] * b.cam[2];
      worst = Math.max(worst, (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI);
    }
    expect(worst).toBeLessThanOrEqual(0.5);
    expect(pageErrors).toEqual([]);
  });
});
