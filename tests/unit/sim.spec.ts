/**
 * The orbital laboratory's numerical core (src/sim): acceptance tests of behaviour, each against a
 * physical scale or an independent reference, not a copy of the implementation's formulas.
 *
 * References: the two-body problem's exact (Keplerian) solution, solved here from Kepler's equation;
 * and a separately written fourth-order Runge-Kutta integrator at a far smaller step for an encounter.
 * GM values from public/assets/jpl/physical.json (DE440).
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { PhysicalFile } from '../../src/astro/physical';
import { createEphemeris, type MoonFile, type PlanetsFile } from '../../src/astro/ephemeris';
import { DEFAULT_INTEGRATOR, Engine, ENGINE_VERSION, SCHEMA_VERSION, stateFrom, validateScenario, type BodySpec, type Scenario } from '../../src/sim/engine';
import { accelerations, circularOrbit, diagnostics, drift, energy, indexOf, resolveContacts, step, type MergeEvent, type SimState } from '../../src/sim/nbody';
import { seedEpoch, seedLaboratory, seedSolarSystem } from '../../src/sim/seed';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const physical = readJson('public/assets/jpl/physical.json') as PhysicalFile;
const GM_SUN = physical.gmKm3S2.Sun;
const GM_EARTH = physical.gmKm3S2.Earth;
const AU = physical.auKm;

const body = (id: string, gm: number, radiusKm: number, pos: [number, number, number], vel: [number, number, number]): BodySpec => ({ id, name: id, gm, radiusKm, pos, vel, origin: 'user-edited', sourceIds: [] });

/** A star and a planet on a circular orbit of radius r about their barycentre (at rest). */
function circularPair(r: number, e = 0): { state: SimState; period: number; a: number } {
  const mu = GM_SUN + GM_EARTH;
  // Start at periapsis of an orbit of eccentricity e (e = 0: circular): speed from the vis-viva equation.
  const a = r / (1 - e);
  const v = Math.sqrt(mu * (2 / r - 1 / a));
  const fs = GM_EARTH / mu;
  const fp = GM_SUN / mu;
  const state = stateFrom([body('star', GM_SUN, 1, [-r * fs, 0, 0], [0, -v * fs, 0]), body('planet', GM_EARTH, 1, [r * fp, 0, 0], [0, v * fp, 0])]);
  return { state, period: 2 * Math.PI * Math.sqrt((a * a * a) / mu), a };
}

function run(state: SimState, dt: number, steps: number, each?: (s: SimState) => void): MergeEvent[] {
  const acc: number[] = [];
  const events: MergeEvent[] = [];
  for (let k = 0; k < steps; k += 1) {
    step(state, dt, acc, events);
    each?.(state);
  }
  return events;
}

const sep = (s: SimState, a = 0, b = 1): number => Math.hypot((s.pos[b * 3] ?? 0) - (s.pos[a * 3] ?? 0), (s.pos[b * 3 + 1] ?? 0) - (s.pos[a * 3 + 1] ?? 0), (s.pos[b * 3 + 2] ?? 0) - (s.pos[a * 3 + 2] ?? 0));

/** The largest relative energy error over a run of `periods` at period/perPeriod (orbit eccentricity e). */
function maxEnergyError(perPeriod: number, periods: number, e: number): number {
  const { state, period } = circularPair(AU, e);
  const e0 = energy(state);
  let worst = 0;
  run(state, period / perPeriod, perPeriod * periods, (s) => {
    worst = Math.max(worst, Math.abs((energy(s) - e0) / e0));
  });
  return worst;
}

test('a circular orbit: 100 periods at P/512 keep energy within 1e-4, momentum, angular momentum, the radius and the period', () => {
  const { state, period } = circularPair(AU);
  const ref = diagnostics(state);
  const e0 = ref.energy;
  let worst = 0;
  let rMin = Infinity;
  let rMax = 0;
  run(state, period / 512, 512 * 100, (s) => {
    worst = Math.max(worst, Math.abs((energy(s) - e0) / e0));
    const r = sep(s);
    rMin = Math.min(rMin, r);
    rMax = Math.max(rMax, r);
  });
  expect(worst).toBeLessThan(1e-4);
  const d = drift(ref, diagnostics(state));
  expect(d.momentum).toBeLessThan(1e-12);
  expect(d.angularMomentum).toBeLessThan(1e-10);
  expect((rMax - rMin) / AU).toBeLessThan(1e-4);
  // After a hundred analytic periods the planet is back at its start but for the leapfrog's phase lag:
  // the period, measured from that lag, matches the exact one to better than 1e-4.
  const phase = Math.atan2((state.pos[4] ?? 0) - (state.pos[1] ?? 0), (state.pos[3] ?? 0) - (state.pos[0] ?? 0));
  expect(Math.abs(phase) / (2 * Math.PI * 100)).toBeLessThan(1e-4);
});

