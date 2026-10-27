import { createEphemeris, type MoonFile, type PlanetsFile } from '../../astro/ephemeris';
import type { PhysicalFile } from '../../astro/physical';
import { BODY_IDS } from '../../core/types';
import { worldClimates } from '../../sim/climate';
import { elementsFromState, hillRadiusKm } from '../../sim/elements';
import { Engine, validateScenario, type LoggedCommand, type Scenario } from '../../sim/engine';
import { diagnostics, drift, primaryOf, type Diagnostics, type SimState } from '../../sim/nbody';
import { seedSolarSystem, type Shapes } from '../../sim/seed';
import { decodeScenario } from '../../sim/share';
import type { Comparison, ComparisonRow, ExperimentId, ExperimentPlan, ToolProblem } from '../types';
import { applyLabCommand } from './apply';
import { SUN_GM_KM3S2, type PlanBody, type PlanWorld } from './experiments';

/**
 * Two runs of the same laboratory side by side, headless (src/sim's Engine, no DOM, no worker needed:
 * ./batch-worker.ts runs this in a dedicated worker; tests run it in Node). The baseline is the
 * laboratory as it stands (its scenario from its share link, replayed to the step it had reached) or,
 * outside the laboratory, the solar system seeded as src/explore/lab.ts seeds it. The variant is the
 * baseline with the plan's commands applied through the engine's own API. Both are integrated to the
 * horizon in slices (abortable, with progress), then each body is read: its osculating orbit about
 * its primary (semi-major axis, eccentricity, period), its closest approach to any other body (checked
 * after every step) and its distance from its primary at the end; with the collisions and escapes of
 * the variant and each run's relative energy error over the window.
 *
 * Deterministic: the engine's step depends only on the state and its log, and nothing here reads a
 * clock or a random number, so the same inputs give the same numbers however the work is sliced. The
 * runs end at the last whole step before the horizon (within a step of it).
 *
 * A simulation integrated ahead, never a forecast: the comparison is labelled as one.
 */

export interface Baseline {
  scenario: Scenario;
  /** The laboratory's one G for kilograms (km^3 s^-2 per kg). */
  gPerKg: number;
  /** The step the laboratory had reached (0: its start). */
  atStep: number;
  auKm: number;
}

export interface BodyMetrics {
  id: string;
  name: string;
  present: boolean;
  primary: string | null;
  aKm: number | null;
  e: number | null;
  periodDays: number | null;
  closestKm: number | null;
  closestTo: string | null;
  distanceKm: number | null;
}

export interface RawEvent {
  kind: 'merge' | 'fragment' | 'graze' | 'disrupt' | 'escape';
  tDays: number;
  /** The body kept (or escaped from) and the one absorbed (or escaping). */
  survivor: string;
  absorbed: string;
}

export interface RawComparison {
  experiment: ExperimentId;
  horizonDays: number;
  reachedDays: { baseline: number; variant: number };
  steps: { baseline: number; variant: number };
  baseline: BodyMetrics[];
  variant: BodyMetrics[];
  /** The bodies the plan concerns (new bodies by their ids in the variant). */
  subjects: string[];
  events: RawEvent[];
  energyError: { baseline: number; variant: number };
  /** Every body's name seen in either run. */
  names: Record<string, string>;
}

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number, phase: 'replay' | 'run') => void;
  /** Steps between yields (to take an abort, to report progress). */
  sliceSteps?: number;
  /**
   * Wall-clock time a comparison may take, ms (COMPARE_BUDGET_MS unless given). Past it the runs stop
   * where they are, both at the same time, and the comparison says how far it reached: in the
   * evaluation one comparison held a visitor's question for over five minutes (docs/AI-EVALUATION.md).
   */
  budgetMs?: number;
}

/** How long a comparison may run before it reports what it reached. */
export const COMPARE_BUDGET_MS = 60_000;

const DAY_S = 86_400;
const SLICE_STEPS = 2000;

/** What a comparison runs: a plan, or a planner given the laboratory as it stands at the fork (the exact world, in the worker). */
export type ComparedPlan = Pick<ExperimentPlan, 'id' | 'commands' | 'horizonDays'>;
export type PlanSource = ComparedPlan | ((world: PlanWorld) => ComparedPlan | ToolProblem[]);

/** A planner that found the experiment's numbers wrong for the laboratory as it stands. */
export class PlanProblems extends Error {
  constructor(readonly problems: ToolProblem[]) {
    super('the experiment does not fit the laboratory');
    this.name = 'PlanProblems';
  }
}

export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

/** Lets other work run (an abort message, a frame) between slices. */
const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortedError();
}

