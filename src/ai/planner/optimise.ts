import type { Engine } from '../../sim/engine';
import type { ExperimentId } from '../types';
import { applyLabCommand } from './apply';
import { AbortedError, engineAt, hillAbout, orbitNow, worldFromState, type Baseline, type RunOptions } from './compare';
import { EXPERIMENT_PARAMS, isPlan, planExperiment } from './experiments';

/**
 * One parameter of an experiment searched for a goal, each probe a headless run (bisection: the goals
 * here are thresholds and targets that change one way as the parameter grows):
 * - escape: the smallest value at which `body` has left the body it moves about by the horizon (beyond
 *   that body's Hill radius, or, about a body with no primary of its own, no longer bound to it);
 * - period: the value at which `body`'s osculating period about its primary at the horizon is
 *   `targetDays` (an unbound orbit counts as longer than any).
 *
 * The engine is brought to the laboratory's step once; each probe applies the plan's commands through
 * the engine's API, integrates to the horizon, reads the goal, and undoes its edits, which takes the
 * run back exactly (bit for bit) to where it was. At most 24 probes, the bracket's ends included.
 */

export type OptimiseGoal = { kind: 'escape'; body: string } | { kind: 'period'; body: string; targetDays: number };

export interface OptimiseSearch {
  experiment: ExperimentId;
  /** The experiment's other parameters; the searched one is filled in for each probe. */
  params: Readonly<Record<string, number | string>>;
  parameter: string;
  lo: number;
  hi: number;
  /** Halve the bracket in log space (a mass factor) or linearly (a speed). */
  scale: 'linear' | 'log';
  goal: OptimiseGoal;
  horizonDays: number;
  /** Probes allowed (at most 24). */
  maxProbes?: number;
  /** Stop when the bracket is this narrow relative to its ends. */
  tolerance?: number;
}

export interface OptimiseProbe {
  value: number;
  /** escape: 1 escaped, -1 not; period: the period found (days; Infinity unbound or gone). */
  measure: number;
}

export interface OptimiseResult {
  value: number | null;
  bracket: [number, number];
  runs: number;
  outcome: 'converged' | 'probes' | 'not-bracketed' | 'invalid';
  probes: OptimiseProbe[];
}

export const MAX_PROBES = 24;
const DAY_S = 86_400;

/** Reads the goal from the run as it stands (after the horizon). */
function read(goal: OptimiseGoal, engine: Engine, primaryId: string | null, hillKm: number | null): number {
  const s = engine.state;
  const i = s.ids.indexOf(goal.body);
  if (goal.kind === 'period') {
    if (i < 0) return Number.POSITIVE_INFINITY;
    const o = orbitNow(s, i);
    return o.periodS === null ? Number.POSITIVE_INFINITY : o.periodS / DAY_S;
  }
  const p = primaryId === null ? -1 : s.ids.indexOf(primaryId);
  if (i < 0 || p < 0) return -1;
  const d = Math.hypot(...[0, 1, 2].map((k) => (s.pos[i * 3 + k] ?? 0) - (s.pos[p * 3 + k] ?? 0)));
  if (hillKm !== null) return d > hillKm ? 1 : -1;
  // About a body with no primary of its own: escaped when no longer bound to it.
  const v2 = [0, 1, 2].reduce((sum, k) => sum + ((s.vel[i * 3 + k] ?? 0) - (s.vel[p * 3 + k] ?? 0)) ** 2, 0);
  return v2 / 2 - ((s.gm[p] ?? 0) + (s.gm[i] ?? 0)) / d >= 0 ? 1 : -1;
}

/** The sign that decides which half of the bracket the answer is in. */
const side = (goal: OptimiseGoal, measure: number): number => (goal.kind === 'escape' ? Math.sign(measure) : Math.sign(measure - goal.targetDays) || 0);