test('convergence: halving the step quarters the energy error on an eccentric orbit (second order)', () => {
  const coarse = maxEnergyError(512, 4, 0.5);
  const fine = maxEnergyError(1024, 4, 0.5);
  expect(coarse / fine).toBeGreaterThan(3.5);
  expect(coarse / fine).toBeLessThan(4.5);
  // On a circular orbit the second-order term cancels (the error falls faster still).
  expect(maxEnergyError(128, 10, 0) / maxEnergyError(256, 10, 0)).toBeGreaterThan(3.5);
});

test('an eccentric orbit (e = 0.6) follows the exact Kepler solution', () => {
  const e = 0.6;
  const { state, period, a } = circularPair(0.4 * AU, e);
  const mu = GM_SUN + GM_EARTH;
  const steps = 20_000;
  const dt = period / steps;
  // The exact relative position at mean anomaly M (Kepler's equation by Newton's method).
  const exact = (t: number): [number, number] => {
    const M = (2 * Math.PI * t) / period;
    let E = M;
    for (let k = 0; k < 50; k += 1) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    return [a * (Math.cos(E) - e), a * Math.sqrt(1 - e * e) * Math.sin(E)];
  };
  let worst = 0;
  let k = 0;
  run(state, dt, steps, (s) => {
    k += 1;
    if (k % 500 !== 0) return;
    const [x, y] = exact(k * dt);
    const rx = (s.pos[3] ?? 0) - (s.pos[0] ?? 0);
    const ry = (s.pos[4] ?? 0) - (s.pos[1] ?? 0);
    worst = Math.max(worst, Math.hypot(rx - x, ry - y) / a);
  });
  expect(Math.sqrt(mu) > 0).toBe(true);
  expect(worst).toBeLessThan(2e-4);
});

test('a close encounter matches an independent fourth-order Runge-Kutta reference', () => {
  // A second star flying past a star and its close planet (0.12 au): aimed 0.4 au wide, it passes the
  // pair at about 0.38 au and pulls the planet's orbit, with the engine's own (encounter-retimed) steps.
  const bodies = [
    body('a', GM_SUN, 7e5, [0, 0, 0], [0, 0, 0]),
    body('b', GM_SUN, 7e5, [2 * AU, 0.4 * AU, 0], [-30, 0, 0]),
    body('p', GM_EARTH, 6371, [0.12 * AU, 0, 0], [0, Math.sqrt(GM_SUN / (0.12 * AU)), 0]),
  ];
  const scenario: Scenario = { schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, name: 't', epochJdTdb: 2451545, frame: 'test', seedNote: '', integrator: { ...DEFAULT_INTEGRATOR, eta: 0.002, dtMaxS: 3600 }, bodies, log: [] };
  const engine = new Engine(scenario);
  const horizon = 120 * 86_400;
  engine.advanceTo(horizon, 10_000_000);
  expect(engine.events).toEqual([]);
  // RK4 on the same equations, written separately, at 30 s.
  const n = 3;
  const gm = bodies.map((b) => b.gm);
  let y = bodies.flatMap((b) => [...b.pos, ...b.vel]);
  const f = (z: number[]): number[] => {
    const d = new Array<number>(z.length).fill(0);
    for (let i = 0; i < n; i += 1) {
      d[i * 6] = z[i * 6 + 3] ?? 0;
      d[i * 6 + 1] = z[i * 6 + 4] ?? 0;
      d[i * 6 + 2] = z[i * 6 + 5] ?? 0;
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        const dx = (z[j * 6] ?? 0) - (z[i * 6] ?? 0);
        const dy = (z[j * 6 + 1] ?? 0) - (z[i * 6 + 1] ?? 0);
        const dz = (z[j * 6 + 2] ?? 0) - (z[i * 6 + 2] ?? 0);
        const r3 = Math.hypot(dx, dy, dz) ** 3;
        d[i * 6 + 3] = (d[i * 6 + 3] ?? 0) + ((gm[j] ?? 0) * dx) / r3;
        d[i * 6 + 4] = (d[i * 6 + 4] ?? 0) + ((gm[j] ?? 0) * dy) / r3;
        d[i * 6 + 5] = (d[i * 6 + 5] ?? 0) + ((gm[j] ?? 0) * dz) / r3;
      }
    }
    return d;
  };
  const h = 30;
  const t = engine.state.t;
  for (let s = 0; s < Math.round(t / h); s += 1) {
    const k1 = f(y);
    const k2 = f(y.map((v, i) => v + (h / 2) * (k1[i] ?? 0)));
    const k3 = f(y.map((v, i) => v + (h / 2) * (k2[i] ?? 0)));
    const k4 = f(y.map((v, i) => v + h * (k3[i] ?? 0)));
    y = y.map((v, i) => v + (h / 6) * ((k1[i] ?? 0) + 2 * (k2[i] ?? 0) + 2 * (k3[i] ?? 0) + (k4[i] ?? 0)));
  }
  const p = indexOf(engine.state, 'p');
  const err = Math.hypot((engine.state.pos[p * 3] ?? 0) - (y[12] ?? 0), (engine.state.pos[p * 3 + 1] ?? 0) - (y[13] ?? 0));
  expect(err / AU).toBeLessThan(1e-3);
});

