/**
 * The laboratory's newer engine parts (docs/SANDBOX-ROADMAP.md M1): seeing an event coming
 * (src/sim/approach: the time to contact by Kepler's equation against the exact drift, the scan's impacts
 * and tidal crossings); throwing a rock (src/sim/aim: the speed and angle asked for at the actual contact,
 * and the outcome worked out the same, step for step, as the run that is given the rock); where bodies come
 * from and what they look like (src/sim/looks, carried through replays); and the one check every edit
 * passes (checkCommand: a refused edit changes nothing, a file and a live edit judged alike, a deterministic
 * fuzz of ten thousand commands after which every save restores and replays to the same state).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createEphemeris, type MoonFile, type PlanetsFile } from '../../src/astro/ephemeris';
import type { PhysicalFile } from '../../src/astro/physical';
import { planner, planThrow, REFUSED, type ThrowRequest } from '../../src/sim/aim';
import { nextApproach, timeToReach } from '../../src/sim/approach';
import { checkCommand, Engine, ENGINE_VERSION, IMPORT_LIMITS, SCHEMA_VERSION, STALE, stateFrom, validateScenario, DEFAULT_INTEGRATOR, type BodySpec, type Command, type Scenario } from '../../src/sim/engine';
import { airlessRock } from '../../src/sim/climate';
import { keplerDrift } from '../../src/sim/kepler';
import { eventKey, lookOf } from '../../src/sim/looks';
import { step, type ContactEvent, type SimState } from '../../src/sim/nbody';
import { swarmPlaces } from '../../src/sim/rewind';
import { seedSolarSystem } from '../../src/sim/seed';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const physical = readJson('public/assets/jpl/physical.json') as PhysicalFile;
const GM_EARTH = physical.gmKm3S2.Earth;
const R_EARTH = 6371;

const body = (id: string, gm: number, radiusKm: number, pos: [number, number, number], vel: [number, number, number], extra: Partial<BodySpec> = {}): BodySpec => ({ id, name: id, gm, radiusKm, pos, vel, origin: 'user-edited', sourceIds: [], ...extra });
const scenario = (bodies: BodySpec[]): Scenario => ({ schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, name: 'test', epochJdTdb: 2_451_545, frame: 'test', seedNote: 'test', integrator: { ...DEFAULT_INTEGRATOR }, bodies, log: [] });
/** The run's state as a hash of its Float64 positions, velocities and GMs (bit for bit). */
const hash = (s: SimState): string => createHash('sha256').update(new Uint8Array(new Float64Array([...s.pos, ...s.vel, ...s.gm, ...Array.from({ length: s.ids.join('|').length }, (_, k) => s.ids.join('|').charCodeAt(k))]).buffer)).digest('hex');
/** Of the 20 seeded throws, how many are made (the rest refused with a reason): all but the hardest. */
const MADE_OF_20 = 19;
/** Mulberry32, for the seeded cases. */
const random = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** The two-body problem by fourth-order Runge-Kutta (a reference independent of ./kepler): the position after `t` seconds. */
function rk4(r0: readonly number[], v0: readonly number[], mu: number, t: number): [number, number, number] {
  const y = [r0[0] ?? 0, r0[1] ?? 0, r0[2] ?? 0, v0[0] ?? 0, v0[1] ?? 0, v0[2] ?? 0];
  const f = (s: readonly number[]): number[] => {
    const d = Math.hypot(s[0] ?? 0, s[1] ?? 0, s[2] ?? 0);
    const k = -mu / (d * d * d);
    return [s[3] ?? 0, s[4] ?? 0, s[5] ?? 0, (s[0] ?? 0) * k, (s[1] ?? 0) * k, (s[2] ?? 0) * k];
  };
  let done = 0;
  while (done < t) {
    const h = Math.min(t - done, (1e-3 * Math.hypot(y[0] ?? 0, y[1] ?? 0, y[2] ?? 0)) / Math.max(Math.hypot(y[3] ?? 0, y[4] ?? 0, y[5] ?? 0), 1e-9));
    const k1 = f(y);
    const k2 = f(y.map((x, i) => x + (h / 2) * (k1[i] ?? 0)));
    const k3 = f(y.map((x, i) => x + (h / 2) * (k2[i] ?? 0)));
    const k4 = f(y.map((x, i) => x + h * (k3[i] ?? 0)));
    for (let i = 0; i < 6; i += 1) y[i] = (y[i] ?? 0) + (h / 6) * ((k1[i] ?? 0) + 2 * (k2[i] ?? 0) + 2 * (k3[i] ?? 0) + (k4[i] ?? 0));
    done += h;
  }
  return [y[0] ?? 0, y[1] ?? 0, y[2] ?? 0];
}

