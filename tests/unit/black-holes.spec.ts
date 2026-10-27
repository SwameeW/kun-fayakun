/**
 * Light bending round a black hole (src/explore/neighbourhood/lens.ts): the Schwarzschild radii of
 * the catalogue's holes, the shadow's size from afar against the Event Horizon Telescope's rings, the
 * shadow's edge (Synge) from near, the tracer against the weak field's bending 4GM/(c^2 b) and the
 * critical impact parameter sqrt(27)/2 r_s, and the shift of a disc's light; and the file's values.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { CRITICAL_B, discShift, discTemperature, impact, ISCO, schwarzschildKm, shadowAngle, shadowMicroArcsec, trace, weakBending, type V3 } from '../../src/explore/neighbourhood/lens';

const ROOT = new URL('../../', import.meta.url);
const AU = 149_597_870.7;
const angle = (a: V3, b: V3): number => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
/** A camera `d` out along +z, looking back at the hole tipped by `theta` toward +x. */
const ray = (d: number, theta: number): { camera: V3; dir: V3 } => ({ camera: [0, 0, d], dir: [Math.sin(theta), 0, -Math.cos(theta)] });
/** The angle (from the hole's direction) at which a camera `d` out sees impact parameter b. */
const thetaFor = (d: number, b: number): number => Math.asin((b / d) * Math.sqrt(1 - 1 / d));

test('Schwarzschild radii: Sagittarius A* 0.085 au, TON 618 about 1,300 au, Gaia BH1 28 km', () => {
  expect(schwarzschildKm(4.297e6) / 1e7).toBeCloseTo(1.269, 3);
  expect(schwarzschildKm(4.297e6) / AU).toBeCloseTo(0.0848, 3);
  expect(schwarzschildKm(6.6e10) / AU).toBeCloseTo(1303, -1);
  expect(schwarzschildKm(9.62)).toBeCloseTo(28.41, 1);
});

test('the shadow from the Earth: within the Event Horizon Telescope’s rings for Sagittarius A* and M87*', () => {
  // GRAVITY's mass and distance: 53.3 microarcseconds; the ring measured 51.8 +/- 2.3 (the ring lies just outside the shadow's edge).
  const sgr = shadowMicroArcsec(4.297e6, 8277);
  expect(sgr).toBeCloseTo(53.3, 0);
  expect(Math.abs(sgr - 51.8) / 51.8).toBeLessThan(0.1);
  const m87 = shadowMicroArcsec(6.5e9, 16.8e6);
  expect(m87).toBeCloseTo(39.7, 0);
  expect(Math.abs(m87 - 42) / 42).toBeLessThan(0.1);
});

test('the shadow’s edge seen from near (Synge): sin(theta) = (sqrt(27)/2)(r_s/r) sqrt(1 - r_s/r)', () => {
  expect(CRITICAL_B).toBeCloseTo(2.598076, 6);
  expect((shadowAngle(20) * 180) / Math.PI).toBeCloseTo(7.27, 2);
  expect((shadowAngle(1.5) * 180) / Math.PI).toBeCloseTo(90, 6);
  expect(shadowAngle(1.2)).toBeGreaterThan(Math.PI / 2);
  // From afar the shadow's radius is the critical impact parameter over the distance.
  expect(shadowAngle(1e6) * 1e6).toBeCloseTo(CRITICAL_B, 3);
});

test('the tracer bends a passing ray by the weak field’s 2 r_s / b (with its second order) far from the hole', () => {
  for (const b of [60, 120, 250, 1000, 5000]) {
    const { camera, dir } = ray(1e7, thetaFor(1e7, b));
    expect(impact(camera, dir)).toBeCloseTo(b, 6);
    const out = trace(camera, dir);
    expect(out.captured).toBe(false);
    const bent = angle(dir, out.direction);
    // Third order and beyond are under (128/3)/b^3: within 0.5% of the bending at these distances.
    expect(Math.abs(bent - weakBending(b)) / weakBending(b)).toBeLessThan(0.005);
  }
});

test('the tracer’s shadow: rays inside sqrt(27)/2 r_s are captured, outside escape, to a thousandth', () => {
  const far = 1e5;
  for (const b of [0.5, 2, 2.59]) expect(trace(...Object.values(ray(far, thetaFor(far, b))) as [V3, V3]).captured).toBe(true);
  for (const b of [2.61, 3, 6]) expect(trace(...Object.values(ray(far, thetaFor(far, b))) as [V3, V3]).captured).toBe(false);
  // The edge by bisection.
  let lo = 2.5;
  let hi = 2.7;
  for (let k = 0; k < 30; k += 1) {
    const mid = (lo + hi) / 2;
    if (trace(...Object.values(ray(far, thetaFor(far, mid))) as [V3, V3]).captured) lo = mid;
    else hi = mid;
  }
  expect(Math.abs((lo + hi) / 2 - CRITICAL_B)).toBeLessThan(1e-3);
});

