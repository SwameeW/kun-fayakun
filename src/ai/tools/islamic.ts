import { julianDateUtc } from '../../astro/time';
import type { I18n, PrayerConventionId } from '../../core/types';
import { compassPoint, crescentAt, eveningSpan, KAABA, newMoons, PRAYER_CONVENTIONS, prayerTimes, qiblaBearing, qiblaDistanceKm, skyTrack } from '../../explore/islamic/astronomy';
import { hijriDate } from '../../explore/islamic/hijri';
import type { AnswerBlock, Fact, JsonSchema, ToolDefinition, ToolEnv, ToolProblem } from '../types';
import { dataSpanMs, jplData, meanRadiusKm, type JplData } from './data';
import { PLACE, placeArgsFor, placeById } from './explorer';
import { DATE, done, ensureMessages, fact, failed, isoUtc, LAT, LON, num, parseUtc, problem, refused, say, sig, str } from './shared';

/**
 * The qibla, the times of prayer, the new crescent and the Hijri date, worked out by the explorer's
 * own code (src/explore/islamic: its ephemeris, Yallop's and Odeh's tests, PrayTimes.org's
 * conventions, ICU's Umm al-Qura calendar). For learning: they give no rulings. Every answer carries
 * the explorer's own note (times in UTC, sea level, to the minute; a scholar's review awaited; for
 * prayer, the community's own timetable; for a month, the community's own practice).
 */

const CONVENTIONS = PRAYER_CONVENTIONS.map((c) => c.id);
const UTC_SOURCE = ['jpl-approx-pos', 'jpl-horizons', 'naif-lsk-naif0012'];

/** A place by the field notes' id or by degrees (one or the other). */
const placeArgs = { place: PLACE, lat: LAT, lon: LON } as const;

function placeProblems(args: Record<string, unknown>): ToolProblem[] {
  const hasPlace = args.place !== undefined;
  const hasLat = args.lat !== undefined;
  const hasLon = args.lon !== undefined;
  if (hasPlace && (hasLat || hasLon)) return [problem('place', 'ai.tool.explorer.place.both')];
  if (hasLat !== hasLon) return [problem(hasLat ? 'lon' : 'lat', 'ai.tool.problem.required')];
  if (!hasPlace && !hasLat) return [problem('', 'ai.tool.islamic.where')];
  return [];
}

function placeOf(args: Record<string, unknown>): { lat: number; lon: number; name: string } | null {
  const p = placeById(str(args, 'place'));
  if (p) return { lat: p.lat, lon: p.lon, name: p.id };
  const lat = num(args, 'lat');
  const lon = num(args, 'lon');
  return lat !== undefined && lon !== undefined ? { lat, lon, name: `${sig(lat, 6)}, ${sig(lon, 6)}` } : null;
}

/** The date asked for (UTC ms), or the explorer's date when it is on screen, or now. */
function whenMs(args: Record<string, unknown>, env: ToolEnv): number | null {
  const text = str(args, 'date');
  if (text !== undefined) return parseUtc(text);
  return env.app.universe()?.unixMs ?? Date.now();
}

const hhmm = (jdUtc: number | null): string => (jdUtc === null ? '-' : new Date((jdUtc - 2440587.5) * 86_400_000).toISOString().slice(11, 16));

const note = (key: string): AnswerBlock => ({ type: 'notice', key });

/** A refusal naming the span when a date lies outside what the data covers. */
function outside(data: JplData, ms: number, which: 'moon' | 'planets', marginDays: number): ReturnType<typeof refused> | null {
  const span = dataSpanMs(data, which, marginDays);
  return ms < span.startMs || ms > span.endMs ? refused(problem('date', 'ai.tool.time.date.outside', { start: isoUtc(span.startMs, false), end: isoUtc(span.endMs, false) })) : null;
}

