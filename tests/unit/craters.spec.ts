/**
 * The crater scaling (src/sim/craters): Collins, Melosh and Marcus's (2005) transient crater, the
 * final crater simple or complex past the gravity-scaled transition, a Meteor Crater-sized check, the
 * Moon's larger craters for the same impact, and no crater for a giant impact; and in the engine, a
 * merger's crater on a solid world (none on a star), with its energy in joules.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { PhysicalFile } from '../../src/astro/physical';
import { bulkDensity, contactCrater, CRATER, crater, CRUST_DENSITY, joules, transitionM, type CraterInput } from '../../src/sim/craters';
import { stateFrom, type BodySpec } from '../../src/sim/engine';
import { resolveContacts, type ContactEvent } from '../../src/sim/nbody';

const physical = JSON.parse(readFileSync(new URL('../../public/assets/jpl/physical.json', import.meta.url), 'utf8')) as PhysicalFile;
const mean = (r: readonly number[]): number => r.reduce((a, b) => a + b, 0) / r.length;
const EARTH = { gm: physical.gmKm3S2.Earth, radiusKm: mean(physical.bodies.Earth.radiiKm) };
const SUN = { gm: physical.gmKm3S2.Sun, radiusKm: mean(physical.bodies.Sun.radiiKm) };
/** A stony body 1 km across (3,000 kg/m^3): its GM, km^3 s^-2. */
const ROCK = { gm: 6.6743e-20 * 3000 * 1e9 * (4 / 3) * Math.PI * 0.5 ** 3, radiusKm: 0.5 };
const spec = (id: string, b: { gm: number; radiusKm: number }, pos: [number, number, number], vel: [number, number, number]): BodySpec => ({ id, name: id, gm: b.gm, radiusKm: b.radiusKm, pos, vel, origin: 'user-edited', sourceIds: [] });

const earth = { targetDensity: 2500, gravity: 9.81, targetRadiusM: 6_371_000 };

test('the transient crater is the fit itself; a 50 m iron body at 12.8 km/s leaves a simple crater about Meteor Crater’s size', () => {
  const iron: CraterInput = { impactorM: 50, impactorDensity: 7800, ...earth, speedMs: 12_800, angle: Math.PI / 4 };
  const c = crater(iron);
  const expected = 1.161 * Math.cbrt(7800 / 2500) * 50 ** 0.78 * 12_800 ** 0.44 * 9.81 ** -0.22 * Math.cbrt(Math.sin(Math.PI / 4));
  expect(c?.transientM).toBeCloseTo(expected, 6);
  expect(c?.finalM).toBeCloseTo(1.25 * expected, 6);
  expect(c?.complex).toBe(false);
  // Meteor Crater is 1.2 km across; the fit gives about 1.5 km for this textbook impactor.
  expect(c?.finalM ?? 0).toBeGreaterThan(1000);
  expect(c?.finalM ?? 0).toBeLessThan(2000);
  // Straight down, a third power of the sine larger.
  expect(crater({ ...iron, angle: Math.PI / 2 })?.transientM ?? 0).toBeCloseTo(expected / Math.cbrt(Math.sin(Math.PI / 4)), 6);
});

test('past the transition the crater is complex: a 1 km stony body at 20 km/s leaves one about 16 km across on the Earth', () => {
  const stony: CraterInput = { impactorM: 1000, impactorDensity: 3000, ...earth, speedMs: 20_000, angle: Math.PI / 4 };
  const c = crater(stony);
  expect(c?.complex).toBe(true);
  const transientAt = CRATER.earthTransitionM / CRATER.simple;
  expect(c?.finalM).toBeCloseTo((1.17 * (c?.transientM ?? 0) ** 1.13) / transientAt ** 0.13, 3);
  expect((c?.finalM ?? 0) / 1000).toBeGreaterThan(14);
  expect((c?.finalM ?? 0) / 1000).toBeLessThan(18);
});

test('the transition scales inversely with gravity (about 19 km on the Moon), and the same impact digs a larger crater there', () => {
  expect(transitionM(9.81)).toBe(3200);
  expect(transitionM(1.62) / 1000).toBeCloseTo(19.4, 1);
  const body: CraterInput = { impactorM: 50, impactorDensity: 3000, ...earth, speedMs: 15_000, angle: Math.PI / 4 };
  const onEarth = crater(body);
  const onMoon = crater({ ...body, gravity: 1.62, targetRadiusM: 1_737_400 });
  expect((onMoon?.transientM ?? 0) / (onEarth?.transientM ?? 1)).toBeCloseTo((9.81 / 1.62) ** 0.22, 6);
});

