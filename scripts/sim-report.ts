/**
 * The orbital laboratory's numbers (src/sim), as recorded in docs/LAB.md: the acceptance tests'
 * scenarios with the errors they actually reach (tests/unit/sim.spec.ts only bounds them), the
 * solar-system seed run against the explorer's ephemeris it was forked from, and the integrator's
 * speed on this machine.
 *
 *   node --import tsx scripts/sim-report.ts
 */
import { readFileSync } from 'node:fs';
import { createEphemeris, type MoonFile, type PlanetsFile } from '../src/astro/ephemeris';
import type { PhysicalFile } from '../src/astro/physical';
import { DEFAULT_INTEGRATOR, Engine, ENGINE_VERSION, SCHEMA_VERSION, stateFrom, type BodySpec } from '../src/sim/engine';
import { accelerations, diagnostics, drift, energy, indexOf, resolveContacts, step, type MergeEvent, type SimState } from '../src/sim/nbody';
import { seedSolarSystem } from '../src/sim/seed';

const ROOT = new URL('../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const physical = readJson('public/assets/jpl/physical.json') as PhysicalFile;
const GM_SUN = physical.gmKm3S2.Sun;
const GM_EARTH = physical.gmKm3S2.Earth;
const AU = physical.auKm;
/** 2026-10-23 06:00 TDB, the explorer tests' date, inside the Moon's table. */
const EPOCH = 2461336.75;

const sci = (x: number): string => x.toExponential(2);
const body = (id: string, gm: number, radiusKm: number, pos: [number, number, number], vel: [number, number, number]): BodySpec => ({ id, name: id, gm, radiusKm, pos, vel, origin: 'user-edited', sourceIds: [] });

/** A star and a planet starting at periapsis of an orbit of eccentricity e about their barycentre. */
function pair(r: number, e = 0): { state: SimState; period: number; a: number } {
  const mu = GM_SUN + GM_EARTH;
  const a = r / (1 - e);
  const v = Math.sqrt(mu * (2 / r - 1 / a));
  const fs = GM_EARTH / mu;
  const fp = GM_SUN / mu;
  const state = stateFrom([body('star', GM_SUN, 1, [-r * fs, 0, 0], [0, -v * fs, 0]), body('planet', GM_EARTH, 1, [r * fp, 0, 0], [0, v * fp, 0])]);
  return { state, period: 2 * Math.PI * Math.sqrt((a * a * a) / mu), a };
}

function run(state: SimState, dt: number, steps: number, each?: (s: SimState) => void): void {
  const acc: number[] = [];
  const events: MergeEvent[] = [];
  for (let k = 0; k < steps; k += 1) {
    step(state, dt, acc, events);
    each?.(state);
  }
}

function worstEnergy(perPeriod: number, periods: number, e: number): number {
  const { state, period } = pair(AU, e);
  const e0 = energy(state);
  let worst = 0;
  run(state, period / perPeriod, perPeriod * periods, (s) => {
    worst = Math.max(worst, Math.abs((energy(s) - e0) / e0));
  });
  return worst;
}

const rows: Array<[string, string]> = [];

// Two-body circular orbit: 100 periods at P/512.
{
  const { state, period } = pair(AU);
  const ref = diagnostics(state);
  let worst = 0;
  run(state, period / 512, 51_200, (s) => {
    worst = Math.max(worst, Math.abs((energy(s) - ref.energy) / ref.energy));
  });
  const d = drift(ref, diagnostics(state));
  const phase = Math.atan2((state.pos[4] ?? 0) - (state.pos[1] ?? 0), (state.pos[3] ?? 0) - (state.pos[0] ?? 0));
  rows.push(['Circular orbit, 100 periods at P/512: largest relative energy error', sci(worst)]);
  rows.push(['  momentum and angular momentum drift (relative)', `${sci(d.momentum)}, ${sci(d.angularMomentum)}`]);
  rows.push(['  period error, from the phase after 100 periods', sci(Math.abs(phase) / (2 * Math.PI * 100))]);
}

// Convergence on an eccentric orbit (e = 0.5): the energy error from P/512 to P/1024.
rows.push(['Convergence, e = 0.5: energy error at P/512 over P/1024 (2nd order: 4)', (worstEnergy(512, 4, 0.5) / worstEnergy(1024, 4, 0.5)).toFixed(2)]);

// An eccentric orbit (e = 0.6) against Kepler's equation.
{
  const e = 0.6;
  const { state, period, a } = pair(0.4 * AU, e);
  const dt = period / 20_000;
  let worst = 0;
  let k = 0;
  run(state, dt, 20_000, (s) => {
    k += 1;
    if (k % 500 !== 0) return;
    const M = (2 * Math.PI * k * dt) / period;
    let E = M;
    for (let n = 0; n < 50; n += 1) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const x = a * (Math.cos(E) - e);
    const y = a * Math.sqrt(1 - e * e) * Math.sin(E);
    worst = Math.max(worst, Math.hypot((s.pos[3] ?? 0) - (s.pos[0] ?? 0) - x, (s.pos[4] ?? 0) - (s.pos[1] ?? 0) - y) / a);
  });
  rows.push(['Eccentric orbit (e = 0.6, P/20,000) against Kepler: largest position error / a', sci(worst)]);
}

// A close encounter (a second star passing a star and its planet) against RK4 at 30 s.
{
  const bodies = [
    body('a', GM_SUN, 7e5, [0, 0, 0], [0, 0, 0]),
    body('b', GM_SUN, 7e5, [2 * AU, 0.4 * AU, 0], [-30, 0, 0]),
    body('p', GM_EARTH, 6371, [0.12 * AU, 0, 0], [0, Math.sqrt(GM_SUN / (0.12 * AU)), 0]),
  ];
  const engine = new Engine({ schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, name: 'encounter', epochJdTdb: 2451545, frame: 'test', seedNote: '', integrator: { ...DEFAULT_INTEGRATOR, eta: 0.002, dtMaxS: 3600 }, bodies, log: [] });
  engine.advanceTo(120 * 86_400, 10_000_000);
  const gm = bodies.map((b) => b.gm);
  let y = bodies.flatMap((b) => [...b.pos, ...b.vel]);
  const f = (z: number[]): number[] => {
    const d = new Array<number>(z.length).fill(0);
    for (let i = 0; i < 3; i += 1) {
      for (let c = 0; c < 3; c += 1) d[i * 6 + c] = z[i * 6 + 3 + c] ?? 0;
      for (let j = 0; j < 3; j += 1) {
        if (i === j) continue;
        const r = [0, 1, 2].map((c) => (z[j * 6 + c] ?? 0) - (z[i * 6 + c] ?? 0));
        const r3 = Math.hypot(...r) ** 3;
        for (let c = 0; c < 3; c += 1) d[i * 6 + 3 + c] = (d[i * 6 + 3 + c] ?? 0) + ((gm[j] ?? 0) * (r[c] ?? 0)) / r3;
      }
    }
    return d;
  };
  const h = 30;
  for (let s = 0; s < Math.round(engine.state.t / h); s += 1) {
    const k1 = f(y);
    const k2 = f(y.map((v, i) => v + (h / 2) * (k1[i] ?? 0)));
    const k3 = f(y.map((v, i) => v + (h / 2) * (k2[i] ?? 0)));
    const k4 = f(y.map((v, i) => v + h * (k3[i] ?? 0)));
    y = y.map((v, i) => v + (h / 6) * ((k1[i] ?? 0) + 2 * (k2[i] ?? 0) + 2 * (k3[i] ?? 0) + (k4[i] ?? 0)));
  }
  const p = indexOf(engine.state, 'p');
  const err = Math.hypot((engine.state.pos[p * 3] ?? 0) - (y[12] ?? 0), (engine.state.pos[p * 3 + 1] ?? 0) - (y[13] ?? 0), (engine.state.pos[p * 3 + 2] ?? 0) - (y[14] ?? 0));
  rows.push(['Close encounter, 120 days (engine steps, eta 0.002) against RK4 at 30 s: planet position error', `${sci(err / AU)} au (${Math.round(err).toLocaleString('en')} km), ${engine.state.step.toLocaleString('en')} steps`]);
}

// A merger: what it keeps, and the energy it turns to heat.
{
  const s = stateFrom([body('a', GM_EARTH, 6371, [0, 0, 0], [0, 0, 0]), body('b', physical.gmKm3S2.Moon, 1737, [8_150, 500, 0], [-8, 0.5, 0.2])]);
  const acc: number[] = [];
  accelerations(s, acc);
  const ref = diagnostics(s);
  const events: MergeEvent[] = [];
  resolveContacts(s, 10, acc, events);
  const d = drift(ref, diagnostics(s));
  rows.push(['Merger (a Moon-mass body striking the Earth): mass, momentum, angular momentum, total energy (relative)', `${sci(Math.abs(diagnostics(s).gm - ref.gm) / ref.gm)}, ${sci(d.momentum)}, ${sci(d.angularMomentum)}, ${sci(d.energy)}`]);
  rows.push(['  heat, as a share of the pair\'s mechanical energy scale', sci((events[0]?.heat ?? 0) / ref.energyScale)]);
}

// The solar-system seed against the explorer's ephemeris (Standish's elements, JPL Horizons' Moon).
{
  const planets = readJson('public/assets/jpl/planets.json') as PlanetsFile;
  const moon = readJson('public/assets/jpl/moon.json') as MoonFile;
  const eph = createEphemeris(planets, moon, physical);
  const engine = new Engine(seedSolarSystem(eph, physical, EPOCH));
  const jupiter = eph.bodies.findIndex((b) => b.name.toLowerCase() === 'jupiter');
  const out = { x: 0, y: 0, z: 0 };
  const truth = (id: string, jd: number): number[] => {
    const v = id === 'earth' ? eph.earthKm(jd, out) : id === 'moon' ? eph.moonHelioKm(jd, out) : eph.planetKm(jupiter, jd, out);
    return [v.x, v.y, v.z];
  };
  const helio = (id: string): number[] => {
    const i = indexOf(engine.state, id);
    const sun = indexOf(engine.state, 'sun');
    return [0, 1, 2].map((c) => (engine.state.pos[i * 3 + c] ?? 0) - (engine.state.pos[sun * 3 + c] ?? 0));
  };
  const apart = (a: number[], b: number[]): number => Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
  const minus = (a: number[], b: number[]): number[] => a.map((v, c) => v - (b[c] ?? 0));
  const started = performance.now();
  for (const days of [1, 7, 30, 365]) {
    engine.advanceTo(days * 86_400, 10_000_000);
    const jd = EPOCH + engine.state.t / 86_400;
    const earth = apart(helio('earth'), truth('earth', jd));
    const moonGeo = apart(minus(helio('moon'), helio('earth')), minus(truth('moon', jd), truth('earth', jd)));
    const jup = apart(helio('jupiter'), truth('jupiter', jd));
    rows.push([`Solar seed after ${days} d, against the ephemeris: the Earth, the Moon (about the Earth), Jupiter`, `${Math.round(earth).toLocaleString('en')} km, ${Math.round(moonGeo).toLocaleString('en')} km, ${Math.round(jup).toLocaleString('en')} km`]);
  }
  const ms = performance.now() - started;
  const d = engine.drift();
  rows.push(['  one year: relative drift of energy, momentum, angular momentum', `${sci(d.energy)}, ${sci(d.momentum)}, ${sci(d.angularMomentum)}`]);
  rows.push(['  one year: steps, mean step, wall time on this machine', `${engine.state.step.toLocaleString('en')}, ${(engine.state.t / engine.state.step / 3600).toFixed(2)} h, ${Math.round(ms)} ms (${Math.round(engine.state.step / (ms / 1000)).toLocaleString('en')} steps/s)`]);
}

const width = Math.max(...rows.map(([k]) => k.length));
for (const [k, v] of rows) console.log(`${k.padEnd(width)}  ${v}`);
