/**
 * The assistant's tools (src/ai/tools): the registry's checks and shortlist with canned contexts;
 * the calculators against textbook values (Earth's escape speed 11.19 km/s and Mars's 5.03 km/s, the
 * Moon's period about 27.32 days, light from the Sun to the Earth about 499 s, a Hohmann transfer from
 * the Earth to Mars about 5.6 km/s, the Earth's Roche limit for the Moon's density about 18,400 km
 * (fluid) and 9,500 km (rigid), the qibla from London about 119 degrees); the citations from the data
 * files themselves; and view and experiment tools confirming by reading a fake app's state back.
 *
 * A fake App in Node: its assets from public/ and data/, its data store the real one
 * (src/core/data.ts), its messages formatted by intl-messageformat. Browser tests come at integration.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { IntlMessageFormat } from 'intl-messageformat';
import { catalogueFrom, createRegistry, createRegistryFor } from '../../src/ai/tools';
import { buildPlanMessages, planSchema } from '../../src/ai/prompts';
import { createToolRegistry } from '../../src/ai/tools/registry';
import { validateSchema } from '../../src/ai/tools/schema';
import type { AiContext, Fact, JsonSchema, Passage, ToolDefinition, ToolEnv, ToolOutcome } from '../../src/ai/types';
import { createDataStore } from '../../src/core/data';
import type { App, AssetLoader, HadithFile, I18n, LabCommand, QuranFile, SkyLayerName, UniverseLab, UniverseLabBody, UniverseSkyCommand, UniverseTimeCommand, UniverseView } from '../../src/core/types';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));

const assets: AssetLoader = {
  url: (p) => p,
  json: <T>(url: string): Promise<T> => Promise.resolve(readJson(url.startsWith('data/') ? url : `public/${url}`) as T),
  ktx2: () => Promise.reject(new Error('no textures in Node')),
  texture: () => Promise.reject(new Error('no textures in Node')),
  binary: () => Promise.reject(new Error('no binaries here')),
};

function fakeI18n(): I18n {
  const messages = new Map<string, string>();
  const files = new Set<string>();
  return {
    locale: 'en',
    dir: 'ltr',
    t(key, values) {
      const m = messages.get(key);
      if (m === undefined) return key;
      const out = new IntlMessageFormat(m, 'en').format(values);
      return Array.isArray(out) ? out.join('') : String(out);
    },
    has: (key) => messages.has(key),
    number: (v) => String(v),
    extend(name, raw) {
      if (files.has(name)) return;
      files.add(name);
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (k.startsWith('$') || typeof v !== 'string') continue;
        if (messages.has(k)) throw new Error(`duplicate ${k}`);
        messages.set(k, v);
      }
    },
  };
}

const data = createDataStore(assets);

interface FakeApp {
  app: App;
  setView(v: UniverseView | null): void;
  sent: unknown[];
}

/** A fake app: the parts the tools read; commands are recorded and handed to `react`, which may change the view. */
function fakeApp(react: (command: unknown, view: UniverseView | null) => void = () => undefined): FakeApp {
  let view: UniverseView | null = null;
  const sent: unknown[] = [];
  const send = (c: unknown): void => {
    sent.push(c);
    react(c, view);
  };
  const app = {
    assets,
    data,
    i18n: fakeI18n(),
    chapters: [],
    universe: () => view,
    openUniverse: (body: unknown) => {
      send({ kind: 'openUniverse', body });
    },
    closeUniverse: () => {
      send({ kind: 'closeUniverse' });
    },
    focusBody: (body: unknown) => {
      send({ kind: 'focusBody', body });
    },
    universeSky: (c: UniverseSkyCommand) => {
      send(c);
    },
    universeTime: (c: UniverseTimeCommand) => {
      send(c);
    },
    universeLab: (c: LabCommand) => {
      send(c);
    },
    earthCommand: (c: unknown) => {
      send(c);
    },
  } as unknown as App;
  return {
    app,
    setView(v) {
      view = v;
    },
    sent,
  };
}

const BASE: AiContext = { where: 'home', chapter: null, chapterT: null, mode: 'cinematic', explorer: null, lab: null, verses: [], summary: '' };
const EXPLORER: AiContext = { ...BASE, where: 'explorer', explorer: { focus: 'earth', distanceKm: 20_000, date: '2026-10-26T00:00:00Z', rate: 1, paused: false, walking: null, stars: false } };
const LAB: AiContext = {
  ...BASE,
  where: 'lab',
  lab: {
    bodies: [
      { id: 'sun', name: 'Sun', massKg: 1.989e30, centralId: null, aKm: null, e: null },
      { id: 'earth', name: 'Earth', massKg: 5.972e24, centralId: 'sun', aKm: 1.496e8, e: 0.0167 },
      { id: 'moon', name: 'Moon', massKg: 7.346e22, centralId: 'earth', aKm: 384_400, e: 0.055 },
    ],
    status: 'running',
    days: 0,
    events: 0,
  },
  verses: [],
};
const CHAPTER: AiContext = { ...BASE, where: 'chapter', chapter: 'ch07', chapterT: 12 };