test('the time to contact by Kepler’s equation lands exactly on the contact distance, for ellipses and hyperbolas; none for a miss or a body leaving', () => {
  const next = random(7);
  let checked = 0;
  for (let k = 0; k < 400; k += 1) {
    // Coming in from 20 to 400 thousand km, at speeds from well below to well above escape, aimed near the centre.
    const d = 20_000 + 380_000 * next();
    const speed = 0.3 + 25 * next();
    const off = (next() - 0.5) * 2 * R_EARTH * 1.5;
    const r = [d, off, (next() - 0.5) * 1000];
    const v = [-speed, (next() - 0.5) * 0.4, 0];
    const t = timeToReach(r, v, GM_EARTH, R_EARTH + 1);
    if (t === null) {
      // Then it never comes within reach: checked by drifting along its whole path in.
      const vr = (r[0] ?? 0) * (v[0] ?? 0) + (r[1] ?? 0) * (v[1] ?? 0) + (r[2] ?? 0) * (v[2] ?? 0);
      expect(vr).toBeLessThan(0);
      continue;
    }
    // An independent reference: the two-body problem integrated by fourth-order Runge-Kutta with steps of a
    // thousandth of the distance over the speed, to that time and to just before it.
    const there = rk4(r, v, GM_EARTH, t);
    expect(Math.abs(Math.hypot(...there) / (R_EARTH + 1) - 1)).toBeLessThan(1e-5);
    const before = rk4(r, v, GM_EARTH, t * 0.999);
    expect(Math.hypot(...before)).toBeGreaterThan((R_EARTH + 1) * (1 - 1e-6));
    checked += 1;
  }
  expect(checked).toBeGreaterThan(100);
  // Leaving on a hyperbola, or passing wide: never.
  expect(timeToReach([50_000, 0, 0], [20, 0, 0], GM_EARTH, R_EARTH)).toBeNull();
  expect(timeToReach([50_000, 30_000, 0], [-20, 0, 0], GM_EARTH, R_EARTH)).toBeNull();
  expect(timeToReach([1000, 0, 0], [5, 0, 0], GM_EARTH, R_EARTH)).toBe(0);
  // A circular orbit outside reach never touches; an ellipse whose near point is inside does, after its far point.
  const vc = Math.sqrt(GM_EARTH / 40_000);
  expect(timeToReach([40_000, 0, 0], [0, vc, 0], GM_EARTH, R_EARTH)).toBeNull();
  const tEll = timeToReach([40_000, 0, 0], [0.1, 0.4 * vc, 0], GM_EARTH, R_EARTH);
  expect(tEll).not.toBeNull();
});

