/**
 * The camera among the stars (src/explore/neighbourhood/rig.ts): free look turns in place with the
 * sky following the hand and no limit on pitch; orbit goes round the star chosen at its distance and
 * never inside it; flight's speed is a share of the distance to the nearest star (five times with
 * Shift); the wheel moves toward what is under the pointer; a flight arrives in orbit looking at its
 * target, kilometres from a black hole 500 parsecs out with no loss of precision.
 */
import { expect, test } from '@playwright/test';
import { cameraOf, createRig, drag, flyTo, forwardOf, length, pan, RIG, rotate, step, sub, toggleMode, upOf, zoom, type Quat, type V3 } from '../../src/explore/neighbourhood/rig';

/** Where a point is seen from the camera: its angle right of and above the gaze (rad). */
function seen(q: Quat, camera: V3, p: V3): { x: number; y: number } {
  const inverse: Quat = [-q[0], -q[1], -q[2], q[3]];
  const local = rotate(inverse, sub(p, camera));
  return { x: Math.atan2(local[0], -local[2]), y: Math.atan2(local[1], -local[2]) };
}

test('free look: a drag turns the camera where it stands, the sky following the hand by the view’s own angle per pixel', () => {
  const rig = createRig([0, 0, 0], [0, 0, 3], 1e-8, 1e10);
  const sun: V3 = [0, 0, 0];
  expect(seen(rig.q, cameraOf(rig), sun).x).toBeCloseTo(0, 9);
  const before = cameraOf(rig);
  drag(rig, 300, 0, 0.001);
  // The camera has not moved; the Sun has moved 0.3 rad to the right, with the drag.
  expect(length(sub(cameraOf(rig), before))).toBe(0);
  expect(seen(rig.q, cameraOf(rig), sun).x).toBeCloseTo(0.3, 6);
  drag(rig, 0, 200, 0.001);
  expect(seen(rig.q, cameraOf(rig), sun).y).toBeLessThan(-0.15);
  // No limit on pitch: two thousand pixels down and the frame is still whole.
  drag(rig, 0, 2000, 0.005);
  expect(rig.q.every(Number.isFinite)).toBe(true);
  expect(length(forwardOf(rig.q))).toBeCloseTo(1, 9);
});

test('orbit: a drag goes round the star at its distance, still looking at it; the wheel never goes inside it', () => {
  const rig = createRig([1, 2, 3], [0, 0, 0.01], 1e-6, 1e4);
  toggleMode(rig);
  step(rig, 1, 1, true);
  expect(rig.mode).toBe('orbit');
  for (const [dx, dy] of [
    [120, 0],
    [0, 500],
    [-40, 2000],
  ] as const) {
    drag(rig, dx, dy, 0);
    expect(length(rig.rel)).toBeCloseTo(0.01, 12);
    const v = seen(rig.q, cameraOf(rig), rig.anchor);
    expect(Math.hypot(v.x, v.y)).toBeLessThan(1e-9);
  }
  for (let k = 0; k < 400; k += 1) zoom(rig, -0.3, null, 0);
  expect(length(rig.rel)).toBeCloseTo(1e-6, 15);
  for (let k = 0; k < 400; k += 1) zoom(rig, 0.3, null, 0);
  expect(length(rig.rel)).toBeCloseTo(1e4, 6);
});

test('flight: half the nearest star’s distance a second, five times with Shift, along the gaze, letting go of an orbit', () => {
  const rig = createRig([0, 0, 0], [0, 0, 3], 1e-8, 1e10);
  rig.mode = 'orbit';
  rig.keys.move = [0, 0, 1];
  const f = forwardOf(rig.q);
  const before = cameraOf(rig);
  for (let k = 0; k < 60; k += 1) step(rig, 1 / 60, 2, false);
  const moved = sub(cameraOf(rig), before);
  expect(length(moved)).toBeCloseTo(RIG.speedShare * 2, 6);
  expect((moved[0] * f[0] + moved[1] * f[1] + moved[2] * f[2]) / length(moved)).toBeCloseTo(1, 9);
  expect(rig.mode).toBe('look');
  rig.keys.boost = true;
  const from = cameraOf(rig);
  for (let k = 0; k < 60; k += 1) step(rig, 1 / 60, 2, false);
  expect(length(sub(cameraOf(rig), from))).toBeCloseTo(RIG.speedShare * 2 * RIG.boost, 6);
  // Near a star the speed falls with the distance: a thousandth of a parsec away, a two-thousandth a second.
  rig.keys.boost = false;
  step(rig, 0.1, 1e-3, false);
  expect(rig.speed).toBeCloseTo(5e-4, 12);
});

