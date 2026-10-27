import type { BodyId, I18n } from '../../core/types';
import { worldFacts } from '../../explore/about';
import { bulkDensity, crater, CRUST_DENSITY, SOLID_MAX_GM } from '../../sim/craters';
import { hillRadiusKm, LIGHT_KM_S, rocheLimits } from '../../sim/elements';
import { impactOutcome } from '../../sim/impacts';
import { hohmann } from '../../sim/ships';
import type { AnswerBlock, Fact, ToolDefinition, ToolOutcome, ToolProblem } from '../types';
import { bodyGm, dateJdTdb, ELEMENTS_SOURCE, GM_SOURCE, heliocentricKm, jplData, meanRadiusKm, planetSemiMajorKm, RADIUS_SOURCE, type JplData } from './data';
import { BODY, bodyName, done, ensureMessages, fact, failed, isBodyId, isoUtc, num, problem, refused, say, sig, str } from './shared';

/**
 * Calculators: deterministic numbers from the explorer's own data (public/assets/jpl: DE440's GM,
 * NAIF's radii, JPL's planetary elements and physical parameters) through the app's own code
 * (src/sim, src/astro, src/explore/about.ts). The inputs come back as facts labelled observed, with
 * their sources; what is worked out from them is labelled model (a two-body, Newtonian model; a
 * scaling law), never a measurement.
 */

const ALT = { type: 'number', minimum: 0, maximum: 1e9, description: 'Height above the surface, km' } as const;
const KM = { type: 'number', minimum: 1e-3, maximum: 1e12, description: 'km' } as const;
/** Kilograms per tonne of TNT, as energy: 4.184e9 J (by definition); a megatonne is 4.184e15 J. */
const MEGATON_J = 4.184e15;
const DAY_S = 86_400;

const PLANETS: readonly BodyId[] = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

/** The world's GM and radius as facts (the inputs every calculator starts from). */
function inputs(i18n: I18n, data: JplData, id: BodyId): Fact[] {
  return [
    fact(i18n, `${id}.gm`, 'ai.tool.calc.gm', { body: bodyName(i18n, id) }, sig(bodyGm(data, id), 7), 'km³/s²', 'observed', [GM_SOURCE]),
    fact(i18n, `${id}.radius`, 'ai.tool.calc.radius', { body: bodyName(i18n, id) }, sig(meanRadiusKm(data, id), 6), 'km', 'observed', [RADIUS_SOURCE]),
  ];
}

/** A calculator's outcome: its facts shown as one block, and the line for the log. */
function answer(key: string, values: Record<string, string | number>, facts: Fact[], notes: readonly string[] = []): ToolOutcome {
  const blocks: AnswerBlock[] = [{ type: 'facts', facts }, ...notes.map((k): AnswerBlock => ({ type: 'notice', key: k }))];
  return done(key, values, { facts, blocks });
}

/** Runs a calculator with the data loaded; anything thrown is reported, never guessed around. */
async function withData(env: { app: Parameters<typeof jplData>[0]; i18n: I18n }, compute: (data: JplData) => ToolOutcome): Promise<ToolOutcome> {
  ensureMessages(env.i18n);
  try {
    return compute(await jplData(env.app));
  } catch (err) {
    return failed(err);
  }
}

const speedTool = (name: 'calc.escape_speed' | 'calc.circular_speed', factor: 2 | 1): ToolDefinition => ({
  name,
  kind: 'calc',
  summary: factor === 2 ? "Escape speed from a world's surface (or a height above it), from its GM and radius." : "Speed of a circular orbit at a height above a world's surface (0: skimming it).",
  keywords: factor === 2 ? ['escape speed', 'escape velocity', 'leave', 'escape'] : ['orbital speed', 'circular orbit', 'orbit speed', 'first cosmic velocity', 'how fast'],
  args: { type: 'object', properties: { body: BODY, altitudeKm: ALT }, required: ['body'], additionalProperties: false },
  available: () => true,
  preview: (args, _ctx, i18n) => say(i18n, `ai.tool.${name}.preview`, { body: bodyName(i18n, str(args, 'body') ?? ''), altitudeKm: num(args, 'altitudeKm') ?? 0 }),
  run: (args, env) =>
    withData(env, (data) => {
      const id = str(args, 'body') as BodyId;
      const h = num(args, 'altitudeKm') ?? 0;
      const r = meanRadiusKm(data, id) + h;
      const v = Math.sqrt((factor * bodyGm(data, id)) / r);
      const i18n = env.i18n;
      const facts = [fact(i18n, `${name}.${id}`, `ai.tool.${name}.value`, { body: bodyName(i18n, id), altitudeKm: h }, sig(v, 4), 'km/s', 'model', [GM_SOURCE, RADIUS_SOURCE]), ...inputs(i18n, data, id)];
      return answer(`ai.tool.${name}.observed`, { body: bodyName(i18n, id), speed: sig(v, 4) }, facts);
    }),
});