test('the scan sees an asteroid heading for the Earth days ahead, and a moon about to cross the Roche limit', () => {
  // A 20 km/s asteroid 3.5 days (6 million km) out: within four seconds at a day a second.
  const s = stateFrom([body('earth', GM_EARTH, R_EARTH, [0, 0, 0], [0, 0, 0]), body('rock', 1e-6, 1, [6.048e6, 0, 0], [-20, 0, 0])]);
  const a = nextApproach(s, 86_400 * 4);
  expect(a?.kind).toBe('impact');
  expect(a?.target).toBe('earth');
  expect(a?.body).toBe('rock');
  expect(a?.inS).toBeGreaterThan(3 * 86_400);
  expect(a?.inS).toBeLessThan(3.6 * 86_400);
  // The rate that shows it: an eighth of the time it takes to cross the Earth's radius at the contact speed.
  expect(a?.showRate).toBeCloseTo(R_EARTH / (a?.speedKmS ?? 1) / 8, 6);
  // Beyond the horizon: nothing yet.
  expect(nextApproach(s, 86_400)).toBeNull();
  // The Moon on an ellipse dipping inside the fluid limit (about 18,400 km) but clear of the Earth: a tidal disruption coming.
  const gmMoon = physical.gmKm3S2.Moon;
  const ra = 60_000;
  const rp = 12_000;
  const aAxis = (ra + rp) / 2;
  const vApo = Math.sqrt((GM_EARTH + gmMoon) * (2 / ra - 1 / aAxis));
  const m = stateFrom([body('earth', GM_EARTH, R_EARTH, [0, 0, 0], [0, 0, 0]), body('moon', gmMoon, 1737.4, [ra, 0, 0], [0, vApo, 0])]);
  const b = nextApproach(m, 10 * 86_400);
  expect(b?.kind).toBe('disrupt');
  expect(b?.body).toBe('moon');
  // Its time: the orbit's own time from its far point to the limit (half a period, less the bit from the limit to the near point).
  const out: number[] = [];
  keplerDrift([ra, 0, 0], [0, vApo, 0], 0, GM_EARTH + gmMoon, b?.inS ?? 0, out);
  expect(Math.abs(Math.hypot(out[0] ?? 0, out[1] ?? 0) / 18_400 - 1)).toBeLessThan(0.03);
});

/** The solar system at the explorer's test date, as the laboratory forks it. */
const solar = (): Scenario => {
  const shapes = {};
  return seedSolarSystem(createEphemeris(readJson('public/assets/jpl/planets.json') as PlanetsFile, readJson('public/assets/jpl/moon.json') as MoonFile, physical), physical, 2_461_336.75, {}, shapes);
};

test('a thrown rock: the speed and angle asked for at the actual contact (20 seeded throws at the Earth, the Moon and Mars), refused with a reason when it cannot be', () => {
  test.setTimeout(240_000);
  const e = new Engine(solar());
  const next = random(2026);
  const targets = ['earth', 'moon', 'mars'];
  let made = 0;
  for (let k = 0; k < 20; k += 1) {
    const target = targets[k % 3] ?? 'earth';
    const vInf = 2 + 28 * next();
    const angle = 15 + 75 * next();
    const lead = (1 + 29 * next()) * 86_400;
    const site: [number, number, number] = [next() - 0.5, next() - 0.5, next() - 0.5];
    const plan = planThrow(e.state, e.dt, e.scenario.integrator, e.keep, { id: `rock-${k}`, name: 'rock', target, gm: 1e-9, radiusKm: 0.5, vInfKmS: vInf, angleDeg: angle, leadS: lead, site, heading: [0, 0, 1] });
    if (plan.refused) {
      // Refused with its reason (one the panel says, with what to change), never silently.
      expect(Object.values(REFUSED)).toContain(plan.refused);
      continue;
    }
    const c = plan.contact;
    expect(c).not.toBeNull();
    if (!c || c.with !== target) continue;
    const ti = e.state.ids.indexOf(target);
    const mu = (e.state.gm[ti] ?? 0) + 1e-9;
    const want = Math.sqrt(vInf * vInf + (2 * mu) / ((e.state.radius[ti] ?? 0) + 0.5));
    expect(Math.abs(c.speedKmS / want - 1)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(c.angleDeg - angle)).toBeLessThanOrEqual(2);
    made += 1;
  }
  expect(made).toBeGreaterThanOrEqual(MADE_OF_20);
  // Refused: a target that does not exist, a throw that is not one.
  expect(planThrow(e.state, e.dt, e.scenario.integrator, e.keep, { id: 'x', name: 'x', target: 'nobody', gm: 0, radiusKm: 1, vInfKmS: 10, angleDeg: 45, leadS: 86_400, site: [1, 0, 0], heading: [0, 1, 0] }).refused).toBe(REFUSED.target);
  expect(planThrow(e.state, e.dt, e.scenario.integrator, e.keep, { id: 'x', name: 'x', target: 'earth', gm: 1e-9, radiusKm: 1, vInfKmS: 10, angleDeg: 45, leadS: 0, site: [1, 0, 0], heading: [0, 1, 0] }).refused).toBe(REFUSED.invalid);
});

