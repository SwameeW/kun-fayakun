import type { BodyId, SkyLayerName, WalkableWorld } from '../../core/types';
import { ATLAS, MAKKAH_FRAME, SITES, type FieldPlace } from '../../explore/field-notes/data';
import { centralAngleDeg, qiblaDistanceKm } from '../../explore/islamic/astronomy';
import type { AiContext, JsonSchema, ToolDefinition, ToolEnv, ToolProblem } from '../types';
import { BODY, bodyName, bool, done, ensureExplorer, ensureMessages, focusOf, isBodyId, LAT, LON, notConfirmed, num, OPEN_MS, problem, refused, returnTo, say, str, view, waitFor } from './shared';

/**
 * The explorer: open and close it, fly to a world, go to a place on the Earth (degrees, or a place of
 * the field notes' atlas), the sky's layers, out among the stars and to a star by name, and on foot.
 * Every command waits for the explorer to be on screen (a command sent before is dropped) and is
 * confirmed by reading its view back; each is undone by its opposite (the world, the place or the
 * layer as it was).
 */

/** The places of the field notes (src/explore/field-notes/data.ts): the atlas's wonders and the sites the prophets' notes name. */
export const PLACES: readonly FieldPlace[] = [...ATLAS, ...SITES];
const PLACE_IDS = PLACES.map((p) => p.id);
export const PLACE = { type: 'string', enum: PLACE_IDS, description: 'A place of the field notes' } as const;
export const placeById = (id: string | undefined): FieldPlace | undefined => (id === undefined ? undefined : PLACES.find((p) => p.id === id));

/** The argument a model names a place by: the orchestrator finds it (src/ai/index.ts placeOfCall). */
export const PLACE_NAME_ARG = 'placeName';
const PLACE_NAME: JsonSchema = { type: 'string', maxLength: 80, description: 'A place by its name: a field-notes place or a town' };

/**
 * A place as a model is offered it (ToolDefinition.argsFor), with the tool's other arguments: a place
 * by its name (a field-notes place or a town, found by the app, so a model never gives a named
 * place's degrees from memory), or degrees the visitor gave. Flat, every one optional: given the
 * field notes' ids, Qwen3 4B wrote the first of them ("richat") with London's latitude and a wrong
 * longitude; given one form per way of naming a place, it took the first form whatever was asked
 * (docs/AI-EVALUATION.md). Which of them may go together is the tool's own check.
 */
export function placeArgsFor(rest: Readonly<Record<string, JsonSchema>>, required: readonly string[] = []): JsonSchema {
  return { type: 'object', properties: { [PLACE_NAME_ARG]: PLACE_NAME, lat: LAT, lon: LON, ...rest }, required: [...required], additionalProperties: false };
}

const WALKABLE = ['earth', 'moon', 'mars', 'mercury', 'venus'] as const satisfies readonly WalkableWorld[];
const LAYERS = ['constellations', 'boundaries', 'grid', 'names'] as const satisfies readonly SkyLayerName[];

/** The Earth's mean radius (km, NAIF's radii averaged) for distances along the ground. */
const EARTH_KM = 6371.0084;
const TRIP_MS = 15_000;
const GLIDE_MS = 20_000;
const QUICK_MS = 3000;

const inExplorer = (ctx: AiContext): boolean => ctx.where === 'explorer';
const inExplorerOrLab = (ctx: AiContext): boolean => ctx.where === 'explorer' || ctx.where === 'lab';

/** Within Makkah's frame (spec principle 4): no walk begins there, no view frames it closer. */
const nearKaaba = (lat: number, lon: number): boolean => qiblaDistanceKm(lat, lon, EARTH_KM) < MAKKAH_FRAME.radiusKm;

/** A place given either by the atlas or by degrees (never both, never half of a pair). */
function placeProblems(args: Record<string, unknown>): ToolProblem[] {
  const hasPlace = args.place !== undefined;
  const hasLat = args.lat !== undefined;
  const hasLon = args.lon !== undefined;
  if (hasPlace && (hasLat || hasLon)) return [problem('place', 'ai.tool.explorer.place.both')];
  if (hasLat !== hasLon) return [problem(hasLat ? 'lon' : 'lat', 'ai.tool.problem.required')];
  return [];
}

function wherePlace(args: Record<string, unknown>): { lat: number; lon: number; viewKm: number; name: string | null } | null {
  const p = placeById(str(args, 'place'));
  if (p) return { lat: p.lat, lon: p.lon, viewKm: p.viewKm, name: p.id };
  const lat = num(args, 'lat');
  const lon = num(args, 'lon');
  return lat !== undefined && lon !== undefined ? { lat, lon, viewKm: 300, name: null } : null;
}