export const calcEscapeSpeed = speedTool('calc.escape_speed', 2);
export const calcCircularSpeed = speedTool('calc.circular_speed', 1);

export const calcOrbitalPeriod: ToolDefinition = {
  name: 'calc.orbital_period',
  kind: 'calc',
  summary: "Period of an orbit by Kepler's third law: about a primary at aKm, or a planet's year from its mean distance.",
  keywords: ['period', 'orbital period', 'year', 'how long', 'kepler', 'month', 'orbit time'],
  args: {
    type: 'object',
    properties: { primary: BODY, body: BODY, aKm: { ...KM, description: 'Semi-major axis, km' } },
    additionalProperties: false,
  },
  available: () => true,
  check(args) {
    if (args.aKm === undefined) {
      if (!isBodyId(args.body) || !PLANETS.includes(args.body)) return [problem('aKm', 'ai.tool.calc.period.needA')];
      if (args.primary !== undefined && args.primary !== 'sun') return [problem('aKm', 'ai.tool.calc.period.needA')];
      return [];
    }
    return args.primary === undefined ? [problem('primary', 'ai.tool.problem.required')] : [];
  },
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.calc.orbital_period.preview', { body: bodyName(i18n, str(args, 'body') ?? ''), primary: bodyName(i18n, str(args, 'primary') ?? 'sun') }),
  run: (args, env) =>
    withData(env, (data) => {
      const body = isBodyId(args.body) ? args.body : null;
      const primary = isBodyId(args.primary) ? args.primary : 'sun';
      const given = num(args, 'aKm');
      const a = given ?? (body ? planetSemiMajorKm(data, body) : null);
      if (a === null) return refused(problem('aKm', 'ai.tool.calc.period.needA'));
      const mu = bodyGm(data, primary) + (body ? bodyGm(data, body) : 0);
      const periodS = 2 * Math.PI * Math.sqrt((a * a * a) / mu);
      const i18n = env.i18n;
      const facts: Fact[] = [
        fact(i18n, 'period.days', 'ai.tool.calc.orbital_period.value', { body: body ? bodyName(i18n, body) : '', primary: bodyName(i18n, primary) }, sig(periodS / DAY_S, 5), 'd', 'model', [GM_SOURCE]),
        fact(i18n, 'period.years', 'ai.tool.calc.orbital_period.years', {}, sig(periodS / (365.25 * DAY_S), 5), 'yr', 'model', [GM_SOURCE]),
        given === undefined ? fact(i18n, 'period.a', 'ai.tool.calc.semiMajor', { body: body ? bodyName(i18n, body) : '' }, sig(a, 6), 'km', 'observed', [ELEMENTS_SOURCE]) : fact(i18n, 'period.a', 'ai.tool.calc.semiMajorGiven', {}, given, 'km', 'model'),
        fact(i18n, `${primary}.gm`, 'ai.tool.calc.gm', { body: bodyName(i18n, primary) }, sig(bodyGm(data, primary), 7), 'km³/s²', 'observed', [GM_SOURCE]),
      ];
      return answer('ai.tool.calc.orbital_period.observed', { days: sig(periodS / DAY_S, 5) }, facts, ['ai.tool.calc.twoBody']);
    }),
};

function oneDistance(args: Record<string, unknown>): ToolProblem[] {
  const pair = args.from !== undefined || args.to !== undefined;
  const given = [pair, args.distanceKm !== undefined, args.distanceAu !== undefined].filter(Boolean).length;
  if (given !== 1) return [problem('', 'ai.tool.calc.light_time.which')];
  if (pair && (args.from === undefined || args.to === undefined)) return [problem(args.from === undefined ? 'from' : 'to', 'ai.tool.problem.required')];
  if (pair && args.from === args.to) return [problem('to', 'ai.tool.calc.light_time.same')];
  return [];
}