test('a thrown rock’s outcome worked out ahead is the run’s, step for step: the same contact at the same step, speed and regime', () => {
  const e = new Engine(solar());
  for (let k = 0; k < 50; k += 1) e.stepOnce();
  const plan = planThrow(e.state, e.dt, e.scenario.integrator, e.keep, { id: 'rock-1', name: 'rock', target: 'earth', gm: 2.0e-5, radiusKm: 5, vInfKmS: 18, angleDeg: 50, leadS: 2 * 86_400, site: [0.3, 0.8, 0.5], heading: [1, 0, 0] });
  expect(plan.refused).toBeNull();
  expect(plan.step).toBe(e.state.step);
  // Given to the run at that step, as the laboratory gives it (Engine.applyAt).
  expect(e.applyAt({ kind: 'add', body: body('rock-1', 2.0e-5, 5, plan.pos, plan.vel) }, plan.step)).toBeNull();
  let hit: ContactEvent | undefined;
  for (let k = 0; k < 200_000 && !hit; k += 1) {
    e.stepOnce();
    hit = e.events.find((x) => x.absorbed === 'rock-1' || x.survivor === 'rock-1');
  }
  expect(hit).toBeDefined();
  expect((hit?.t ?? 0) - plan.t).toBe(plan.contact?.inS);
  expect(hit?.speedKmS).toBe(plan.contact?.speedKmS);
  expect(hit?.regime).toBe(plan.contact?.regime);
});

/** A throw request at a target: an impactor (GM, radius), speed far away, angle and lead time. */
const request = (id: string, target: string, gm: number, radiusKm: number, vInfKmS: number, angleDeg: number, leadS: number): ThrowRequest => ({ id, name: id, target, gm, radiusKm, vInfKmS, angleDeg, leadS, site: [0.3, 0.8, 0.5], heading: [1, 0, 0] });
/** Runs an engine on until `id` strikes something: the contact (its time from `t0`, what with, how fast, at what angle), or null. */
const strike = (e: Engine, id: string, t0: number, steps = 400_000): { with: string; inS: number; speedKmS: number; angleDeg: number } | null => {
  for (let k = 0; k < steps; k += 1) {
    e.stepOnce();
    const hit = e.events.find((x) => x.absorbed === id || x.survivor === id);
    if (hit) return { with: hit.survivor === id ? hit.absorbed : hit.survivor, inS: hit.t - t0, speedKmS: hit.speedKmS, angleDeg: (Math.acos(Math.min(1, Math.max(0, hit.b))) * 180) / Math.PI };
  }
  return null;
};

test('a throw worked out after an edit at the same step, thrown after the clock has run on: the run goes back to just after that edit, and the contact is exactly the one shown', () => {
  const e = new Engine(solar());
  for (let k = 0; k < 20; k += 1) e.stepOnce();
  // Paused here: an edit (a small body far away), then the throw worked out at this same step.
  const probe = body('probe', 1e-6, 1, [(e.state.pos[0] ?? 0) + 5e8, e.state.pos[1] ?? 0, 0], [0, 0, 0]);
  expect(e.applyAt({ kind: 'add', body: probe }, e.state.step)).toBeNull();
  const plan = planThrow(e.state, e.dt, e.scenario.integrator, e.keep, request('rock-1', 'earth', 2e-5, 5, 18, 50, 2 * 86_400));
  expect(plan.refused).toBeNull();
  expect(plan.step).toBe(e.state.step);
  // Played on 30 steps before Throw is pressed: made at the step it was worked out at, the edit kept.
  for (let k = 0; k < 30; k += 1) e.stepOnce();
  expect(e.applyAt({ kind: 'add', body: body('rock-1', 2e-5, 5, plan.pos, plan.vel) }, plan.step, true)).toBeNull();
  expect(e.state.ids).toContain('probe');
  expect(e.scenario.log.map((x) => x.step)).toEqual([plan.step, plan.step]);
  const hit = strike(e, 'rock-1', plan.t);
  expect(hit?.with).toBe(plan.contact?.with);
  expect(hit?.inS).toBe(plan.contact?.inS);
  expect(hit?.speedKmS).toBe(plan.contact?.speedKmS);
  expect(hit?.angleDeg).toBeCloseTo(plan.contact?.angleDeg ?? -1, 12);
});

