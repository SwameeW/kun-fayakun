/**
 * Rings and belts of test particles (src/sim/swarms, ledger IM-6): they pull nothing (the bodies run
 * the same, bit for bit, with a ring or without); a ring about the Earth, whose particles turn in a
 * few hours, stays a ring under the hour-long steps the Earth and Moon set; a particle perturbed by
 * Jupiter follows an independent fine-step integration; a scenario with a belt replays exactly
 * through save and load; a ring whose planet merges into another goes on about the survivor without
 * a jump; particles that strike a body are counted; impossible rings are refused.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { PhysicalFile } from '../../src/astro/physical';
import { DEFAULT_INTEGRATOR, Engine, ENGINE_VERSION, SCHEMA_VERSION, stateFrom, validateScenario, type BodySpec, type Scenario } from '../../src/sim/engine';
import { cloneState, step, type ContactEvent, type SimState } from '../../src/sim/nbody';
import { makeSwarm, SWARM_LIMITS, type SwarmSpec } from '../../src/sim/swarms';

const physical = JSON.parse(readFileSync(new URL('../../public/assets/jpl/physical.json', import.meta.url), 'utf8')) as PhysicalFile;
const mean = (r: readonly number[]): number => r.reduce((a, b) => a + b, 0) / r.length;
const AU = physical.auKm;
const SUN = { gm: physical.gmKm3S2.Sun, radiusKm: mean(physical.bodies.Sun.radiiKm) };
const EARTH = { gm: physical.gmKm3S2.Earth, radiusKm: mean(physical.bodies.Earth.radiiKm) };
const MOON = { gm: physical.gmKm3S2.Moon, radiusKm: mean(physical.bodies.Moon.radiiKm) };
const JUPITER = { gm: physical.gmKm3S2.Jupiter, radiusKm: mean(physical.bodies.Jupiter.radiiKm) };
const spec = (id: string, b: { gm: number; radiusKm: number }, pos: [number, number, number], vel: [number, number, number], extra: Partial<BodySpec> = {}): BodySpec => ({ id, name: id, gm: b.gm, radiusKm: b.radiusKm, pos, vel, origin: 'user-edited', sourceIds: [], ...extra });
const circular = (gm: number, r: number): number => Math.sqrt(gm / r);

/** The Sun, the Earth (turning, oblate) and the Moon. */
const earthMoon = (): BodySpec[] => {
  const v = circular(SUN.gm, AU);
  return [
    spec('sun', SUN, [0, 0, 0], [0, 0, 0]),
    spec('earth', EARTH, [AU, 0, 0], [0, v, 0], { spin: { periodS: 86_164, pole: [0, -0.3978, 0.9175] }, j2: 1.08263e-3, inertia: 0.3308 }),
    spec('moon', MOON, [AU + 384_400, 0, 0], [0, v + circular(EARTH.gm + MOON.gm, 384_400), 0]),
  ];
};
const ringSpec = (extra: Partial<SwarmSpec> = {}): SwarmSpec => ({ id: 'ring', name: 'Ring', primary: 'earth', count: 300, innerKm: 1.5 * EARTH.radiusKm, outerKm: 2.5 * EARTH.radiusKm, eccentricity: 0, inclinationDeg: 0, normal: [0, -0.3978, 0.9175], seed: 7, ...extra });
const scenario = (bodies: BodySpec[], log: Scenario['log'] = []): Scenario => ({ schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, name: 'test', epochJdTdb: 2451545, frame: 'test', seedNote: '', integrator: { ...DEFAULT_INTEGRATOR }, bodies, log });
/** Each particle's distance from its primary (km). */
const radii = (s: SimState): number[] => {
  const w = s.swarms[0];
  return w ? Array.from({ length: w.pos.length / 3 }, (_, k) => Math.hypot(w.pos[k * 3] ?? 0, w.pos[k * 3 + 1] ?? 0, w.pos[k * 3 + 2] ?? 0)) : [];
};

test('test particles pull nothing: the bodies run the same, bit for bit, with a ring and without', () => {
  const a = new Engine(scenario(earthMoon()));
  const b = new Engine(scenario(earthMoon(), [{ step: 0, command: { kind: 'addSwarm', swarm: ringSpec() } }]));
  a.advanceTo(10 * 86_400, 1_000_000);
  b.advanceTo(10 * 86_400, 1_000_000);
  expect(b.state.swarms[0]?.pos.length).toBe(900);
  expect(b.state.pos).toEqual(a.state.pos);
  expect(b.state.vel).toEqual(a.state.vel);
  expect(b.state.step).toBe(a.state.step);
});