test('moving the whole system, or giving it all one velocity, changes nothing relative', () => {
  const a = circularPair(AU).state;
  const b = circularPair(AU).state;
  const shift = [1e6, -2e6, 3e5];
  const boost = [10, -5, 3];
  for (let i = 0; i < 2; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      b.pos[i * 3 + k] = (b.pos[i * 3 + k] ?? 0) + (shift[k] ?? 0);
      b.vel[i * 3 + k] = (b.vel[i * 3 + k] ?? 0) + (boost[k] ?? 0);
    }
  }
  const dt = 3600;
  run(a, dt, 2000);
  run(b, dt, 2000);
  const relA = [0, 1, 2].map((k) => (a.pos[3 + k] ?? 0) - (a.pos[k] ?? 0));
  const relB = [0, 1, 2].map((k) => (b.pos[3 + k] ?? 0) - (b.pos[k] ?? 0));
  expect(Math.hypot(...relA.map((v, k) => v - (relB[k] ?? 0))) / AU).toBeLessThan(1e-9);
});

test('a test particle feels gravity and pulls nothing', () => {
  const with_ = circularPair(AU).state;
  const without = circularPair(AU).state;
  stateAdd(with_, body('dust', 0, 1, [0, 1.2 * AU, 0], [-25, 0, 0]));
  run(with_, 3600, 5000);
  run(without, 3600, 5000);
  for (let k = 0; k < 6; k += 1) expect(with_.pos[k]).toBe(without.pos[k]);
  expect(Math.hypot((with_.vel[6] ?? 0) + 25, with_.vel[7] ?? 0)).toBeGreaterThan(0.01);
});

function stateAdd(s: SimState, b: BodySpec): void {
  s.ids.push(b.id);
  s.names.push(b.name);
  s.gm.push(b.gm);
  s.radius.push(b.radiusKm);
  s.pos.push(...b.pos);
  s.vel.push(...b.vel);
  s.spin.push(0, 0, 0);
}

test('a satellite placed on a circular orbit inherits its primary’s motion and keeps its distance', () => {
  const { state } = circularPair(AU);
  const r = 400_000;
  const gmMoon = physical.gmKm3S2.Moon;
  const placed = circularOrbit(state, 1, r, gmMoon, [0, 0, 1], [1, 0, 0]);
  const rel = [0, 1, 2].map((k) => (placed.vel[k] ?? 0) - (state.vel[3 + k] ?? 0));
  expect(Math.hypot(...rel)).toBeCloseTo(Math.sqrt((GM_EARTH + gmMoon) / r), 9);
  stateAdd(state, body('moon2', gmMoon, 1737, placed.pos as [number, number, number], placed.vel as [number, number, number]));
  let worst = 0;
  run(state, 600, 1000, (s) => {
    worst = Math.max(worst, Math.abs(sep(s, 1, 2) - r) / r);
  });
  expect(worst).toBeLessThan(0.02);
});

test('a mass edit changes the orbits, and is recorded as an intervention, not drift', () => {
  const lab = seedLaboratory(physical, false);
  const control = new Engine(structuredClone(lab));
  const edited = new Engine(structuredClone(lab));
  edited.apply({ kind: 'setMass', id: 'star', gm: 2 * GM_SUN });
  const half = 0.5 * 365.25 * 86_400;
  control.advanceTo(half, 1_000_000);
  edited.advanceTo(half, 1_000_000);
  const rc = sep(control.state);
  const re = sep(edited.state);
  expect(Math.abs(re - rc) / rc).toBeGreaterThan(0.1);
  expect(edited.interventions.length).toBe(1);
  expect(edited.interventions[0]?.after.gm).toBeGreaterThan(edited.interventions[0]?.before.gm ?? Infinity);
  expect(edited.drift().energy).toBeLessThan(1e-3);
});