export const calcLightTime: ToolDefinition = {
  name: 'calc.light_time',
  kind: 'calc',
  summary: 'How long light takes over a distance: between two worlds (centre to centre, at the date shown or now), or over distanceKm or distanceAu.',
  keywords: ['light time', 'speed of light', 'how long does light take', 'light travel', 'signal delay', 'light minutes', 'light seconds'],
  args: {
    type: 'object',
    properties: { from: BODY, to: BODY, distanceKm: KM, distanceAu: { type: 'number', minimum: 1e-9, maximum: 1e7, description: 'Distance, au' } },
    additionalProperties: false,
  },
  available: () => true,
  check: (args) => oneDistance(args),
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.calc.light_time.preview', { pair: args.from !== undefined && args.to !== undefined ? 1 : 0, from: bodyName(i18n, str(args, 'from') ?? ''), to: bodyName(i18n, str(args, 'to') ?? '') }),
  run: (args, env) =>
    withData(env, (data) => {
      const i18n = env.i18n;
      const facts: Fact[] = [];
      let km: number;
      const from = isBodyId(args.from) ? args.from : null;
      const to = isBodyId(args.to) ? args.to : null;
      if (from && to) {
        const jd = dateJdTdb(env.app, data, Date.now());
        const a = heliocentricKm(data, from, jd);
        const b = heliocentricKm(data, to, jd);
        km = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        const ms = env.app.universe()?.unixMs ?? Date.now();
        facts.push(fact(i18n, 'light.distance', 'ai.tool.calc.light_time.distance', { from: bodyName(i18n, from), to: bodyName(i18n, to), date: isoUtc(ms) }, sig(km, 6), 'km', 'model', [ELEMENTS_SOURCE, 'jpl-horizons']));
      } else {
        const au = num(args, 'distanceAu');
        km = au !== undefined ? au * data.physical.auKm : (num(args, 'distanceKm') ?? 0);
        facts.push(fact(i18n, 'light.distance', 'ai.tool.calc.light_time.given', {}, sig(km, 7), 'km', 'model'));
      }
      const s = km / LIGHT_KM_S;
      facts.unshift(fact(i18n, 'light.seconds', 'ai.tool.calc.light_time.value', {}, sig(s, 5), 's', 'model', ['light.speed']));
      facts.push(fact(i18n, 'light.minutes', 'ai.tool.calc.light_time.minutes', {}, sig(s / 60, 5), 'min', 'model', ['light.speed']));
      facts.push(fact(i18n, 'light.speed', 'ai.tool.calc.light_time.speed', {}, LIGHT_KM_S, 'km/s', 'observed', ['light.speed']));
      return answer('ai.tool.calc.light_time.observed', { seconds: sig(s, 5) }, facts);
    }),
};

