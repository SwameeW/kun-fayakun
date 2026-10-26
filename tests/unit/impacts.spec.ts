/**
 * Impact outcomes (src/sim/impacts.ts) against Leinhardt and Stewart (2012), ApJ 745, 79: the
 * definition of Q*_RD (half the mass in the largest remnant), the paper's own closed form for the
 * equal-mass critical speed (eq. 30, from eqs. 2 and 28), the regimes in the order the paper's
 * procedure gives them, continuity where they meet (eq. 44's coefficient is chosen for it), and mass
 * accounted to the last digit. GM values from public/assets/jpl/physical.json (DE440).
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { PhysicalFile } from '../../src/astro/physical';
import { impactOutcome, impactParameter, LS2012, type ImpactBody } from '../../src/sim/impacts';

const physical = JSON.parse(readFileSync(new URL('../../public/assets/jpl/physical.json', import.meta.url), 'utf8')) as PhysicalFile;
const mean = (r: readonly number[]): number => r.reduce((a, b) => a + b, 0) / r.length;
const EARTH: ImpactBody = { gm: physical.gmKm3S2.Earth, radiusKm: mean(physical.bodies.Earth.radiiKm) };
const MARS: ImpactBody = { gm: physical.gmKm3S2.Mars, radiusKm: mean(physical.bodies.Mars.radiiKm) };
const SUN: ImpactBody = { gm: physical.gmKm3S2.Sun, radiusKm: mean(physical.bodies.Sun.radiiKm) };
const G_RHO1 = 6.6743e-11 * 1000;

const sum = (o: ReturnType<typeof impactOutcome>): number => o.largest + o.second + o.debris + o.projectile;

test('Q*_RD is the energy that leaves half the mass, and its critical speed is the paper’s eq. 30', () => {
  // Two half-Earths head-on: no mass-ratio or angle correction.
  const half: ImpactBody = { gm: EARTH.gm / 2, radiusKm: EARTH.radiusKm / Math.cbrt(2) };
  const slow = impactOutcome(half, half, 1, 0);
  const total = 2 * half.gm;
  const rC1 = Math.cbrt((3 * total) / (4 * Math.PI * G_RHO1));
  const vStar = Math.sqrt(((32 * Math.PI * LS2012.cStar) / 5) * G_RHO1) * rC1;
  // At V* (eq. 30) the specific energy is Q*_RD, and the universal law leaves half the mass.
  const atStar = impactOutcome(half, half, vStar, 0);
  expect(atStar.qR / atStar.qRdPrime).toBeCloseTo(1, 12);
  expect(atStar.largest / total).toBeCloseTo(0.5, 12);
  expect(slow.alpha).toBe(1);
  expect(slow.grazing).toBe(false);
});

test('the regimes in order of speed, joined where they meet, with all the mass accounted', () => {
  const o = impactOutcome(EARTH, MARS, 1, 0);
  expect(o.vEscPrime).toBeLessThan(o.vErosion);
  expect(o.vErosion).toBeLessThan(o.vSuperCat);
  const at = (v: number, b = 0): ReturnType<typeof impactOutcome> => impactOutcome(EARTH, MARS, v, b);
  expect(at(0.9 * o.vEscPrime).regime).toBe('merge');
  expect(at(0.9 * o.vEscPrime).largest).toBe(EARTH.gm + MARS.gm);
  expect(at((o.vEscPrime + o.vErosion) / 2).regime).toBe('partial-accretion');
  expect(at((o.vErosion + o.vSuperCat) / 2).regime).toBe('erosion');
  expect(at(1.2 * o.vSuperCat).regime).toBe('super-catastrophic');
  // Erosion begins where the largest remnant has fallen to the target's mass; the super-catastrophic law takes over at a tenth of the total, continuously.
  const total = EARTH.gm + MARS.gm;
  expect(at(o.vErosion * (1 - 1e-9)).largest / EARTH.gm).toBeCloseTo(1, 6);
  expect(at(o.vErosion * (1 + 1e-9)).largest / EARTH.gm).toBeCloseTo(1, 6);
  expect(at(o.vSuperCat * (1 - 1e-9)).largest / total).toBeCloseTo(0.1, 6);
  expect(at(o.vSuperCat * (1 + 1e-9)).largest / total).toBeCloseTo(0.1, 6);
  // The largest remnant shrinks as the impact speeds up; everything sums to the total.
  let last = Number.POSITIVE_INFINITY;
  for (let v = 0.5 * o.vEscPrime; v < 2 * o.vSuperCat; v *= 1.15) {
    const out = at(v);
    expect(out.largest).toBeLessThanOrEqual(last + 1e-9 * total);
    last = out.largest;
    expect(sum(out) / total).toBeCloseTo(1, 12);
    expect(out.second).toBeLessThanOrEqual(out.largest);
  }
});

test('grazing impacts: hit-and-run below erosion, the projectile carried on whole; head-on ones accrete', () => {
  const o = impactOutcome(EARTH, MARS, 1, 0);
  const bCrit = EARTH.radiusKm / (EARTH.radiusKm + MARS.radiusKm);
  const v = 1.05 * o.vEscPrime;
  const graze = impactOutcome(EARTH, MARS, v, Math.min(0.99, bCrit + 0.1));
  expect(graze.grazing).toBe(true);
  expect(graze.alpha).toBeLessThan(1);
  // Less of the projectile interacts, so the merging speed falls and the disruption criterion rises.
  expect(graze.vEscPrime).toBeLessThan(o.vEscPrime);
  expect(graze.qRdPrime).toBeGreaterThan(o.qRdPrime);
  expect(graze.regime).toBe('hit-and-run');
  expect(graze.largest).toBe(EARTH.gm);
  expect(graze.projectile).toBe(MARS.gm);
  expect(impactOutcome(EARTH, MARS, v, 0).regime).toBe('partial-accretion');
});

test('a planet falling into a star merges: no realistic speed reaches the Sun’s escape speed', () => {
  const into = impactOutcome(SUN, EARTH, 29.8, 0);
  expect(into.vEscPrime).toBeGreaterThan(600);
  expect(into.regime).toBe('merge');
  expect(into.largest).toBe(SUN.gm + EARTH.gm);
});

test('the impact parameter: 0 head-on, 1 grazing, the sine of the angle between', () => {
  expect(impactParameter(1, 0, 0, -3, 0, 0)).toBe(0);
  expect(impactParameter(1, 0, 0, 0, 2, 0)).toBeCloseTo(1, 12);
  expect(impactParameter(1, 0, 0, -1, 1, 0)).toBeCloseTo(Math.SQRT1_2, 12);
  expect(impactParameter(0, 0, 0, 1, 0, 0)).toBe(0);
});