function envFor(app: App, ctx: AiContext = BASE, waitMs = 400): ToolEnv {
  return {
    app,
    i18n: app.i18n,
    signal: new AbortController().signal,
    context: () => ctx,
    retriever: { search: () => [], get: () => null },
    async until(predicate, timeoutMs) {
      const end = Date.now() + Math.min(timeoutMs, waitMs);
      for (;;) {
        if (predicate()) return true;
        if (Date.now() > end) return false;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

const registry = createRegistry();
const tool = (name: string): ToolDefinition => {
  const t = registry.get(name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

/** Runs a tool against a fresh fake app and returns its outcome. */
async function run(name: string, args: Record<string, unknown>, ctx: AiContext = BASE, app: App = fakeApp().app): Promise<ToolOutcome> {
  const checked = registry.validate({ tool: name, args }, ctx);
  expect(checked.ok, JSON.stringify(checked)).toBe(true);
  return tool(name).run(args, envFor(app, ctx));
}

const factValue = (out: ToolOutcome, id: string): number | string => {
  const f: Fact | undefined = out.facts?.find((x) => x.id === id);
  if (!f) throw new Error(`no fact ${id} in ${JSON.stringify(out.facts?.map((x) => x.id))}`);
  return f.value;
};
const factNumber = (out: ToolOutcome, id: string): number => Number(factValue(out, id));

test.beforeAll(async () => {
  await data.ready;
});

/* ----- The registry ----- */

const NAMES = [
  'film.open', 'film.control', 'film.moment',
  'explorer.open', 'explorer.close', 'explorer.fly', 'explorer.place', 'explorer.sky', 'explorer.stars', 'explorer.find_star', 'explorer.walk', 'explorer.walk_end',
  'time.control', 'time.date', 'time.rate',
  'islamic.qibla', 'islamic.prayer_times', 'islamic.crescent', 'islamic.hijri',
  'lab.open', 'lab.state', 'lab.experiment', 'lab.undo', 'lab.measure', 'lab.compare', 'lab.optimise',
  'calc.escape_speed', 'calc.circular_speed', 'calc.orbital_period', 'calc.light_time', 'calc.hohmann', 'calc.roche', 'calc.hill', 'calc.impact', 'calc.world_facts',
  'cite.verse', 'cite.hadith', 'cite.constant', 'cite.source',
  'search.knowledge',
];

test('the registry holds every tool of the design, each small and closed', () => {
  const all = registry.all();
  expect(all.map((t) => t.name).sort()).toEqual([...NAMES].sort());
  for (const t of all) {
    expect(t.summary.length, t.name).toBeLessThanOrEqual(220);
    expect(t.summary, t.name).not.toContain('\n');
    const args = t.args as Extract<JsonSchema, { type: 'object' }>;
    expect(args.type).toBe('object');
    expect(args.additionalProperties, t.name).toBe(false);
    expect(t.keywords.length, t.name).toBeGreaterThan(0);
  }
  expect(tool('lab.experiment').kind).toBe('experiment');
  expect(tool('lab.compare').kind).toBe('read');
  expect(tool('lab.optimise').kind).toBe('read');
  expect(all.filter((t) => t.kind === 'experiment').map((t) => t.name)).toEqual(['lab.experiment']);
  expect(registry.get('nothing.here')).toBeNull();
  expect(() => createToolRegistry([tool('calc.hill'), tool('calc.hill')])).toThrow(/twice/u);
});

test('validate: the schema first, then where it works, then its own checks', () => {
  const paths = (r: ReturnType<typeof registry.validate>): string[] => (r.ok ? [] : r.problems.map((p) => `${p.path}:${p.messageKey}`));
  expect(paths(registry.validate({ tool: 'calc.nothing', args: {} }, BASE))).toEqual(['tool:ai.tool.problem.unknownTool']);
  expect(paths(registry.validate({ tool: 'calc.escape_speed', args: { body: 'pluto' } }, BASE))).toEqual(['body:ai.tool.problem.enum']);
  expect(paths(registry.validate({ tool: 'calc.escape_speed', args: { body: 'mars', altitudeKm: '5' } }, BASE))).toEqual(['altitudeKm:ai.tool.problem.type']);
  expect(paths(registry.validate({ tool: 'calc.escape_speed', args: { body: 'mars', speed: 1 } }, BASE))).toEqual(['speed:ai.tool.problem.additional']);
  // A schema problem is reported even where the tool is not offered (the schema comes first).
  expect(paths(registry.validate({ tool: 'lab.experiment', args: { experiment: 'scale-mass', body: 'sun', factor: 1000 } }, BASE))).toEqual(['factor:ai.tool.problem.maximum']);
  expect(paths(registry.validate({ tool: 'lab.experiment', args: { experiment: 'scale-mass', body: 'sun', factor: 2 } }, BASE))).toEqual([':ai.tool.problem.unavailable']);
  expect(paths(registry.validate({ tool: 'explorer.walk_end', args: {} }, EXPLORER))).toEqual([':ai.tool.problem.unavailable']);
  expect(paths(registry.validate({ tool: 'time.rate', args: { rate: 1000 } }, EXPLORER))).toEqual(['rate:ai.tool.time.rate.ladder']);
  expect(paths(registry.validate({ tool: 'time.rate', args: { rate: -86_400 } }, LAB))).toEqual(['rate:ai.tool.time.notInLab']);
  expect(paths(registry.validate({ tool: 'time.control', args: { action: 'reverse' } }, LAB))).toEqual(['action:ai.tool.time.notInLab']);
  expect(paths(registry.validate({ tool: 'time.date', args: { date: '2030-02-30' } }, EXPLORER))).toEqual(['date:ai.tool.time.date.invalid']);
  expect(paths(registry.validate({ tool: 'explorer.place', args: { place: 'everest', lat: 1, lon: 2 } }, EXPLORER))).toEqual(['place:ai.tool.explorer.place.both']);
  expect(paths(registry.validate({ tool: 'explorer.place', args: { lat: 1 } }, EXPLORER))).toEqual(['lon:ai.tool.problem.required']);
  expect(paths(registry.validate({ tool: 'explorer.walk', args: { place: 'mecca' } }, EXPLORER))).toEqual([':ai.tool.explorer.walk.makkah']);
  expect(paths(registry.validate({ tool: 'lab.experiment', args: { experiment: 'scale-mass', body: 'sun', factor: 2, dvKmS: 1 } }, LAB))).toEqual(['dvKmS:ai.tool.experiment.notFor']);
  expect(paths(registry.validate({ tool: 'lab.experiment', args: { experiment: 'remove-body', body: 'Sun' } }, LAB))).toEqual(['body:ai.tool.experiment.persistent']);
  expect(paths(registry.validate({ tool: 'lab.experiment', args: { experiment: 'kick-body', body: 'pluto', dvKmS: 1, direction: 'prograde' } }, LAB))).toEqual(['body:ai.tool.experiment.noBody']);
  expect(paths(registry.validate({ tool: 'explorer.fly', args: { body: 'mars' } }, LAB))).toEqual(['body:ai.tool.explorer.fly.gone']);
  expect(paths(registry.validate({ tool: 'calc.light_time', args: { from: 'sun', distanceKm: 4 } }, BASE))).toEqual([':ai.tool.calc.light_time.which']);
  const ok = registry.validate({ tool: 'calc.escape_speed', args: { body: 'mars' } }, BASE);
  expect(ok.ok).toBe(true);
  if (ok.ok) {
    expect(ok.call).toEqual({ tool: 'calc.escape_speed', args: { body: 'mars' } });
    expect(ok.tool.name).toBe('calc.escape_speed');
  }
});

test('shortlist: the core first, then the best matches here, deterministic', () => {
  const names = (q: string, ctx: AiContext, limit = 6): string[] => registry.shortlist(q, ctx, limit).map((t) => t.name);
  expect(names('hello', BASE).slice(0, 2)).toEqual(['search.knowledge', 'film.open']);
  expect(names('hello', CHAPTER).slice(0, 2)).toEqual(['search.knowledge', 'film.control']);
  expect(names('hello', EXPLORER).slice(0, 2)).toEqual(['search.knowledge', 'explorer.fly']);
  expect(names('What is the escape speed of Mars?', BASE)[2]).toBe('calc.escape_speed');
  expect(names('Which way is the qibla from London?', BASE)).toContain('islamic.qibla');
  expect(names('When is maghrib today?', BASE)).toContain('islamic.prayer_times');
  expect(names('What if the Sun had double its mass?', LAB)).toContain('lab.experiment');
  expect(names('What if the Sun had double its mass?', BASE)).not.toContain('lab.experiment');
  expect(names('How long does light take from the Sun to the Earth?', BASE)).toContain('calc.light_time');
  expect(names('show the constellations', EXPLORER)).toContain('explorer.sky');
  expect(names('anything', BASE, 1)).toEqual(['search.knowledge']);
  expect(names('escape escaping escapes', BASE, 3)).toHaveLength(3);
  // The same question, the same list.
  expect(names('a trip to Mars: how much delta-v?', BASE)).toEqual(names('a trip to Mars: how much delta-v?', BASE));
  expect(names('a trip to Mars: how much delta-v?', BASE)).toContain('calc.hohmann');
  // A date in the question offers the tools that take one; a field-notes place by name offers explorer.place (both missed before, docs/AI-EVALUATION.md).
  expect(names('Show the sky on 2027-08-02', EXPLORER, 9)).toContain('time.date');
  expect(names('Set it to 1 January 2030 at noon', EXPLORER, 9)).toContain('time.date');
  expect(names('Show me the Salar de Uyuni', EXPLORER, 9)).toContain('explorer.place');
  expect(names('Show me the Grand Canyon from 50 km up', EXPLORER, 9)).toContain('explorer.place');
  // "Throw a rock at the Earth" in the laboratory: its own experiment is offered, not only the calculator (docs/AI-EVALUATION.md).
  expect(names('Throw a rock at the Earth', LAB, 9)).toContain('lab.experiment');
  // A verse key in the question offers the tool that shows a verse by its key ("Show me 21:30" was read as a time in the film).
  const scripture = createRegistry({ scripture: { verses: ['21:30', '36:38'], hadith: ['bukhari-3199'], withheld: [] } });
  expect(scripture.shortlist('Show me 21:30', BASE, 9).map((t) => t.name)).toContain('cite.verse');
  expect(scripture.shortlist('Show me the orbit', BASE, 9).map((t) => t.name)).not.toContain('cite.verse');
  // Ties are broken by name.
  const twin = (name: string): ToolDefinition => ({ ...tool('calc.hill'), name, keywords: ['zebra'], summary: 'Nothing.' });
  const tie = createToolRegistry([twin('b.second'), twin('a.first'), twin('c.third')]);
  expect(tie.shortlist('a zebra', BASE, 5).map((t) => t.name)).toEqual(['a.first', 'b.second', 'c.third']);
});

test('in a chapter with moments, film.moment is offered with this chapter’s moments by id (“Show the orrery” named no keyword)', () => {
  const ch7: AiContext = { ...CHAPTER, mode: 'explore', moments: [{ id: 'orrery', title: 'The orrery' }, { id: 'sun-apex', title: 'The solar apex' }] };
  // As the registry gave it to Qwen3 4B in the evaluation before: search and film.control only.
  expect(registry.shortlist('Show the orrery', CHAPTER, 9).map((t) => t.name)).not.toContain('film.moment');
  const offered = registry.shortlist('Show the orrery', ch7, 9).map((t) => t.name);
  expect(offered.slice(0, 3)).toEqual(['search.knowledge', 'film.control', 'film.moment']);
  const moment = registry.get('film.moment');
  if (!moment) throw new Error('no film.moment');
  const schema = planSchema([moment], ch7);
  expect(JSON.stringify(schema)).toContain('"enum":["orrery","sun-apex"]');
  const plan = buildPlanMessages('Show the orrery', ch7, [moment], []);
  expect(plan[0]?.content).toContain('point: orrery|sun-apex');
  // Validation is the registry's own: a moment the plan's schema does not offer fails it.
  expect(validateSchema(schema, { intent: 'act', calls: [{ tool: 'film.moment', args: { point: 'redshift' } }] }).length).toBeGreaterThan(0);
  expect(validateSchema(schema, { intent: 'act', calls: [{ tool: 'film.moment', args: { point: 'orrery' } }] })).toEqual([]);
  // Without moments in the context, the tool's own arguments.
  expect(planSchema([moment], CHAPTER)).toEqual(planSchema([moment]));
});

test('the laboratory’s tools are offered its bodies by id and one form per experiment; the plans Qwen3 4B wrote under the old schema fail them', () => {
  const offered = (name: string, ctx: AiContext): JsonSchema => {
    const t = registry.get(name);
    if (!t) throw new Error(name);
    return planSchema([t], ctx);
  };
  const plan = (tool: string, args: Record<string, unknown>): unknown => ({ intent: 'act', calls: [{ tool, args }] });
  const measure = offered('lab.measure', LAB);
  expect(JSON.stringify(measure)).toContain('"enum":["sun","earth","moon"]');
  // As Qwen3 4B wrote it, held to a pattern of Unicode letters XGrammar cannot read.
  expect(validateSchema(measure, plan('lab.measure', { from: 'N', to: 'N', via: 'N' })).length).toBeGreaterThan(0);
  expect(validateSchema(measure, plan('lab.measure', { from: 'earth', to: 'moon' }))).toEqual([]);
  // Outside the laboratory, the solar system's ten worlds.
  expect(JSON.stringify(offered('lab.compare', BASE))).toContain('"enum":["sun","mercury","venus","earth","moon","mars","jupiter","saturn","uranus","neptune"]');
  // One form per experiment: its parameters, all required, and no other experiment's.
  const compare = offered('lab.compare', BASE);
  expect(validateSchema(compare, plan('lab.compare', { experiment: 'scale-mass', body: 'sun', factor: 1.1 }))).toEqual([]);
  expect(validateSchema(compare, plan('lab.compare', { experiment: 'scale-mass', body: 'sun', factor: 1.1, horizonDays: 3650 }))).toEqual([]);
  expect(validateSchema(compare, plan('lab.compare', { experiment: 'scale-mass', body: 'sun' })).length).toBeGreaterThan(0);
  expect(validateSchema(compare, plan('lab.compare', { experiment: 'change-orbit', body: 'earth', factor: 1.1, target: 'earth', distanceKm: 147.1, massSun: 1.1 })).length).toBeGreaterThan(0);
  // lab.optimise: escape takes days, year takes targetDays.
  const optimise = offered('lab.optimise', LAB);
  expect(validateSchema(optimise, plan('lab.optimise', { goal: 'year', body: 'earth', targetDays: 300 }))).toEqual([]);
  expect(validateSchema(optimise, plan('lab.optimise', { goal: 'year', body: 'earth', days: 300 })).length).toBeGreaterThan(0);
  expect(validateSchema(optimise, plan('lab.optimise', { goal: 'escape', body: 'earth', days: 1826 }))).toEqual([]);
  // What the forms accept, the tool's own schema accepts too (validation is the registry's).
  expect(registry.validate({ tool: 'lab.compare', args: { experiment: 'scale-mass', body: 'sun', factor: 1.1 } }, BASE).ok).toBe(true);
  // The prompt shows the forms.
  const lines = buildPlanMessages('Double the Sun', LAB, [registry.get('lab.experiment') as ToolDefinition], [])[0]?.content ?? '';
  expect(lines).toContain("{experiment: scale-mass, body: sun|earth|moon, factor: number (multiply the body's mass by this), horizonDays?: number (Days to integrate ahead)} or {experiment: remove-body");
  expect(lines).toContain("aFactor: number (multiply the orbit's size by this)");
  expect(lines).toContain('massKg: number (kg; a large number as a power of ten: 1e22)');
});

test('a place is offered by its name or by degrees, flat; the tool’s own check says which go together', () => {
  const qibla = registry.get('islamic.qibla');
  if (!qibla) throw new Error('no qibla');
  const schema = planSchema([qibla], BASE);
  const plan = (args: Record<string, unknown>): unknown => ({ intent: 'answer', calls: [{ tool: 'islamic.qibla', args }] });
  expect(validateSchema(schema, plan({ placeName: 'London' }))).toEqual([]);
  expect(validateSchema(schema, plan({ lat: 51.5, lon: -0.12 }))).toEqual([]);
  // The field notes' ids are not offered: as Qwen3 4B used them, the first of them ("richat") with degrees from memory.
  expect(validateSchema(schema, plan({ place: 'richat', lat: 51.5074, lon: -113.9324 })).length).toBeGreaterThan(0);
  const line = buildPlanMessages('qibla', BASE, [qibla], [])[0]?.content ?? '';
  expect(line).toContain('args {placeName?: string, lat?: number (Latitude, degrees north), lon?: number (Longitude, degrees east)}');
  expect(line).not.toContain('richat');
});

test('search never says back, or searches for, a verse key the data does not hold (“Quran 2:999”)', async () => {
  const unheld = await run('search.knowledge', { query: 'Quran 2:999' });
  expect(unheld.status).toBe('done');
  expect(JSON.stringify(unheld)).not.toContain('2:999');
  const only = await run('search.knowledge', { query: '2:999' });
  expect(only.status).toBe('refused');
  expect(JSON.stringify(only)).not.toContain('2:999');
  // A key the data holds is searched for as asked.
  const held = { search: () => [], get: (id: string) => (id === 'verse:21:30' ? ({ id, kind: 'verse', ref: '21:30', title: '21:30', text: '', knowledge: 'scripture' } as unknown as Passage) : null) };
  const kept = await tool('search.knowledge').run({ query: 'verse 21:30' }, { ...envFor(fakeApp().app), retriever: held });
  expect(JSON.stringify(kept)).toContain('21:30');
  const search = registry.get('search.knowledge');
  expect(search?.preview({ query: 'Quran 2:999' }, BASE, fakeApp().app.i18n)).not.toContain('2:999');
});

/* ----- Calculators against textbook values ----- */

test('escape and circular speeds: the Earth 11.19 km/s, Mars 5.03 km/s', async () => {
  expect(factNumber(await run('calc.escape_speed', { body: 'earth' }), 'calc.escape_speed.earth')).toBeCloseTo(11.19, 2);
  const mars = await run('calc.escape_speed', { body: 'mars' });
  expect(mars.status).toBe('done');
  expect(factNumber(mars, 'calc.escape_speed.mars')).toBeCloseTo(5.03, 2);
  const inputs = mars.facts?.filter((f) => f.knowledge === 'observed').map((f) => f.sourceIds?.[0]);
  expect(inputs).toEqual(['jpl-de440', 'naif-pck00011']);
  expect(mars.facts?.[0]?.knowledge).toBe('model');
  expect(mars.blocks?.[0]?.type).toBe('facts');
  // Low orbit: about 7.8 km/s at 200 km.
  expect(factNumber(await run('calc.circular_speed', { body: 'earth', altitudeKm: 200 }), 'calc.circular_speed.earth')).toBeCloseTo(7.78, 1);
});

test('orbital period: the Moon about 27.32 days, the Earth’s year 365.25', async () => {
  const moon = await run('calc.orbital_period', { primary: 'earth', body: 'moon', aKm: 384_400 });
  // Two bodies alone give 27.28 d at the Moon's mean distance; the Sun's pull makes the real sidereal month 27.32 d.
  expect(Math.abs(factNumber(moon, 'period.days') - 27.32)).toBeLessThan(0.06);
  const year = await run('calc.orbital_period', { body: 'earth' });
  expect(factNumber(year, 'period.days')).toBeCloseTo(365.25, 0);
  expect(registry.validate({ tool: 'calc.orbital_period', args: { body: 'moon' } }, BASE).ok).toBe(false);
});

test('light time: about 499 s from the Sun to the Earth', async () => {
  expect(factNumber(await run('calc.light_time', { distanceAu: 1 }), 'light.seconds')).toBeCloseTo(499.0, 0);
  // At today's distance (or the explorer's date): between perihelion and aphelion.
  const now = factNumber(await run('calc.light_time', { from: 'sun', to: 'earth' }), 'light.seconds');
  expect(now).toBeGreaterThan(489);
  expect(now).toBeLessThan(509);
});

test('Hohmann transfer: the Earth to Mars about 5.6 km/s, about 259 days', async () => {
  const out = await run('calc.hohmann', { from: 'earth', to: 'mars' });
  expect(Math.abs(factNumber(out, 'hohmann.total') - 5.6)).toBeLessThan(0.1);
  expect(Math.abs(factNumber(out, 'hohmann.days') - 259)).toBeLessThan(3);
  expect(factNumber(out, 'hohmann.dv1')).toBeCloseTo(2.94, 1);
  // About a body other than the Sun, radii are given.
  const leo = await run('calc.hohmann', { primary: 'earth', fromKm: 6678, toKm: 42_164 });
  expect(factNumber(leo, 'hohmann.total')).toBeCloseTo(3.9, 1);
});

test('Roche limits of the Earth for the Moon’s density: about 18,400 km fluid, 9,500 km rigid', async () => {
  const out = await run('calc.roche', { primary: 'earth', satellite: 'moon' });
  const fluid = factNumber(out, 'roche.fluid');
  const rigid = factNumber(out, 'roche.rigid');
  expect(fluid).toBeGreaterThan(18_200);
  expect(fluid).toBeLessThan(18_600);
  expect(rigid).toBeGreaterThan(9400);
  expect(rigid).toBeLessThan(9600);
  expect(factNumber(out, 'roche.primaryDensity')).toBeCloseTo(5513, -1);
  expect(factNumber(out, 'roche.satelliteDensity')).toBeCloseTo(3344, -1);
});

test('the qibla from London is about 119 degrees from true north', async () => {
  const out = await run('islamic.qibla', { lat: 51.5074, lon: -0.1278 });
  expect(Math.abs(factNumber(out, 'qibla.bearing') - 119)).toBeLessThan(0.5);
  expect(factValue(out, 'qibla.compass')).toBe('east-south-east');
  expect(factNumber(out, 'qibla.distance')).toBeGreaterThan(4700);
  expect(factNumber(out, 'qibla.distance')).toBeLessThan(4850);
  expect(out.blocks?.some((b) => b.type === 'notice' && b.key === 'ai.tool.islamic.note')).toBe(true);
});

test('the Hill radius, world facts and an impact', async () => {
  const hill = factNumber(await run('calc.hill', { body: 'earth' }), 'hill.radius');
  expect(hill).toBeGreaterThan(1.4e6);
  expect(hill).toBeLessThan(1.55e6);
  const facts = await run('calc.world_facts', { body: 'earth' });
  expect(factNumber(facts, 'earth.escapeKmS')).toBe(11.19);
  expect(facts.facts?.find((f) => f.id === 'earth.escapeKmS')?.knowledge).toBe('observed');
  const moon = await run('calc.world_facts', { body: 'moon' });
  expect(moon.facts?.find((f) => f.id === 'moon.escapeKmS')?.knowledge).toBe('model');
  const impact = await run('calc.impact', { target: 'earth', diameterKm: 10, speedKmS: 20, angleDeg: 45 });
  expect(factNumber(impact, 'impact.crater')).toBeGreaterThan(80);
  expect(factNumber(impact, 'impact.crater')).toBeLessThan(250);
  expect(factValue(impact, 'impact.complex')).toContain('complex');
  const jupiter = await run('calc.impact', { target: 'jupiter', diameterKm: 1, speedKmS: 60 });
  expect(jupiter.facts?.some((f) => f.id === 'impact.crater')).toBe(false);
  expect(jupiter.blocks?.some((b) => b.type === 'notice' && b.key === 'ai.tool.calc.impact.noSurface')).toBe(true);
});

test('the times of prayer by a named convention, the crescent and the Hijri date', async () => {
  const london = await run('islamic.prayer_times', { lat: 51.5074, lon: -0.1278, date: '2026-06-21', convention: 'mwl' });
  expect(factValue(london, 'prayer.convention')).toBe('Muslim World League');
  // The Sun's transit over London on 21 June 2026: 12:02 UTC (US Naval Observatory).
  expect(String(factValue(london, 'prayer.dhuhr'))).toMatch(/^12:0[12]$/u);
  expect(london.facts?.find((f) => f.id === 'prayer.dhuhr')?.unit).toBe('UTC');
  expect(london.blocks?.some((b) => b.type === 'notice' && b.key === 'ai.tool.islamic.prayer.note')).toBe(true);
  expect(registry.validate({ tool: 'islamic.prayer_times', args: { lat: 1, lon: 2 } }, BASE).ok).toBe(false);
  // 1 Ramadan 1447 on 18 February 2026 (Umm al-Qura).
  expect(factValue(await run('islamic.hijri', { date: '2026-02-18' }), 'hijri.date')).toBe('1 Ramadan 1447 AH');
  const crescent = await run('islamic.crescent', { place: 'medina', date: '2026-02-17' });
  expect(crescent.facts?.filter((f) => f.id.startsWith('crescent.evening'))).toHaveLength(3);
  expect(String(factValue(crescent, 'crescent.conjunction'))).toContain('2026-02-17');
  // Outside the data (the Moon's table ends with 2035; the planets' elements with 2050) the answer would be wrong: refused, with the span.
  const late = await run('islamic.crescent', { place: 'medina', date: '2040-01-01' });
  expect(late.status).toBe('refused');
  expect(late.problem?.messageKey).toBe('ai.tool.time.date.outside');
  expect((await run('islamic.prayer_times', { place: 'medina', date: '2100-01-01', convention: 'makkah' })).status).toBe('refused');
});

/* ----- Citations from the data files ----- */

test('citations: only keys and ids in the data, never an excluded hadith, never wording', async () => {
  const quran = readJson('data/quran.json') as QuranFile;
  const hadith = readJson('data/hadith.json') as HadithFile;
  const catalogue = catalogueFrom(quran, hadith, data);
  expect(catalogue.verses).toEqual(quran.ayat.map((a) => a.key));
  const excluded = new Set(hadith.excluded.map((e) => e.sunnahKey));
  for (const id of catalogue.hadith) {
    const entry = hadith.hadith.find((h) => h.id === id);
    expect(entry && !excluded.has(entry.sunnahKey) && !entry.parallels.some((p) => excluded.has(p))).toBe(true);
  }
  const app = fakeApp().app;
  const full = await createRegistryFor(app);
  const verse = full.get('cite.verse');
  const verseKeys = (verse?.args as Extract<JsonSchema, { type: 'object' }> | undefined)?.properties.key;
  expect(verseKeys && 'enum' in verseKeys ? verseKeys.enum : null).toEqual(catalogue.verses);
  expect(full.validate({ tool: 'cite.verse', args: { key: '21:30' } }, BASE).ok).toBe(true);
  expect(full.validate({ tool: 'cite.verse', args: { key: '2:255' } }, BASE).ok).toBe(false);
  const shown = await full.get('cite.verse')?.run({ key: '21:30' }, envFor(app));
  expect(shown?.blocks).toEqual([{ type: 'verse', key: '21:30' }]);
  const id = catalogue.hadith[0] ?? '';
  const h = await full.get('cite.hadith')?.run({ id }, envFor(app));
  expect(h?.blocks?.[0]).toEqual({ type: 'hadith', id });
  // Reference, narrator and grading only: no fact carries the wording.
  expect(h?.facts?.map((f) => f.id.split('.').pop())).toEqual(expect.arrayContaining(['reference', 'narrator', 'grading']));
  expect(JSON.stringify(h)).not.toContain('"text"');
  // Without a catalogue the scripture tools are not offered.
  expect(registry.get('cite.verse')?.available(BASE)).toBe(false);
  const c = await run('cite.constant', { id: 'light.speed' });
  expect(factValue(c, 'constant:light.speed')).toBe(299_792_458);
  expect((await run('cite.constant', { id: 'no.such.thing' })).status).toBe('refused');
  const s = await run('cite.source', { id: 'jpl-de440' });
  expect(s.status).toBe('done');
});

test('search returns verses and hadith by reference only', async () => {
  const app = fakeApp().app;
  const env: ToolEnv = {
    ...envFor(app),
    retriever: {
      get: () => null,
      search: () => [
        { passage: { id: 'verse:21:30', kind: 'verse', title: '21:30', text: 'a translation', ref: '21:30', knowledge: 'scripture' }, score: 2 },
        { passage: { id: 'hadith:none', kind: 'hadith', title: 'x', text: 'x', ref: 'not-a-hadith', knowledge: 'scripture' }, score: 1.5 },
        { passage: { id: 'prose:x', kind: 'prose', title: 'Prose', text: 'Some prose.', knowledge: 'explanation' }, score: 1 },
      ],
    },
  };
  const out = await tool('search.knowledge').run({ query: 'water' }, env);
  expect(out.blocks?.map((b) => b.type)).toEqual(['verse', 'passage']);
});

/* ----- View tools confirm by reading the state back, and undo ----- */

function skyView(): UniverseView {
  return { sky: { layers: { constellations: false, boundaries: false, grid: false, names: false }, stars: 0 }, lab: null, time: { rate: 1, paused: false, edge: null, startMs: Date.UTC(2026, 0, 1), endMs: Date.UTC(2035, 0, 1), hijri: null }, unixMs: Date.UTC(2026, 9, 26), focus: 'earth', travelling: false } as unknown as UniverseView;
}

test('a view tool is done only when the state shows it, and its undo puts it back', async () => {
  const fake = fakeApp((c, v) => {
    if (v && typeof c === 'object' && c !== null && 'kind' in c && c.kind === 'layer') {
      const cmd = c as unknown as { layer: SkyLayerName; on: boolean };
      v.sky.layers[cmd.layer] = cmd.on;
    }
  });
  fake.setView(skyView());
  const out = await tool('explorer.sky').run({ layer: 'grid', on: true }, envFor(fake.app, EXPLORER));
  expect(out.status).toBe('done');
  expect(fake.app.universe()?.sky.layers.grid).toBe(true);
  await out.undo?.();
  expect(fake.app.universe()?.sky.layers.grid).toBe(false);
  // An app that takes the command but shows nothing: not confirmed.
  const deaf = fakeApp();
  deaf.setView(skyView());
  const unseen = await tool('explorer.sky').run({ layer: 'names', on: true }, envFor(deaf.app, EXPLORER, 50));
  expect(unseen.status).toBe('not-confirmed');
});

test('a date outside the data’s span is refused with the span', async () => {
  const fake = fakeApp();
  fake.setView(skyView());
  const out = await tool('time.date').run({ date: '2040-01-01' }, envFor(fake.app, EXPLORER));
  expect(out.status).toBe('refused');
  expect(out.problem).toEqual({ path: 'date', messageKey: 'ai.tool.time.date.outside', values: { start: '2026-01-01', end: '2035-01-01' } });
  expect(fake.sent).toEqual([]);
});

/** A small laboratory that keeps an undo list of whole states, as the real one does (src/sim/engine.ts). */
function fakeLab(): { fake: FakeApp; lab: UniverseLab } {
  const gPerKg = 398_600.435 / 5.972e24;
  const body = (id: string, name: string, massKg: number): UniverseLabBody => ({ id, name, massKg, gm: massKg * gPerKg, radiusKm: 1000, primary: id === 'sun' ? null : 'sun', persistent: id === 'sun', relativeVelKmS: [0, 0, 0], edited: false, orbit: null } as unknown as UniverseLabBody);
  const lab = { name: 'solar-system', bodies: [body('sun', 'Sun', 1.989e30), body('earth', 'Earth', 5.972e24), body('jupiter', 'Jupiter', 1.898e27)], undoable: 0, names: { sun: 'Sun', earth: 'Earth', jupiter: 'Jupiter' }, auKm: 149_597_870.7 } as unknown as UniverseLab;
  const history: UniverseLabBody[][] = [];
  const fake = fakeApp((c) => {
    const cmd = c as LabCommand;
    const edit = (change: () => void): void => {
      history.push(structuredClone<UniverseLabBody[]>([...lab.bodies]));
      change();
      lab.undoable += 1;
    };
    if (cmd.kind === 'mass') {
      edit(() => {
        const b = lab.bodies.find((x) => x.id === cmd.id);
        if (b) b.massKg = cmd.massKg;
      });
    } else if (cmd.kind === 'remove') {
      edit(() => {
        (lab as { bodies: UniverseLabBody[] }).bodies = lab.bodies.filter((x) => x.id !== cmd.id);
      });
    } else if (cmd.kind === 'undo') {
      const back = history.pop();
      if (!back) return;
      (lab as { bodies: UniverseLabBody[] }).bodies = back;
      lab.undoable -= 1;
    }
  });
  fake.setView({ ...skyView(), lab });
  return { fake, lab };
}

const sunMass = (lab: UniverseLab): number | undefined => lab.bodies.find((b) => b.id === 'sun')?.massKg;

test('an experiment is applied, confirmed by reading the laboratory back, and undone by its own undo', async () => {
  const { fake, lab } = fakeLab();
  const preview = tool('lab.experiment').preview({ experiment: 'scale-mass', body: 'sun', factor: 2 }, LAB, fake.app.i18n);
  // The card promises only the edit: nothing is integrated ahead by applying it.
  expect(preview).toBe('Multiply Sun’s mass by 2.');
  expect(tool('lab.compare').preview({ experiment: 'scale-mass', body: 'sun', factor: 2 }, LAB, fake.app.i18n)).toBe('In the background, integrate 3,650 days ahead with and without this change: Multiply Sun’s mass by 2.');
  const out = await tool('lab.experiment').run({ experiment: 'scale-mass', body: 'sun', factor: 2 }, envFor(fake.app, LAB));
  expect(out.status).toBe('done');
  expect(fake.app.i18n.t(out.observedKey ?? '', out.observedValues)).toBe('The laboratory shows the change: Multiply Sun’s mass by 2.');
  expect(sunMass(lab)).toBeCloseTo(2 * 1.989e30, -25);
  expect(fake.sent[0]).toEqual({ kind: 'mass', id: 'sun', massKg: 2 * 1.989e30 });
  expect(await out.undo?.()).toEqual({ status: 'done' });
  expect(sunMass(lab)).toBe(1.989e30);
  expect(lab.undoable).toBe(0);
});

test('an experiment’s undo is its own: refused while a later edit sits on top, done once that edit is undone', async () => {
  const { fake, lab } = fakeLab();
  const out = await tool('lab.experiment').run({ experiment: 'scale-mass', body: 'sun', factor: 2 }, envFor(fake.app, LAB));
  expect(out.status).toBe('done');
  // The visitor removes Jupiter by hand, as the laboratory's panel would.
  fake.app.universeLab({ kind: 'remove', id: 'jupiter' });
  expect(lab.undoable).toBe(2);
  const refused = await out.undo?.();
  expect(refused).toEqual({ status: 'refused', problem: { path: '', messageKey: 'ai.tool.lab.experiment.undoLater' } });
  // Nothing was sent: Jupiter is still gone and the Sun still doubled.
  expect(fake.sent.filter((c) => (c as LabCommand).kind === 'undo')).toEqual([]);
  expect(lab.bodies.some((b) => b.id === 'jupiter')).toBe(false);
  expect(sunMass(lab)).toBeCloseTo(2 * 1.989e30, -25);
  // The visitor's own edit undone in the laboratory, the experiment's undo goes through.
  fake.app.universeLab({ kind: 'undo' });
  expect(await out.undo?.()).toEqual({ status: 'done' });
  expect(sunMass(lab)).toBe(1.989e30);
  expect(lab.bodies.some((b) => b.id === 'jupiter')).toBe(true);
});

test('an experiment’s undo once the laboratory no longer shows it is refused, and an undo the laboratory ignores is not confirmed', async () => {
  const { fake, lab } = fakeLab();
  const out = await tool('lab.experiment').run({ experiment: 'scale-mass', body: 'sun', factor: 2 }, envFor(fake.app, LAB));
  fake.app.universeLab({ kind: 'undo' });
  expect(await out.undo?.()).toEqual({ status: 'refused', problem: { path: '', messageKey: 'ai.tool.lab.experiment.undoGone' } });
  expect(lab.undoable).toBe(0);
  // A laboratory that takes the undo but never shows it.
  const second = await tool('lab.experiment').run({ experiment: 'scale-mass', body: 'sun', factor: 2 }, envFor(fake.app, LAB));
  const realUndo = fake.app.universeLab.bind(fake.app);
  (fake.app as { universeLab: (c: LabCommand) => void }).universeLab = () => undefined;
  expect(await second.undo?.()).toEqual({ status: 'not-confirmed' });
  (fake.app as { universeLab: (c: LabCommand) => void }).universeLab = realUndo;
});

test('an experiment stopped before it sends anything sends nothing; stopped while it waits, it reports what it sent, with its undo', async () => {
  const { fake, lab } = fakeLab();
  const stopped = new AbortController();
  stopped.abort();
  const none = await tool('lab.experiment').run({ experiment: 'scale-mass', body: 'sun', factor: 2 }, { ...envFor(fake.app, LAB), signal: stopped.signal });
  expect(none.status).toBe('refused');
  expect(fake.sent).toEqual([]);
  // A laboratory slow to show the edit, and the turn stopped meanwhile.
  const slow = fakeLab();
  const real = slow.fake.app.universeLab.bind(slow.fake.app);
  (slow.fake.app as { universeLab: (c: LabCommand) => void }).universeLab = (c) => {
    setTimeout(() => {
      real(c);
    }, 200);
  };
  const control = new AbortController();
  const env = { ...envFor(slow.fake.app, LAB, 2000), signal: control.signal };
  const waiting = tool('lab.experiment').run({ experiment: 'scale-mass', body: 'sun', factor: 2 }, {
    ...env,
    until: (p, ms) => (control.signal.aborted ? Promise.resolve(false) : env.until(() => control.signal.aborted || p(), ms).then((held) => held && !control.signal.aborted)),
  });
  setTimeout(() => {
    control.abort();
  }, 50);
  const sent = await waiting;
  expect(sent.status).toBe('not-confirmed');
  expect(sent.undo).toBeDefined();
  await expect.poll(() => sunMass(slow.lab)).toBeCloseTo(2 * 1.989e30, -25);
  (slow.fake.app as { universeLab: (c: LabCommand) => void }).universeLab = real;
  expect(await sent.undo?.()).toEqual({ status: 'done' });
  expect(sunMass(slow.lab)).toBe(1.989e30);
  expect(slow.lab.undoable).toBe(0);
  expect(lab.undoable).toBe(0);
});

/* ----- In the background (no worker in Node: the same job in this thread) ----- */

test('a comparison outside the laboratory runs against the solar system as seeded, changing nothing', async () => {
  const fake = fakeApp();
  const out = await run('lab.compare', { experiment: 'scale-mass', body: 'sun', factor: 2, horizonDays: 30 }, BASE, fake.app);
  expect(out.status, JSON.stringify(out.problem)).toBe('done');
  expect(fake.sent).toEqual([]);
  const block = out.blocks?.find((b) => b.type === 'comparison');
  if (block?.type !== 'comparison') throw new Error('no comparison');
  expect(block.comparison.experiment).toBe('scale-mass');
  expect(block.comparison.horizonDays).toBe(30);
  expect(block.comparison.rows[0]?.label).toBe('Sun: closest approach to any body');
  expect(out.facts?.every((f) => f.knowledge === 'simulation')).toBe(true);
  expect(out.blocks?.some((b) => b.type === 'notice' && b.key === 'ai.tool.lab.compare.note')).toBe(true);
  // Numbers the laboratory would refuse are refused before anything runs.
  const slow = await run('lab.compare', { experiment: 'impact', target: 'earth', diameterKm: 1, speedKmS: 3, angleDeg: 45 }, BASE, fake.app);
  expect(slow.problem?.messageKey).toBe('ai.tool.experiment.slow');
});

test('a search outside the laboratory: the Sun’s mass for a year of 300 days', async () => {
  const out = await run('lab.optimise', { goal: 'year', body: 'earth', targetDays: 300 });
  expect(out.status, JSON.stringify(out.problem)).toBe('done');
  const factor = factNumber(out, 'optimise.value');
  // Kepler's third law with the Earth's speed kept, T = T0 / sqrt(f (2 - 1/f)^3), gives f of about 1.11.
  expect(factor).toBeGreaterThan(1.09);
  expect(factor).toBeLessThan(1.13);
  expect(factNumber(out, 'optimise.runs')).toBeLessThanOrEqual(24);
});

test('a background job stops when the turn is cancelled', async () => {
  const fake = fakeApp();
  const control = new AbortController();
  const env = { ...envFor(fake.app), signal: control.signal };
  const pending = tool('lab.compare').run({ experiment: 'scale-mass', body: 'sun', factor: 2, horizonDays: 36_500 }, env);
  setTimeout(() => {
    control.abort();
  }, 50);
  const out = await pending;
  expect(out.status).toBe('failed');
  expect(out.problem?.messageKey).toBe('ai.tool.problem.cancelled');
});
