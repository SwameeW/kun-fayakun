/**
 * The experiment planner (src/ai/planner): a plan for every experiment, made of commands the
 * laboratory accepts and the headless engine applies; out-of-range numbers refused with their paths;
 * the background comparison deterministic and faithful (the impactor strikes at the speed and angle
 * asked; a laboratory's scenario replayed to its step is the laboratory's state, bit for bit); and the
 * optimiser converging on answers known in closed form.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { IntlMessageFormat } from 'intl-messageformat';
import { applyLabCommand } from '../../src/ai/planner/apply';
import { compareRuns, engineAt, sharedBaseline, solarBaseline, toComparison, worldAtStart, type Baseline } from '../../src/ai/planner/compare';
import { EXPERIMENT_IDS, isPlan, labCommandProblems, planExperiment, SUN_GM_KM3S2, worldFromContext, type PlanWorld } from '../../src/ai/planner/experiments';
import { MAX_PROBES, optimise } from '../../src/ai/planner/optimise';
import type { AiContext, ExperimentId, ExperimentPlan } from '../../src/ai/types';
import type { MoonFile, PlanetsFile } from '../../src/astro/ephemeris';
import type { PhysicalFile } from '../../src/astro/physical';
import type { ConstantsFile } from '../../src/core/types';
import { SUN_GM } from '../../src/sim/climate';
import { Engine } from '../../src/sim/engine';
import { seedLaboratory } from '../../src/sim/seed';
import { encodeScenario } from '../../src/sim/share';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const physical = readJson('public/assets/jpl/physical.json') as PhysicalFile;
const planets = readJson('public/assets/jpl/planets.json') as PlanetsFile;
const moon = readJson('public/assets/jpl/moon.json') as MoonFile;
const constants = readJson('data/constants.json') as ConstantsFile;
const messages = readJson('src/i18n/en.ai.tools.json') as Record<string, string>;
const figure = (id: string): number | null => constants.constants.find((c) => c.id === id)?.value ?? null;
const format = (key: string, values: Record<string, string | number>): string => {
  const m = messages[key];
  if (m === undefined) throw new Error(`no message ${key}`);
  return String(new IntlMessageFormat(m, 'en').format(values));
};

/** 2026-10-23 06:00 TDB, the explorer tests' date, inside the Moon's table. */
const EPOCH = 2461336.75;
const DAY = 86_400;
const solar = solarBaseline(physical, planets, moon, EPOCH, figure);
const world = worldAtStart(solar);

const plan = (id: ExperimentId, params: Record<string, unknown>, w: PlanWorld = world): ExperimentPlan => {
  const p = planExperiment(id, params, null, { world: w });
  if (!isPlan(p)) throw new Error(`${id}: ${JSON.stringify(p)}`);
  return p;
};
const problems = (id: ExperimentId, params: Record<string, unknown>, w: PlanWorld | null = world): string[] => {
  const p = planExperiment(id, params, null, { world: w });
  return isPlan(p) ? [] : p.map((x) => `${x.path}:${x.messageKey.split('.').pop() ?? ''}`);
};

const GOOD: Readonly<Record<ExperimentId, Record<string, unknown>>> = {
  'scale-mass': { body: 'sun', factor: 2 },
  'remove-body': { body: 'Jupiter' },
  'kick-body': { body: 'moon', dvKmS: 0.5, direction: 'prograde' },
  impact: { target: 'earth', diameterKm: 10, speedKmS: 20, angleDeg: 45 },
  'add-moon': { host: 'mars', distanceKm: 20_000, massKg: 1e20 },
  'second-star': { massSun: 1, distanceAu: 50 },
  'change-orbit': { body: 'mars', aFactor: 1.5, e: 0.3 },
};

