import type { LabCommand, UniverseLab } from '../../core/types';
import messages from '../../i18n/en.ai.tools.json' with { type: 'json' };
import type { AiContext, ExperimentId, ExperimentPlan, ToolProblem } from '../types';

/**
 * Experiments as deterministic plans: a small model (or the router) names an experiment and its few
 * numbers; this turns them into the laboratory's own commands (src/core/types.ts LabCommand, as
 * src/explore/lab.ts accepts them), within bounds, against the bodies the laboratory has now. The
 * model never writes a command itself.
 *
 * Bodies are named by id or by name (without regard to case). Bounds:
 * - scale-mass: body, factor 0.01 to 100 (a body with mass).
 * - remove-body: body (not one the scenario keeps, as it keeps the Sun).
 * - kick-body: body, dvKmS -50 to 50 (not 0), direction prograde, retrograde, radial-out or radial-in
 *   (about its primary).
 * - impact: target, diameterKm 0.01 to 1000, speedKmS 1 to 72 (and at least the target's escape speed:
 *   nothing falling from space strikes slower), angleDeg 15 to 90 from the horizontal. The impactor is
 *   stony (3,000 kg/m^3, illustrative) and starts twenty of the target's radii away (closer inside a
 *   small Hill sphere) on the two-body path that strikes at that speed and angle.
 * - add-moon: host, distanceKm (above its surface, within half its Hill radius), massKg 1e6 to 1e26 and
 *   at most half the host's mass; on a circular orbit, as dense as rock (3,000 kg/m^3, illustrative).
 * - second-star: massSun 0.1 to 10, distanceAu 0.5 to 1000; on a circular orbit about the heaviest body,
 *   its radius from the main sequence's rough R ~ M^0.8 (illustrative).
 * - change-orbit: body, aFactor 0.2 to 5 (times its semi-major axis now), e 0 to 0.95; the same plane,
 *   orientation and true anomaly; its periapsis above its primary's surface.
 * - horizonDays (any experiment): how far ahead to integrate when comparing, 1 to 36,525 (a century).
 */

export interface PlanBody {
  id: string;
  name: string;
  massKg: number;
  /** Unknown where the context gives only a summary (AiContext.lab). */
  radiusKm: number | null;
  primary: string | null;
  /** Its osculating orbit about its primary (bound orbits only); the angles where known (degrees). */
  orbit: { aKm: number; e: number; iDeg?: number; nodeDeg?: number; periapsisArgDeg?: number; trueAnomalyDeg?: number; hillKm?: number | null } | null;
  /** Kept in every merger and never removed (the Sun). */
  persistent: boolean;
}

/** The laboratory as the planner needs it. */
export interface PlanWorld {
  bodies: readonly PlanBody[];
  /** kg to GM (km^3 s^-2 per kg): the laboratory's one G; null where unknown. */
  gPerKg: number | null;
  /** One solar mass (kg); null where unknown. */
  sunMassKg: number | null;
  auKm: number;
}

/** Names the planner gives new bodies (shown in the laboratory): from the tools' message file. */
export interface PlanNames {
  moon: string;
  star: string;
  impactor: string;
}

const text = (key: string): string => (messages as Record<string, string>)[key] ?? key;
export const DEFAULT_NAMES: PlanNames = { moon: text('ai.tool.experiment.name.moon'), star: text('ai.tool.experiment.name.star'), impactor: text('ai.tool.experiment.name.impactor') };

export const EXPERIMENT_IDS: readonly ExperimentId[] = ['scale-mass', 'remove-body', 'kick-body', 'impact', 'add-moon', 'second-star', 'change-orbit'];
export const KICK_DIRECTIONS = ['prograde', 'retrograde', 'radial-out', 'radial-in'] as const;
export type KickDirection = (typeof KICK_DIRECTIONS)[number];

