/**
 * The laboratory engine's newer edits and physics (src/sim/engine, src/sim/nbody): oblateness's
 * nodal precession against the textbook rate (with energy and angular momentum still kept, the
 * planet's axis taking up the torque), a body held in place, radius, spin, state and name edits,
 * undo and redo bit for bit, a prediction's encounters, the file checks for all of them, and the
 * solar system seeded turning as the IAU models have it, with the fact sheets' J2s.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createEphemeris, type MoonFile, type PlanetsFile } from '../../src/astro/ephemeris';
import type { PhysicalFile } from '../../src/astro/physical';
import { DEFAULT_INTEGRATOR, Engine, ENGINE_VERSION, SCHEMA_VERSION, stateFrom, validateScenario, type BodySpec, type Scenario } from '../../src/sim/engine';
import { seedSolarSystem } from '../../src/sim/seed';
import { elementsFromState } from '../../src/sim/elements';
import { diagnostics, drift, rotationOf, step, type MergeEvent } from '../../src/sim/nbody';

const GM_EARTH = 398_600.435;
const R_EARTH = 6378.137;
const J2_EARTH = 1.08263e-3;

const body = (id: string, gm: number, radiusKm: number, pos: [number, number, number], vel: [number, number, number], extra: Partial<BodySpec> = {}): BodySpec => ({ id, name: id, gm, radiusKm, pos, vel, origin: 'user-edited', sourceIds: [], ...extra });
const scenario = (bodies: BodySpec[], integrator = DEFAULT_INTEGRATOR): Scenario => ({ schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, name: 'test', epochJdTdb: 2_451_545, frame: 'test', seedNote: 'test', integrator: { ...integrator }, bodies, log: [] });

test('oblateness: an inclined satellite’s node regresses at the textbook rate, energy and angular momentum kept (the planet’s axis takes up the torque)', () => {
  const a = 7000;
  const inc = (50 * Math.PI) / 180;
  const v = Math.sqrt(GM_EARTH / a);
  const earth = body('earth', GM_EARTH, R_EARTH, [0, 0, 0], [0, 0, 0], { j2: J2_EARTH, inertia: 0.3307, spin: { periodS: 86_164.1, pole: [0, 0, 1] } });
  const sat = body('sat', 0, 0.001, [a, 0, 0], [0, v * Math.cos(inc), v * Math.sin(inc)]);
  const s = stateFrom([earth, sat]);
  const ref = diagnostics(s);
  const acc: number[] = [];
  const events: MergeEvent[] = [];
  const node0 = elementsFromState(s.pos.slice(3, 6), s.vel.slice(3, 6), GM_EARTH).node;
  const days = 5;
  const dt = 10;
  for (let k = 0; k < (days * 86_400) / dt; k += 1) step(s, dt, acc, events);
  const el = elementsFromState(
    [0, 1, 2].map((k) => (s.pos[3 + k] ?? 0) - (s.pos[k] ?? 0)),
    [0, 1, 2].map((k) => (s.vel[3 + k] ?? 0) - (s.vel[k] ?? 0)),
    GM_EARTH,
  );
  // Theory: dNode/dt = -(3/2) n J2 (R / p)^2 cos i (Vallado, eq. 9-41), about -5.0 degrees a day here.
  const n = Math.sqrt(GM_EARTH / a ** 3);
  const rate = -1.5 * n * J2_EARTH * (R_EARTH / (a * (1 - el.e ** 2))) ** 2 * Math.cos(inc);
  let moved = el.node - node0;
  if (moved > Math.PI) moved -= 2 * Math.PI;
  expect(moved / (rate * days * 86_400)).toBeCloseTo(1, 1);
  // A test particle: the planet feels nothing, so its spin is unchanged; energy kept to the integrator's accuracy.
  const d = drift(ref, diagnostics(s));
  expect(d.energy).toBeLessThan(1e-6);
  expect(d.angularMomentum).toBeLessThan(1e-12);
});

test('oblateness with a massive moon: the torque turns the planet’s axis, and the total angular momentum is kept', () => {
  const earth = body('earth', GM_EARTH, R_EARTH, [0, 0, 0], [0, 0, 0], { j2: J2_EARTH, inertia: 0.3307, spin: { periodS: 86_164.1, pole: [0, 0.3978, 0.9175] } });
  const moonA = 30_000;
  const vm = Math.sqrt((GM_EARTH + 4902.8) / moonA);
  const moon = body('moon', 4902.8, 1737.4, [moonA, 0, 0], [0, vm, 0]);
  const s = stateFrom([earth, moon]);
  const ref = diagnostics(s);
  const pole0 = rotationOf(s, 0).pole;
  const acc: number[] = [];
  const events: MergeEvent[] = [];
  for (let k = 0; k < 20_000; k += 1) step(s, 60, acc, events);
  const pole1 = rotationOf(s, 0).pole;
  // The axis has moved (precessing about the moon's orbit pole), its rate of turning not (to the
  // leapfrog's second order: each kick adds a torque square to the spin, lengthening it by (tau dt)^2 / 2L).
  expect(Math.hypot(pole1[0] - pole0[0], pole1[1] - pole0[1], pole1[2] - pole0[2])).toBeGreaterThan(1e-9);
  expect((rotationOf(s, 0).periodS ?? 0) / 86_164.1).toBeCloseTo(1, 7);
  const d = drift(ref, diagnostics(s));
  expect(d.angularMomentum).toBeLessThan(1e-10);
  expect(d.momentum).toBeLessThan(1e-10);
  expect(d.energy).toBeLessThan(1e-6);
});

test('a body held in place does not move; a moon goes on orbiting it; the edits of radius, spin, state and name', () => {
  const e = new Engine(scenario([body('sun', 132_712_440_041.279, 695_700, [0, 0, 0], [0, 0.01, 0]), body('planet', GM_EARTH, R_EARTH, [149_597_870.7, 0, 0], [0, 29.78, 0])]));
  e.apply({ kind: 'setFixed', id: 'sun', fixed: true });
  e.advanceTo(86_400 * 30, 1_000_000);
  expect(e.state.pos.slice(0, 3)).toEqual([0, 0, 0]);
  expect(e.state.vel.slice(0, 3)).toEqual([0, 0, 0]);
  expect(Math.hypot(e.state.pos[3] ?? 0, e.state.pos[4] ?? 0) / 149_597_870.7).toBeCloseTo(1, 2);
  e.apply({ kind: 'setFixed', id: 'sun', fixed: false });
  expect(e.state.fixed).toEqual([]);
  // Spin, then radius: the period and pole kept as the radius changes.
  e.apply({ kind: 'setSpin', id: 'planet', periodS: 36_000, pole: [0, 0, 2] });
  expect(rotationOf(e.state, 1).periodS).toBeCloseTo(36_000, 6);
  expect(rotationOf(e.state, 1).pole).toEqual([0, 0, 1]);
  e.apply({ kind: 'setRadius', id: 'planet', radiusKm: 8000 });
  expect(e.state.radius[1]).toBe(8000);
  expect(rotationOf(e.state, 1).periodS).toBeCloseTo(36_000, 6);
  e.apply({ kind: 'setState', id: 'planet', pos: [2e8, 0, 0], vel: [0, 25, 0] });
  expect(e.state.pos.slice(3, 6)).toEqual([2e8, 0, 0]);
  e.apply({ kind: 'rename', id: 'planet', name: '  Second Earth  ' });
  expect(e.state.names[1]).toBe('Second Earth');
});

test('undo goes back to the moment of the edit as it was before it, bit for bit; redo puts it back exactly', () => {
  const start = scenario([body('sun', 132_712_440_041.279, 695_700, [0, 0, 0], [0, 0, 0]), body('planet', GM_EARTH, R_EARTH, [149_597_870.7, 0, 0], [0, 29.78, 0]), body('moon', 4902.8, 1737.4, [149_597_870.7 + 384_400, 0, 0], [0, 29.78 + 1.022, 0])]);
  const e = new Engine(structuredClone(start));
  e.advanceTo(86_400 * 10, 1_000_000);
  const before = JSON.stringify(e.state);
  const stepAt = e.state.step;
  e.apply({ kind: 'setMass', id: 'moon', gm: 4902.8 * 50 });
  const after = JSON.stringify(e.state);
  e.advanceTo(86_400 * 40, 1_000_000);
  expect(e.undoable).toBe(1);
  expect(e.undo()).toBe(true);
  expect(e.state.step).toBe(stepAt);
  expect(JSON.stringify(e.state)).toBe(before);
  expect(e.undoable).toBe(0);
  expect(e.redoable).toBe(1);
  expect(e.redo()).toBe(true);
  expect(JSON.stringify(e.state)).toBe(after);
  // Run on: exactly as the run that never undid.
  const straight = new Engine(structuredClone(start));
  straight.advanceTo(86_400 * 10, 1_000_000);
  straight.apply({ kind: 'setMass', id: 'moon', gm: 4902.8 * 50 });
  straight.advanceTo(86_400 * 40, 1_000_000);
  e.advanceTo(86_400 * 40, 1_000_000);
  expect(JSON.stringify(e.state)).toBe(JSON.stringify(straight.state));
  // A new edit clears what could be redone.
  e.undo();
  e.apply({ kind: 'setMass', id: 'moon', gm: 4902.8 });
  expect(e.redoable).toBe(0);
});

test('a prediction names its encounters: a body passing a planet, when and how close', () => {
  // A small body crossing near a planet at rest (no primary for the body: the encounter is the planet).
  const planet = body('planet', GM_EARTH, R_EARTH, [0, 0, 0], [0, 0, 0]);
  const rock = body('rock', 1e-6, 1, [-500_000, 50_000, 0], [10, 0, 0]);
  const e = new Engine(scenario([planet, rock], { ...DEFAULT_INTEGRATOR, dtMaxS: 600 }));
  const p = e.predict('rock', 100_000, 100, 1_000_000);
  // Its own primary is the planet (heavier, nearest): encounters exclude the body it orbits, so none here.
  expect(p.frame).toBe('planet');
  expect(p.encounters).toEqual([]);
  // Starting far off, with a star as its primary (nearer it for the star's pull), the planet is an encounter.
  const star = body('star', 132_712_440_041.279, 695_700, [1.5e8, 0, 0], [0, 0, 0]);
  const far = body('rock', 1e-6, 1, [-5e6, 50_000, 0], [50, 0, 0]);
  const e2 = new Engine(scenario([star, planet, far], { ...DEFAULT_INTEGRATOR, dtMaxS: 600 }));
  const p2 = e2.predict('rock', 200_000, 200, 1_000_000);
  expect(p2.frame).toBe('star');
  const [enc] = p2.encounters;
  expect(enc?.with).toBe('planet');
  // Closest near x = 0 after about 100,000 s, at a little under 50,000 km (gravity bends it in a little).
  expect(enc?.t ?? 0).toBeGreaterThan(90_000);
  expect(enc?.t ?? 0).toBeLessThan(110_000);
  expect(enc?.distanceKm ?? 0).toBeGreaterThan(40_000);
  expect(enc?.distanceKm ?? 0).toBeLessThan(50_000);
  // A finer prediction agrees on the distance.
  const fine = e2.predict('rock', 200_000, 200, 4_000_000, 0.25);
  expect((fine.encounters[0]?.distanceKm ?? 0) / (enc?.distanceKm ?? 1)).toBeCloseTo(1, 2);
});

test('files with the new edits and bodies with spin, J2 and inertia are read; impossible ones are refused', () => {
  const ok = scenario([body('earth', GM_EARTH, R_EARTH, [0, 0, 0], [0, 0, 0], { j2: J2_EARTH, inertia: 0.33, spin: { periodS: 86_164, pole: [0, 0, 1] } }), body('moon', 4902.8, 1737.4, [384_400, 0, 0], [0, 1.02, 0])]);
  ok.log = [
    { step: 0, command: { kind: 'setRadius', id: 'moon', radiusKm: 1800 } },
    { step: 1, command: { kind: 'setSpin', id: 'moon', periodS: 2_360_000, pole: [0, 0, 1] } },
    { step: 2, command: { kind: 'setFixed', id: 'earth', fixed: true } },
    { step: 3, command: { kind: 'rename', id: 'moon', name: 'Luna' } },
    { step: 4, command: { kind: 'setState', id: 'moon', pos: [400_000, 0, 0], vel: [0, 1, 0] } },
  ];
  expect(validateScenario(JSON.parse(JSON.stringify(ok))).ok).toBe(true);
  const bad = JSON.parse(JSON.stringify(ok)) as Scenario;
  (bad.bodies[0] as BodySpec).j2 = 2;
  bad.log.push({ step: 5, command: { kind: 'setSpin', id: 'moon', periodS: -1, pole: [0, 0, 0] } });
  bad.log.push({ step: 6, command: { kind: 'rename', id: 'moon', name: '' } });
  const r = validateScenario(bad);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
});

test('the solar system seeded turning as the IAU models have it: the Earth’s tilt and sidereal day, the Moon locked, Venus backwards; a year with oblateness keeps its energy', () => {
  const ROOT = new URL('../../', import.meta.url);
  const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
  const physical = readJson('public/assets/jpl/physical.json') as PhysicalFile;
  const constants = (readJson('data/constants.json') as { constants: Array<{ id: string; value: number }> }).constants;
  const value = (id: string): number | null => constants.find((c) => c.id === id)?.value ?? null;
  const eph = createEphemeris(readJson('public/assets/jpl/planets.json') as PlanetsFile, readJson('public/assets/jpl/moon.json') as MoonFile, physical);
  const ids = ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
  const shapes = Object.fromEntries(ids.map((id) => [id, { j2: value(`${id}.j2`), inertia: value(`${id}.momentOfInertia`) }]));
  const scenario = seedSolarSystem(eph, physical, 2_461_336.75, {}, shapes);
  const e = new Engine(scenario);
  const s = e.state;
  const at = (id: string): number => s.ids.indexOf(id);
  const tilt = (id: string, about: string): number => {
    const i = at(id);
    const p = at(about);
    const r = [0, 1, 2].map((k) => (s.pos[i * 3 + k] ?? 0) - (s.pos[p * 3 + k] ?? 0));
    const v = [0, 1, 2].map((k) => (s.vel[i * 3 + k] ?? 0) - (s.vel[p * 3 + k] ?? 0));
    const h = [(r[1] ?? 0) * (v[2] ?? 0) - (r[2] ?? 0) * (v[1] ?? 0), (r[2] ?? 0) * (v[0] ?? 0) - (r[0] ?? 0) * (v[2] ?? 0), (r[0] ?? 0) * (v[1] ?? 0) - (r[1] ?? 0) * (v[0] ?? 0)];
    const pole = rotationOf(s, i).pole;
    return (Math.acos(((h[0] ?? 0) * pole[0] + (h[1] ?? 0) * pole[1] + (h[2] ?? 0) * pole[2]) / Math.hypot(...h)) * 180) / Math.PI;
  };
  expect(tilt('earth', 'sun')).toBeCloseTo(23.44, 1);
  expect((rotationOf(s, at('earth')).periodS ?? 0) / 86_164.1).toBeCloseTo(1, 4);
  expect((rotationOf(s, at('moon')).periodS ?? 0) / 86_400).toBeCloseTo(27.32, 2);
  // Venus turns backwards: tilted by nearly 180 degrees from its orbit's pole.
  expect(tilt('venus', 'sun')).toBeGreaterThan(170);
  expect(s.j2[at('earth')]).toBeCloseTo(1.08263e-3, 9);
  expect(s.inertia[at('earth')]).toBe(0.3308);
  // A year of the solar system with every world's oblateness: energy and angular momentum still kept.
  e.advanceTo(365.25 * 86_400, 1_000_000);
  const d = e.drift();
  expect(d.energy).toBeLessThan(1e-6);
  expect(d.angularMomentum).toBeLessThan(1e-9);
});

test('undo through several edits made at the same moment (paused): each comes off in turn, exactly; a branch drops the old future’s checkpoints', () => {
  const start = scenario([body('sun', 132_712_440_041.279, 695_700, [0, 0, 0], [0, 0, 0]), body('planet', GM_EARTH, R_EARTH, [149_597_870.7, 0, 0], [0, 29.78, 0]), body('moon', 4902.8, 1737.4, [149_597_870.7 + 384_400, 0, 0], [0, 29.78 + 1.022, 0])]);
  const e = new Engine(structuredClone(start));
  e.advanceTo(86_400 * 5, 1_000_000);
  const states = [JSON.stringify(e.state)];
  for (const c of [
    { kind: 'setRadius', id: 'moon', radiusKm: 2000 },
    { kind: 'rename', id: 'moon', name: 'Luna' },
    { kind: 'setFixed', id: 'moon', fixed: true },
    { kind: 'setFixed', id: 'moon', fixed: false },
  ] as const) {
    e.apply(c);
    states.push(JSON.stringify(e.state));
  }
  for (let k = states.length - 2; k >= 0; k -= 1) {
    expect(e.undo()).toBe(true);
    expect(JSON.stringify(e.state)).toBe(states[k]);
  }
  expect(e.undo()).toBe(false);
  for (let k = 1; k < states.length; k += 1) {
    expect(e.redo()).toBe(true);
    expect(JSON.stringify(e.state)).toBe(states[k]);
  }
  // Back to an earlier checkpoint and a new edit there: no checkpoint of the old future survives to be gone back to.
  e.advanceTo(86_400 * 30, 1_000_000);
  const early = e.checkpoints.find((c) => c.step > 0 && c.t < 86_400 * 5) ?? e.checkpoints[0];
  e.seek(early?.step ?? 0);
  const branchStep = e.state.step;
  e.apply({ kind: 'setMass', id: 'moon', gm: 1 });
  expect(e.checkpoints.every((c) => c.step <= branchStep)).toBe(true);
});

test('an edit made on a view the run has since passed is made at that view’s step, exactly as if made then; no checkpoint of a run without it survives', () => {
  const start = scenario([body('sun', 132_712_440_041.279, 695_700, [0, 0, 0], [0, 0, 0]), body('planet', GM_EARTH, R_EARTH, [149_597_870.7, 0, 0], [0, 29.78, 0]), body('moon', 4902.8, 1737.4, [149_597_870.7 + 384_400, 0, 0], [0, 29.78 + 1.022, 0])]);
  const e = new Engine(structuredClone(start));
  e.advanceTo(86_400 * 10, 1_000_000);
  const seen = e.state.step;
  // A ship placed 7,000 km from the planet as it was seen, on a circular orbit; the run goes on a day (a fast rate) before the edit arrives.
  const p = e.state.ids.indexOf('planet');
  const at = [0, 1, 2].map((k) => e.state.pos[p * 3 + k] ?? 0);
  const av = [0, 1, 2].map((k) => e.state.vel[p * 3 + k] ?? 0);
  const ship = body('ship', 0, 0.01, [(at[0] ?? 0) + 7000, at[1] ?? 0, at[2] ?? 0], [av[0] ?? 0, (av[1] ?? 0) + Math.sqrt(GM_EARTH / 7000), av[2] ?? 0]);
  e.advanceTo(86_400 * 11, 1_000_000);
  e.applyAt({ kind: 'add', body: ship }, seen);
  expect(e.toScenario().log.at(-1)?.step).toBe(seen);
  // Exactly the run that made it then, there and a day on.
  const straight = new Engine(structuredClone(start));
  straight.advanceTo(86_400 * 10, 1_000_000);
  straight.apply({ kind: 'add', body: ship });
  expect(JSON.stringify(e.state)).toBe(JSON.stringify(straight.state));
  expect(e.checkpoints.every((c) => c.step <= seen)).toBe(true);
  e.advanceTo(86_400 * 11, 1_000_000);
  straight.advanceTo(86_400 * 11, 1_000_000);
  expect(JSON.stringify(e.state)).toBe(JSON.stringify(straight.state));
  // Still on its orbit (made at the later step, it would have been some 2.6 million kilometres behind the planet).
  const i = e.state.ids.indexOf('ship');
  const q = e.state.ids.indexOf('planet');
  const rel = (v: readonly number[]): number[] => [0, 1, 2].map((k) => (v[i * 3 + k] ?? 0) - (v[q * 3 + k] ?? 0));
  const orbit = elementsFromState(rel(e.state.pos), rel(e.state.vel), GM_EARTH);
  expect(orbit.a / 7000).toBeGreaterThan(0.99);
  expect(orbit.a / 7000).toBeLessThan(1.01);
  expect(orbit.e).toBeLessThan(0.01);
  // A view from before the latest edit: made now instead, the edit before it kept.
  const now = e.state.step;
  e.applyAt({ kind: 'rename', id: 'moon', name: 'Luna' }, seen - 10);
  expect(e.toScenario().log.map((x) => x.step)).toEqual([seen, now]);
  // Gone back (the history) to before nothing later in the log, an edit there: the run as it was keeps no checkpoint to go back to.
  e.advanceTo(86_400 * 30, 1_000_000);
  const back = e.checkpoints.find((c) => c.step > now && c.t < 86_400 * 25);
  expect(back).toBeDefined();
  e.seek(back?.step ?? 0);
  e.apply({ kind: 'setMass', id: 'moon', gm: 4902.8 * 2 });
  expect(e.checkpoints.every((c) => c.step <= (back?.step ?? 0))).toBe(true);
  // Likewise a redo: the checkpoints taken while it was undone go.
  e.advanceTo(86_400 * 40, 1_000_000);
  expect(e.undo()).toBe(true);
  e.advanceTo(86_400 * 50, 1_000_000);
  expect(e.redo()).toBe(true);
  expect(e.checkpoints.every((c) => c.step <= (back?.step ?? 0))).toBe(true);
});
