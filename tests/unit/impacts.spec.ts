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
import { DEFAULT_INTEGRATOR, Engine, ENGINE_VERSION, SCHEMA_VERSION, stateFrom, type BodySpec } from '../../src/sim/engine';
import { impactOutcome, impactParameter, LS2012, type ImpactBody } from '../../src/sim/impacts';
import { diagnostics, drift, MAX_BODIES, MAX_DEBRIS, resolveContacts, step, type ContactEvent, type SimState } from '../../src/sim/nbody';

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

const spec = (id: string, b: ImpactBody, pos: [number, number, number], vel: [number, number, number]): BodySpec => ({ id, name: id, gm: b.gm, radiusKm: b.radiusKm, pos, vel, origin: 'user-edited', sourceIds: [] });
/** A Mars-mass body about to strike the Earth at `v` km/s, `offset` km off centre (it touches within the next 120 s step). */
const strike = (v: number, offset: number): SimState => stateFrom([spec('earth', EARTH, [0, 0, 0], [0, 0, 0]), spec('impactor', MARS, [EARTH.radiusKm + MARS.radiusKm + 1500, offset, 0], [-v, 0, 0])]);
const apartOrTouching = (s: SimState): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.ids.length; i += 1)
    for (let j = i + 1; j < s.ids.length; j += 1) {
      const d = Math.hypot((s.pos[j * 3] ?? 0) - (s.pos[i * 3] ?? 0), (s.pos[j * 3 + 1] ?? 0) - (s.pos[i * 3 + 1] ?? 0), (s.pos[j * 3 + 2] ?? 0) - (s.pos[i * 3 + 2] ?? 0));
      if (d < (s.radius[i] ?? 0) + (s.radius[j] ?? 0)) out.push(`${s.ids[i] ?? ''}/${s.ids[j] ?? ''}`);
    }
  return out;
};

test('a breakup in the engine: the remnant keeps the target\u2019s id, and mass, momentum, angular momentum and the closed model\u2019s energy are all kept', () => {
  // 40 km/s head-on (a little off centre): erosion, between 21.6 and 65.9 km/s.
  const s = strike(40, 2000);
  const ref = diagnostics(s);
  const events: ContactEvent[] = [];
  expect(resolveContacts(s, 120, null, events)).toBe(true);
  const [e] = events;
  expect(e?.kind).toBe('fragment');
  expect(e?.regime).toBe('erosion');
  expect(e?.speedKmS).toBeGreaterThan(40);
  expect(s.ids).toContain('earth');
  expect(s.ids).not.toContain('impactor');
  expect(e?.created.length).toBe(1 + MAX_DEBRIS);
  expect(s.ids.slice(1)).toEqual(e?.created);
  const now = diagnostics(s);
  expect(Math.abs(now.gm - ref.gm) / ref.gm).toBeLessThan(1e-14);
  const d = drift(ref, now);
  expect(d.momentum).toBeLessThan(1e-12);
  expect(d.angularMomentum).toBeLessThan(1e-12);
  expect(d.energy).toBeLessThan(1e-12);
  expect(e?.heat).toBeGreaterThan(0);
  // Eroded: the remnant is lighter than the Earth was; every piece starts clear of every other, and all is finite.
  expect(s.gm[0] ?? 0).toBeLessThan(EARTH.gm);
  expect(apartOrTouching(s)).toEqual([]);
  expect([...s.pos, ...s.vel, ...s.gm, ...s.radius, ...s.spin].every(Number.isFinite)).toBe(true);
  // Launched past the remnant's escape speed, the pieces leave: no further collision over the next hours.
  const acc: number[] = [];
  for (let k = 0; k < 60; k += 1) step(s, 60, acc, events);
  expect(events.length).toBe(1);
});

test('a graze passes on: hit-and-run leaves both bodies, and the pair is not struck again until it has parted', () => {
  // Just above the merging speed, well off centre (b over b_crit = 0.65).
  const o = impactOutcome(EARTH, MARS, 1, 0.8);
  const s = stateFrom([spec('earth', EARTH, [0, 0, 0], [0, 0, 0]), spec('impactor', MARS, [EARTH.radiusKm + MARS.radiusKm + 600, 0.85 * (EARTH.radiusKm + MARS.radiusKm), 0], [-1.05 * o.vEscPrime, 0, 0])]);
  const ref = diagnostics(s);
  const events: ContactEvent[] = [];
  const acc: number[] = [];
  for (let k = 0; k < 200 && events.length === 0; k += 1) step(s, 30, acc, events);
  expect(events.map((e) => e.kind)).toEqual(['graze']);
  expect(s.ids).toEqual(['earth', 'impactor']);
  expect(s.passing).toEqual(['earth|impactor']);
  // Through the overlap and out: still one event; once apart, the pair is tested again.
  for (let k = 0; k < 400; k += 1) step(s, 30, acc, events);
  expect(events.length).toBe(1);
  expect(s.passing).toEqual([]);
  expect(drift(ref, diagnostics(s)).energy).toBeLessThan(1e-4);
});

test('debris that would pass the body limit is returned to the remnant, accounted', () => {
  // The scenario at the limit: the second remnant takes the projectile's place, and no room is left for debris.
  const crowd: BodySpec[] = Array.from({ length: MAX_BODIES - 2 }, (_, k) => spec(`m${k}`, { gm: 1, radiusKm: 1 }, [1e9 + k * 1e6, 0, 0], [0, 0, 0]));
  const s = stateFrom([spec('earth', EARTH, [0, 0, 0], [0, 0, 0]), spec('impactor', MARS, [EARTH.radiusKm + MARS.radiusKm + 1500, 2000, 0], [-40, 0, 0]), ...crowd]);
  const ref = diagnostics(s);
  const events: ContactEvent[] = [];
  resolveContacts(s, 120, null, events);
  expect(s.ids.length).toBe(MAX_BODIES);
  expect(events[0]?.created.length).toBe(1);
  expect(events[0]?.unresolved).toBeGreaterThan(0);
  expect(Math.abs(diagnostics(s).gm - ref.gm) / ref.gm).toBeLessThan(1e-14);
});

test('a breakup replays to exactly the same bodies, through save and load', () => {
  const scenario = { schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, name: 'strike', epochJdTdb: 2451545, frame: 'test', seedNote: '', integrator: { ...DEFAULT_INTEGRATOR }, bodies: [spec('earth', EARTH, [0, 0, 0], [0, 0, 0]), spec('impactor', MARS, [60_000, 2000, 0], [-40, 0, 0])], log: [] };
  const a = new Engine(structuredClone(scenario));
  a.advanceTo(3 * 3600, 1_000_000);
  expect(a.events.some((e) => e.kind === 'fragment')).toBe(true);
  const b = new Engine(JSON.parse(JSON.stringify(a.toScenario())) as typeof scenario);
  b.advanceTo(a.state.t, 1_000_000);
  expect(b.state.ids).toEqual(a.state.ids);
  expect(b.state.pos).toEqual(a.state.pos);
  expect(b.state.vel).toEqual(a.state.vel);
});