test('every experiment becomes commands the laboratory accepts, with its sentence', () => {
  const sun = world.bodies.find((b) => b.id === 'sun');
  const mars = world.bodies.find((b) => b.id === 'mars');
  for (const id of EXPERIMENT_IDS) {
    const p = plan(id, GOOD[id]);
    expect(p.commands.length, id).toBeGreaterThan(0);
    for (const c of p.commands) expect(labCommandProblems(c), id).toEqual([]);
    expect(p.previewKey).toBe(`ai.tool.experiment.${id}.preview`);
    expect(format(p.previewKey, p.previewValues), id).not.toContain('{');
    expect(p.horizonDays).toBeGreaterThan(0);
    // The headless engine applies them as the laboratory does.
    const engine = new Engine(structuredClone(solar.scenario));
    for (const c of p.commands) expect(applyLabCommand(engine, c, solar.gPerKg).ok, id).toBe(true);
  }
  expect(plan('scale-mass', GOOD['scale-mass']).commands).toEqual([{ kind: 'mass', id: 'sun', massKg: (sun?.massKg ?? 0) * 2 }]);
  expect(plan('remove-body', GOOD['remove-body']).commands).toEqual([{ kind: 'remove', id: 'jupiter' }]);
  expect(plan('kick-body', GOOD['kick-body']).commands).toEqual([{ kind: 'impulse', id: 'moon', progradeMs: 500, normalMs: 0, radialMs: 0 }]);
  expect(plan('kick-body', { body: 'moon', dvKmS: 0.5, direction: 'radial-in' }).commands).toEqual([{ kind: 'impulse', id: 'moon', progradeMs: 0, normalMs: 0, radialMs: -500 }]);
  expect(plan('kick-body', { body: 'moon', dvKmS: 0.5, direction: 'retrograde' }).commands[0]).toMatchObject({ progradeMs: -500 });
  expect(plan('add-moon', GOOD['add-moon']).commands[0]).toMatchObject({ kind: 'addOrbit', primary: 'mars', distanceKm: 20_000, massKg: 1e20, name: 'New moon' });
  const star = plan('second-star', GOOD['second-star']).commands[0];
  expect(star).toMatchObject({ kind: 'addOrbit', primary: 'sun', name: 'Second star' });
  if (star?.kind === 'addOrbit') {
    expect(star.distanceKm).toBeCloseTo(50 * physical.auKm, -3);
    expect(star.massKg / (sun?.massKg ?? 1)).toBeCloseTo(1, 6);
  }
  const orbit = plan('change-orbit', GOOD['change-orbit']).commands[0];
  if (orbit?.kind !== 'elements') throw new Error('not elements');
  expect(orbit.aKm / (mars?.orbit?.aKm ?? 1)).toBeCloseTo(1.5, 9);
  expect(orbit.e).toBe(0.3);
  expect(orbit.iDeg).toBeCloseTo(mars?.orbit?.iDeg ?? 0, 9);
  expect(plan('scale-mass', { body: 'sun', factor: 2, horizonDays: 100 }).horizonDays).toBe(100);
  expect(plan('scale-mass', { body: 'sun', factor: 2 }).params).toEqual({ body: 'sun', factor: 2, horizonDays: 3650 });
});

test('out-of-range and impossible numbers are refused, each at its path', () => {
  expect(problems('scale-mass', { body: 'sun', factor: 1000 })).toEqual(['factor:range']);
  expect(problems('scale-mass', { body: 'sun', factor: 0.001 })).toEqual(['factor:range']);
  expect(problems('scale-mass', { body: 'sun', factor: '2' })).toEqual(['factor:type']);
  expect(problems('scale-mass', { body: 'sun' })).toEqual(['factor:required']);
  expect(problems('scale-mass', { body: 'sun', factor: 2, dvKmS: 1 })).toEqual(['dvKmS:notFor']);
  expect(problems('scale-mass', { body: 'pluto', factor: 2 })).toEqual(['body:noBody']);
  expect(problems('scale-mass', { body: 'sun', factor: 2, horizonDays: 1e6 })).toEqual(['horizonDays:range']);
  expect(problems('remove-body', { body: 'sun' })).toEqual(['body:persistent']);
  expect(problems('kick-body', { body: 'moon', dvKmS: 0, direction: 'prograde' })).toEqual(['dvKmS:zero']);
  expect(problems('kick-body', { body: 'moon', dvKmS: 60, direction: 'prograde' })).toEqual(['dvKmS:range']);
  expect(problems('kick-body', { body: 'moon', dvKmS: 1, direction: 'sideways' })).toEqual(['direction:enum']);
  expect(problems('impact', { target: 'earth', diameterKm: 10, speedKmS: 5, angleDeg: 45 })).toEqual(['speedKmS:slow']);
  expect(problems('impact', { target: 'earth', diameterKm: 10, speedKmS: 20, angleDeg: 10 })).toEqual(['angleDeg:range']);
  expect(problems('impact', { target: 'earth', diameterKm: 2000, speedKmS: 20, angleDeg: 45 })).toEqual(['diameterKm:range']);
  expect(problems('add-moon', { host: 'moon', distanceKm: 5e6, massKg: 1e15 })).toEqual(['distanceKm:tooFar']);
  expect(problems('add-moon', { host: 'earth', distanceKm: 7000, massKg: 1e15 })).toEqual(['distanceKm:tooClose']);
  expect(problems('add-moon', { host: 'moon', distanceKm: 10_000, massKg: 5e22 })).toEqual(['massKg:tooHeavy']);
  expect(problems('add-moon', { host: 'earth', distanceKm: 100_000, massKg: 1e3 })).toEqual(['massKg:range']);
  expect(problems('second-star', { massSun: 20, distanceAu: 50 })).toEqual(['massSun:range']);
  expect(problems('second-star', { massSun: 1, distanceAu: 0.1 })).toEqual(['distanceAu:range']);
  expect(problems('change-orbit', { body: 'mars', aFactor: 1.5, e: 0.99 })).toEqual(['e:range']);
  expect(problems('change-orbit', { body: 'mars', aFactor: 0.1, e: 0.1 })).toEqual(['aFactor:range']);
  // Mercury's orbit a fifth as wide and nearly parabolic would dip inside the Sun.
  expect(problems('change-orbit', { body: 'mercury', aFactor: 0.2, e: 0.95 })).toEqual(['aFactor:periapsis']);
  expect(problems('change-orbit', { body: 'sun', aFactor: 1, e: 0 })).toEqual(['body:noOrbit']);
  expect(problems('scale-mass', { body: 'sun', factor: 2 }, null)).toEqual([':noLab']);
  expect(problems('nothing' as ExperimentId, {})).toEqual(['experiment:enum']);
});