test('a ring about the Earth (its particles turning in 4 to 9 hours) stays a ring under hour-long steps: thirty days, none flung out', () => {
  const e = new Engine(scenario(earthMoon()));
  e.apply({ kind: 'addSwarm', swarm: ringSpec() });
  // The Earth and Moon set the step: about an hour, a sixth of the innermost particle's orbit.
  expect(e.dt).toBeGreaterThan(1800);
  const before = radii(e.state);
  e.advanceTo(30 * 86_400, 1_000_000);
  const after = radii(e.state);
  expect(after.length).toBe(before.length);
  // Circular orbits stay circular: each particle's distance within a few km of where it started (J2 and the Moon perturb it a little).
  const worst = Math.max(...after.map((r, k) => Math.abs(r - (before[k] ?? 0))));
  expect(worst).toBeLessThan(150);
  // In the plane it was made in: the Earth's equator.
  const w = e.state.swarms[0];
  const pole = [0, -0.3978, 0.9175];
  const out = Math.max(...Array.from({ length: (w?.pos.length ?? 0) / 3 }, (_, k) => Math.abs((w?.pos[k * 3] ?? 0) * (pole[0] ?? 0) + (w?.pos[k * 3 + 1] ?? 0) * (pole[1] ?? 0) + (w?.pos[k * 3 + 2] ?? 0) * (pole[2] ?? 0))));
  expect(out).toBeLessThan(100);
});

test('a particle in the asteroid belt, pulled by Jupiter, follows an independent fine-step integration of the same massless body', () => {
  const vj = circular(SUN.gm + JUPITER.gm, 5.2 * AU);
  const bodies = [spec('sun', SUN, [0, 0, 0], [0, 0, 0]), spec('jupiter', JUPITER, [5.2 * AU, 0, 0], [0, vj, 0])];
  const s = stateFrom(bodies);
  const w = makeSwarm(s, { id: 'belt', name: 'Belt', primary: 'sun', count: 1, innerKm: 2.5 * AU, outerKm: 2.5 * AU, eccentricity: 0.15, inclinationDeg: 8, normal: [0, 0, 1], seed: 3 });
  if (!w) throw new Error('no swarm');
  // The reference: the same particle as a massless body of the N-body leapfrog, at a fixed ten-minute step.
  const ref = stateFrom([...bodies, spec('p', { gm: 0, radiusKm: 1 }, [w.pos[0] ?? 0, w.pos[1] ?? 0, w.pos[2] ?? 0], [w.vel[0] ?? 0, w.vel[1] ?? 0, w.vel[2] ?? 0])]);
  s.swarms.push(w);
  const events: ContactEvent[] = [];
  // Two years of 730 whole days, so both runs end at the same instant.
  const two = 730 * 86_400;
  const acc: number[] = [];
  const refAcc: number[] = [];
  // The swarm under a coarse one-day step (it is carried exactly about the Sun between kicks).
  for (let t = 0; t < two; t += 86_400) step(s, 86_400, acc, events);
  for (let t = 0; t < two; t += 600) step(ref, 600, refAcc, events);
  const sunAt = [s.pos[0] ?? 0, s.pos[1] ?? 0, s.pos[2] ?? 0];
  const p = [0, 1, 2].map((k) => (sunAt[k] ?? 0) + (s.swarms[0]?.pos[k] ?? 0));
  const q = [ref.pos[6] ?? 0, ref.pos[7] ?? 0, ref.pos[8] ?? 0];
  const miss = Math.hypot(...p.map((x, k) => x - (q[k] ?? 0)));
  // Two years along 1.2 billion km of path, at a step 144 times longer: within 5 km (measured 0.5).
  expect(miss).toBeLessThan(5);
});

test('a scenario with a belt replays exactly through save and load; it can be removed', () => {
  const log: Scenario['log'] = [{ step: 0, command: { kind: 'addSwarm', swarm: ringSpec({ count: 200 }) } }];
  const a = new Engine(scenario(earthMoon(), structuredClone(log)));
  a.advanceTo(5 * 86_400, 1_000_000);
  a.apply({ kind: 'removeSwarm', id: 'ring' });
  a.apply({ kind: 'addSwarm', swarm: ringSpec({ id: 'second', count: 150, seed: 99 }) });
  a.advanceTo(8 * 86_400, 1_000_000);
  const saved = JSON.parse(JSON.stringify(a.toScenario())) as Scenario;
  const checked = validateScenario(saved);
  expect(checked.ok).toBe(true);
  const b = new Engine(saved);
  b.advanceTo(a.state.t, 1_000_000);
  expect(b.state.swarms.map((w) => w.id)).toEqual(['second']);
  expect(b.state.swarms[0]?.pos).toEqual(a.state.swarms[0]?.pos);
  expect(b.state.swarms[0]?.vel).toEqual(a.state.swarms[0]?.vel);
});