test('a throw tied to its step is refused, with nothing changed, when an edit has been made after that step (the run cannot go back there with it)', () => {
  const e = new Engine(solar());
  for (let k = 0; k < 10; k += 1) e.stepOnce();
  const plan = planThrow(e.state, e.dt, e.scenario.integrator, e.keep, request('rock-1', 'earth', 2e-5, 5, 18, 50, 2 * 86_400));
  expect(plan.refused).toBeNull();
  for (let k = 0; k < 10; k += 1) e.stepOnce();
  expect(e.applyAt({ kind: 'add', body: body('probe', 1e-6, 1, [(e.state.pos[0] ?? 0) + 5e8, 0, 0], [0, 0, 0]) }, e.state.step)).toBeNull();
  const before = hash(e.state);
  const log = e.scenario.log.length;
  expect(e.applyAt({ kind: 'add', body: body('rock-1', 2e-5, 5, plan.pos, plan.vel) }, plan.step, true)).toBe(STALE);
  expect(hash(e.state)).toBe(before);
  expect(e.scenario.log.length).toBe(log);
  // Not tied to its step (any other edit), it is made where the run is.
  expect(e.applyAt({ kind: 'add', body: body('rock-2', 2e-5, 5, plan.pos, plan.vel) }, plan.step)).toBeNull();
});

test('heavy and long throws are aimed by correcting the start forwards (a Mars at the Earth ten and thirty days out, Ceres at the Moon), each contact the run’s own, step for step', () => {
  test.setTimeout(240_000);
  const e = new Engine(solar());
  const cases: Array<[string, number, number, number, number, number]> = [
    ['earth', physical.gmKm3S2.Mars, 3389.5, 20, 45, 10 * 86_400],
    ['earth', physical.gmKm3S2.Mars, 3389.5, 20, 45, 30 * 86_400],
    ['earth', physical.gmKm3S2.Mars, 3389.5, 11, 80, 30 * 86_400],
    ['moon', 62.6, 470, 20, 45, 10 * 86_400],
    ['moon', 62.6, 470, 11, 80, 30 * 86_400],
  ];
  for (const [target, gm, radiusKm, vInf, angle, lead] of cases) {
    const plan = planThrow(e.state, e.dt, e.scenario.integrator, e.keep, request('rock-h', target, gm, radiusKm, vInf, angle, lead));
    expect(plan.refused, `${target} ${gm} ${vInf} ${angle} ${lead}`).toBeNull();
    const ti = e.state.ids.indexOf(target);
    const want = Math.sqrt(vInf * vInf + (2 * ((e.state.gm[ti] ?? 0) + gm)) / ((e.state.radius[ti] ?? 0) + radiusKm));
    expect(plan.contact?.with).toBe(target);
    expect(Math.abs((plan.contact?.speedKmS ?? 0) / want - 1)).toBeLessThanOrEqual(0.02);
    expect(Math.abs((plan.contact?.angleDeg ?? 0) - angle)).toBeLessThanOrEqual(2);
    // The run given it at that step strikes exactly as shown.
    const run = new Engine(solar());
    expect(run.applyAt({ kind: 'add', body: body('rock-h', gm, radiusKm, plan.pos, plan.vel) }, 0, true)).toBeNull();
    const hit = strike(run, 'rock-h', plan.t);
    expect(hit?.inS).toBe(plan.contact?.inS);
    expect(hit?.speedKmS).toBe(plan.contact?.speedKmS);
  }
});

test('the planner sliced (as the worker runs it, a few milliseconds a tick) gives the same plan as run at once', () => {
  const e = new Engine(solar());
  const req = request('rock-s', 'moon', 62.6, 470, 5, 45, 10 * 86_400);
  const work = planner(e.state, e.dt, e.scenario.integrator, e.keep, req);
  let slices = 0;
  let r = work.next();
  while (!r.done) {
    slices += 1;
    r = work.next();
  }
  expect(slices).toBeGreaterThan(10);
  expect(r.value).toEqual(planThrow(e.state, e.dt, e.scenario.integrator, e.keep, req));
});