test('a merger conserves mass, momentum and angular momentum, and accounts the energy turned to heat', () => {
  // A body about to strike the Earth (it would touch within the next 10 s step), off-centre so the pair has angular momentum.
  const s = stateFrom([body('a', GM_EARTH, 6371, [0, 0, 0], [0, 0, 0]), body('b', physical.gmKm3S2.Moon, 1737, [8_150, 500, 0], [-8, 0.5, 0.2])]);
  const acc: number[] = [];
  accelerations(s, acc);
  const ref = diagnostics(s);
  const events: MergeEvent[] = [];
  expect(resolveContacts(s, 10, acc, events)).toBe(true);
  expect(events.map((e) => [e.survivor, e.absorbed])).toEqual([['a', 'b']]);
  expect(s.ids).toEqual(['a']);
  const now = diagnostics(s);
  expect(now.gm).toBe(ref.gm);
  const d = drift(ref, now);
  expect(d.momentum).toBeLessThan(1e-12);
  expect(d.angularMomentum).toBeLessThan(1e-12);
  expect(d.energy).toBeLessThan(1e-12);
  expect(events[0]?.heat).toBeGreaterThan(0);
  // The spin it took up is the pair's orbital angular momentum: none of the total is lost.
  expect(Math.hypot(s.spin[0] ?? 0, s.spin[1] ?? 0, s.spin[2] ?? 0)).toBeGreaterThan(0);
  // A whole run into the merger keeps the closed model's energy (with the heat) to the integration's accuracy.
  const t = stateFrom([body('a', GM_EARTH, 6371, [0, 0, 0], [0, 0, 0]), body('b', physical.gmKm3S2.Moon, 1737, [30_000, 5_000, 0], [-8, 0.5, 0.2])]);
  const start = diagnostics(t);
  expect(run(t, 5, 4000).length).toBe(1);
  expect(drift(start, diagnostics(t)).energy).toBeLessThan(1e-4);
});

test('a fast impactor cannot pass through its target between steps', () => {
  // 1,000 km/s at steps of 100 s: 100,000 km a step, over eight times the target's diameter.
  const s = stateFrom([body('target', GM_EARTH, 6371, [0, 0, 0], [0, 0, 0]), body('impactor', 1, 10, [-500_000, 1_000, 0], [1000, 0, 0])]);
  const events = run(s, 100, 20);
  expect(events.map((e) => e.absorbed)).toEqual(['impactor']);
});

test('the same scenario and edits replay to exactly the same state, through save and load', () => {
  const lab = seedLaboratory(physical, true);
  const a = new Engine(structuredClone(lab));
  a.advanceTo(30 * 86_400, 1_000_000);
  a.apply({ kind: 'setMass', id: 'giant', gm: 3 * physical.gmKm3S2.Jupiter });
  a.advanceTo(60 * 86_400, 1_000_000);
  const moon = circularOrbit(a.state, indexOf(a.state, 'planet'), 600_000, 1, [0, 0, 1], [0, 1, 0]);
  a.apply({ kind: 'add', body: body('moonlet', 1, 100, moon.pos as [number, number, number], moon.vel as [number, number, number]) });
  a.advanceTo(200 * 86_400, 1_000_000);
  const saved = JSON.parse(JSON.stringify(a.toScenario())) as unknown;
  const checked = validateScenario(saved);
  expect(checked.ok).toBe(true);
  if (!checked.ok) return;
  const b = new Engine(checked.scenario);
  while (b.state.step < a.state.step) b.stepOnce();
  expect(b.state.ids).toEqual(a.state.ids);
  expect(b.state.pos).toEqual(a.state.pos);
  expect(b.state.vel).toEqual(a.state.vel);
  // Going back to a checkpoint and on again reaches the same place too.
  const at = a.state.step;
  const pos = [...a.state.pos];
  a.seek(Math.floor(at / 2));
  while (a.state.step < at) a.stepOnce();
  expect(a.state.pos).toEqual(pos);
});

test('an edit made after going back starts a new branch, discarding the later edits', () => {
  const e = new Engine(seedLaboratory(physical, true));
  e.advanceTo(10 * 86_400, 1_000_000);
  e.apply({ kind: 'setMass', id: 'giant', gm: 2 * physical.gmKm3S2.Jupiter });
  e.advanceTo(20 * 86_400, 1_000_000);
  e.apply({ kind: 'remove', id: 'giant' });
  e.seek(5);
  e.apply({ kind: 'setVelocity', id: 'planet', vel: [0, 20, 0] });
  expect(e.discarded).toBe(2);
  expect(e.toScenario().log.map((l) => l.command.kind)).toEqual(['setVelocity']);
});