export const calcHohmann: ToolDefinition = {
  name: 'calc.hohmann',
  kind: 'calc',
  summary: 'A Hohmann transfer between two circular orbits about a primary: between planets (about the Sun), or fromKm to toKm.',
  keywords: ['hohmann', 'transfer', 'delta v', 'delta-v', 'trip to mars', 'how much fuel', 'rocket', 'mission', 'travel time', 'interplanetary'],
  args: {
    type: 'object',
    properties: { primary: BODY, from: BODY, to: BODY, fromKm: { ...KM, description: 'First orbit radius, km' }, toKm: { ...KM, description: 'Second orbit radius, km' } },
    additionalProperties: false,
  },
  available: () => true,
  check(args) {
    const out: ToolProblem[] = [];
    for (const [body, radius] of [
      ['from', 'fromKm'],
      ['to', 'toKm'],
    ] as const) {
      const hasBody = args[body] !== undefined;
      const hasRadius = args[radius] !== undefined;
      if (hasBody === hasRadius) out.push(problem(body, 'ai.tool.calc.hohmann.which'));
      else if (hasBody && (!isBodyId(args[body]) || !PLANETS.includes(args[body]) || (args.primary !== undefined && args.primary !== 'sun'))) out.push(problem(body, 'ai.tool.calc.hohmann.planet'));
    }
    if (out.length === 0 && args.from !== undefined && args.from === args.to) out.push(problem('to', 'ai.tool.calc.light_time.same'));
    return out;
  },
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.calc.hohmann.preview', { pair: args.from !== undefined && args.to !== undefined ? 1 : 0, from: bodyName(i18n, str(args, 'from') ?? ''), to: bodyName(i18n, str(args, 'to') ?? '') }),
  run: (args, env) =>
    withData(env, (data) => {
      const i18n = env.i18n;
      const primary = isBodyId(args.primary) ? args.primary : 'sun';
      const radius = (body: unknown, km: number | undefined): number | null => (km !== undefined ? km : isBodyId(body) ? planetSemiMajorKm(data, body) : null);
      const r1 = radius(args.from, num(args, 'fromKm'));
      const r2 = radius(args.to, num(args, 'toKm'));
      if (r1 === null || r2 === null) return refused(problem('', 'ai.tool.calc.hohmann.which'));
      const mu = bodyGm(data, primary);
      // The transfer's changes of speed only: a ship with no propellant (its burns' lengths are not asked for).
      const t = hohmann({ dryKg: 1, fuelKg: 0, thrustN: 1, ispS: 1 }, mu, r1, Math.sqrt(mu / r1), r2);
      const dv1 = Math.abs(t.dv1Ms) / 1000;
      const dv2 = Math.abs(t.dv2Ms) / 1000;
      const facts: Fact[] = [
        fact(i18n, 'hohmann.total', 'ai.tool.calc.hohmann.total', {}, sig(dv1 + dv2, 4), 'km/s', 'model', [GM_SOURCE, ELEMENTS_SOURCE]),
        fact(i18n, 'hohmann.dv1', 'ai.tool.calc.hohmann.dv1', {}, sig(dv1, 4), 'km/s', 'model', [GM_SOURCE]),
        fact(i18n, 'hohmann.dv2', 'ai.tool.calc.hohmann.dv2', {}, sig(dv2, 4), 'km/s', 'model', [GM_SOURCE]),
        fact(i18n, 'hohmann.days', 'ai.tool.calc.hohmann.days', {}, sig(t.coastS / DAY_S, 4), 'd', 'model', [GM_SOURCE]),
        fact(i18n, 'hohmann.r1', 'ai.tool.calc.hohmann.r1', {}, sig(r1, 6), 'km', args.from !== undefined ? 'observed' : 'model', args.from !== undefined ? [ELEMENTS_SOURCE] : []),
        fact(i18n, 'hohmann.r2', 'ai.tool.calc.hohmann.r2', {}, sig(r2, 6), 'km', args.to !== undefined ? 'observed' : 'model', args.to !== undefined ? [ELEMENTS_SOURCE] : []),
      ];
      return answer('ai.tool.calc.hohmann.observed', { total: sig(dv1 + dv2, 4), days: sig(t.coastS / DAY_S, 4) }, facts, ['ai.tool.calc.hohmann.note']);
    }),
};