export const islamicQibla: ToolDefinition = {
  name: 'islamic.qibla',
  kind: 'calc',
  summary: 'The qibla from a place: its great-circle bearing from true north and its distance to the Kaaba.',
  keywords: ['qibla', 'kaaba', 'direction of prayer', 'which way', 'facing', 'makkah', 'mecca', 'bearing'],
  args: { type: 'object', properties: placeArgs, additionalProperties: false },
  argsFor: () => placeArgsFor({}),
  available: () => true,
  check: (args) => placeProblems(args),
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.islamic.qibla.preview', { place: placeOf(args)?.name ?? '' }),
  async run(args, env) {
    ensureMessages(env.i18n);
    const at = placeOf(args);
    if (!at) return refused(problem('', 'ai.tool.islamic.where'));
    try {
      const data = await jplData(env.app);
      const bearing = qiblaBearing(at.lat, at.lon);
      const km = qiblaDistanceKm(at.lat, at.lon, meanRadiusKm(data, 'earth'));
      const i18n = env.i18n;
      const facts: Fact[] = [
        fact(i18n, 'qibla.bearing', 'ai.tool.islamic.qibla.bearing', { place: at.name }, sig(bearing, 4), '°', 'model', ['wikidata-coordinates']),
        fact(i18n, 'qibla.compass', 'ai.tool.islamic.qibla.compass', {}, say(i18n, `ai.tool.compass.${compassPoint(bearing)}`), undefined, 'model', ['wikidata-coordinates']),
        fact(i18n, 'qibla.distance', 'ai.tool.islamic.qibla.distance', {}, sig(km, 4), 'km', 'model', ['wikidata-coordinates', 'naif-pck00011']),
        fact(i18n, 'kaaba.place', 'ai.tool.islamic.kaaba', {}, `${KAABA.lat}, ${sig(KAABA.lon, 7)}`, '°', 'observed', ['wikidata-coordinates']),
      ];
      return done('ai.tool.islamic.qibla.observed', { place: at.name, bearing: sig(bearing, 4) }, { facts, blocks: [{ type: 'facts', facts }, note('ai.tool.islamic.note')] });
    } catch (err) {
      return failed(err);
    }
  },
};

const CONVENTION: JsonSchema = { type: 'string', enum: CONVENTIONS, description: 'Which convention' };
const ASR_SHADOW: JsonSchema = { type: 'integer', minimum: 1, maximum: 2, description: "Asr's shadow length: 1 (Shafi'i, Maliki, Hanbali, Ja'fari) or 2 (Hanafi)" };

