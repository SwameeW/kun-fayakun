/**
 * The exact two-body drift (src/sim/kepler): a circular orbit a quarter turn on; an eccentric one
 * against Kepler's equation solved independently; many periods at once; hyperbolas keep their energy
 * and angular momentum; and every drift undone by the same drift backward.
 */
import { expect, test } from '@playwright/test';
import { elementsFromState, stateFromElements } from '../../src/sim/elements';
import { keplerDrift } from '../../src/sim/kepler';

const MU = 398_600.4418;
const drift = (r: number[], v: number[], dt: number): number[] => {
  const out: number[] = [];
  expect(keplerDrift(r, v, 0, MU, dt, out)).toBe(true);
  return out;
};
const energy = (s: readonly number[]): number => 0.5 * Math.hypot(s[3] ?? 0, s[4] ?? 0, s[5] ?? 0) ** 2 - MU / Math.hypot(s[0] ?? 0, s[1] ?? 0, s[2] ?? 0);
const momentum = (s: readonly number[]): number[] => {
  const [x, y, z, u, v, w] = [s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, s[3] ?? 0, s[4] ?? 0, s[5] ?? 0];
  return [y * w - z * v, z * u - x * w, x * v - y * u];
};

test('a circular orbit, a quarter turn on: a quarter of the way round, at the same speed', () => {
  const a = 7000;
  const speed = Math.sqrt(MU / a);
  const period = 2 * Math.PI * Math.sqrt(a ** 3 / MU);
  const s = drift([a, 0, 0], [0, speed, 0], period / 4);
  expect(s[0]).toBeCloseTo(0, 6);
  expect(s[1]).toBeCloseTo(a, 6);
  expect(s[3]).toBeCloseTo(-speed, 9);
  expect(s[4]).toBeCloseTo(0, 9);
});

test('an eccentric orbit (e = 0.7) agrees with Kepler’s equation solved on its own; a thousand periods on lands where a fraction does', () => {
  const el = { a: 26_600, e: 0.7, i: 1.1, node: 0.6, periapsisArg: 4.7, trueAnomaly: 0.3 };
  const { r, v } = stateFromElements(el, MU);
  const n = Math.sqrt(MU / el.a ** 3);
  const dt = 9000;
  const start = elementsFromState(r, v, MU);
  // Kepler's equation by Newton's method, independently: M = E - e sin E.
  const M = start.meanAnomaly + n * dt;
  let E = M;
  for (let k = 0; k < 50; k += 1) E -= (E - el.e * Math.sin(E) - M) / (1 - el.e * Math.cos(E));
  const nu = 2 * Math.atan2(Math.sqrt(1 + el.e) * Math.sin(E / 2), Math.sqrt(1 - el.e) * Math.cos(E / 2));
  const expected = stateFromElements({ ...el, trueAnomaly: nu }, MU);
  const s = drift([...r], [...v], dt);
  for (let k = 0; k < 3; k += 1) {
    expect(Math.abs((s[k] ?? 0) - (expected.r[k] ?? 0))).toBeLessThan(1e-5);
    expect(Math.abs((s[k + 3] ?? 0) - (expected.v[k] ?? 0))).toBeLessThan(1e-9);
  }
  const period = (2 * Math.PI) / n;
  const far = drift([...r], [...v], 1000 * period + dt);
  for (let k = 0; k < 3; k += 1) expect(Math.abs((far[k] ?? 0) - (expected.r[k] ?? 0))).toBeLessThan(1e-3);
});

test('a hyperbola keeps its energy and angular momentum, and every drift comes back the same way it went', () => {
  const r = [-50_000, 12_000, 3000];
  const v = [8, 0.5, -0.2];
  const start = [...r, ...v];
  const s = drift(r, v, 20_000);
  expect(energy(start)).toBeGreaterThan(0);
  expect(Math.abs(energy(s) - energy(start)) / energy(start)).toBeLessThan(1e-10);
  const h0 = momentum(start);
  const h1 = momentum(s);
  for (let k = 0; k < 3; k += 1) expect(Math.abs((h1[k] ?? 0) - (h0[k] ?? 0))).toBeLessThan(1e-6 * Math.hypot(...h0));
  for (const [rr, vv, dt] of [[r, v, 20_000], [[7000, 0, 0], [0, 7.546, 0.5], 3000], [[42_000, 1000, 0], [0, 3.07, 0], 86_400 * 3]] as const) {
    const go = drift([...rr], [...vv], dt);
    const back = drift(go.slice(0, 3), go.slice(3), -dt);
    for (let k = 0; k < 3; k += 1) {
      expect(Math.abs((back[k] ?? 0) - (rr[k] ?? 0))).toBeLessThan(1e-6);
      expect(Math.abs((back[k + 3] ?? 0) - (vv[k] ?? 0))).toBeLessThan(1e-10);
    }
  }
});

test('no drift without gravity or from the centre; no time, no change', () => {
  const out: number[] = [];
  expect(keplerDrift([1, 0, 0], [0, 1, 0], 0, 0, 10, out)).toBe(false);
  expect(keplerDrift([0, 0, 0], [0, 1, 0], 0, MU, 10, out)).toBe(false);
  const s = drift([7000, 0, 0], [0, 7.5, 0], 0);
  expect(s).toEqual([7000, 0, 0, 0, 7.5, 0]);
});