test('a ring whose planet merges into another goes on about the survivor without a jump; particles that strike a body are counted', () => {
  // A small planet with a ring falls straight into a large one.
  const big = { gm: EARTH.gm, radiusKm: EARTH.radiusKm };
  const small = { gm: MOON.gm, radiusKm: MOON.radiusKm };
  const s = stateFrom([spec('big', big, [0, 0, 0], [0, 0, 0]), spec('small', small, [EARTH.radiusKm + MOON.radiusKm + 2000, 0, 0], [-5, 0, 0])]);
  const w = makeSwarm(s, { id: 'r', name: 'R', primary: 'small', count: 40, innerKm: 3 * MOON.radiusKm, outerKm: 4 * MOON.radiusKm, eccentricity: 0, inclinationDeg: 0, normal: [0, 0, 1], seed: 1 });
  if (!w) throw new Error('no swarm');
  s.swarms.push(w);
  const absolute = (st: SimState): number[] => {
    const sw = st.swarms[0];
    const p = st.ids.indexOf(sw?.primary ?? '');
    return Array.from({ length: (sw?.pos.length ?? 0) }, (_, k) => (st.pos[p * 3 + (k % 3)] ?? 0) + (sw?.pos[k] ?? 0));
  };
  const events: ContactEvent[] = [];
  const acc: number[] = [];
  let merged = false;
  for (let k = 0; k < 200 && !merged; k += 1) {
    const before = cloneState(s);
    step(s, 10, acc, events);
    if (s.ids.length === 1) {
      merged = true;
      // Carried over to the survivor: each surviving particle where a straight 10 s on from before would put it, give or take its bending.
      expect(s.swarms[0]?.primary).toBe('big');
      const was = absolute(before);
      const now = absolute(s);
      const sw = s.swarms[0];
      expect((sw?.pos.length ?? 0) / 3 + (sw?.lost ?? 0)).toBe(40);
      // No particle teleports: compare the ones that remain, by their order (losses only remove).
      if ((sw?.lost ?? 0) === 0) for (let i = 0; i < now.length; i += 1) expect(Math.abs((now[i] ?? 0) - (was[i] ?? 0))).toBeLessThan(200);
    }
  }
  expect(merged).toBe(true);
  // Run on: some of the ring's particles, now about the big planet with their old speeds, strike it and are counted.
  for (let k = 0; k < 2000; k += 1) step(s, 30, acc, events);
  const sw = s.swarms[0];
  expect((sw?.pos.length ?? 0) / 3 + (sw?.lost ?? 0)).toBe(40);
});

test('impossible rings are refused; the limits hold', () => {
  const bad = (swarm: unknown): string[] => {
    const r = validateScenario({ ...scenario(earthMoon()), log: [{ step: 0, command: { kind: 'addSwarm', swarm } }] });
    return r.ok ? [] : r.errors;
  };
  expect(bad(ringSpec())).toEqual([]);
  expect(bad(ringSpec({ primary: 'nobody' })).length).toBeGreaterThan(0);
  expect(bad(ringSpec({ count: SWARM_LIMITS.perSwarm + 1 })).length).toBeGreaterThan(0);
  expect(bad(ringSpec({ innerKm: 20_000, outerKm: 10_000 })).length).toBeGreaterThan(0);
  expect(bad(ringSpec({ eccentricity: 1.2 })).length).toBeGreaterThan(0);
  expect(bad(ringSpec({ normal: [0, 0, 0] })).length).toBeGreaterThan(0);
  expect(bad({ ...ringSpec(), seed: 1.5 }).length).toBeGreaterThan(0);
  const removeUnknown = validateScenario({ ...scenario(earthMoon()), log: [{ step: 0, command: { kind: 'removeSwarm', id: 'ghost' } }] });
  expect(removeUnknown.ok).toBe(false);
  // Beyond the total, the engine makes as many as there is room for.
  const e = new Engine(scenario(earthMoon()));
  e.apply({ kind: 'addSwarm', swarm: ringSpec({ id: 'a', count: SWARM_LIMITS.perSwarm }) });
  e.apply({ kind: 'addSwarm', swarm: ringSpec({ id: 'b', count: SWARM_LIMITS.perSwarm }) });
  e.apply({ kind: 'addSwarm', swarm: ringSpec({ id: 'c', count: SWARM_LIMITS.perSwarm }) });
  expect(e.state.swarms.reduce((n, w) => n + w.pos.length / 3, 0)).toBe(SWARM_LIMITS.total);
  expect(e.state.swarms.map((w) => w.id)).toEqual(['a', 'b']);
  // A gravitating ring: its bodies are bodies, its mass shared among them.
  e.apply({ kind: 'addRing', ring: { id: 'moonlets', name: 'Moonlet', primary: 'earth', count: 12, innerKm: 2 * EARTH.radiusKm, outerKm: 2.2 * EARTH.radiusKm, gm: MOON.gm / 100, radiusKm: 50, normal: [0, 0, 1], seed: 4 } });
  const made = e.state.ids.filter((id) => id.startsWith('moonlets-'));
  expect(made.length).toBe(12);
  expect(e.state.gm.slice(3).reduce((a, b) => a + b, 0)).toBeCloseTo(MOON.gm / 100, 9);
});