export const calcRoche: ToolDefinition = {
  name: 'calc.roche',
  kind: 'calc',
  summary: "Roche limits of a primary for a satellite (another world's density, or satelliteDensity in kg/m³): fluid and rigid.",
  keywords: ['roche', 'roche limit', 'torn apart', 'tidal', 'tides', 'rings', 'break up', 'disintegrate'],
  args: {
    type: 'object',
    properties: { primary: BODY, satellite: BODY, satelliteDensity: { type: 'number', minimum: 10, maximum: 30_000, description: 'kg/m³' } },
    required: ['primary'],
    additionalProperties: false,
  },
  available: () => true,
  check: (args) => ((args.satellite === undefined) === (args.satelliteDensity === undefined) ? [problem('satellite', 'ai.tool.calc.roche.which')] : []),
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.calc.roche.preview', { primary: bodyName(i18n, str(args, 'primary') ?? '') }),
  run: (args, env) =>
    withData(env, (data) => {
      const i18n = env.i18n;
      const primary = str(args, 'primary') as BodyId;
      const sat = isBodyId(args.satellite) ? args.satellite : null;
      const rhoP = bulkDensity(bodyGm(data, primary), meanRadiusKm(data, primary));
      const rhoS = sat ? bulkDensity(bodyGm(data, sat), meanRadiusKm(data, sat)) : (num(args, 'satelliteDensity') ?? Number.NaN);
      const R = meanRadiusKm(data, primary);
      const r = rocheLimits(R, rhoP, rhoS);
      const facts: Fact[] = [
        fact(i18n, 'roche.fluid', 'ai.tool.calc.roche.fluid', {}, sig(r.fluidKm, 4), 'km', 'model', [GM_SOURCE, RADIUS_SOURCE]),
        fact(i18n, 'roche.rigid', 'ai.tool.calc.roche.rigid', {}, sig(r.rigidKm, 4), 'km', 'model', [GM_SOURCE, RADIUS_SOURCE]),
        fact(i18n, 'roche.primaryDensity', 'ai.tool.calc.density', { body: bodyName(i18n, primary) }, sig(rhoP, 4), 'kg/m³', 'model', [GM_SOURCE, RADIUS_SOURCE]),
        sat ? fact(i18n, 'roche.satelliteDensity', 'ai.tool.calc.density', { body: bodyName(i18n, sat) }, sig(rhoS, 4), 'kg/m³', 'model', [GM_SOURCE, RADIUS_SOURCE]) : fact(i18n, 'roche.satelliteDensity', 'ai.tool.calc.densityGiven', {}, rhoS, 'kg/m³', 'model'),
        fact(i18n, 'roche.radius', 'ai.tool.calc.radius', { body: bodyName(i18n, primary) }, sig(R, 6), 'km', 'observed', [RADIUS_SOURCE]),
      ];
      return answer('ai.tool.calc.roche.observed', { fluid: sig(r.fluidKm, 4), rigid: sig(r.rigidKm, 4) }, facts, ['ai.tool.calc.roche.note']);
    }),
};

export const calcHill: ToolDefinition = {
  name: 'calc.hill',
  kind: 'calc',
  summary: "A world's Hill radius, where its gravity holds moons against its primary's: a planet from its elements, or aKm and e about a primary.",
  keywords: ['hill sphere', 'hill radius', 'sphere of influence', 'how far can a moon', 'moons can orbit'],
  args: {
    type: 'object',
    properties: { body: BODY, primary: BODY, aKm: { ...KM, description: 'Semi-major axis, km' }, e: { type: 'number', minimum: 0, maximum: 0.99 } },
    required: ['body'],
    additionalProperties: false,
  },
  available: () => true,
  check(args) {
    if (args.body === 'sun') return [problem('body', 'ai.tool.calc.hill.sun')];
    if (args.aKm === undefined && (!isBodyId(args.body) || !PLANETS.includes(args.body) || (args.primary !== undefined && args.primary !== 'sun'))) return [problem('aKm', 'ai.tool.calc.period.needA')];
    if (args.aKm !== undefined && args.primary === undefined) return [problem('primary', 'ai.tool.problem.required')];
    return [];
  },
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.calc.hill.preview', { body: bodyName(i18n, str(args, 'body') ?? '') }),
  run: (args, env) =>
    withData(env, (data) => {
      const i18n = env.i18n;
      const body = str(args, 'body') as BodyId;
      const primary = isBodyId(args.primary) ? args.primary : 'sun';
      const given = num(args, 'aKm');
      const elements = data.planets.bodies.find((b) => b.name.toLowerCase() === body)?.elements;
      const a = given ?? planetSemiMajorKm(data, body);
      const e = given !== undefined ? (num(args, 'e') ?? 0) : (elements?.e ?? 0);
      if (a === null) return refused(problem('aKm', 'ai.tool.calc.period.needA'));
      const hill = hillRadiusKm(a, e, bodyGm(data, body), bodyGm(data, primary));
      const facts: Fact[] = [
        fact(i18n, 'hill.radius', 'ai.tool.calc.hill.value', { body: bodyName(i18n, body) }, sig(hill, 4), 'km', 'model', [GM_SOURCE, ELEMENTS_SOURCE]),
        fact(i18n, 'hill.a', given === undefined ? 'ai.tool.calc.semiMajor' : 'ai.tool.calc.semiMajorGiven', { body: bodyName(i18n, body) }, sig(a, 6), 'km', given === undefined ? 'observed' : 'model', given === undefined ? [ELEMENTS_SOURCE] : []),
        fact(i18n, 'hill.e', 'ai.tool.calc.eccentricity', {}, sig(e, 4), '', given === undefined ? 'observed' : 'model', given === undefined ? [ELEMENTS_SOURCE] : []),
      ];
      return answer('ai.tool.calc.hill.observed', { body: bodyName(i18n, body), km: sig(hill, 4) }, facts);
    }),
};