/** The scenario to run: a copy, its log cut at the step reached (later entries belong to a branch left behind); the entries at that very step returned to apply there. */
function prepared(base: Baseline): { scenario: Scenario; atStep: LoggedCommand[] } {
  const copy = structuredClone(base.scenario);
  const atStep = copy.log.filter((e) => e.step === base.atStep);
  copy.log = copy.log.filter((e) => e.step < base.atStep);
  return { scenario: copy, atStep };
}

/** An engine at the step the laboratory had reached, with its edits there applied (as the laboratory applied them). */
export async function engineAt(base: Baseline, options: RunOptions = {}, report?: (fraction: number) => void): Promise<Engine> {
  const { scenario, atStep } = prepared(base);
  const engine = new Engine(scenario);
  const slice = options.sliceSteps ?? SLICE_STEPS;
  while (engine.state.step < base.atStep && !engine.failure) {
    const taken = engine.advanceTo(Number.POSITIVE_INFINITY, Math.min(slice, base.atStep - engine.state.step));
    if (taken === 0) break;
    report?.(engine.state.step / Math.max(1, base.atStep));
    stopIfAborted(options.signal);
    await breathe();
  }
  for (const e of atStep) engine.apply(e.command);
  return engine;
}

interface Closest {
  km: number;
  to: string | null;
}

/** Each body's nearest approach to any other so far (centre to centre), updated in place. */
function noteClosest(s: SimState, closest: Map<string, Closest>): void {
  const n = s.ids.length;
  for (let i = 0; i < n; i += 1) {
    const id = s.ids[i] ?? '';
    let best = closest.get(id);
    if (!best) {
      best = { km: Number.POSITIVE_INFINITY, to: null };
      closest.set(id, best);
    }
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const d = Math.hypot((s.pos[j * 3] ?? 0) - (s.pos[i * 3] ?? 0), (s.pos[j * 3 + 1] ?? 0) - (s.pos[i * 3 + 1] ?? 0), (s.pos[j * 3 + 2] ?? 0) - (s.pos[i * 3 + 2] ?? 0));
      if (d < best.km) {
        best.km = d;
        best.to = s.ids[j] ?? null;
      }
    }
  }
}

/** Body i's orbit about its primary now: the primary, the osculating elements (bound only) and the distance. */
export function orbitNow(s: SimState, i: number): { primary: number; aKm: number | null; e: number | null; periodS: number | null; distanceKm: number | null; energy: number | null } {
  const p = primaryOf(s.gm, s.pos, i);
  if (p < 0) return { primary: -1, aKm: null, e: null, periodS: null, distanceKm: null, energy: null };
  const r = [0, 1, 2].map((k) => (s.pos[i * 3 + k] ?? 0) - (s.pos[p * 3 + k] ?? 0));
  const v = [0, 1, 2].map((k) => (s.vel[i * 3 + k] ?? 0) - (s.vel[p * 3 + k] ?? 0));
  const el = elementsFromState(r, v, (s.gm[p] ?? 0) + (s.gm[i] ?? 0));
  return { primary: p, aKm: el.bound ? el.a : null, e: el.e, periodS: el.periodS, distanceKm: Math.hypot(r[0] ?? 0, r[1] ?? 0, r[2] ?? 0), energy: el.energy };
}

function metrics(s: SimState, ids: readonly string[], names: Record<string, string>, closest: Map<string, Closest>): BodyMetrics[] {
  return ids.map((id) => {
    const i = s.ids.indexOf(id);
    const c = closest.get(id);
    const near = c && Number.isFinite(c.km) ? { closestKm: c.km, closestTo: c.to } : { closestKm: null, closestTo: null };
    if (i < 0) return { id, name: names[id] ?? id, present: false, primary: null, aKm: null, e: null, periodDays: null, distanceKm: null, ...near };
    const o = orbitNow(s, i);
    return { id, name: names[id] ?? id, present: true, primary: o.primary >= 0 ? (s.ids[o.primary] ?? null) : null, aKm: o.aKm, e: o.e, periodDays: o.periodS === null ? null : o.periodS / DAY_S, distanceKm: o.distanceKm, ...near };
  });
}

/**
 * Bodies that left the body they moved about: bound to it at the fork as the laboratory stood (or, for a
 * body the plan made, as it was made), and at the end bound to another, or no longer bound to it.
 */