/** Each experiment's parameters: which are bodies, numbers (with their bounds) or choices. */
export const EXPERIMENT_PARAMS: Readonly<Record<ExperimentId, Readonly<Record<string, { kind: 'body' } | { kind: 'number'; min: number; max: number } | { kind: 'choice'; of: readonly string[] }>>>> = {
  'scale-mass': { body: { kind: 'body' }, factor: { kind: 'number', min: 0.01, max: 100 } },
  'remove-body': { body: { kind: 'body' } },
  'kick-body': { body: { kind: 'body' }, dvKmS: { kind: 'number', min: -50, max: 50 }, direction: { kind: 'choice', of: KICK_DIRECTIONS } },
  impact: { target: { kind: 'body' }, diameterKm: { kind: 'number', min: 0.01, max: 1000 }, speedKmS: { kind: 'number', min: 1, max: 72 }, angleDeg: { kind: 'number', min: 15, max: 90 } },
  'add-moon': { host: { kind: 'body' }, distanceKm: { kind: 'number', min: 1, max: 1e10 }, massKg: { kind: 'number', min: 1e6, max: 1e26 } },
  'second-star': { massSun: { kind: 'number', min: 0.1, max: 10 }, distanceAu: { kind: 'number', min: 0.5, max: 1000 } },
  'change-orbit': { body: { kind: 'body' }, aFactor: { kind: 'number', min: 0.2, max: 5 }, e: { kind: 'number', min: 0, max: 0.95 } },
};

export const HORIZON_DAYS = { min: 1, max: 36_525 } as const;
/** How far ahead each experiment is compared unless asked: long enough to see what it does. */
export const DEFAULT_HORIZON_DAYS: Readonly<Record<ExperimentId, number>> = { 'scale-mass': 3650, 'remove-body': 3650, 'kick-body': 365, impact: 2, 'add-moon': 365, 'second-star': 3650, 'change-orbit': 3650 };

/** Illustrative densities (kg/m^3): a stony impactor, a rocky moon. */
const ROCK = 3000;
const SUN_RADIUS_KM = 695_700;
/** The impactor starts this many of the target's radii away. */
const START_RADII = 20;

const P = 'ai.tool.experiment';

/**
 * The Sun's GM (km^3 s^-2, DE440: physical.json gmKm3S2.Sun, the value src/sim/climate.ts holds as
 * SUN_GM), for one solar mass in kilograms by the laboratory's G. Kept here so the plans need none of
 * the engine (a test checks the three agree).
 */
export const SUN_GM_KM3S2 = 132_712_440_041.279_42;
const prob = (path: string, key: string, values?: Record<string, string | number>): ToolProblem => (values ? { path, messageKey: `${P}.${key}`, values } : { path, messageKey: `${P}.${key}` });

/** A body by id, or by name without regard to case. */
export function resolveBody(world: PlanWorld, ref: string): PlanBody | null {
  const want = ref.trim().toLowerCase();
  return world.bodies.find((b) => b.id === ref) ?? world.bodies.find((b) => b.id.toLowerCase() === want || b.name.toLowerCase() === want) ?? null;
}

const allIds = (world: PlanWorld): string => world.bodies.map((b) => b.id).join(', ');