test('seen from 20 r_s the traced shadow’s edge is where Synge puts it, and a ray near the edge circles the hole', () => {
  const d = 20;
  let lo = 0;
  let hi = 0.3;
  for (let k = 0; k < 30; k += 1) {
    const mid = (lo + hi) / 2;
    if (trace(...Object.values(ray(d, mid)) as [V3, V3]).captured) lo = mid;
    else hi = mid;
  }
  expect(Math.abs((lo + hi) / 2 - shadowAngle(d)) / shadowAngle(d)).toBeLessThan(0.002);
  // Just outside the edge: round the hole and away (a photon ring's light), more than a straight line's half turn.
  const edge = trace(...Object.values(ray(d, hi * 1.0005)) as [V3, V3]);
  expect(edge.captured).toBe(false);
  expect(edge.phi).toBeGreaterThan(2 * Math.PI);
  // Looking straight away from the hole: not bent at all; a little off it, a little.
  expect(angle([0, 0, 1], trace([0, 0, d], [0, 0, 1]).direction)).toBeLessThan(1e-9);
  const off: V3 = [Math.sin(0.3), 0, Math.cos(0.3)];
  const bent = angle(off, trace([0, 0, d], off).direction);
  expect(bent).toBeGreaterThan(0);
  expect(bent).toBeLessThan(0.01);
});

test('a disc’s light: a face-on ring at the innermost stable orbit shifted by sqrt(1 - 3M/r) = 0.707; the side coming toward the camera brighter', () => {
  // Seen along its axis from far away (the ray's angular momentum square to the axis): only the gravitational and transverse shift.
  const face = trace([0, 1e6, 0], [ISCO / 1e6, -1, 0], [0, 1, 0]);
  // (Bent on its way in, it crosses the disc's plane inside 3 r_s.)
  expect(face.crossings[0]?.r ?? 0).toBeGreaterThan(2);
  expect(discShift(ISCO, face.er, face.et, face.b, [0, 1, 0], 1e6)).toBeCloseTo(Math.SQRT1_2, 3);
  // Nearly edge on (the camera along +x, 10 degrees above the disc, which turns about +y): at +z the
  // gas moves toward +x, toward the camera, and its light is blue-shifted; at -z away, red-shifted.
  const camera: V3 = [1e4 * Math.cos(0.17), 1e4 * Math.sin(0.17), 0];
  const shift = (z: number): number => {
    const to: V3 = [-camera[0], -camera[1], z - camera[2]];
    const l = Math.hypot(...to);
    const t = trace(camera, [to[0] / l, to[1] / l, to[2] / l], [0, 1, 0]);
    const c = t.crossings[0];
    expect(c?.r ?? 0).toBeGreaterThan(4);
    expect(c?.r ?? 99).toBeLessThan(9);
    return discShift(c?.r ?? 0, t.er, t.et, t.b, [0, 1, 0], 1e4);
  };
  expect(shift(6)).toBeGreaterThan(1.1);
  expect(shift(-6)).toBeLessThan(0.75);
  // The disc's temperature: none inside its inner edge, hottest just beyond it.
  expect(discTemperature(2.9)).toBe(0);
  expect(discTemperature((ISCO * 49) / 36)).toBeCloseTo(1, 6);
  expect(discTemperature(20)).toBeLessThan(0.5);
});

test('the black holes’ file: seven, each with its cited mass and distance, TON 618’s mass a range and its distance the comoving one', () => {
  const file = JSON.parse(readFileSync(new URL('public/assets/stars/black-holes.json', ROOT), 'utf8')) as { blackHoles: Array<{ id: string; mass: { value: number; low?: number }; distance: { pc: number }; schwarzschildAu: number }> };
  const ids = file.blackHoles.map((h) => h.id);
  expect(ids).toEqual(['sgr-a', 'm87', 'ton-618', 'gaia-bh1', 'gaia-bh2', 'gaia-bh3', 'cyg-x-1']);
  const ton = file.blackHoles.find((h) => h.id === 'ton-618');
  expect(ton?.mass.low).toBeCloseTo(4.07e10, -8);
  expect(ton?.mass.value).toBeCloseTo(6.6e10, -9);
  expect((ton?.distance.pc ?? 0) / 1e6).toBeCloseTo(5621, -1);
  expect(ton?.schwarzschildAu ?? 0).toBeCloseTo(1303, -1);
  expect(file.blackHoles.find((h) => h.id === 'sgr-a')?.distance.pc).toBe(8277);
});