export const explorerOpen: ToolDefinition = {
  name: 'explorer.open',
  kind: 'view',
  summary: 'Open the true-scale solar-system explorer, optionally on a world.',
  keywords: ['explorer', 'solar system', 'universe', 'space', 'planets', 'open explorer', 'true scale'],
  args: { type: 'object', properties: { body: BODY }, additionalProperties: false },
  available: (ctx) => ctx.where !== 'explorer' && ctx.where !== 'lab',
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.explorer.open.preview', { on: isBodyId(args.body) ? 1 : 0, body: isBodyId(args.body) ? bodyName(i18n, args.body) : '' }),
  async run(args, env) {
    ensureMessages(env.i18n);
    const body = isBodyId(args.body) ? args.body : null;
    const wasOpen = env.app.universe() !== null;
    if (wasOpen && body) env.app.focusBody(body);
    else if (!wasOpen) env.app.openUniverse(body);
    const seen = await waitFor(env, () => {
      const v = env.app.universe();
      return v !== null && (body === null || v.focus === body);
    }, OPEN_MS);
    const focus = view(env)?.focus ?? body ?? 'earth';
    const undo = (): void => {
      if (!wasOpen) env.app.closeUniverse();
    };
    return seen ? done('ai.tool.explorer.open.observed', { body: bodyName(env.i18n, focus) }, { undo }) : notConfirmed('ai.tool.explorer.open.notSeen', {}, { undo });
  },
};

export const explorerClose: ToolDefinition = {
  name: 'explorer.close',
  kind: 'view',
  summary: 'Leave the explorer and go back to the film.',
  keywords: ['close explorer', 'leave', 'back to the film', 'exit'],
  args: { type: 'object', properties: {}, additionalProperties: false },
  available: inExplorerOrLab,
  preview: (_args, _ctx, i18n) => say(i18n, 'ai.tool.explorer.close.preview'),
  async run(_args, env) {
    ensureMessages(env.i18n);
    const focus = focusOf(view(env));
    env.app.closeUniverse();
    const seen = await waitFor(env, () => env.app.universe() === null, 10_000);
    const undo = (): void => {
      if (focus) returnTo(env.app, focus);
      else env.app.openUniverse(null);
    };
    return seen ? done('ai.tool.explorer.close.observed', {}, { undo }) : notConfirmed('ai.tool.explorer.close.notSeen', {}, { undo });
  },
};

export const explorerFly: ToolDefinition = {
  name: 'explorer.fly',
  kind: 'view',
  summary: 'Fly the camera to one of the ten worlds (opening the explorer if needed).',
  keywords: ['fly', 'go to', 'take me', 'visit', 'travel', 'show', 'planet', 'sun', 'moon', 'earth', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'follow'],
  args: { type: 'object', properties: { body: BODY }, required: ['body'], additionalProperties: false },
  available: () => true,
  check(args, ctx) {
    // In an experiment a world can be gone (removed, merged): there is nothing to fly to.
    if (ctx.lab && isBodyId(args.body) && !ctx.lab.bodies.some((b) => b.id === args.body)) return [problem('body', 'ai.tool.explorer.fly.gone', { body: args.body })];
    return [];
  },
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.explorer.fly.preview', { body: bodyName(i18n, str(args, 'body') ?? '') }),
  async run(args, env) {
    ensureMessages(env.i18n);
    const body = str(args, 'body') as BodyId;
    const before = focusOf(view(env));
    if (before === null) {
      env.app.openUniverse(body);
      if (!(await waitFor(env, () => env.app.universe() !== null, OPEN_MS))) return notConfirmed('ai.tool.explorer.open.notSeen');
    } else {
      env.app.focusBody(body);
    }
    const seen = await waitFor(env, () => view(env)?.focus === body, TRIP_MS);
    const undo = (): void => {
      if (before === null) env.app.closeUniverse();
      else returnTo(env.app, before);
    };
    const values = { body: bodyName(env.i18n, body), travelling: view(env)?.travelling ? 1 : 0 };
    return seen ? done('ai.tool.explorer.fly.observed', values, { undo }) : notConfirmed('ai.tool.explorer.fly.notSeen', values, { undo });
  },
};

const VIEW_KM: JsonSchema = { type: 'number', minimum: 1, maximum: 20_000, description: 'Ground to frame, km' };