export const calcImpact: ToolDefinition = {
  name: 'calc.impact',
  kind: 'calc',
  summary: 'What an asteroid striking a world does: its energy, the crater it leaves, and the outcome regime.',
  keywords: ['impact', 'asteroid', 'meteor', 'crater', 'hit', 'strike', 'collision', 'throw a rock', 'dinosaur', 'chicxulub', 'energy'],
  args: {
    type: 'object',
    properties: {
      target: BODY,
      diameterKm: { type: 'number', minimum: 0.001, maximum: 1000, description: "The impactor's diameter, km" },
      speedKmS: { type: 'number', minimum: 1, maximum: 72, description: 'Speed at contact, km/s' },
      angleDeg: { type: 'number', minimum: 15, maximum: 90, description: 'From the horizontal, degrees (90 straight down)' },
      densityKgM3: { type: 'number', minimum: 300, maximum: 8000, description: "The impactor's density, kg/m³ (3000: stony)" },
    },
    required: ['target', 'diameterKm', 'speedKmS'],
    additionalProperties: false,
  },
  available: () => true,
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.calc.impact.preview', { target: bodyName(i18n, str(args, 'target') ?? ''), diameterKm: num(args, 'diameterKm') ?? 0, speedKmS: num(args, 'speedKmS') ?? 0 }),
  run: (args, env) =>
    withData(env, (data) => {
      const i18n = env.i18n;
      const target = str(args, 'target') as BodyId;
      const dKm = num(args, 'diameterKm') ?? 1;
      const v = num(args, 'speedKmS') ?? 20;
      const angleDeg = num(args, 'angleDeg') ?? 45;
      const rho = num(args, 'densityKgM3') ?? 3000;
      const gm = bodyGm(data, target);
      const R = meanRadiusKm(data, target);
      const rKm = dKm / 2;
      const massKg = rho * (4 / 3) * Math.PI * (rKm * 1000) ** 3;
      const energyJ = 0.5 * massKg * (v * 1000) ** 2;
      const facts: Fact[] = [
        fact(i18n, 'impact.mass', 'ai.tool.calc.impact.mass', {}, sig(massKg, 3), 'kg', 'model'),
        fact(i18n, 'impact.energy', 'ai.tool.calc.impact.energy', {}, sig(energyJ, 3), 'J', 'model'),
        fact(i18n, 'impact.megatons', 'ai.tool.calc.impact.megatons', {}, sig(energyJ / MEGATON_J, 3), 'Mt TNT', 'model'),
      ];
      const notes = ['ai.tool.calc.impact.note'];
      const solid = gm <= SOLID_MAX_GM;
      const c = solid
        ? crater({ impactorM: dKm * 1000, impactorDensity: rho, targetDensity: Math.min(CRUST_DENSITY, bulkDensity(gm, R)), gravity: (gm / (R * R)) * 1000, targetRadiusM: R * 1000, speedMs: v * 1000, angle: (angleDeg * Math.PI) / 180 })
        : null;
      if (c) {
        // The target's gravity and density come from its GM and radius.
        const from = [GM_SOURCE, RADIUS_SOURCE];
        facts.push(fact(i18n, 'impact.crater', 'ai.tool.calc.impact.crater', {}, sig(c.finalM / 1000, 3), 'km', 'model', from));
        facts.push(fact(i18n, 'impact.depth', 'ai.tool.calc.impact.depth', {}, sig(c.depthM / 1000, 3), 'km', 'model', from));
        facts.push(fact(i18n, 'impact.complex', 'ai.tool.calc.impact.complex', {}, say(i18n, c.complex ? 'ai.tool.calc.impact.complexYes' : 'ai.tool.calc.impact.complexNo'), undefined, 'model', from));
      } else {
        notes.push(solid ? 'ai.tool.calc.impact.giant' : 'ai.tool.calc.impact.noSurface');
      }
      // Leinhardt and Stewart's regimes: b, the sine of the angle from head-on, is the cosine of the angle from the horizontal.
      const projectileGm = massKg * data.gPerKg;
      const outcome = impactOutcome({ gm, radiusKm: R }, { gm: projectileGm, radiusKm: rKm }, v, Math.cos((angleDeg * Math.PI) / 180));
      facts.push(fact(i18n, 'impact.regime', 'ai.tool.calc.impact.regime', {}, say(i18n, `ai.tool.regime.${outcome.regime}`), undefined, 'model', [GM_SOURCE, RADIUS_SOURCE]));
      const escape = Math.sqrt((2 * gm) / R);
      if (v < escape) notes.push('ai.tool.calc.impact.slow');
      facts.push(...inputs(i18n, data, target));
      return answer('ai.tool.calc.impact.observed', { target: bodyName(i18n, target), known: c ? 1 : 0, crater: c ? sig(c.finalM / 1000, 3) : 0 }, facts, notes);
    }),
};