test('the planner’s solar mass is the engine’s and the data’s', () => {
  expect(SUN_GM_KM3S2).toBe(SUN_GM);
  expect(SUN_GM_KM3S2).toBe(physical.gmKm3S2.Sun);
});

test('the context’s summary is enough to check numbers, not to plan an impact', () => {
  const ctx: AiContext = {
    where: 'lab',
    chapter: null,
    chapterT: null,
    mode: 'cinematic',
    explorer: null,
    lab: { bodies: [{ id: 'sun', name: 'Sun', massKg: 1.989e30, centralId: null, aKm: null, e: null }, { id: 'earth', name: 'Earth', massKg: 5.972e24, centralId: 'sun', aKm: 1.496e8, e: 0.0167 }], status: 'running', days: 0, events: 0 },
    verses: [],
    summary: '',
  };
  const w = worldFromContext(ctx);
  expect(problems('scale-mass', { body: 'Earth', factor: 3 }, w)).toEqual([]);
  expect(problems('impact', { target: 'earth', diameterKm: 1, speedKmS: 20, angleDeg: 45 }, w)).toEqual(['target:needsState']);
});

test('the comparison is deterministic on a short horizon, and shows what changed', async () => {
  const p = plan('scale-mass', { body: 'sun', factor: 1.1, horizonDays: 30 });
  let reports = 0;
  const first = await compareRuns(solar, p, {
    sliceSteps: 50,
    onProgress: () => {
      reports += 1;
    },
  });
  const second = await compareRuns(solar, p, { sliceSteps: 500 });
  expect(second).toEqual(first);
  expect(reports).toBeGreaterThan(2);
  expect(first.subjects).toEqual(['sun']);
  expect(Math.abs(first.reachedDays.baseline - 30)).toBeLessThan(0.1);
  expect(Math.abs(first.reachedDays.variant - 30)).toBeLessThan(0.1);
  expect(Math.abs(first.energyError.baseline)).toBeLessThan(1e-6);
  expect(Math.abs(first.energyError.variant)).toBeLessThan(1e-6);
  const earthA = first.baseline.find((m) => m.id === 'earth');
  const earthB = first.variant.find((m) => m.id === 'earth');
  // A heavier Sun holds the Earth tighter: its osculating orbit shrinks and its year shortens.
  expect(earthB?.periodDays ?? 0).toBeLessThan(earthA?.periodDays ?? 0);
  expect(earthB?.e ?? 0).toBeGreaterThan(earthA?.e ?? 0);
  const comparison = toComparison(first, solar.auKm, format);
  expect(comparison.experiment).toBe('scale-mass');
  // The Sun first (the plan's own), with only what it has (no orbit); then the worlds it changed most.
  expect(comparison.rows[0]?.label).toBe('Sun: closest approach to any body');
  expect(comparison.rows.filter((r) => r.label.startsWith('Sun'))).toHaveLength(1);
  expect(comparison.rows.length).toBeLessThanOrEqual(21);
  expect(comparison.rows.some((r) => r.label.endsWith('semi-major axis') && r.unit === 'au' && r.variant !== null && r.baseline !== null && r.variant < r.baseline)).toBe(true);
  expect(comparison.events).toEqual([]);
  // A lighter Sun lets the Earth go: with a tenth of its mass, the Earth is no longer bound.
  const freed = await compareRuns(solar, plan('scale-mass', { body: 'sun', factor: 0.1, horizonDays: 30 }));
  expect(freed.events.some((e) => e.kind === 'escape' && e.absorbed === 'earth' && e.survivor === 'sun')).toBe(true);
  expect(toComparison(freed, solar.auKm, format).events).toContain('Earth left Sun within 30 days.');
});