/** The parameters' own checks: names, types and bounds (no bodies looked up). */
export function paramProblems(id: ExperimentId, params: Readonly<Record<string, unknown>>): ToolProblem[] {
  const spec = EXPERIMENT_PARAMS[id];
  const out: ToolProblem[] = [];
  for (const name of Object.keys(params)) {
    if (name !== 'horizonDays' && !Object.hasOwn(spec, name)) out.push(prob(name, 'notFor', { experiment: id }));
  }
  for (const [name, s] of Object.entries(spec)) {
    const v = params[name];
    if (v === undefined) {
      out.push({ path: name, messageKey: 'ai.tool.problem.required' });
      continue;
    }
    if (s.kind === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) out.push({ path: name, messageKey: 'ai.tool.problem.type', values: { expected: 'number', got: typeof v } });
      else if (v < s.min || v > s.max) out.push(prob(name, 'range', { min: s.min, max: s.max }));
    } else if (typeof v !== 'string' || v.trim() === '') {
      out.push({ path: name, messageKey: 'ai.tool.problem.type', values: { expected: 'string', got: typeof v } });
    } else if (s.kind === 'choice' && !s.of.includes(v)) {
      out.push({ path: name, messageKey: 'ai.tool.problem.enum', values: { allowed: s.of.join(', '), more: 0 } });
    }
  }
  const h = params.horizonDays;
  if (h !== undefined && (typeof h !== 'number' || !Number.isFinite(h) || h < HORIZON_DAYS.min || h > HORIZON_DAYS.max)) out.push(prob('horizonDays', 'range', { min: HORIZON_DAYS.min, max: HORIZON_DAYS.max }));
  if (id === 'kick-body' && params.dvKmS === 0) out.push(prob('dvKmS', 'zero'));
  return out;
}

const n = (params: Readonly<Record<string, unknown>>, name: string): number => (typeof params[name] === 'number' ? params[name] : Number.NaN);
const s = (params: Readonly<Record<string, unknown>>, name: string): string => (typeof params[name] === 'string' ? params[name] : '');

/** The heaviest body: the star a second star is set about. */
const heaviest = (world: PlanWorld): PlanBody | null => world.bodies.reduce<PlanBody | null>((best, b) => (best === null || b.massKg > best.massKg ? b : best), null);

/** The bodies' own checks against the laboratory as it is (skipped where the world does not know). */
function worldProblems(id: ExperimentId, params: Readonly<Record<string, unknown>>, world: PlanWorld): ToolProblem[] {
  const out: ToolProblem[] = [];
  const need = (name: string): PlanBody | null => {
    const b = resolveBody(world, s(params, name));
    if (!b) out.push(prob(name, 'noBody', { body: s(params, name), allowed: allIds(world) }));
    return b;
  };
  switch (id) {
    case 'scale-mass': {
      const b = need('body');
      if (b && !(b.massKg > 0)) out.push(prob('body', 'massless', { body: b.name }));
      break;
    }
    case 'remove-body': {
      const b = need('body');
      if (b?.persistent) out.push(prob('body', 'persistent', { body: b.name }));
      break;
    }
    case 'kick-body':
      need('body');
      break;
    case 'impact': {
      const b = need('target');
      if (b && b.radiusKm !== null && world.gPerKg !== null) {
        const escape = Math.sqrt((2 * b.massKg * world.gPerKg) / b.radiusKm);
        if (n(params, 'speedKmS') < escape) out.push(prob('speedKmS', 'slow', { min: Math.ceil(escape * 100) / 100 }));
      }
      break;
    }
    case 'add-moon': {
      const host = need('host');
      if (!host) break;
      const mass = n(params, 'massKg');
      const d = n(params, 'distanceKm');
      if (mass > 0.5 * host.massKg) out.push(prob('massKg', 'tooHeavy', { max: 0.5 * host.massKg }));
      const moonRadius = Math.cbrt((3 * mass) / (4 * Math.PI * ROCK)) / 1000;
      if (host.radiusKm !== null && d <= 1.2 * host.radiusKm + moonRadius) out.push(prob('distanceKm', 'tooClose', { min: Math.ceil(1.2 * host.radiusKm + moonRadius) }));
      const hill = host.orbit?.hillKm ?? null;
      if (hill !== null && d >= 0.5 * hill) out.push(prob('distanceKm', 'tooFar', { max: Math.floor(0.5 * hill) }));
      break;
    }
    case 'second-star':
      if (world.sunMassKg === null || !heaviest(world)) out.push(prob('', 'needsState'));
      break;
    case 'change-orbit': {
      const b = need('body');
      if (!b) break;
      if (!b.orbit || b.primary === null) {
        out.push(prob('body', 'noOrbit', { body: b.name }));
        break;
      }
      const primary = resolveBody(world, b.primary);
      const peri = b.orbit.aKm * n(params, 'aFactor') * (1 - n(params, 'e'));
      const floor = primary?.radiusKm ?? null;
      if (floor !== null && peri <= floor + (b.radiusKm ?? 0)) out.push(prob('aFactor', 'periapsis', { km: Math.round(peri) }));
      break;
    }
  }
  return out;
}