test('no crater where the scaling does not hold: a giant impact, no speed, or a grazing miss', () => {
  // Mars-sized into the Earth: the target is reshaped, not cratered.
  expect(crater({ impactorM: 6_779_000, impactorDensity: 3930, targetDensity: 5510, gravity: 9.81, targetRadiusM: 6_371_000, speedMs: 10_000, angle: Math.PI / 4 })).toBeNull();
  expect(crater({ impactorM: 50, impactorDensity: 3000, ...earth, speedMs: 0, angle: Math.PI / 4 })).toBeNull();
  expect(crater({ impactorM: 50, impactorDensity: 3000, ...earth, speedMs: 15_000, angle: 0 })).toBeNull();
});

test('in the engine, a small body’s impact leaves its crater on a solid world, with the impact’s energy; a star has none', () => {
  expect(bulkDensity(ROCK.gm, ROCK.radiusKm)).toBeCloseTo(3000, 6);
  // 20 km/s straight down onto the Earth (it touches within the next 60 s step): above the escape
  // speed, Leinhardt and Stewart's partial accretion, which for a body this small throws off nothing.
  const s = stateFrom([spec('earth', EARTH, [0, 0, 0], [0, 0, 0]), spec('rock', ROCK, [EARTH.radiusKm + ROCK.radiusKm + 500, 0, 0], [-20, 0, 0])]);
  const events: ContactEvent[] = [];
  expect(resolveContacts(s, 60, null, events)).toBe(true);
  const [e] = events;
  expect(e?.regime).toBe('partial-accretion');
  expect(e?.created).toEqual([]);
  expect(s.ids).toEqual(['earth']);
  expect(e?.crater).toEqual(contactCrater(EARTH, ROCK, e?.speedKmS ?? 0, e?.b ?? 0));
  expect(e?.crater?.complex).toBe(true);
  // The same as the fit for that impactor into crystalline rock (straight down: b = 0).
  const fit = crater({ impactorM: 1000, impactorDensity: 3000, targetDensity: CRUST_DENSITY, gravity: (EARTH.gm / EARTH.radiusKm ** 2) * 1000, targetRadiusM: EARTH.radiusKm * 1000, speedMs: (e?.speedKmS ?? 0) * 1000, angle: Math.PI / 2 });
  expect(e?.crater?.diameterKm).toBeCloseTo((fit?.finalM ?? 0) / 1000, 9);
  // Its energy: half its mass times the speed at contact squared (the Earth's share of the motion is negligible).
  const massKg = (ROCK.gm * 1e9) / 6.6743e-11;
  expect(joules(e?.energy ?? 0) / (0.5 * massKg * ((e?.speedKmS ?? 0) * 1000) ** 2)).toBeCloseTo(1, 6);
  // About 75,000 megatons of TNT (4.184e15 J each) for a 1 km stone at 20 km/s.
  expect(joules(e?.energy ?? 0) / 4.184e15 / 1000).toBeCloseTo(76.6, 0);
  // Dropped from 600 km, it arrives below the escape speed and merges: a smaller crater, still complex.
  const slow = stateFrom([spec('earth', EARTH, [0, 0, 0], [0, 0, 0]), spec('rock', ROCK, [EARTH.radiusKm + ROCK.radiusKm + 0.5, 0, 0], [-3.4, 0, 0])]);
  const merged: ContactEvent[] = [];
  resolveContacts(slow, 60, null, merged);
  expect(merged[0]?.kind).toBe('merge');
  expect(merged[0]?.crater?.diameterKm ?? 0).toBeGreaterThan(5);
  expect(merged[0]?.crater?.diameterKm ?? Infinity).toBeLessThan(e?.crater?.diameterKm ?? 0);
  // Into a star: no crater.
  const t = stateFrom([spec('star', SUN, [0, 0, 0], [0, 0, 0]), spec('rock', ROCK, [SUN.radiusKm + ROCK.radiusKm + 500, 0, 0], [-20, 0, 0])]);
  const intoStar: ContactEvent[] = [];
  resolveContacts(t, 60, null, intoStar);
  expect(intoStar.length).toBe(1);
  expect(intoStar[0]?.crater).toBeNull();
});