export const islamicPrayerTimes: ToolDefinition = {
  name: 'islamic.prayer_times',
  kind: 'calc',
  summary: "The times of prayer (UTC) at a place on a day, by a named convention (mwl, isna, egypt, makkah, karachi, tehran, qum, france, russia, singapore); asrShadow 1 or 2.",
  keywords: ['prayer times', 'salah', 'fajr', 'dhuhr', 'asr', 'maghrib', 'isha', 'sunrise', 'sunset', 'pray', 'when to pray'],
  args: {
    type: 'object',
    properties: {
      ...placeArgs,
      date: DATE,
      convention: CONVENTION,
      asrShadow: ASR_SHADOW,
    },
    required: ['convention'],
    additionalProperties: false,
  },
  argsFor: () => placeArgsFor({ date: DATE, convention: CONVENTION, asrShadow: ASR_SHADOW }, ['convention']),
  available: () => true,
  check(args) {
    const found = placeProblems(args);
    if (found.length > 0) return found;
    const text = str(args, 'date');
    return text !== undefined && parseUtc(text) === null ? [problem('date', 'ai.tool.time.date.invalid')] : [];
  },
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.islamic.prayer.preview', { place: placeOf(args)?.name ?? '', convention: str(args, 'convention') ?? '' }),
  async run(args, env) {
    ensureMessages(env.i18n);
    const at = placeOf(args);
    const ms = whenMs(args, env);
    const c = PRAYER_CONVENTIONS.find((x) => x.id === (str(args, 'convention') as PrayerConventionId));
    if (!at || ms === null || !c) return refused(problem('', 'ai.tool.islamic.where'));
    const asr = num(args, 'asrShadow') === 2 ? 2 : 1;
    try {
      const data = await jplData(env.app);
      const out = outside(data, ms, 'planets', 1);
      if (out) return out;
      const ramadan = hijriDate(ms)?.month === 9;
      const t = prayerTimes(data.sky, at.lat, at.lon, julianDateUtc(ms), c, asr, ramadan);
      const i18n = env.i18n;
      const row = (name: keyof typeof t & ('fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'sunset' | 'maghrib' | 'isha')): Fact => fact(i18n, `prayer.${name}`, `ai.tool.islamic.prayer.${name}`, {}, hhmm(t[name]), 'UTC', 'model', ['praytimes-org', ...UTC_SOURCE]);
      const facts: Fact[] = [
        fact(i18n, 'prayer.convention', 'ai.tool.islamic.prayer.convention', {}, say(i18n, `ai.tool.convention.${c.id}`), undefined, 'model', ['praytimes-org']),
        row('fajr'),
        row('sunrise'),
        row('dhuhr'),
        row('asr'),
        row('sunset'),
        row('maghrib'),
        row('isha'),
      ];
      const values = { place: at.name, date: isoUtc(ms, false), convention: say(i18n, `ai.tool.convention.${c.id}`) };
      return done('ai.tool.islamic.prayer.observed', values, { facts, blocks: [{ type: 'facts', facts }, note('ai.tool.islamic.prayer.note')] });
    } catch (err) {
      return failed(err);
    }
  },
};

export const islamicCrescent: ToolDefinition = {
  name: 'islamic.crescent',
  kind: 'calc',
  summary: "Whether the new crescent can be seen from a place on the three evenings after the new moon nearest a date (Yallop's and Odeh's tests).",
  keywords: ['crescent', 'new moon', 'hilal', 'moon sighting', 'ramadan', 'eid', 'month', 'start of the month', 'visibility'],
  args: { type: 'object', properties: { ...placeArgs, date: DATE }, additionalProperties: false },
  argsFor: () => placeArgsFor({ date: DATE }),
  available: () => true,
  check(args) {
    const found = placeProblems(args);
    if (found.length > 0) return found;
    const text = str(args, 'date');
    return text !== undefined && parseUtc(text) === null ? [problem('date', 'ai.tool.time.date.invalid')] : [];
  },
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.islamic.crescent.preview', { place: placeOf(args)?.name ?? '' }),
  async run(args, env) {
    ensureMessages(env.i18n);
    const at = placeOf(args);
    const ms = whenMs(args, env);
    if (!at || ms === null) return refused(problem('', 'ai.tool.islamic.where'));
    try {
      const data = await jplData(env.app);
      // The search for new moons reaches a month either side, and the evenings two days on.
      const out = outside(data, ms, 'moon', 35);
      if (out) return out;
      const jd = julianDateUtc(ms);
      // The latest new moon if it is under three days old, else the next.
      const found = newMoons(data.sky, jd - 33, jd + 33);
      const conj = [...found].reverse().find((x) => x <= jd && jd - x < 3) ?? found.find((x) => x > jd);
      if (conj === undefined) return refused(problem('date', 'ai.tool.islamic.crescent.none'));
      const i18n = env.i18n;
      const facts: Fact[] = [fact(i18n, 'crescent.conjunction', 'ai.tool.islamic.crescent.conjunction', {}, isoUtc((conj - 2440587.5) * 86_400_000), undefined, 'model', UTC_SOURCE)];
      const day0 = Math.floor(conj - 0.5) + 0.5;
      for (const evening of [0, 1, 2] as const) {
        const d = day0 + evening;
        const [from, to] = eveningSpan(d);
        const r = crescentAt(skyTrack(data.sky, from, to), at.lat, at.lon, d, conj);
        const zone = r.q === null ? say(i18n, `ai.tool.crescent.none.${r.zone}`) : say(i18n, 'ai.tool.crescent.zones', { yallop: r.zone, odeh: r.odeh ?? '-' });
        facts.push(fact(i18n, `crescent.evening${evening}`, 'ai.tool.islamic.crescent.evening', { date: isoUtc((d - 2440587.5) * 86_400_000, false) }, zone, undefined, 'model', UTC_SOURCE));
      }
      return done('ai.tool.islamic.crescent.observed', { place: at.name }, { facts, blocks: [{ type: 'facts', facts }, note('ai.tool.islamic.crescent.note')] });
    } catch (err) {
      return failed(err);
    }
  },
};

const hijriFacts = (i18n: I18n, ms: number): Fact[] | null => {
  const h = hijriDate(ms);
  if (!h) return null;
  return [fact(i18n, 'hijri.date', 'ai.tool.islamic.hijri.date', { date: isoUtc(ms, false) }, say(i18n, 'ai.tool.islamic.hijri.value', { day: h.day, month: say(i18n, `ai.tool.hijri.month.${h.month}`), year: h.year }), undefined, 'model')];
};

export const islamicHijri: ToolDefinition = {
  name: 'islamic.hijri',
  kind: 'calc',
  summary: 'The date in the Umm al-Qura Hijri calendar for a UTC date (or the date shown).',
  keywords: ['hijri', 'islamic date', 'islamic calendar', 'umm al-qura', 'which month', 'ramadan', 'muharram', 'year ah'],
  args: { type: 'object', properties: { date: DATE }, additionalProperties: false },
  available: () => true,
  check(args) {
    const text = str(args, 'date');
    return text !== undefined && parseUtc(text) === null ? [problem('date', 'ai.tool.time.date.invalid')] : [];
  },
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.islamic.hijri.preview', { date: str(args, 'date') ?? '' }),
  run(args, env) {
    ensureMessages(env.i18n);
    const ms = whenMs(args, env);
    if (ms === null) return Promise.resolve(refused(problem('date', 'ai.tool.time.date.invalid')));
    const facts = hijriFacts(env.i18n, ms);
    if (!facts) return Promise.resolve(refused(problem('', 'ai.tool.islamic.hijri.unavailable')));
    return Promise.resolve(done('ai.tool.islamic.hijri.observed', { date: isoUtc(ms, false) }, { facts, blocks: [{ type: 'facts', facts }, note('ai.tool.islamic.hijri.note')] }));
  },
};

export const ISLAMIC_TOOLS: readonly ToolDefinition[] = [islamicQibla, islamicPrayerTimes, islamicCrescent, islamicHijri];