export const explorerPlace: ToolDefinition = {
  name: 'explorer.place',
  kind: 'view',
  summary: 'Fly to a place on the Earth: a field-notes place id, or lat and lon in degrees (viewKm: ground to frame).',
  // The field notes' own places by name too: "Show me the Salar de Uyuni" named no other keyword.
  keywords: ['place', 'city', 'country', 'location', 'coordinates', 'latitude', 'longitude', 'mountain', 'desert', 'canyon', 'makkah', 'madinah', 'zoom', 'where is', ...PLACE_IDS.map((id) => id.replace(/-/gu, ' '))],
  args: {
    type: 'object',
    properties: { place: PLACE, lat: LAT, lon: LON, viewKm: VIEW_KM },
    additionalProperties: false,
  },
  argsFor: () => placeArgsFor({ viewKm: VIEW_KM }),
  available: inExplorer,
  check(args) {
    const found = placeProblems(args);
    if (found.length > 0) return found;
    return args.place === undefined && args.lat === undefined ? [problem('', 'ai.tool.explorer.place.which')] : [];
  },
  preview(args, _ctx, i18n) {
    const p = wherePlace(args);
    return say(i18n, 'ai.tool.explorer.place.preview', { named: p?.name ? 1 : 0, place: p?.name ?? '', lat: p?.lat ?? 0, lon: p?.lon ?? 0 });
  },
  async run(args, env) {
    ensureMessages(env.i18n);
    const target = wherePlace(args);
    if (!target) return refused(problem('', 'ai.tool.explorer.place.which'));
    if (!(await ensureExplorer(env, 'earth'))) return notConfirmed('ai.tool.explorer.open.notSeen');
    const before = view(env);
    const prior = before?.place ? { ...before.place } : null;
    const priorFocus = focusOf(before) ?? { body: 'earth' as const, world: null };
    // Makkah is seen as a city in its valley, never closer (the explorer holds to it too).
    const viewKm = Math.max(num(args, 'viewKm') ?? target.viewKm, nearKaaba(target.lat, target.lon) ? MAKKAH_FRAME.minWidthKm : 0);
    env.app.earthCommand({ kind: 'goto', lat: target.lat, lon: target.lon, viewKm });
    const near = Math.max(20, viewKm);
    const seen = await waitFor(env, () => {
      const v = view(env);
      return v !== null && !v.travelling && v.place?.body === 'earth' && (centralAngleDeg(v.place.lat, v.place.lon, target.lat, target.lon) * Math.PI * EARTH_KM) / 180 < near;
    }, GLIDE_MS);
    const undo = (): void => {
      if (prior) env.app.earthCommand({ kind: 'view', body: prior.body, lat: prior.lat, lon: prior.lon, altitudeKm: prior.altitudeKm });
      else returnTo(env.app, priorFocus);
    };
    const values = { place: target.name ?? '', lat: Math.round(target.lat * 100) / 100, lon: Math.round(target.lon * 100) / 100, viewKm: Math.round(viewKm) };
    return seen ? done('ai.tool.explorer.place.observed', values, { undo }) : notConfirmed('ai.tool.explorer.place.notSeen', values, { undo });
  },
};

export const explorerSky: ToolDefinition = {
  name: 'explorer.sky',
  kind: 'view',
  summary: 'Show or hide a layer of the sky: constellations, boundaries, grid or names.',
  keywords: ['constellation', 'constellations', 'star names', 'grid', 'boundaries', 'sky', 'zodiac', 'ecliptic', 'equator'],
  args: { type: 'object', properties: { layer: { type: 'string', enum: LAYERS }, on: { type: 'boolean' } }, required: ['layer', 'on'], additionalProperties: false },
  available: inExplorerOrLab,
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.explorer.sky.preview', { layer: str(args, 'layer') ?? '', on: bool(args, 'on') ? 1 : 0 }),
  async run(args, env) {
    ensureMessages(env.i18n);
    const layer = str(args, 'layer') as SkyLayerName;
    const on = bool(args, 'on') ?? true;
    if (!(await ensureExplorer(env))) return notConfirmed('ai.tool.explorer.open.notSeen');
    const was = view(env)?.sky.layers[layer] ?? !on;
    env.app.universeSky({ kind: 'layer', layer, on });
    const seen = await waitFor(env, () => view(env)?.sky.layers[layer] === on, QUICK_MS);
    const undo = (): void => {
      env.app.universeSky({ kind: 'layer', layer, on: was });
    };
    return seen ? done('ai.tool.explorer.sky.observed', { layer, on: on ? 1 : 0 }, { undo }) : notConfirmed('ai.tool.explorer.sky.notSeen', { layer, on: on ? 1 : 0 }, { undo });
  },
};