function escapes(fork: SimState, made: SimState, end: SimState, t0: number): RawEvent[] {
  const out: RawEvent[] = [];
  const ids = [...fork.ids, ...made.ids.filter((id) => !fork.ids.includes(id))];
  for (const id of ids) {
    const start = fork.ids.includes(id) ? fork : made;
    const before = orbitNow(start, start.ids.indexOf(id));
    const j = end.ids.indexOf(id);
    if (before.primary < 0 || before.aKm === null || j < 0) continue;
    const was = start.ids[before.primary] ?? '';
    const p = end.ids.indexOf(was);
    if (p < 0) continue;
    const after = orbitNow(end, j);
    const r = [0, 1, 2].map((k) => (end.pos[j * 3 + k] ?? 0) - (end.pos[p * 3 + k] ?? 0));
    const v = [0, 1, 2].map((k) => (end.vel[j * 3 + k] ?? 0) - (end.vel[p * 3 + k] ?? 0));
    const unbound = !elementsFromState(r, v, (end.gm[p] ?? 0) + (end.gm[j] ?? 0)).bound;
    if (unbound || (after.primary >= 0 && end.ids[after.primary] !== was)) out.push({ kind: 'escape', tDays: (end.t - t0) / DAY_S, survivor: was, absorbed: id });
  }
  return out;
}

/** Runs an engine on to `tEnd` in slices of whole steps, noting closest approaches after each step, until `deadline` (ms since the epoch). */
async function runTo(engine: Engine, tEnd: number, closest: Map<string, Closest> | null, options: RunOptions, report: () => void, deadline = Number.POSITIVE_INFINITY): Promise<void> {
  const slice = options.sliceSteps ?? SLICE_STEPS;
  for (;;) {
    let taken = 0;
    while (taken < slice && engine.advanceTo(tEnd, 1) === 1) {
      taken += 1;
      if (closest) noteClosest(engine.state, closest);
    }
    report();
    stopIfAborted(options.signal);
    if (taken < slice || Date.now() >= deadline) return;
    await breathe();
  }
}

/** Names of every body in a state, kept as they come and go. */
function noteNames(s: SimState, names: Record<string, string>): void {
  s.ids.forEach((id, i) => {
    names[id] ??= s.names[i] ?? id;
  });
}

/** The comparison of the baseline and the baseline with the plan's commands, integrated `plan.horizonDays` ahead. */
export async function compareRuns(base: Baseline, source: PlanSource, options: RunOptions = {}): Promise<RawComparison> {
  const progress = options.onProgress ?? (() => undefined);
  const a = await engineAt(base, options, (f) => {
    progress(f * 0.5, 'replay');
  });
  const b = await engineAt(base, options, (f) => {
    progress(0.5 + f * 0.5, 'replay');
  });
  const made = typeof source === 'function' ? source(worldFromState(b.state, base.gPerKg, base.auKm, base.scenario.persistentIds ?? [])) : source;
  if (Array.isArray(made)) throw new PlanProblems(made);
  const plan = made;
  const names: Record<string, string> = {};
  for (const body of base.scenario.bodies) names[body.id] = body.name;
  noteNames(b.state, names);
  const subjects: string[] = [];
  const stepAtFork = b.state.step;
  const eventsBefore = b.events.length;
  for (const c of plan.commands) {
    const done = applyLabCommand(b, c, base.gPerKg);
    if (!done.ok) throw new Error(`the plan's ${c.kind} could not be applied: ${done.reason}`);
    if (!subjects.includes(done.id)) subjects.push(done.id);
  }
  noteNames(b.state, names);
  const t0 = a.state.t;
  const tEnd = t0 + plan.horizonDays * DAY_S;
  const refA: Diagnostics = diagnostics(a.state);
  const refB: Diagnostics = diagnostics(b.state);
  const forkA = structuredClone(a.state);
  const startB = structuredClone(b.state);
  const closeA = new Map<string, Closest>();
  const closeB = new Map<string, Closest>();
  noteClosest(a.state, closeA);
  noteClosest(b.state, closeB);
  const span = Math.max(1, tEnd - t0);
  const report = (): void => {
    progress(Math.min(1, (a.state.t - t0 + (b.state.t - t0)) / (2 * span)), 'run');
  };
  // Half the time for the laboratory as it is, half for the change, run only as far as the first got.
  const half = (options.budgetMs ?? COMPARE_BUDGET_MS) / 2;
  await runTo(a, tEnd, closeA, options, report, Date.now() + half);
  await runTo(b, Math.min(tEnd, a.state.t), closeB, options, () => {
    report();
    noteNames(b.state, names);
  }, Date.now() + half);
  noteNames(a.state, names);
  noteNames(b.state, names);
  const ids = [...base.scenario.bodies.map((x) => x.id), ...a.state.ids, ...b.state.ids, ...subjects].filter((id, i, all) => all.indexOf(id) === i);
  const contact: RawEvent[] = b.events.slice(eventsBefore).filter((e) => e.step >= stepAtFork).map((e) => ({ kind: e.kind, tDays: (e.t - t0) / DAY_S, survivor: e.survivor, absorbed: e.absorbed }));
  return {
    experiment: plan.id,
    horizonDays: plan.horizonDays,
    reachedDays: { baseline: (a.state.t - t0) / DAY_S, variant: (b.state.t - t0) / DAY_S },
    steps: { baseline: a.state.step - stepAtFork, variant: b.state.step - stepAtFork },
    baseline: metrics(a.state, ids, names, closeA),
    variant: metrics(b.state, ids, names, closeB),
    subjects,
    events: [...contact, ...escapes(forkA, startB, b.state, t0)],
    energyError: { baseline: drift(refA, diagnostics(a.state)).energy, variant: drift(refB, diagnostics(b.state)).energy },
    names,
  };
}