const FACT_ROWS = ['meanRadiusKm', 'massKg', 'densityGcm3', 'gravityMs2', 'escapeKmS', 'rotationDays', 'solarDayDays', 'tiltDeg'] as const;
const FACT_UNITS: Readonly<Record<(typeof FACT_ROWS)[number], string>> = { meanRadiusKm: 'km', massKg: 'kg', densityGcm3: 'g/cm³', gravityMs2: 'm/s²', escapeKmS: 'km/s', rotationDays: 'd', solarDayDays: 'd', tiltDeg: '°' };

export const calcWorldFacts: ToolDefinition = {
  name: 'calc.world_facts',
  kind: 'calc',
  summary: "A world's measured facts: radius, mass, density, gravity, escape speed, day, tilt and orbit (JPL, NAIF).",
  keywords: ['facts', 'how big', 'mass', 'radius', 'size', 'gravity', 'density', 'day length', 'tilt', 'how heavy', 'about'],
  args: { type: 'object', properties: { body: BODY }, required: ['body'], additionalProperties: false },
  available: () => true,
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.calc.world_facts.preview', { body: bodyName(i18n, str(args, 'body') ?? '') }),
  run: (args, env) =>
    withData(env, (data) => {
      const i18n = env.i18n;
      const id = str(args, 'body') as BodyId;
      const w = worldFacts(id, data.physical, data.planets);
      // The Sun's and the Moon's gravity, escape speed, mass and density are worked out from GM and radius (about.ts); the planets' are JPL's table.
      const derived = w.gravityAt === 'surface';
      const facts: Fact[] = [];
      for (const row of FACT_ROWS) {
        const value = w[row];
        if (value === null) continue;
        const knowledge = derived && (row === 'massKg' || row === 'densityGcm3' || row === 'gravityMs2' || row === 'escapeKmS') ? 'model' : 'observed';
        facts.push(fact(i18n, `${id}.${row}`, `ai.tool.calc.world.${row}`, { body: bodyName(i18n, id) }, sig(value, 5), FACT_UNITS[row], knowledge, w.sources));
      }
      if (w.orbit) {
        facts.push(fact(i18n, `${id}.orbitDays`, 'ai.tool.calc.world.orbitDays', { around: bodyName(i18n, w.orbit.around) }, sig(w.orbit.periodDays, 6), 'd', 'observed', w.sources));
        if (w.orbit.semiMajorKm !== null) facts.push(fact(i18n, `${id}.semiMajorKm`, 'ai.tool.calc.semiMajor', { body: bodyName(i18n, id) }, sig(w.orbit.semiMajorKm, 6), 'km', 'observed', [ELEMENTS_SOURCE]));
        if (w.orbit.eccentricity !== null) facts.push(fact(i18n, `${id}.eccentricity`, 'ai.tool.calc.eccentricity', {}, sig(w.orbit.eccentricity, 4), '', 'observed', [ELEMENTS_SOURCE]));
      }
      return answer('ai.tool.calc.world_facts.observed', { body: bodyName(i18n, id) }, facts);
    }),
};

export const CALC_TOOLS: readonly ToolDefinition[] = [calcEscapeSpeed, calcCircularSpeed, calcOrbitalPeriod, calcLightTime, calcHohmann, calcRoche, calcHill, calcImpact, calcWorldFacts];
