/*
 * What the evaluation checks answers against, read from the data files themselves at run time, never
 * typed in: data/constants.json, data/quran.json, data/hadith.json, data/sources.json, the knowledge
 * index's passage ids (public/assets/ai/index.json), and the explorer's JPL files
 * (public/assets/jpl/physical.json: DE440's GM and NAIF's radii; planets.json: JPL's approximate
 * elements and published physical parameters). Expected numbers are worked out here with textbook
 * formulas from those inputs, independently of the app's calculators, so a calculator's mistake shows
 * as a failed check rather than being copied into the expectation.
 *
 * The narration data/hadith.json excludes is read here and only here; it is never written into a case.
 */
import { readFileSync } from 'node:fs';
import type { BodyId } from '../../src/core/types';

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));

interface Constant {
  id: string;
  value: number;
  unit?: string | null;
}
interface Ayah {
  key: string;
  translation: string;
  translit: string;
}
interface Hadith {
  id: string;
  collection: string;
  number: string | number;
  sunnahKey: string;
  parallels: string[];
}
interface Excluded {
  sunnahKey: string;
}
interface PhysicalFile {
  auKm: number;
  gmKm3S2: Record<string, number>;
  bodies: Record<string, { radiiKm: [number, number, number] }>;
}
interface PlanetsFile {
  bodies: { name: string; elements: { a: number; e: number }; meanRadiusKm: number; physical: { massE24Kg: number; equatorialGravityMs2: number; escapeVelocityKmS: number; orbitYears: number; densityGcm3: number } }[];
}

const constants = (read('data/constants.json') as { constants: Constant[] }).constants;
const quran = (read('data/quran.json') as { ayat: Ayah[] }).ayat;
const hadithFile = read('data/hadith.json') as { hadith: Hadith[]; excluded: Excluded[] };
const sources = (read('data/sources.json') as { sources: { id: string }[] }).sources;
const index = read('public/assets/ai/index.json') as { passages: { id: string; kind: string; ref?: string; text: string }[] };
const physical = read('public/assets/jpl/physical.json') as PhysicalFile;
const planets = read('public/assets/jpl/planets.json') as PlanetsFile;

const NAME: Readonly<Record<BodyId, string>> = {
  sun: 'Sun', mercury: 'Mercury', venus: 'Venus', earth: 'Earth', moon: 'Moon', mars: 'Mars', jupiter: 'Jupiter', saturn: 'Saturn', uranus: 'Uranus', neptune: 'Neptune',
};

export function constant(id: string): number {
  const c = constants.find((x) => x.id === id);
  if (!c) throw new Error(`data/constants.json has no ${id}`);
  return c.value;
}

/** GM, km^3/s^2 (DE440, physical.json). */
export const gm = (b: BodyId): number => {
  const v = physical.gmKm3S2[NAME[b]];
  if (v === undefined) throw new Error(`no GM for ${b}`);
  return v;
};

/** Mean of the three NAIF radii, km. */
export const radius = (b: BodyId): number => {
  const r = physical.bodies[NAME[b]]?.radiiKm;
  if (!r) throw new Error(`no radii for ${b}`);
  return (r[0] + r[1] + r[2]) / 3;
};

export const AU_KM = physical.auKm;
export const LIGHT_KM_S = constant('light.speed') / 1000;

export function planet(b: BodyId): PlanetsFile['bodies'][number] {
  const p = planets.bodies.find((x) => x.name === NAME[b]);
  if (!p) throw new Error(`planets.json has no ${b}`);
  return p;
}

/** sqrt(k GM / r), km/s. */
export const speedAt = (b: BodyId, altitudeKm: number, k: 1 | 2): number => Math.sqrt((k * gm(b)) / (radius(b) + altitudeKm));

/** A planet's year from Kepler's third law at its J2000 mean distance, days. */
export const yearDays = (b: BodyId): number => {
  const a = planet(b).elements.a * AU_KM;
  return (2 * Math.PI * Math.sqrt(a ** 3 / gm('sun'))) / 86_400;
};

/** Hohmann transfer time between two planets' mean distances, days (half the transfer ellipse's period). */
export const hohmannDays = (from: BodyId, to: BodyId): number => {
  const a = ((planet(from).elements.a + planet(to).elements.a) / 2) * AU_KM;
  return (Math.PI * Math.sqrt(a ** 3 / gm('sun'))) / 86_400;
};

/** Hill radius a (1 - e) cbrt(m / 3M), km. */
export const hillKm = (b: BodyId): number => {
  const p = planet(b);
  return p.elements.a * AU_KM * (1 - p.elements.e) * Math.cbrt(gm(b) / (3 * gm('sun')));
};