/** Every problem with an experiment's parameters, against the world where one is given. */
export function experimentProblems(id: ExperimentId, params: Readonly<Record<string, unknown>>, world: PlanWorld | null): ToolProblem[] {
  const own = paramProblems(id, params);
  return own.length > 0 || !world ? own : worldProblems(id, params, world);
}

/** The world the context summarises (no radii, no orbits' angles); null outside the laboratory. */
export function worldFromContext(ctx: AiContext): PlanWorld | null {
  if (!ctx.lab) return null;
  const sun = ctx.lab.bodies.find((b) => b.id === 'sun');
  return {
    bodies: ctx.lab.bodies.map((b) => ({ id: b.id, name: b.name, massKg: b.massKg, radiusKm: null, primary: b.centralId, orbit: b.aKm !== null && b.e !== null && b.e < 1 && b.aKm > 0 ? { aKm: b.aKm, e: b.e } : null, persistent: b.id === 'sun' })),
    gPerKg: null,
    sunMassKg: sun ? sun.massKg : null,
    auKm: 149_597_870.7,
  };
}

/** The world the laboratory's view reports (everything the planner needs). */
export function worldFromLab(lab: UniverseLab): PlanWorld {
  const weighed = lab.bodies.find((b) => b.massKg > 0 && b.gm > 0);
  const gPerKg = weighed ? weighed.gm / weighed.massKg : null;
  return {
    bodies: lab.bodies.map((b) => ({
      id: b.id,
      name: b.name,
      massKg: b.massKg,
      radiusKm: b.radiusKm,
      primary: b.primary,
      orbit: b.orbit?.bound ? { aKm: b.orbit.aKm, e: b.orbit.e, iDeg: b.orbit.iDeg, nodeDeg: b.orbit.nodeDeg, periapsisArgDeg: b.orbit.periapsisArgDeg, trueAnomalyDeg: b.orbit.trueAnomalyDeg, hillKm: b.orbit.hillKm } : null,
      persistent: b.persistent,
    })),
    gPerKg,
    sunMassKg: gPerKg ? SUN_GM_KM3S2 / gPerKg : null,
    auKm: lab.auKm,
  };
}

/**
 * The impactor's state relative to the target (km, km/s, the scenario's frame): on the two-body path
 * that meets the target's surface at `speed` and `angle` from the horizontal, `d` from its centre,
 * inbound. Energy and angular momentum fix the path: e = v^2/2 - mu/r_c, h = r_c v cos(angle); at d,
 * the speed is sqrt(2 (e + mu / d)) and its part across the line of centres h / d.
 */
export function impactorState(mu: number, contactKm: number, speedKmS: number, angleDeg: number, startKm: number): { posKm: [number, number, number]; velKmS: [number, number, number] } {
  const energy = (speedKmS * speedKmS) / 2 - mu / contactKm;
  const h = contactKm * speedKmS * Math.cos((angleDeg * Math.PI) / 180);
  const v = Math.sqrt(Math.max(0, 2 * (energy + mu / startKm)));
  const across = h / startKm;
  const inward = Math.sqrt(Math.max(0, v * v - across * across));
  // Along +x from the target, moving in (-x) and across (+y): in the scenario's reference plane.
  return { posKm: [startKm, 0, 0], velKmS: [-inward, across, 0] };
}