test('the impactor strikes at the speed and angle asked, and the comparison sees it', async () => {
  const p = plan('impact', { target: 'earth', diameterKm: 10, speedKmS: 20, angleDeg: 45, horizonDays: 1 });
  const engine = new Engine(structuredClone(solar.scenario));
  const applied = applyLabCommand(engine, p.commands[0] ?? { kind: 'undo' }, solar.gPerKg);
  if (!applied.ok) throw new Error(applied.reason);
  engine.advanceTo(DAY, 1e6);
  const hit = engine.events.find((e) => e.absorbed === applied.id || e.survivor === applied.id);
  expect(hit?.survivor).toBe('earth');
  expect(hit?.speedKmS ?? 0).toBeGreaterThan(19.5);
  expect(hit?.speedKmS ?? 0).toBeLessThan(20.5);
  // b is the sine of the angle from head-on: the cosine of 45 degrees from the horizontal.
  expect(hit?.b ?? 0).toBeCloseTo(Math.cos(Math.PI / 4), 1);
  const raw = await compareRuns(solar, p);
  expect(raw.events.some((e) => (e.kind === 'merge' || e.kind === 'fragment') && e.survivor === 'earth')).toBe(true);
  expect(raw.names[applied.id]).toBe('Impactor');
});

test('a laboratory’s scenario replayed to its step is its state, bit for bit, with its edits', async () => {
  const lab = seedLaboratory(physical, true);
  const live = new Engine(structuredClone(lab));
  live.advanceTo(Number.POSITIVE_INFINITY, 300);
  live.apply({ kind: 'setMass', id: 'giant', gm: 2 * physical.gmKm3S2.Jupiter });
  live.advanceTo(Number.POSITIVE_INFINITY, 200);
  // An edit at the very step the laboratory reached.
  live.apply({ kind: 'setVelocity', id: 'planet', vel: [0, 31, 0] });
  const gPerKg = physical.gmKm3S2.Earth / 5.97217e24;
  const shared = await sharedBaseline(`https://kf.test/#/universe/lab?s=${await encodeScenario(live.toScenario())}`, live.state.step, gPerKg, physical.auKm);
  if (!shared.ok) throw new Error(shared.errors.join('; '));
  const replayed = await engineAt(shared.baseline, { sliceSteps: 64 });
  expect(replayed.state.step).toBe(live.state.step);
  expect(replayed.state.pos).toEqual(live.state.pos);
  expect(replayed.state.vel).toEqual(live.state.vel);
  expect(replayed.state.gm).toEqual(live.state.gm);
  expect((await sharedBaseline('not a link', 0, gPerKg, physical.auKm)).ok).toBe(false);
});

/** The two-body laboratory: a star and a planet on a circular orbit of 1 au. */
const pair = (): { base: Baseline; mu: number; r: number; v: number } => {
  const scenario = seedLaboratory(physical, false);
  const engine = new Engine(structuredClone(scenario));
  const s = engine.state;
  const rel = [0, 1, 2].map((k) => (s.pos[3 + k] ?? 0) - (s.pos[k] ?? 0));
  const vel = [0, 1, 2].map((k) => (s.vel[3 + k] ?? 0) - (s.vel[k] ?? 0));
  return { base: { scenario, gPerKg: physical.gmKm3S2.Earth / 5.97217e24, atStep: 0, auKm: physical.auKm }, mu: (s.gm[0] ?? 0) + (s.gm[1] ?? 0), r: Math.hypot(...rel), v: Math.hypot(...vel) };
};