test('the wheel in free look moves toward the point under the pointer; a pan moves across the view', () => {
  const rig = createRig([0, 0, 0], [0, 0, 3], 1e-8, 1e10);
  const ray: V3 = [0.6, 0, -0.8];
  const before = cameraOf(rig);
  for (let k = 0; k < 10; k += 1) zoom(rig, -0.15, ray, 5);
  const moved = sub(cameraOf(rig), before);
  expect((moved[0] * ray[0] + moved[2] * ray[2]) / length(moved)).toBeCloseTo(1, 9);
  expect(length(moved)).toBeGreaterThan(5);
  const up = upOf(rig.q);
  const at = cameraOf(rig);
  pan(rig, 0, -100, 0.01);
  const shift = sub(cameraOf(rig), at);
  expect((shift[0] * up[0] + shift[1] * up[1] + shift[2] * up[2]) / length(shift)).toBeCloseTo(-1, 9);
});

test('a flight arrives in orbit at its distance looking at its target: kilometres from a black hole 590 parsecs away, held exactly', () => {
  const rig = createRig([0, 0, 0], [0, 0, 3], 1e-8, 1e10);
  const hole: V3 = [300.123456789, -400.987654321, 250.5];
  const rs = 96.57 / 3.0857e13;
  flyTo(rig, hole, 20 * rs, null);
  let frames = 0;
  let worst = 0;
  while (rig.trip && frames < 1000) {
    step(rig, 1 / 60, 1, false);
    frames += 1;
    worst = Math.max(worst, rig.q.some((x) => !Number.isFinite(x)) ? Infinity : 0);
  }
  expect(worst).toBe(0);
  expect(rig.trip).toBeNull();
  expect(rig.mode).toBe('orbit');
  expect(rig.anchor).toEqual(hole);
  expect(length(rig.rel) / rs).toBeCloseTo(20, 9);
  const v = seen(rig.q, rig.rel, [0, 0, 0]);
  expect(Math.hypot(v.x, v.y)).toBeLessThan(1e-9);
  // Orbiting there: still 20 r_s (to a millionth), the hole still in the middle.
  rig.minPc = 2 * rs;
  for (let k = 0; k < 50; k += 1) drag(rig, 37, -11, 0);
  expect(length(rig.rel) / rs).toBeCloseTo(20, 6);
  for (let k = 0; k < 100; k += 1) zoom(rig, -0.2, null, 0);
  expect(length(rig.rel) / rs).toBeCloseTo(2, 9);
});

test('under reduced motion a flight is a cut: the view holds, then is at its arrival, in orbit, never between', () => {
  const rig = createRig([0, 0, 0], [0, 0, 3], 1e-8, 1e10);
  const start = cameraOf(rig);
  const to: V3 = [2.1, -1.4, 0.7];
  flyTo(rig, to, 0.01, null);
  const end: V3 = (() => {
    const t = rig.trip;
    if (!t) throw new Error('no flight');
    return [to[0] + t.toDir[0] * 0.01, to[1] + t.toDir[1] * 0.01, to[2] + t.toDir[2] * 0.01];
  })();
  let frames = 0;
  let travelling = 0;
  // (A function, so the flight is asked after each step, not taken as known from the loop's test.)
  const flying = (): boolean => rig.trip !== null;
  while (flying() && frames < 600) {
    step(rig, 1 / 60, 1, true);
    frames += 1;
    if (flying()) travelling += 1;
    const at = cameraOf(rig);
    // Only ever where it started or where it lands.
    expect(Math.min(length(sub(at, start)), length(sub(at, end)))).toBeLessThan(1e-9);
  }
  expect(rig.trip).toBeNull();
  expect(rig.mode).toBe('orbit');
  // Still a flight for a moment (Esc can stop it, the panel says so), and short.
  expect(travelling / 60).toBeGreaterThan(RIG.cutSeconds * 0.8);
  expect(frames / 60).toBeLessThan(RIG.cutSeconds + 0.1);
  const v = seen(rig.q, cameraOf(rig), to);
  expect(Math.hypot(v.x, v.y)).toBeLessThan(1e-9);
});