const STARS_MS = 20_000;

/** Out among the stars, if not there already; resolves to whether the view shows it. */
async function ensureStars(env: ToolEnv): Promise<boolean> {
  if (!(await ensureExplorer(env))) return false;
  if (view(env)?.neighbourhood) return true;
  env.app.earthCommand({ kind: 'stars' });
  return waitFor(env, () => (view(env)?.neighbourhood ?? null) !== null, STARS_MS);
}

export const explorerStars: ToolDefinition = {
  name: 'explorer.stars',
  kind: 'view',
  summary: 'Go out among the stars around the Sun.',
  keywords: ['stars', 'nearby stars', 'neighbourhood', 'galaxy', 'milky way', 'beyond the solar system', 'interstellar', 'exoplanets'],
  args: { type: 'object', properties: {}, additionalProperties: false },
  available: inExplorer,
  preview: (_args, _ctx, i18n) => say(i18n, 'ai.tool.explorer.stars.preview'),
  async run(_args, env) {
    ensureMessages(env.i18n);
    if (!(await ensureExplorer(env))) return notConfirmed('ai.tool.explorer.open.notSeen');
    const already = (view(env)?.neighbourhood ?? null) !== null;
    const seen = await ensureStars(env);
    const undo = (): void => {
      if (!already) env.app.earthCommand({ kind: 'starsEnd' });
    };
    return seen ? done('ai.tool.explorer.stars.observed', {}, { undo }) : notConfirmed('ai.tool.explorer.stars.notSeen', {}, { undo });
  },
};

export const explorerFindStar: ToolDefinition = {
  name: 'explorer.find_star',
  kind: 'view',
  summary: 'Find a star by its name or catalogue number and fly to it.',
  keywords: ['star', 'find star', 'sirius', 'proxima', 'alpha centauri', 'betelgeuse', 'vega', 'polaris', 'hip', 'catalogue'],
  args: { type: 'object', properties: { name: { type: 'string', maxLength: 60, pattern: "^[\\p{L}\\p{N} .+'-]{1,60}$", description: 'A star name or number' } }, required: ['name'], additionalProperties: false },
  available: inExplorer,
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.explorer.findStar.preview', { name: str(args, 'name') ?? '' }),
  async run(args, env) {
    ensureMessages(env.i18n);
    const text = (str(args, 'name') ?? '').trim();
    const opened = (view(env)?.neighbourhood ?? null) !== null;
    const priorHip = view(env)?.neighbourhood?.focus.hip ?? null;
    if (!(await ensureStars(env))) return notConfirmed('ai.tool.explorer.stars.notSeen');
    const wanted = text.toLowerCase();
    const matches = () => (view(env)?.neighbourhood?.results ?? []).filter((r) => r.name.toLowerCase().includes(wanted) || (r.hip !== null && String(r.hip) === wanted.replace(/^hip\s*/u, '')));
    env.app.earthCommand({ kind: 'starsSearch', text });
    const found = await waitFor(env, () => matches().length > 0, 5000);
    const undo = (): void => {
      if (!opened) env.app.earthCommand({ kind: 'starsEnd' });
      else env.app.earthCommand({ kind: 'starsGoTo', hip: priorHip });
    };
    if (!found) return notConfirmed('ai.tool.explorer.findStar.none', { name: text }, { undo });
    const list = matches();
    const best = list.find((r) => r.name.toLowerCase() === wanted) ?? list[0];
    if (!best || best.hip === null) return notConfirmed('ai.tool.explorer.findStar.notPlaced', { name: best?.name ?? text }, { undo });
    const hip = best.hip;
    env.app.earthCommand({ kind: 'starsGoTo', hip });
    const seen = await waitFor(env, () => view(env)?.neighbourhood?.focus.hip === hip, TRIP_MS);
    const values = { name: best.name, known: best.distPc === null ? 0 : 1, distPc: best.distPc ?? 0 };
    return seen ? done('ai.tool.explorer.findStar.observed', values, { undo }) : notConfirmed('ai.tool.explorer.findStar.notSeen', values, { undo });
  },
};