test('the optimiser finds the smallest kick that escapes, and the mass for a year, as known in closed form', async () => {
  const { base, mu, r, v } = pair();
  // Escape: a prograde kick raising the speed to sqrt(2 mu / r).
  const escape = await optimise(base, { experiment: 'kick-body', params: { body: 'planet', direction: 'prograde' }, parameter: 'dvKmS', lo: 0.001, hi: 50, scale: 'linear', goal: { kind: 'escape', body: 'planet' }, horizonDays: 10, tolerance: 1e-5 });
  const dv = Math.sqrt((2 * mu) / r) - v;
  expect(escape.outcome).toBe('converged');
  expect(escape.runs).toBeLessThanOrEqual(MAX_PROBES);
  expect(Math.abs((escape.value ?? 0) - dv)).toBeLessThan(1e-3);
  expect(escape.bracket[0]).toBeLessThanOrEqual(dv + 1e-9);
  expect(escape.bracket[1]).toBeGreaterThanOrEqual(dv - 1e-9);

  // A year of 200 days: the star's mass factor f with 2 pi sqrt(a^3 / mu_f) = 200 d, a = 1 / (2 / r - v^2 / mu_f).
  const gmStar = base.scenario.bodies[0]?.gm ?? 0;
  const gmPlanet = base.scenario.bodies[1]?.gm ?? 0;
  const period = (f: number): number => {
    const m = f * gmStar + gmPlanet;
    const a = 1 / (2 / r - (v * v) / m);
    return a > 0 ? (2 * Math.PI * Math.sqrt((a * a * a) / m)) / DAY : Number.POSITIVE_INFINITY;
  };
  let lo = 0.6;
  let hi = 100;
  for (let k = 0; k < 200; k += 1) {
    const mid = (lo + hi) / 2;
    if (period(mid) > 200) lo = mid;
    else hi = mid;
  }
  const known = (lo + hi) / 2;
  const year = await optimise(base, { experiment: 'scale-mass', params: { body: 'star' }, parameter: 'factor', lo: 0.01, hi: 100, scale: 'log', goal: { kind: 'period', body: 'planet', targetDays: 200 }, horizonDays: 1, tolerance: 1e-6 });
  expect(year.runs).toBeLessThanOrEqual(MAX_PROBES);
  expect(Math.abs((year.value ?? 0) - known) / known).toBeLessThan(1e-3);

  // A bracket that does not hold the answer says so.
  const short = await optimise(base, { experiment: 'kick-body', params: { body: 'planet', direction: 'prograde' }, parameter: 'dvKmS', lo: 0.001, hi: 0.002, scale: 'linear', goal: { kind: 'escape', body: 'planet' }, horizonDays: 1 });
  expect(short).toMatchObject({ value: null, outcome: 'not-bracketed', runs: 2 });
  const invalid = await optimise(base, { experiment: 'kick-body', params: { body: 'planet', direction: 'prograde' }, parameter: 'dvKmS', lo: 0, hi: 99, scale: 'linear', goal: { kind: 'escape', body: 'planet' }, horizonDays: 1 });
  expect(invalid.outcome).toBe('invalid');
});

test('the Moon’s escape from the Earth within 30 days needs a kick of under a kilometre a second', async () => {
  const result = await optimise(solar, { experiment: 'kick-body', params: { body: 'moon', direction: 'prograde' }, parameter: 'dvKmS', lo: 0.001, hi: 2.9, scale: 'linear', goal: { kind: 'escape', body: 'moon' }, horizonDays: 30, maxProbes: 12 });
  expect(result.runs).toBeLessThanOrEqual(12);
  expect(result.value ?? 0).toBeGreaterThan(0.3);
  expect(result.value ?? 0).toBeLessThan(1.2);
  // The same search, the same answer.
  const again = await optimise(solar, { experiment: 'kick-body', params: { body: 'moon', direction: 'prograde' }, parameter: 'dvKmS', lo: 0.001, hi: 2.9, scale: 'linear', goal: { kind: 'escape', body: 'moon' }, horizonDays: 30, maxProbes: 12 });
  expect(again).toEqual(result);
});