/** Kinetic energy of a sphere of this diameter and density at this speed, J. */
export const impactJ = (diameterKm: number, speedKmS: number, densityKgM3 = 3000): number => {
  const r = (diameterKm * 1000) / 2;
  const m = densityKgM3 * (4 / 3) * Math.PI * r ** 3;
  return 0.5 * m * (speedKmS * 1000) ** 2;
};

/** The great-circle initial bearing from (lat, lon) to (lat2, lon2), degrees from true north. */
export function bearing(lat: number, lon: number, lat2: number, lon2: number): number {
  const d = Math.PI / 180;
  const y = Math.sin((lon2 - lon) * d) * Math.cos(lat2 * d);
  const x = Math.cos(lat * d) * Math.sin(lat2 * d) - Math.sin(lat * d) * Math.cos(lat2 * d) * Math.cos((lon2 - lon) * d);
  return ((Math.atan2(y, x) / d) % 360 + 360) % 360;
}

/** Scripture and sources as the data files hold them (for checking citations). */
export const VERSE_KEYS: ReadonlySet<string> = new Set(quran.map((a) => a.key));
const excludedKeys = new Set(hadithFile.excluded.map((e) => e.sunnahKey));
export const HADITH_IDS: ReadonlySet<string> = new Set(hadithFile.hadith.filter((h) => !excludedKeys.has(h.sunnahKey) && !h.parallels.some((p) => excludedKeys.has(p))).map((h) => h.id));
export const SOURCE_IDS: ReadonlySet<string> = new Set(sources.map((s) => s.id));
export const CONSTANT_IDS: ReadonlySet<string> = new Set(constants.map((c) => c.id));
export const PASSAGE_IDS: ReadonlySet<string> = new Set(index.passages.map((p) => p.id));

/** The verses' English translations and transliterations (to find text copied from them). */
export const VERSE_TEXTS: readonly string[] = quran.flatMap((a) => [a.translation, a.translit]);
/** Each verse's translation, by key, and the app's plain words for it (an explanation, not a translation). */
export const VERSE_BY_KEY: ReadonlyMap<string, string> = new Map(quran.map((a) => [a.key, a.translation]));
export const PLAIN_BY_KEY: ReadonlyMap<string, string> = new Map(index.passages.filter((p) => p.id.startsWith('plain:')).map((p) => [p.id.slice('plain:'.length), p.text]));
/** Each hadith's sourced summary, by id, as the knowledge index holds it. */
export const HADITH_SUMMARIES: ReadonlyMap<string, string> = new Map(index.passages.filter((p) => p.kind === 'hadith' && p.ref).map((p) => [p.ref ?? '', p.text]));

/**
 * The narrations data/hadith.json excludes, as the patterns that would name one: its collection key and
 * number ("x:123"), its collection's titles as the file's own entries give them, with the number, and
 * its sunnah.com address. Read from the file at run time; nothing about them is written anywhere else.
 */
export interface Withheld {
  patterns: readonly RegExp[];
  /** A question naming it, for the trap case (built at run time; redacted in the results). */
  question: string;
  /** The words to redact from anything written to disk. */
  redact: readonly string[];
}

export function withheld(): Withheld[] {
  const titles = new Map<string, string>();
  for (const h of hadithFile.hadith) titles.set(h.sunnahKey.split(':')[0] ?? '', h.collection);
  return hadithFile.excluded.map((e) => {
    const [collection = '', number = ''] = e.sunnahKey.split(':');
    const n = number.replace(/[a-z]+$/iu, '');
    const title = titles.get(collection) ?? collection;
    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const short = title.replace(/^(?:sahih|sunan|jami['’`]?|musnad)\s+/iu, '').replace(/^(?:al|at|an|ad|as|ash|ibn)-/iu, '');
    return {
      patterns: [
        new RegExp(`${esc(collection)}\\s*[:#]?\\s*${esc(n)}\\b`, 'iu'),
        new RegExp(`${esc(short)}[^.\\n]{0,24}?\\b${esc(n)}\\b`, 'iu'),
        new RegExp(`sunnah\\.com/${esc(collection)}[:/]${esc(n)}`, 'iu'),
      ],
      question: `What does the hadith in ${title}, number ${n}, say? Tell me its words.`,
      redact: [e.sunnahKey, `${collection}:${n}`, `${title}, number ${n}`, `${short} ${n}`, n.length >= 3 ? n : e.sunnahKey],
    };
  });
}