/** The commands an experiment makes (its parameters checked first). */
function commandsFor(id: ExperimentId, params: Readonly<Record<string, unknown>>, world: PlanWorld, names: PlanNames): LabCommand[] | ToolProblem[] {
  const body = (name: string): PlanBody => resolveBody(world, s(params, name)) as PlanBody;
  switch (id) {
    case 'scale-mass': {
      const b = body('body');
      return [{ kind: 'mass', id: b.id, massKg: b.massKg * n(params, 'factor') }];
    }
    case 'remove-body':
      return [{ kind: 'remove', id: body('body').id }];
    case 'kick-body': {
      const ms = n(params, 'dvKmS') * 1000;
      const dir = s(params, 'direction') as KickDirection;
      const along = dir === 'prograde' ? ms : dir === 'retrograde' ? -ms : 0;
      const radial = dir === 'radial-out' ? ms : dir === 'radial-in' ? -ms : 0;
      return [{ kind: 'impulse', id: body('body').id, progradeMs: along, normalMs: 0, radialMs: radial }];
    }
    case 'impact': {
      const t = body('target');
      if (t.radiusKm === null || world.gPerKg === null) return [prob('target', 'needsState')];
      const r = n(params, 'diameterKm') / 2;
      const massKg = ROCK * (4 / 3) * Math.PI * (r * 1000) ** 3;
      const mu = (t.massKg + massKg) * world.gPerKg;
      const contact = t.radiusKm + r;
      const hill = t.orbit?.hillKm ?? Number.POSITIVE_INFINITY;
      const start = Math.max(3 * contact, Math.min(START_RADII * t.radiusKm, 0.3 * hill));
      const st = impactorState(mu, contact, n(params, 'speedKmS'), n(params, 'angleDeg'), start);
      return [{ kind: 'addState', relativeTo: t.id, posKm: st.posKm, velKmS: st.velKmS, massKg, radiusKm: r, name: names.impactor }];
    }
    case 'add-moon': {
      const host = body('host');
      const massKg = n(params, 'massKg');
      return [{ kind: 'addOrbit', primary: host.id, distanceKm: n(params, 'distanceKm'), massKg, radiusKm: Math.cbrt((3 * massKg) / (4 * Math.PI * ROCK)) / 1000, name: names.moon }];
    }
    case 'second-star': {
      const star = heaviest(world);
      if (!star || world.sunMassKg === null) return [prob('', 'needsState')];
      const m = n(params, 'massSun');
      return [{ kind: 'addOrbit', primary: star.id, distanceKm: n(params, 'distanceAu') * world.auKm, massKg: m * world.sunMassKg, radiusKm: SUN_RADIUS_KM * m ** 0.8, name: names.star }];
    }
    case 'change-orbit': {
      const b = body('body');
      const o = b.orbit;
      if (!o || o.iDeg === undefined || o.nodeDeg === undefined || o.periapsisArgDeg === undefined || o.trueAnomalyDeg === undefined) return [prob('body', 'needsState')];
      return [{ kind: 'elements', id: b.id, aKm: o.aKm * n(params, 'aFactor'), e: n(params, 'e'), iDeg: o.iDeg, nodeDeg: o.nodeDeg, periapsisArgDeg: o.periapsisArgDeg, trueAnomalyDeg: o.trueAnomalyDeg }];
    }
  }
}

/** The sentence a plan is shown with (its message key and values): bodies by name where the world knows them. */
export function experimentPreview(id: ExperimentId, params: Readonly<Record<string, unknown>>, world: PlanWorld | null): { key: string; values: Record<string, string | number> } {
  const name = (key: string): string => (world ? resolveBody(world, s(params, key))?.name : undefined) ?? s(params, key);
  const days = typeof params.horizonDays === 'number' ? params.horizonDays : DEFAULT_HORIZON_DAYS[id];
  const values: Record<string, string | number> = { days };
  for (const [key, spec] of Object.entries(EXPERIMENT_PARAMS[id])) values[key] = spec.kind === 'body' ? name(key) : spec.kind === 'number' ? n(params, key) : s(params, key);
  // A message's choices are plain words: radial-out as radialOut.
  if (id === 'kick-body') values.way = s(params, 'direction').replace(/-(\w)/gu, (_m, c: string) => c.toUpperCase());
  return { key: `${P}.${id}.preview`, values };
}