test('a stone the visitor throws (or adds) is drawn as rock by its density, not by its illustrative climate’s albedo; the worlds keep their measured albedos', () => {
  const e = new Engine(solar());
  // A stone a kilometre across at 3,000 kg/m^3 (GM: its mass times G, as the Earth's GM over its mass gives it).
  const stone = (4 / 3) * Math.PI * 500 ** 3 * 3000 * (GM_EARTH / 5.972e24);
  expect(e.applyAt({ kind: 'add', body: body('rock-1', stone, 0.5, [(e.state.pos[0] ?? 0) + 1e6, 0, 0], [0, 0, 0], { climate: airlessRock() }) }, e.state.step)).toBeNull();
  const s = e.state;
  const look = lookOf(s, s.ids.indexOf('rock-1'));
  expect(look.material).toBe('rock');
  expect(look.albedo).toBeCloseTo(0.12, 12);
  // A seeded world with a climate keeps its own measured albedo (the fact sheet's Bond albedo its climate reads).
  const world = { ...s, climate: { ...s.climate, moon: { spec: { ...airlessRock(), albedo: 0.11 }, t: [250] } } };
  expect(lookOf(world, world.ids.indexOf('moon')).albedo).toBeCloseTo(0.11, 12);
});

test('where bodies come from: a torn moon’s pieces and dust carry it and its look; a breakup’s pieces the event and a blend of both looks; all through save and load', () => {
  const gmMoon = physical.gmKm3S2.Moon;
  const r = 15_000;
  const v = Math.sqrt((GM_EARTH + gmMoon) / r);
  const s = stateFrom([body('earth', GM_EARTH, R_EARTH, [0, 0, 0], [0, 0, 0]), body('moon', gmMoon, 1737.4, [r, 0, 0], [0, v, 0])]);
  const events: ContactEvent[] = [];
  step(s, 60, [], events);
  const torn = events[0];
  expect(torn?.kind).toBe('disrupt');
  for (const id of torn?.created ?? []) {
    expect(s.rubble).toContain(id);
    expect(s.origins[id]?.parent).toBe('moon');
    expect(s.origins[id]?.kind).toBe('piece');
    expect(s.origins[id]?.event).toBe(eventKey({ step: torn?.step ?? 0, absorbed: 'moon', kind: 'disrupt' }));
    // Rock by its density (Carry 2012), its look the Moon's.
    expect(s.origins[id]?.look.material).toBe('rock');
    expect(s.origins[id]?.look.albedo).toBeCloseTo(0.12, 12);
  }
  const dust = swarmPlaces(s)[0];
  expect(dust?.kind).toBe('dust');
  expect(dust?.source).toBe('moon');
  expect(dust?.look.albedo).toBeCloseTo(0.12, 12);
  // A breakup in the engine: a Mars at erosion speed into an icy body and a rocky one.
  const mars = { gm: physical.gmKm3S2.Mars, r: 3389.5 };
  const sc = scenario([body('target', GM_EARTH, R_EARTH, [0, 0, 0], [0, 0, 0]), body('impactor', mars.gm, mars.r, [R_EARTH + mars.r + 2000, 3000, 0], [-25, 0, 0])]);
  const e = new Engine(sc);
  for (let k = 0; k < 2000 && !e.events.some((x) => x.kind === 'fragment'); k += 1) e.stepOnce();
  const ev = e.events.find((x) => x.kind === 'fragment');
  expect(ev).toBeDefined();
  const key = eventKey(ev ?? { step: 0, absorbed: '', kind: '' });
  for (const id of ev?.created ?? []) {
    expect(e.state.origins[id]?.event).toBe(key);
    expect(e.state.origins[id]?.parent).toBe('target');
  }
  // Save and load: the replay gives the same origins.
  const replay = new Engine(validateScenario(JSON.parse(JSON.stringify(e.toScenario()))).ok ? (JSON.parse(JSON.stringify(e.toScenario())) as Scenario) : sc);
  while (replay.state.step < e.state.step) replay.stepOnce();
  expect(replay.state.origins).toEqual(e.state.origins);
});