export const explorerWalk: ToolDefinition = {
  name: 'explorer.walk',
  kind: 'view',
  summary: 'Walk on the ground of the Earth, the Moon, Mars, Mercury or Venus: at a place, at lat and lon, or below the camera.',
  keywords: ['walk', 'on foot', 'stand', 'surface', 'land', 'landing', 'ground', 'space suit'],
  args: { type: 'object', properties: { world: { type: 'string', enum: WALKABLE }, place: PLACE, lat: LAT, lon: LON }, additionalProperties: false },
  argsFor: () => placeArgsFor({ world: { type: 'string', enum: WALKABLE } }),
  available: inExplorer,
  check(args) {
    const found = placeProblems(args);
    if (found.length > 0) return found;
    if (args.place !== undefined && args.world !== undefined && args.world !== 'earth') return [problem('place', 'ai.tool.explorer.walk.placeOnEarth')];
    const p = wherePlace(args);
    if (p && (args.world === undefined || args.world === 'earth') && nearKaaba(p.lat, p.lon)) return [problem('', 'ai.tool.explorer.walk.makkah', { km: MAKKAH_FRAME.radiusKm })];
    return [];
  },
  preview(args, _ctx, i18n) {
    const p = wherePlace(args);
    return say(i18n, 'ai.tool.explorer.walk.preview', { world: bodyName(i18n, str(args, 'world') ?? 'earth'), named: p?.name ? 1 : 0, place: p?.name ?? '', lat: p?.lat ?? 0, lon: p?.lon ?? 0, here: p ? 0 : 1 });
  },
  async run(args, env) {
    ensureMessages(env.i18n);
    const world = (str(args, 'world') ?? 'earth') as WalkableWorld;
    const p = wherePlace(args);
    if (!(await ensureExplorer(env, world))) return notConfirmed('ai.tool.explorer.open.notSeen');
    if (!p && !view(env)?.walkHere) return refused(problem('', 'ai.tool.explorer.walk.noGround'));
    env.app.earthCommand(p ? { kind: 'walk', world, lat: p.lat, lon: p.lon } : { kind: 'walk' });
    const settled = await waitFor(env, () => {
      const v = view(env);
      return v !== null && (v.walk !== null || v.walkRefused);
    }, GLIDE_MS);
    const v = view(env);
    if (v?.walkRefused) return refused(problem('', 'ai.tool.explorer.walk.makkah', { km: MAKKAH_FRAME.radiusKm }));
    const undo = (): void => {
      env.app.earthCommand({ kind: 'walkEnd' });
    };
    const walk = v?.walk ?? null;
    if (!settled || !walk) return notConfirmed('ai.tool.explorer.walk.notSeen', { world: bodyName(env.i18n, world) }, { undo });
    return done('ai.tool.explorer.walk.observed', { world: bodyName(env.i18n, walk.world), lat: Math.round(walk.lat * 100) / 100, lon: Math.round(walk.lon * 100) / 100, landing: walk.state === 'landing' ? 1 : 0 }, { undo });
  },
};

export const explorerWalkEnd: ToolDefinition = {
  name: 'explorer.walk_end',
  kind: 'view',
  summary: 'End the walk and go back to the view from above.',
  keywords: ['stop walking', 'end walk', 'back to orbit', 'take off', 'leave the surface'],
  args: { type: 'object', properties: {}, additionalProperties: false },
  available: (ctx) => ctx.where === 'explorer' && (ctx.explorer?.walking ?? null) !== null,
  preview: (_args, _ctx, i18n) => say(i18n, 'ai.tool.explorer.walkEnd.preview'),
  async run(_args, env) {
    ensureMessages(env.i18n);
    const walk = view(env)?.walk;
    if (!walk) return refused(problem('', 'ai.tool.explorer.walkEnd.none'));
    const prior = { world: walk.world, lat: walk.lat, lon: walk.lon, headingDeg: walk.headingDeg, pitchDeg: walk.pitchDeg };
    env.app.earthCommand({ kind: 'walkEnd' });
    const seen = await waitFor(env, () => view(env)?.walk === null, 5000);
    const undo = (): void => {
      env.app.earthCommand({ kind: 'walk', ...prior });
    };
    return seen ? done('ai.tool.explorer.walkEnd.observed', {}, { undo }) : notConfirmed('ai.tool.explorer.walkEnd.notSeen', {}, { undo });
  },
};

export const EXPLORER_TOOLS: readonly ToolDefinition[] = [explorerOpen, explorerClose, explorerFly, explorerPlace, explorerSky, explorerStars, explorerFindStar, explorerWalk, explorerWalkEnd];