export async function optimise(base: Baseline, search: OptimiseSearch, options: RunOptions = {}): Promise<OptimiseResult> {
  const spec = EXPERIMENT_PARAMS[search.experiment][search.parameter];
  const maxProbes = Math.min(MAX_PROBES, Math.max(2, Math.floor(search.maxProbes ?? MAX_PROBES)));
  const tol = search.tolerance ?? 1e-4;
  const invalid = (): OptimiseResult => ({ value: null, bracket: [search.lo, search.hi], runs: 0, outcome: 'invalid', probes: [] });
  if (spec?.kind !== 'number' || !(search.lo < search.hi) || search.lo < spec.min || search.hi > spec.max || (search.scale === 'log' && !(search.lo > 0))) return invalid();
  const engine = await engineAt(base, options);
  const world = worldFromState(engine.state, base.gPerKg, base.auKm, base.scenario.persistentIds ?? []);
  const subject = engine.state.ids.indexOf(search.goal.body);
  if (subject < 0) return invalid();
  const primaryIndex = orbitNow(engine.state, subject).primary;
  const primaryId = primaryIndex >= 0 ? (engine.state.ids[primaryIndex] ?? null) : null;
  const hillKm = primaryIndex >= 0 ? hillAbout(engine.state, primaryIndex) : null;
  const t0 = engine.state.t;
  const probes: OptimiseProbe[] = [];

  const probe = async (value: number): Promise<number | null> => {
    const plan = planExperiment(search.experiment, { ...search.params, [search.parameter]: value, horizonDays: search.horizonDays }, null, { world });
    if (!isPlan(plan)) return null;
    let edits = 0;
    for (const c of plan.commands) {
      const applied = applyLabCommand(engine, c, base.gPerKg);
      if (!applied.ok) break;
      edits += 1;
    }
    if (edits !== plan.commands.length) {
      for (let k = 0; k < edits; k += 1) engine.undo();
      return null;
    }
    const tEnd = t0 + search.horizonDays * DAY_S;
    const slice = options.sliceSteps ?? 2000;
    for (;;) {
      const taken = engine.advanceTo(tEnd, slice);
      if (options.signal?.aborted) {
        for (let k = 0; k < edits; k += 1) engine.undo();
        throw new AbortedError();
      }
      if (taken < slice) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const measure = read(search.goal, engine, primaryId, hillKm);
    // Back to the fork exactly: each edit undone restores the checkpoint taken before it.
    for (let k = 0; k < edits; k += 1) engine.undo();
    probes.push({ value, measure });
    options.onProgress?.(probes.length / maxProbes, 'run');
    return measure;
  };

  let a = search.lo;
  let b = search.hi;
  const fa = await probe(a);
  const fb = await probe(b);
  if (fa === null || fb === null) return { value: null, bracket: [a, b], runs: probes.length, outcome: 'invalid', probes };
  const sa = side(search.goal, fa);
  const sb = side(search.goal, fb);
  if (sa === 0) return { value: a, bracket: [a, a], runs: probes.length, outcome: 'converged', probes };
  if (sb === 0) return { value: b, bracket: [b, b], runs: probes.length, outcome: 'converged', probes };
  if (sa === sb) return { value: null, bracket: [a, b], runs: probes.length, outcome: 'not-bracketed', probes };
  let outcome: OptimiseResult['outcome'] = 'probes';
  while (probes.length < maxProbes) {
    if (b - a <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-12)) {
      outcome = 'converged';
      break;
    }
    const mid = search.scale === 'log' ? Math.sqrt(a * b) : (a + b) / 2;
    const fm = await probe(mid);
    if (fm === null) break;
    const sm = side(search.goal, fm);
    if (sm === 0) {
      a = mid;
      b = mid;
      outcome = 'converged';
      break;
    }
    if (sm === sa) a = mid;
    else b = mid;
  }
  if (outcome === 'probes' && b - a <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-12)) outcome = 'converged';
  // An escape's threshold: the smallest value seen to escape (the bracket's escaping end). A target: the bracket's middle.
  const escapingEnd = sa > 0 ? a : b;
  const value = search.goal.kind === 'escape' ? escapingEnd : search.scale === 'log' ? Math.sqrt(a * b) : (a + b) / 2;
  return { value, bracket: [a, b], runs: probes.length, outcome, probes };
}