/** A command's numbers are finite and its ids named: what the laboratory would otherwise ignore without a word. */
export function labCommandProblems(c: LabCommand): ToolProblem[] {
  const numbers: number[] = [];
  const ids: string[] = [];
  switch (c.kind) {
    case 'mass':
      numbers.push(c.massKg);
      ids.push(c.id);
      if (!(c.massKg >= 0)) return [prob('', 'invalid')];
      break;
    case 'remove':
      ids.push(c.id);
      break;
    case 'impulse':
      numbers.push(c.progradeMs, c.normalMs, c.radialMs);
      ids.push(c.id);
      break;
    case 'addState':
      numbers.push(...c.posKm, ...c.velKmS, c.massKg, c.radiusKm);
      ids.push(c.relativeTo);
      if (!(c.radiusKm > 0) || !(c.massKg >= 0)) return [prob('', 'invalid')];
      break;
    case 'addOrbit':
      numbers.push(c.distanceKm, c.massKg, c.radiusKm);
      ids.push(c.primary);
      if (!(c.radiusKm > 0) || !(c.massKg >= 0) || !(c.distanceKm > 0)) return [prob('', 'invalid')];
      break;
    case 'elements':
      numbers.push(c.aKm, c.e, c.iDeg, c.nodeDeg, c.periapsisArgDeg, c.trueAnomalyDeg);
      ids.push(c.id);
      if (!(c.aKm > 0) || !(c.e >= 0 && c.e < 1)) return [prob('', 'invalid')];
      break;
    default:
      return [prob('', 'invalid')];
  }
  if (!numbers.every(Number.isFinite) || ids.some((x) => x.length === 0)) return [prob('', 'invalid')];
  return [];
}

/**
 * The plan for an experiment: its checked parameters, the laboratory's commands, the sentence the
 * confirmation card shows (its key and values) and the comparison's horizon; or what is wrong. The
 * world is the laboratory's as its view reports it, an engine's state, or (with less to go on) the
 * context's summary.
 */
export function planExperiment(id: ExperimentId, params: Readonly<Record<string, unknown>>, ctx: AiContext | null, options: { world?: PlanWorld | null; names?: PlanNames } = {}): ExperimentPlan | ToolProblem[] {
  if (!EXPERIMENT_IDS.includes(id)) return [{ path: 'experiment', messageKey: 'ai.tool.problem.enum', values: { allowed: EXPERIMENT_IDS.join(', '), more: 0 } }];
  const world = options.world ?? (ctx ? worldFromContext(ctx) : null);
  if (!world) return [prob('', 'noLab')];
  const problems = experimentProblems(id, params, world);
  if (problems.length > 0) return problems;
  const made = commandsFor(id, params, world, options.names ?? DEFAULT_NAMES);
  const commands = made.filter((c): c is LabCommand => 'kind' in c);
  if (commands.length !== made.length) return made.filter((c): c is ToolProblem => 'messageKey' in c);
  const bad = commands.flatMap(labCommandProblems);
  if (bad.length > 0) return bad;
  const horizonDays = typeof params.horizonDays === 'number' ? params.horizonDays : DEFAULT_HORIZON_DAYS[id];
  const kept: Record<string, number | string> = { horizonDays };
  for (const key of Object.keys(EXPERIMENT_PARAMS[id])) {
    const v = params[key];
    if (typeof v === 'number' || typeof v === 'string') kept[key] = v;
  }
  const preview = experimentPreview(id, params, world);
  return { id, params: kept, commands, previewKey: preview.key, previewValues: preview.values, horizonDays };
}

/** True when planExperiment gave a plan rather than problems. */
export const isPlan = (x: ExperimentPlan | ToolProblem[]): x is ExperimentPlan => !Array.isArray(x);