test('imports that are not valid scenarios are refused, quickly, with reasons', () => {
  const good = seedLaboratory(physical, false);
  expect(validateScenario(JSON.parse(JSON.stringify(good)) as unknown).ok).toBe(true);
  const bad = (mutate: (s: Record<string, unknown>) => void): string[] => {
    const s = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    mutate(s);
    const r = validateScenario(s);
    return r.ok ? [] : r.errors;
  };
  expect(bad((s) => (s.schemaVersion = 99))[0]).toMatch(/schema version/);
  expect(bad((s) => ((s.bodies as BodySpec[])[0]!.gm = Number.NaN))).not.toEqual([]);
  expect(bad((s) => ((s.bodies as BodySpec[])[1]!.id = 'star'))).toContainEqual(expect.stringMatching(/duplicate id/));
  expect(bad((s) => (s.log = [{ step: 0, command: { kind: 'remove', id: 'nobody' } }]))).toContainEqual(expect.stringMatching(/does not exist/));
  const started = performance.now();
  expect(bad((s) => (s.bodies = Array.from({ length: 100_000 }, (_, i) => ({ ...(s.bodies as BodySpec[])[0], id: `b${i}` }))))).toContainEqual(expect.stringMatching(/at most 64/));
  expect(performance.now() - started).toBeLessThan(500);
  expect(validateScenario('<script>').ok).toBe(false);
});

test('the solar system seed: ten bodies at the barycentre, at rest, the epoch inside the data', () => {
  const planets = readJson('public/assets/jpl/planets.json') as PlanetsFile;
  const moon = readJson('public/assets/jpl/moon.json') as MoonFile;
  const eph = createEphemeris(planets, moon, physical);
  const late = seedEpoch(eph, 9e9);
  expect(late).toBeLessThan(eph.validRange().moon.endJd);
  const s = seedSolarSystem(eph, physical, 2461336.75);
  expect(s.bodies.map((b) => b.id)).toEqual(['sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);
  const d = diagnostics(stateFrom(s.bodies));
  expect(Math.hypot(...d.momentum) / d.momentumScale).toBeLessThan(1e-12);
  // The Moon about 384,000 km from the Earth, moving about 1 km/s relative to it.
  const e = s.bodies.find((b) => b.id === 'earth')!;
  const m = s.bodies.find((b) => b.id === 'moon')!;
  const r = Math.hypot(m.pos[0] - e.pos[0], m.pos[1] - e.pos[1], m.pos[2] - e.pos[2]);
  const v = Math.hypot(m.vel[0] - e.vel[0], m.vel[1] - e.vel[1], m.vel[2] - e.vel[2]);
  expect(r).toBeGreaterThan(356_000);
  expect(r).toBeLessThan(407_000);
  expect(v).toBeGreaterThan(0.95);
  expect(v).toBeLessThan(1.1);
  // A year of the whole system integrated stays bound and well-behaved.
  const engine = new Engine(s);
  engine.advanceTo(365.25 * 86_400, 10_000_000);
  expect(engine.failure).toBeNull();
  expect(engine.state.ids.length).toBe(10);
  expect(engine.drift().energy).toBeLessThan(1e-5);
});

test('a prediction integrates a copy ahead (the live state untouched), closing a circular orbit, stopping at a merger', () => {
  const e = new Engine(seedLaboratory(physical, false));
  const before = [...e.state.pos];
  const year = 2 * Math.PI * Math.sqrt(AU ** 3 / (GM_SUN + GM_EARTH));
  const p = e.predict('planet', year, 360, 1_000_000);
  expect(e.state.pos).toEqual(before);
  expect(p.path.length).toBe(360 * 3);
  expect(p.merged).toBeNull();
  const i = indexOf(e.state, 'planet');
  const end = p.path.slice(-3);
  expect(Math.hypot((end[0] ?? 0) - (before[i * 3] ?? 0), (end[1] ?? 0) - (before[i * 3 + 1] ?? 0)) / AU).toBeLessThan(0.02);
  // Aimed at the star, the path ends where it strikes it.
  e.apply({ kind: 'setVelocity', id: 'planet', vel: [-29.8, 0, 0] });
  const hit = e.predict('planet', year, 360, 1_000_000);
  expect(hit.merged?.with).toBe('star');
  expect(hit.path.length).toBeLessThan(360 * 3);
});