test('one check for every edit: a file’s and a live edit judged alike; past the mass limit refused (the tenth doubling of the Sun), with nothing changed', () => {
  const e = new Engine(solar());
  for (let k = 0; k < 9; k += 1) {
    const sun = e.state.ids.indexOf('sun');
    expect(e.apply({ kind: 'setMass', id: 'sun', gm: 2 * (e.state.gm[sun] ?? 0) })).toBeNull();
  }
  const before = hash(e.state);
  const undoable = e.undoable;
  const sun = e.state.ids.indexOf('sun');
  // 1.327e11 x 2^10 = 1.36e14 km^3 s^-2: beyond what a save may hold, so refused, and nothing changed.
  expect(e.apply({ kind: 'setMass', id: 'sun', gm: 2 * (e.state.gm[sun] ?? 0) })).toBe('mass out of range');
  expect(hash(e.state)).toBe(before);
  expect(e.undoable).toBe(undoable);
  // The save restores.
  expect(validateScenario(JSON.parse(JSON.stringify(e.toScenario()))).ok).toBe(true);
  // A held body's velocity, the scene's light removed, a body that is not there: refused live, with why.
  expect(e.apply({ kind: 'setFixed', id: 'mars', fixed: true })).toBeNull();
  expect(e.apply({ kind: 'setVelocity', id: 'mars', vel: [1, 2, 3] })).toMatch(/held/);
  expect(e.apply({ kind: 'remove', id: 'sun' })).toMatch(/kept/);
  expect(e.apply({ kind: 'rename', id: 'ghost', name: 'x' })).toMatch(/does not exist/);
  expect(e.apply({ kind: 'setAtmosphere', id: 'jupiter', tau: 1 })).toMatch(/no climate/);
  // A file may name a torn moon's pieces before they exist (they are made on the way); live they must exist.
  const known = { bodies: new Set(['earth', 'moon']), swarms: new Set<string>() };
  expect(checkCommand({ kind: 'setMass', id: 'moon-piece-3', gm: 1 }, known)).toBeNull();
  expect(checkCommand({ kind: 'setMass', id: 'moon-piece-3', gm: 1 }, known, IMPORT_LIMITS, true)).toMatch(/does not exist/);
  expect(checkCommand({ kind: 'setAtmosphere', id: 'earth', tau: 2 }, known)).toBeNull();
  expect(checkCommand({ kind: 'setAtmosphere', id: 'earth' }, known)).toMatch(/atmosphere/);
  // A saved experiment with an atmosphere edit restores (it used to be refused as "unknown edit").
  const sc = solar();
  sc.log.push({ step: 0, command: { kind: 'setAtmosphere', id: 'earth', forcing: 3.9 } });
  expect(validateScenario(JSON.parse(JSON.stringify(sc))).ok).toBe(true);
});