/* ----- The comparison as the interface shows it ----- */

/** At most this many bodies are compared on screen: the plan's own first, then those it changed most. */
export const BODIES_SHOWN = 5;

/** How much a body changed between the runs (gone or appeared counts most). */
function change(a: BodyMetrics | undefined, b: BodyMetrics | undefined): number {
  if (!a || !b || a.present !== b.present) return Number.POSITIVE_INFINITY;
  if (!a.present) return 0;
  const rel = (x: number | null, y: number | null): number => (x === null || y === null ? (x === y ? 0 : 1) : Math.abs(y - x) / Math.max(Math.abs(x), 1e-12));
  return Math.max(rel(a.aKm, b.aKm), Math.abs((b.e ?? 0) - (a.e ?? 0)), a.primary === b.primary ? 0 : 1);
}

/**
 * The rows and events in words (`label(key, values)` is the i18n lookup), for the bodies that matter:
 * the plan's subjects, then the rest by how much they changed (ties in the scenario's order).
 */
export function toComparison(raw: RawComparison, auKm: number, label: (key: string, values: Record<string, string | number>) => string): Comparison {
  const byId = (list: readonly BodyMetrics[]) => new Map(list.map((m) => [m.id, m]));
  const A = byId(raw.baseline);
  const B = byId(raw.variant);
  const order = raw.baseline.map((m) => m.id).concat(raw.variant.map((m) => m.id)).filter((id, i, all) => all.indexOf(id) === i);
  const rest = order
    .filter((id) => !raw.subjects.includes(id))
    .map((id, k) => ({ id, k, c: change(A.get(id), B.get(id)) }))
    .filter((x) => x.c > 1e-9)
    .sort((x, y) => (y.c === x.c ? x.k - y.k : y.c > x.c ? 1 : -1))
    .map((x) => x.id);
  const shown = [...raw.subjects, ...rest].slice(0, BODIES_SHOWN);
  const rows: ComparisonRow[] = [];
  const far = (km: number | null): boolean => km !== null && km > 0.01 * auKm;
  for (const id of shown) {
    const a = A.get(id);
    const b = B.get(id);
    const body = raw.names[id] ?? id;
    const inAu = far(a?.aKm ?? null) || far(b?.aKm ?? null);
    const dist = (x: number | null | undefined): number | null => (x === null || x === undefined ? null : inAu ? x / auKm : x);
    const unit = inAu ? 'au' : 'km';
    const candidates: ComparisonRow[] = [
      { label: label('ai.tool.compare.row.a', { body }), unit, baseline: dist(a?.aKm), variant: dist(b?.aKm) },
      { label: label('ai.tool.compare.row.e', { body }), unit: '', baseline: a?.e ?? null, variant: b?.e ?? null },
      { label: label('ai.tool.compare.row.period', { body }), unit: 'd', baseline: a?.periodDays ?? null, variant: b?.periodDays ?? null },
      { label: label('ai.tool.compare.row.closest', { body }), unit: 'km', baseline: a?.closestKm ?? null, variant: b?.closestKm ?? null },
      { label: label('ai.tool.compare.row.distance', { body }), unit, baseline: dist(a?.distanceKm), variant: dist(b?.distanceKm) },
    ];
    // A row with nothing on either side (the Sun has no orbit) says nothing.
    rows.push(...candidates.filter((r) => r.baseline !== null || r.variant !== null));
  }
  const events = raw.events.map((e) => label(`ai.tool.compare.event.${e.kind}`, { survivor: raw.names[e.survivor] ?? e.survivor, absorbed: raw.names[e.absorbed] ?? e.absorbed, days: Math.round(e.tDays * 10) / 10 }));
  return { experiment: raw.experiment, horizonDays: raw.horizonDays, rows, events, energyError: raw.energyError };
}