test('a deterministic fuzz of ten thousand edits (two-body, three-body and torn moons): every refusal changes nothing, file and live checks agree, and every save restores and replays to the same state', () => {
  test.setTimeout(240_000);
  const next = random(31_337);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const weird = [Number.NaN, Number.POSITIVE_INFINITY, -Number.POSITIVE_INFINITY, 1e300, -1, 0, 1e-12, 3.5];
  const num = (good: number): number => (next() < 0.3 ? pick(weird) : good * (0.5 + next()));
  const vec = (good: number): [number, number, number] => [num(good), num(good), num(good)];
  const gmMoon = physical.gmKm3S2.Moon;
  const seeds: Array<() => Scenario> = [
    () => scenario([body('star', physical.gmKm3S2.Sun, 695_700, [0, 0, 0], [0, 0, 0], { luminosityW: 3.828e26 }), body('planet', GM_EARTH, R_EARTH, [1.496e8, 0, 0], [0, 29.78, 0])]),
    () => scenario([body('star', physical.gmKm3S2.Sun, 695_700, [0, 0, 0], [0, 0, 0]), body('planet', GM_EARTH, R_EARTH, [1.496e8, 0, 0], [0, 29.78, 0]), body('giant', physical.gmKm3S2.Jupiter, 69_911, [7.78e8, 0, 0], [0, 13.07, 0])]),
    () => scenario([body('earth', GM_EARTH, R_EARTH, [0, 0, 0], [0, 0, 0]), body('moon', gmMoon, 1737.4, [15_000, 0, 0], [0, Math.sqrt((GM_EARTH + gmMoon) / 15_000), 0])]),
  ];
  let accepted = 0;
  let refused = 0;
  const kinds: Command['kind'][] = ['setMass', 'setVelocity', 'setState', 'setRadius', 'setSpin', 'setFixed', 'rename', 'add', 'remove', 'addSwarm', 'removeSwarm', 'setAtmosphere', 'burn', 'cancelBurns', 'addRing'];
  for (let round = 0; round < 3; round += 1) {
    const seed = seeds[round] ?? seeds[0];
    if (!seed) throw new Error('no seed');
    const e = new Engine(seed());
    for (let k = 0; k < 3334; k += 1) {
      // A step now and then, so collisions and torn pieces make new ids.
      if (next() < 0.2) for (let j = 0; j < 5; j += 1) e.stepOnce();
      const ids = [...e.state.ids, 'ghost', `debris-${e.state.step}-1`, 'moon-piece-2'];
      const id = pick(ids);
      const kind = pick(kinds);
      const c = (
        kind === 'setMass' ? { kind, id, gm: num(1e5) }
        : kind === 'setVelocity' ? { kind, id, vel: vec(10) }
        : kind === 'setState' ? { kind, id, pos: vec(1e6), vel: vec(10) }
        : kind === 'setRadius' ? { kind, id, radiusKm: num(1000) }
        : kind === 'setSpin' ? { kind, id, periodS: num(86_400), pole: vec(1) }
        : kind === 'setFixed' ? { kind, id, fixed: next() < 0.5 }
        : kind === 'rename' ? { kind, id, name: next() < 0.2 ? '' : 'name' }
        : kind === 'add' ? { kind, body: body(next() < 0.2 ? id : `fuzz-${k}`, num(1), num(100), vec(1e7), vec(10)) }
        : kind === 'remove' ? { kind, id }
        : kind === 'addSwarm' ? { kind, swarm: { id: `swarm-${k}`, name: 'ring', primary: id, count: Math.round(num(50)), innerKm: num(2e4), outerKm: num(4e4), eccentricity: 0, inclinationDeg: 0, normal: [0, 0, 1], seed: k } }
        : kind === 'removeSwarm' ? { kind, id: next() < 0.5 ? (e.state.swarms[0]?.id ?? 'none') : 'none' }
        : kind === 'setAtmosphere' ? { kind, id, tau: num(1) }
        : kind === 'burn' ? { kind, id, burn: { startT: 0, durationS: num(10), direction: 'prograde', ref: id, throttle: 1 } }
        : kind === 'cancelBurns' ? { kind, id }
        : { kind, ring: { id: `ring-${k}`, name: 'ring', primary: id, count: 3, innerKm: num(3e4), outerKm: num(5e4), gm: num(1), radiusKm: num(10), normal: [0, 0, 1], seed: k } }
      ) as Command;
      const before = hash(e.state);
      const undoable = e.undoable;
      const reason = e.apply(c);
      if (reason) {
        refused += 1;
        expect(hash(e.state)).toBe(before);
        expect(e.undoable).toBe(undoable);
      } else accepted += 1;
      // The file check and the live one agree on the command's shape and limits (live adds only presence).
      const file = checkCommand(c, { bodies: new Set([...e.state.ids, id]), swarms: new Set([...e.state.swarms.map((w) => w.id), 'none']) });
      if (file === null && reason !== null) expect(reason).toMatch(/does not exist|already exists|held|kept|no room|no climate|ship/);
    }
    // Every save restores and replays to the run's own state, bit for bit.
    const saved = JSON.parse(JSON.stringify(e.toScenario())) as unknown;
    const checked = validateScenario(saved);
    expect(checked.ok, checked.ok ? '' : checked.errors.join('; ')).toBe(true);
    if (!checked.ok) continue;
    const replay = new Engine(checked.scenario);
    // A step on, so edits made at this very step are in both (a replay applies them as it steps on).
    e.stepOnce();
    while (replay.state.step < e.state.step && !replay.failure) replay.stepOnce();
    if (!e.failure) expect(hash(replay.state)).toBe(hash(e.state));
  }
  expect(accepted).toBeGreaterThan(500);
  expect(refused).toBeGreaterThan(2000);
});