/** The world of an engine's state (a headless run): orbits from the state about each body's primary. */
export function worldFromState(st: SimState, gPerKg: number, auKm: number, persistentIds: readonly string[] = []): PlanWorld {
  const D = 180 / Math.PI;
  const bodies: PlanBody[] = st.ids.map((id, i) => {
    const p = primaryOf(st.gm, st.pos, i);
    let orbit: PlanBody['orbit'] = null;
    if (p >= 0) {
      const r = [0, 1, 2].map((k) => (st.pos[i * 3 + k] ?? 0) - (st.pos[p * 3 + k] ?? 0));
      const v = [0, 1, 2].map((k) => (st.vel[i * 3 + k] ?? 0) - (st.vel[p * 3 + k] ?? 0));
      const gm = st.gm[i] ?? 0;
      const gp = st.gm[p] ?? 0;
      const el = elementsFromState(r, v, gp + gm);
      if (el.bound) orbit = { aKm: el.a, e: el.e, iDeg: el.i * D, nodeDeg: el.node * D, periapsisArgDeg: el.periapsisArg * D, trueAnomalyDeg: el.trueAnomaly * D, hillKm: gp > 0 ? hillRadiusKm(el.a, el.e, gm, gp) : null };
    }
    return { id, name: st.names[i] ?? id, massKg: (st.gm[i] ?? 0) / gPerKg, radiusKm: st.radius[i] ?? null, primary: p >= 0 ? (st.ids[p] ?? null) : null, orbit, persistent: persistentIds.includes(id) };
  });
  return { bodies, gPerKg, sunMassKg: SUN_GM_KM3S2 / gPerKg, auKm };
}

/** The world at a baseline's start (an engine made, not run): what a plan is checked against outside the laboratory. */
export const worldAtStart = (base: Baseline): PlanWorld => worldFromState(new Engine(structuredClone(base.scenario)).state, base.gPerKg, base.auKm, base.scenario.persistentIds ?? []);

/* ----- Baselines ----- */

/**
 * The solar system as src/explore/lab.ts seeds it at `jdTdb`: the explorer's ephemeris, each world's
 * J2 and moment of inertia, its climate and the Sun's light from data/constants.json (`figure` reads a
 * constant's value, or null), kilograms by the Earth's GM over JPL's mass of the Earth.
 */
export function solarBaseline(physical: PhysicalFile, planets: PlanetsFile, moon: MoonFile, jdTdb: number, figure: (id: string) => number | null): Baseline {
  const figures: Shapes = Object.fromEntries(BODY_IDS.map((id) => [id, { j2: figure(`${id}.j2`), inertia: figure(`${id}.momentOfInertia`) }]));
  const climates = worldClimates(figure);
  const sunLight = figure('sun.luminosity');
  const shapes: Shapes = Object.fromEntries([...new Set([...Object.keys(figures), ...Object.keys(climates), 'sun'])].map((id) => [id, { ...figures[id], climate: climates[id] ?? null, luminosityW: id === 'sun' ? sunLight : null }]));
  const earthMassKg = (planets.bodies.find((b) => b.name === 'Earth')?.physical.massE24Kg ?? Number.NaN) * 1e24;
  const scenario = seedSolarSystem(createEphemeris(planets, moon, physical), physical, jdTdb, {}, shapes);
  return { scenario, gPerKg: physical.gmKm3S2.Earth / earthMassKg, atStep: 0, auKm: physical.auKm };
}

/** The scenario a laboratory share link carries (its `s=` text, or the whole link), validated; or why not. */
export async function sharedBaseline(link: string, atStep: number, gPerKg: number, auKm: number): Promise<{ ok: true; baseline: Baseline } | { ok: false; errors: string[] }> {
  const m = /[?&]s=([A-Za-z0-9_-]+)/u.exec(link);
  const raw = await decodeScenario(m?.[1] ?? link);
  if (raw === null) return { ok: false, errors: ['the link could not be read'] };
  const checked = validateScenario(raw);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  return { ok: true, baseline: { scenario: checked.scenario, gPerKg, atStep, auKm } };
}

/** A body's Hill radius about its primary's own primary (km), from a state; null without one. */
export function hillAbout(s: SimState, i: number): number | null {
  const p = primaryOf(s.gm, s.pos, i);
  if (p < 0) return null;
  const o = orbitNow(s, i);
  return o.aKm === null || o.e === null ? null : hillRadiusKm(o.aKm, o.e, s.gm[i] ?? 0, s.gm[p] ?? 0);
}
