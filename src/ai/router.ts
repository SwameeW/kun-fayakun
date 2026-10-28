/**
 * The guide's router: plain English commands and look-ups matched deterministically, before any
 * model is asked. It aims for precision over reach. A question it is not sure of returns null, and
 * a model (when one is loaded) or retrieval takes it instead.
 *
 * Every plan passes through the registry's validator (registry.validate): a tool that is not in the
 * registry, not available where the visitor is, or that refuses the arguments, means no plan. The
 * calls have exactly the argument shapes of the real tools (src/ai/tools, docs/AI-INTELLIGENCE.md
 * §4). Where more than one call could do what is asked (a place of the field notes by its id, else
 * by its degrees; leaving the explorer, else Explore Mode), the router offers them in order and
 * keeps the first the registry accepts here.
 */
import type { BodyId, ChapterId } from '../core/types';
import type { AiContext, Plan, ToolCall, ToolRegistry } from './types';

/** A named place from verified data: its name, its degrees, and its id when it is a place of the field notes. */
export interface NamedPlace {
  name: string;
  lat: number;
  lon: number;
  /** The field notes' id (src/explore/field-notes/data.ts), which the place tools take as `place`. */
  place?: string;
}

export interface RouteOptions {
  /**
   * Resolves a place's name to its coordinates from verified data (the knowledge index's places),
   * or null when no place has that name. Without it, commands that need a named place are left to
   * the model or retrieval.
   */
  place?: (name: string) => NamedPlace | null;
}

interface Candidate {
  intent: Plan['intent'];
  query?: string;
  /** Alternative call lists, in order of preference; the first the registry accepts wins. */
  options: ReadonlyArray<readonly ToolCall[]>;
}

type Matcher = (q: string, ctx: AiContext, options: RouteOptions) => Candidate | null;

/* ------------------------------------------------------------------ */
/* Words                                                               */
/* ------------------------------------------------------------------ */

const BODY_WORDS: Readonly<Record<string, BodyId>> = {
  sun: 'sun',
  mercury: 'mercury',
  venus: 'venus',
  earth: 'earth',
  moon: 'moon',
  mars: 'mars',
  'red planet': 'mars',
  jupiter: 'jupiter',
  saturn: 'saturn',
  uranus: 'uranus',
  neptune: 'neptune',
};
/** A body, with an optional article or "planet": captures the body's word. */
const BODY = String.raw`(?:the\s+|planet\s+|our\s+)?(sun|mercury|venus|earth|moon|mars|red planet|jupiter|saturn|uranus|neptune)`;
const WALKABLE: ReadonlySet<BodyId> = new Set<BodyId>(['earth', 'moon', 'mars', 'mercury', 'venus']);

function bodyOf(word: string | undefined): BodyId | null {
  return word ? (BODY_WORDS[word] ?? null) : null;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

/** The chapters by the names the film gives them (their titles and timeline stops), lower case. */
const CHAPTER_NAMES: Readonly<Record<string, ChapterId>> = {
  'before creation': 'ch00', 'before time': 'ch00',
  beginning: 'ch01', 'the beginning': 'ch01', 'big bang': 'ch01', 'the big bang': 'ch01',
  'first light': 'ch02', 'the first light': 'ch02',
  'first stars': 'ch03', 'the first stars': 'ch03', 'dark ages': 'ch03', 'the dark ages': 'ch03', 'the dark ages and first stars': 'ch03',
  'vast heaven': 'ch04', 'a vast heaven': 'ch04',
  galaxies: 'ch05', 'the galaxies': 'ch05', 'seven heavens': 'ch05', 'the seven heavens': 'ch05', 'seven heavens and the galaxies': 'ch05',
  iron: 'ch06', 'stars and iron': 'ch06',
  'the sun and its course': 'ch07', 'sun and its course': 'ch07',
  'the earth spread out': 'ch08', 'earth spread out': 'ch08',
  life: 'ch09', 'life from water': 'ch09',
  'the end': 'ch10', 'the folding of the heavens': 'ch10', 'folding of the heavens': 'ch10',
};

/** Named stars the explorer can find (its search resolves the rest of the IAU's names). */
const KNOWN_STARS: ReadonlySet<string> = new Set([
  'sirius', 'canopus', 'arcturus', 'vega', 'capella', 'rigel', 'procyon', 'achernar', 'betelgeuse', 'hadar', 'altair',
  'acrux', 'aldebaran', 'antares', 'spica', 'pollux', 'fomalhaut', 'deneb', 'mimosa', 'regulus', 'adhara', 'castor',
  'gacrux', 'shaula', 'bellatrix', 'elnath', 'alnilam', 'alnitak', 'mintaka', 'alioth', 'dubhe', 'mirfak', 'alkaid',
  'polaris', 'hamal', 'alphard', 'algol', 'mizar', 'alcor', 'saiph', 'denebola', 'alpheratz', 'mirach', 'almach',
  'kochab', 'eltanin', 'rasalhague', 'schedar', 'caph', 'izar', 'sadr', 'alphecca', 'suhail', 'toliman',
  'rigil kentaurus', 'alpha centauri', 'proxima centauri', "barnard's star", 'barnards star', 'tau ceti',
  'epsilon eridani', 'wolf 359', 'vega',
]);

const MONTHS: Readonly<Record<string, number>> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH = String.raw`(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)`;

/**
 * Prayer-time conventions by the names people use for them. `places` are names that are also places
 * ("prayer times in Karachi" names a city), so in free text they name the convention only beside a
 * word that says so ("by Karachi", "the Karachi method").
 */
const CONVENTION_NAMES: ReadonlyArray<{ id: string; names?: string; places?: string }> = [
  { id: 'mwl', names: 'mwl|(?:the )?muslim world league' },
  { id: 'isna', names: 'isna|islamic society of north america' },
  { id: 'egypt', names: 'egyptian(?: general authority(?: of survey)?)?', places: 'egypt' },
  { id: 'makkah', names: 'umm al-?qura', places: 'makkah|mecca' },
  { id: 'karachi', names: 'university of islamic sciences(?:,? karachi)?', places: 'karachi' },
  { id: 'tehran', places: 'tehran' },
  { id: 'qum', names: 'jafari', places: 'qum|qom' },
  { id: 'france', names: 'uoif', places: 'france' },
  { id: 'russia', places: 'russia' },
  { id: 'singapore', names: 'muis', places: 'singapore' },
];

/** The conventions as a whole phrase names them (the router's "… by <convention>"). */
const CONVENTIONS: ReadonlyArray<readonly [RegExp, string]> = CONVENTION_NAMES.map(({ id, names, places }) => [new RegExp(`^(?:${[names, places].filter(Boolean).join('|')})$`, 'u'), id] as const);

/** The conventions as free text names them (a model's plan may use only one the question names). */
const NAMED_IN_TEXT: ReadonlyArray<readonly [RegExp, string]> = CONVENTION_NAMES.map(({ id, names, places }) => {
  const ways: string[] = [];
  if (names) ways.push(String.raw`(?<![\p{L}\p{N}])(?:${names})(?![\p{L}\p{N}])`);
  if (places) {
    ways.push(String.raw`\b(?:using|with|by|per|under|following|according to)\s+(?:the\s+)?(?:${places})(?![\p{L}\p{N}])`);
    ways.push(String.raw`(?<![\p{L}\p{N}])(?:${places})\s+(?:convention|method|calculation|angles?|rules?|standard)\b`);
  }
  return [new RegExp(ways.join('|'), 'u'), id] as const;
});

/** The prayer-time conventions a question names, by their ids. */
export function conventionsNamed(question: string): string[] {
  const q = normaliseCommand(question);
  return NAMED_IN_TEXT.filter(([re]) => re.test(q)).map(([, id]) => id);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Lower case, quotes straightened, end punctuation and polite lead-ins dropped. */
export function normaliseCommand(question: string): string {
  let s = question
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[\s?!.]+$/u, '')
    .trim();
  const lead = /^(?:please|kindly|hey|hi|hello|ok(?:ay)?|so|now|right|could you|can you|would you|will you|i want to|i'd like to|i would like to|i want you to|let's|lets|let me|go ahead and)[,\s]+/u;
  for (let i = 0; i < 4 && lead.test(s); i += 1) s = s.replace(lead, '');
  return s.replace(/,?\s+please$/u, '').trim();
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function isoDay(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(2000, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return null;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** A date written as "2030-01-01", "1 January 2030", "January 1, 2030", "March 2030" or a year. */
export function parseDate(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/^(?:the\s+)?/u, '');
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(t);
  if (m) return isoDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = new RegExp(String.raw`^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}\s*,?\s+(\d{3,4})(?:\s*(?:ad|ce))?$`, 'u').exec(t);
  if (m) return isoDay(Number(m[3]), MONTHS[m[2] ?? ''] ?? 0, Number(m[1]));
  m = new RegExp(String.raw`^${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s+(\d{3,4})(?:\s*(?:ad|ce))?$`, 'u').exec(t);
  if (m) return isoDay(Number(m[3]), MONTHS[m[1] ?? ''] ?? 0, Number(m[2]));
  m = new RegExp(String.raw`^${MONTH}\s+(\d{3,4})(?:\s*(?:ad|ce))?$`, 'u').exec(t);
  if (m) return isoDay(Number(m[2]), MONTHS[m[1] ?? ''] ?? 0, 1);
  m = /^(?:year\s+)?(\d{3,4})(?:\s*(?:ad|ce))?$/u.exec(t);
  if (m) return isoDay(Number(m[1]), 1, 1);
  return null;
}

/** "21.42, 39.83", "21.42 n 39.83 e", "-33.9, 151.2": degrees, or null. */
export function parseCoordinates(text: string): { lat: number; lon: number } | null {
  const m = /^(-?\d{1,2}(?:\.\d+)?)\s*°?\s*([ns])?\s*,?\s+(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([ew])?$/u.exec(text.trim().toLowerCase());
  if (!m) return null;
  let lat = Number(m[1]);
  let lon = Number(m[3]);
  if (m[2] === 's') lat = -Math.abs(lat);
  if (m[4] === 'w') lon = -Math.abs(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** "twice", "half", "10 times", "three times", "a tenth": a factor, or null. */
function parseFactor(text: string): number | null {
  const t = text.trim();
  if (/^(?:twice|double|two times|2 times|2x)$/u.test(t)) return 2;
  if (/^(?:half|a half|one half|0\.5 times)$/u.test(t)) return 0.5;
  if (/^(?:triple|three times|thrice|3 times|3x)$/u.test(t)) return 3;
  if (/^(?:a tenth|one tenth|a tenth of)$/u.test(t)) return 0.1;
  const words = /^(two|three|four|five|six|seven|eight|nine|ten) times$/u.exec(t);
  if (words) return NUMBER_WORDS[words[1] ?? ''] ?? null;
  const m = /^(\d+(?:\.\d+)?)\s*(?:times|x|×)$/u.exec(t);
  if (m) {
    const n = Number(m[1]);
    return n > 0 && n <= 1000 ? n : null;
  }
  return null;
}

function titleCase(name: string): string {
  return name.replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, ch: string) => `${sep}${ch.toUpperCase()}`);
}

function call(tool: string, args: Record<string, unknown> = {}): ToolCall {
  return { tool, args };
}

const inExplorer = (ctx: AiContext): boolean => ctx.where === 'explorer' || ctx.where === 'lab';

/* ------------------------------------------------------------------ */
/* Matchers, most specific first                                       */
/* ------------------------------------------------------------------ */

const VERSE_FILLER = new Set([
  'explain', 'what', 'does', 'do', 'say', 'says', 'mean', 'means', 'meaning', 'show', 'me', 'read', 'verse', 'ayah', 'aya',
  'quran', "qur'an", 'the', 'of', 'about', 'cite', 'tell', 'is', 'in', 'plain', 'words', 'open', 'surah', 'sura', 'it',
  'this', 'translation', 'and', 'a', 'display', 'look', 'up', 'at', 'reference',
]);

const verse: Matcher = (q) => {
  let key: string | null = null;
  let rest = q;
  const colon = /\b(\d{1,3})\s*:\s*(\d{1,3})\b/u.exec(q);
  if (colon) {
    key = `${Number(colon[1])}:${Number(colon[2])}`;
    rest = q.replace(colon[0], ' ');
  } else {
    const named = /\b(?:surah|sura)\s+(\d{1,3}),?\s+(?:verse|ayah|aya)\s+(\d{1,3})\b/u.exec(q) ?? /\b(?:verse|ayah|aya)\s+(\d{1,3})\s+of\s+(?:surah|sura)\s+(\d{1,3})\b/u.exec(q);
    if (named) {
      const swap = named[0].startsWith('verse') || named[0].startsWith('ayah') || named[0].startsWith('aya');
      key = swap ? `${Number(named[2])}:${Number(named[1])}` : `${Number(named[1])}:${Number(named[2])}`;
      rest = q.replace(named[0], ' ');
    }
  }
  if (!key) return null;
  const words = rest.split(/[^a-z']+/u).filter((w) => w.length > 0);
  if (!words.every((w) => VERSE_FILLER.has(w))) return null;
  return { intent: 'answer', query: key, options: [[call('cite.verse', { key })]] };
};

const HADITH_COLLECTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:sahih\s+)?(?:al-?)?bukhari$/u, 'bukhari'],
  [/^(?:sahih\s+)?muslim$/u, 'muslim'],
  [/^(?:sunan\s+)?(?:abu|abi)\s*-?\s*dawud$|^abudawud$/u, 'abudawud'],
  [/^(?:jami\s+)?(?:at-?|al-?)?tirmidhi$/u, 'tirmidhi'],
];
const HADITH_FILLER = new Set(['hadith', 'show', 'explain', 'cite', 'the', 'me', 'about', 'what', 'is', 'does', 'say', 'says', 'tell', 'read', 'open', 'number', 'no', 'in', 'of', 'a']);

const hadith: Matcher = (q) => {
  const m = /\b((?:sahih\s+)?(?:al-?)?bukhari|(?:sahih\s+)?muslim|(?:sunan\s+)?(?:abu|abi)\s*-?\s*dawud|abudawud|(?:jami\s+)?(?:at-?|al-?)?tirmidhi)\s*(?:no\.?|number|#|-|:)?\s*(\d{1,5})\b/u.exec(q);
  if (!m) return null;
  const collection = HADITH_COLLECTIONS.find(([re]) => re.test((m[1] ?? '').trim()))?.[1];
  if (!collection) return null;
  const words = q.replace(m[0], ' ').split(/[^a-z]+/u).filter((w) => w.length > 0);
  if (!words.every((w) => HADITH_FILLER.has(w))) return null;
  const id = `${collection}-${Number(m[2])}`;
  return { intent: 'answer', query: id, options: [[call('cite.hadith', { id })]] };
};

const chapter: Matcher = (q) => {
  const verbs = String.raw`(?:(?:go|jump|skip|take me|bring me)\s+(?:back\s+)?to|open|play|show(?:\s+me)?|watch|start|begin|replay)`;
  let id: ChapterId | null = null;
  let m = new RegExp(String.raw`^(?:${verbs}\s+)?(?:the\s+)?chapter\s+(\d{1,2}|${Object.keys(NUMBER_WORDS).join('|')})$`, 'u').exec(q);
  if (m) {
    const n = /^\d+$/u.test(m[1] ?? '') ? Number(m[1]) : (NUMBER_WORDS[m[1] ?? ''] ?? -1);
    if (n >= 0 && n <= 10) id = `ch${pad(n, 2)}` as ChapterId;
  }
  if (!id) {
    m = new RegExp(String.raw`^(?:${verbs}\s+)?(?:the\s+)?(${Object.keys(NUMBER_WORDS).join('|')})\s+chapter$`, 'u').exec(q);
    const n = m ? (NUMBER_WORDS[m[1] ?? ''] ?? -1) : -1;
    if (m && n >= 1 && n <= 10) id = `ch${pad(n, 2)}` as ChapterId;
  }
  if (!id) {
    m = new RegExp(String.raw`^(?:${verbs}\s+)?(?:the\s+)?chapter\s+(?:on|about|called|named)\s+(.+)$`, 'u').exec(q) ?? new RegExp(String.raw`^(?:${verbs}\s+)?(?:the\s+)?(.+?)\s+chapter$`, 'u').exec(q);
    if (m) id = CHAPTER_NAMES[(m[1] ?? '').trim()] ?? null;
  }
  if (!id) return null;
  return { intent: 'act', options: [[call('film.open', { chapter: id })]] };
};

/** Commands for the film's transport and the explorer's clock. */
const transport: Matcher = (q, ctx) => {
  const time = (action: string): Candidate => ({ intent: 'act', options: [[call('time.control', { action })]] });
  const film = (action: string): Candidate => ({ intent: 'act', options: [[call('film.control', { action })]] });
  if (/^(?:pause|stop|freeze|halt|hold)\s+(?:the\s+)?(?:time|clock)$|^(?:pause|freeze)\s+time$/u.test(q)) return time('pause');
  if (/^(?:play|resume|start|restart|unpause|run)\s+(?:the\s+)?(?:time|clock)(?:\s+again)?$|^let\s+(?:the\s+)?(?:time|clock)\s+run$/u.test(q)) return time('play');
  if (/^(?:faster|go faster|speed up|speed it up|speed up (?:the\s+)?(?:time|clock)|(?:make\s+)?(?:time|the clock)\s+(?:go\s+|run\s+)?faster|fast[- ]?forward)$/u.test(q)) return time('faster');
  if (/^(?:slower|go slower|slow down|slow it down|slow down (?:the\s+)?(?:time|clock)|slow (?:the\s+)?(?:time|clock)(?:\s+down)?|(?:make\s+)?(?:time|the clock)\s+(?:go\s+|run\s+)?slower)$/u.test(q)) return time('slower');
  if (/^(?:reverse|backwards|rewind|reverse (?:the\s+)?(?:time|clock)|run (?:the\s+)?(?:time|clock) backwards|(?:go|run|turn) (?:time )?backwards(?: in time)?|make time (?:go|run) backwards)$/u.test(q)) return time('reverse');
  if (/^(?:now|back to now|go to now|today|back to today|go to today|real[- ]time|back to (?:the\s+)?present|return to (?:the\s+)?present|(?:set|reset) (?:the\s+)?(?:date|clock|time) to (?:now|today)|(?:show\s+)?(?:the\s+)?current (?:date|time))$/u.test(q)) return time('now');
  const explorer = inExplorer(ctx);
  if (/^(?:pause|pause it)$/u.test(q)) return explorer ? time('pause') : film('pause');
  if (/^(?:play|resume|continue|unpause|play it|resume it)$/u.test(q)) return explorer ? time('play') : film('play');
  if (/^(?:pause|stop|halt)\s+(?:the\s+)?(?:film|movie|video|chapter)$/u.test(q)) return film('pause');
  if (/^(?:play|resume|continue|start|unpause)\s+(?:the\s+)?(?:film|movie|video|chapter)$/u.test(q)) return film('play');
  if (/^(?:next|next chapter|(?:go\s+)?(?:on\s+)?to the next chapter|(?:play|watch|start) the next chapter|skip to the next chapter|skip (?:this\s+)?chapter|forward a chapter)$/u.test(q)) return film('next');
  if (/^(?:previous|prev|previous chapter|last chapter|(?:go\s+)?back a chapter|(?:go\s+)?(?:back\s+)?to the previous chapter)$/u.test(q)) return film('previous');
  if (/^(?:explore mode|(?:enter|open|start|switch to|go to|go into|turn on) explore mode|look around|free look)$/u.test(q)) return film('explore');
  if (/^(?:(?:leave|exit|close|stop|end|turn off) explore mode|(?:back to\s+)?cinematic mode)$/u.test(q)) return film('film');
  return null;
};

const rate: Matcher = (q) => {
  const m = /^set\s+(?:the\s+)?(?:time\s+|clock\s+)?(?:rate|speed)\s+(?:of\s+(?:time|the\s+clock)\s+)?to\s+(-?\d[\d,]*(?:\.\d+)?)\s*(?:x|×|times)?$/u.exec(q);
  if (!m) return null;
  const value = Number((m[1] ?? '').replace(/,/gu, ''));
  if (!Number.isFinite(value) || value === 0) return null;
  return { intent: 'act', options: [[call('time.rate', { rate: value })]] };
};

const date: Matcher = (q) => {
  let m = /^(?:set|change|move)\s+(?:the\s+)?(?:date|day|clock|time)\s+to\s+(.+)$/u.exec(q);
  if (!m) m = /^(?:go|jump|travel|take me|bring me|skip|fly)\s+(?:back\s+|forward\s+)?(?:in\s+time\s+)?to\s+(.+)$/u.exec(q);
  if (!m) m = /^(?:show|what did|what will)\s+(?:me\s+)?(?:the\s+)?sky\s+(?:look\s+like\s+)?(?:on|in)\s+(.+)$/u.exec(q);
  if (!m) return null;
  const iso = parseDate(m[1] ?? '');
  if (!iso) return null;
  return { intent: 'act', options: [[call('time.date', { date: iso })]] };
};

const explorerOpen: Matcher = (q) => {
  if (/^(?:open|launch|start|enter|show(?:\s+me)?|go to|take me to|explore)\s+(?:the\s+)?(?:solar[- ]system(?:\s+explorer)?|explorer|universe|planets)$/u.test(q)) {
    return { intent: 'act', options: [[call('explorer.open', {})]] };
  }
  if (/^(?:open|launch|start|enter|go to|take me to|show(?:\s+me)?)\s+(?:the\s+)?(?:orbital\s+)?(?:lab|laboratory|sandbox)$/u.test(q)) {
    return { intent: 'act', options: [[call('lab.open', {})]] };
  }
  if (/^(?:close|leave|exit|quit)\s+(?:the\s+)?(?:solar[- ]system\s+)?(?:explorer|solar system|universe)$/u.test(q)) {
    return { intent: 'act', options: [[call('explorer.close', {})]] };
  }
  // From the explorer, back to the film; in a chapter's Explore Mode, back to its film.
  if (/^(?:back|go back|return)\s+to\s+the\s+(?:film|chapters?|movie)$/u.test(q)) {
    return { intent: 'act', options: [[call('explorer.close', {})], [call('film.control', { action: 'film' })]] };
  }
  return null;
};

const walk: Matcher = (q, ctx) => {
  if (/^(?:stop walking|stop the walk|end (?:the|this|my) walk|finish (?:the|this|my) walk|leave the ground|take off|(?:go\s+)?back (?:up\s+)?(?:in)?to orbit|return to orbit|fly back up)$/u.test(q)) {
    return { intent: 'act', options: [[call('explorer.walk_end', {})]] };
  }
  let m = new RegExp(String.raw`^(?:walk|land|go for a walk|take a walk|go walking|stroll|set foot|stand)\s+(?:on|onto|upon)\s+(?:the\s+surface\s+of\s+)?${BODY}(?:'s\s+surface|\s+surface)?$`, 'u').exec(q);
  if (!m) m = new RegExp(String.raw`^(?:let me\s+)?walk\s+around\s+(?:on\s+)?${BODY}$`, 'u').exec(q);
  let world = m ? bodyOf(m[1]) : null;
  if (!m && /^(?:walk here|land here|walk on the ground here|go for a walk here)$/u.test(q) && ctx.explorer) world = ctx.explorer.focus;
  if (!world) return null;
  if (!WALKABLE.has(world)) return { intent: 'act', options: [] };
  return { intent: 'act', options: [[call('explorer.walk', { world })]] };
};

const stars: Matcher = (q) => {
  if (/^(?:(?:show me|take me to|go to|fly to|go out to|go out among|go among|fly out to|fly out among|open|leave for)\s+)?(?:the\s+)?(?:stars view|star view|nearby stars|stellar neighbourhood|stellar neighborhood|neighbourhood of the sun|stars around the sun)$|^(?:show me|take me to|go to|fly to|go out to|go out among|go among|fly out to|fly out among)\s+the\s+stars$/u.test(q)) {
    return { intent: 'act', options: [[call('explorer.stars', {})]] };
  }
  const m = /^(?:find|locate|show me|where is|point (?:me )?to|go to|fly to|take me to|travel to|visit)\s+(?:the\s+)?(?:star\s+)?(.+?)$/u.exec(q);
  if (!m) return null;
  const name = (m[1] ?? '').trim();
  const isStar = /^(?:find|locate|where is|point (?:me )?to)\s+the\s+star\s+/u.test(q) || q.includes(' star ') || KNOWN_STARS.has(name);
  if (!isStar || bodyOf(name) || name.length === 0 || name.split(' ').length > 3) return null;
  return { intent: 'act', options: [[call('explorer.find_star', { name: titleCase(name) })]] };
};

const SKY_LAYERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:constellations?|constellation (?:lines|figures|shapes)|star figures|figures)$/u, 'constellations'],
  [/^(?:constellation\s+)?(?:boundaries|borders)$/u, 'boundaries'],
  [/^(?:(?:coordinate|sky|celestial)\s+)?grid(?:\s+lines)?$/u, 'grid'],
  [/^(?:star\s+)?(?:names|labels)$|^names of (?:the\s+)?stars$/u, 'names'],
];

const sky: Matcher = (q) => {
  const layerOf = (text: string): string | null => SKY_LAYERS.find(([re]) => re.test(text.trim()))?.[1] ?? null;
  const on = /^(?:show|turn on|switch on|display|enable|draw)\s+(?:the\s+)?(.+)$/u.exec(q);
  const off = /^(?:hide|turn off|switch off|remove|disable)\s+(?:the\s+)?(.+)$/u.exec(q);
  const toggle = /^(?:turn\s+|switch\s+)?(?:the\s+)?(.+?)\s+(on|off)$/u.exec(q);
  let layer: string | null = null;
  let value = true;
  if (on) layer = layerOf(on[1] ?? '');
  if (!layer && off) {
    layer = layerOf(off[1] ?? '');
    value = false;
  }
  if (!layer && toggle) {
    layer = layerOf(toggle[1] ?? '');
    value = toggle[2] === 'on';
  }
  if (!layer) return null;
  return { intent: 'act', options: [[call('explorer.sky', { layer, on: value })]] };
};

/** Words after "go to" that are never places. */
const NOT_PLACES = new Set(['sleep', 'bed', 'home', 'back', 'settings', 'the settings', 'school', 'work', 'it', 'there', 'here', 'top', 'the top', 'start', 'the start', 'the end', 'end']);

const fly: Matcher = (q, ctx, options) => {
  const toBody =
    new RegExp(String.raw`^(?:go|fly|travel|head|zoom|jump|move|warp|take me|bring me|get me|send me|let's go|lets go)(?:\s+(?:back|over|out|on))?\s+(?:to|towards?)\s+${BODY}$`, 'u').exec(q) ??
    new RegExp(String.raw`^(?:visit|show me|focus on|look at|fly over|orbit|go and see|go see)\s+${BODY}$`, 'u').exec(q);
  const body = toBody ? bodyOf(toBody[1]) : null;
  if (body) {
    const options: ToolCall[][] = inExplorer(ctx) ? [[call('explorer.fly', { body })]] : [[call('explorer.open', { body })], [call('explorer.fly', { body })]];
    return { intent: 'act', options };
  }
  const toPlace = /^(?:go|fly|travel|head|zoom|take me|bring me|get me|send me)(?:\s+(?:over|back))?\s+(?:to|over)\s+(.+)$/u.exec(q) ?? /^(?:show me|visit)\s+(.+)$/u.exec(q);
  if (!toPlace) return null;
  const rest = (toPlace[1] ?? '').trim();
  const coords = parseCoordinates(rest.replace(/^(?:latitude\s+)?/u, ''));
  if (coords) return { intent: 'act', options: [[call('explorer.place', coords)]] };
  if (NOT_PLACES.has(rest) || rest.split(' ').length > 5 || /\d/u.test(rest)) return null;
  const found = options.place?.(rest.replace(/^the\s+/u, '')) ?? null;
  if (!found) return null;
  return { intent: 'act', options: placeOptions('explorer.place', found) };
};

/** A named place as the place tools take it: the field notes' id where it is one, else its degrees. */
function placeOptions(tool: string, found: NamedPlace, extra: Record<string, unknown> = {}): ToolCall[][] {
  const byDegrees = [call(tool, { lat: found.lat, lon: found.lon, ...extra })];
  return found.place ? [[call(tool, { place: found.place, ...extra })], byDegrees] : [byDegrees];
}

const calc: Matcher = (q) => {
  let m =
    new RegExp(String.raw`^(?:what(?:'s|\s+is)\s+)?(?:the\s+)?escape\s+(?:speed|velocity)\s+(?:of|on|from|at|for)\s+${BODY}$`, 'u').exec(q) ??
    new RegExp(String.raw`^${BODY}(?:'s)?\s+escape\s+(?:speed|velocity)$`, 'u').exec(q) ??
    new RegExp(String.raw`^how fast (?:do (?:you|i|we)|does (?:a rocket|one)|would (?:you|a rocket)|must (?:you|a rocket))\s+(?:need to |have to )?(?:go|travel|move|fly)\s+to\s+(?:escape|leave)\s+${BODY}(?:'s gravity)?$`, 'u').exec(q);
  let body = m ? bodyOf(m[1]) : null;
  if (body) return { intent: 'answer', query: `escape speed ${body}`, options: [[call('calc.escape_speed', { body })]] };

  m =
    new RegExp(String.raw`^(?:what(?:'s|\s+is)\s+)?(?:the\s+)?(?:orbital\s+period|period of revolution|length of (?:a|the) year)\s+(?:of|on|for)\s+${BODY}$`, 'u').exec(q) ??
    new RegExp(String.raw`^how long (?:is|does|lasts?) (?:a|one) year (?:last\s+)?on\s+${BODY}$`, 'u').exec(q) ??
    new RegExp(String.raw`^how long (?:is (?:a|one) year on|does it take)\s+${BODY}(?:\s+to\s+(?:orbit|go (?:round|around)|circle) the (?:sun|earth))?$`, 'u').exec(q) ??
    new RegExp(String.raw`^how long does ${BODY} take to (?:orbit|go (?:round|around)|circle) the (?:sun|earth)$`, 'u').exec(q);
  body = m ? bodyOf(m[1]) : null;
  if (body) return { intent: 'answer', query: `orbit year ${body}`, options: [[call('calc.orbital_period', { body })]] };

  m =
    new RegExp(String.raw`^(?:tell me about|(?:give me\s+)?(?:the\s+)?facts (?:about|on|of)|describe|what do you know about|how big is|how large is|how heavy is|how massive is|how hot is|what(?:'s|\s+is) the (?:mass|radius|size|gravity|density|diameter|surface gravity|day length|length of (?:a|the) day) (?:of|on)|how strong is (?:the\s+)?gravity on|what is (?:the\s+)?gravity like on)\s+${BODY}$`, 'u').exec(q) ??
    new RegExp(String.raw`^${BODY}\s+(?:facts|in numbers)$`, 'u').exec(q);
  body = m ? bodyOf(m[1]) : null;
  if (body) return { intent: 'answer', query: `${body} in numbers`, options: [[call('calc.world_facts', { body })]] };

  m =
    new RegExp(String.raw`^how long (?:does|would|will) (?:it take (?:for\s+)?)?(?:light|sunlight|a radio signal|a signal|a message|radio)\s+(?:take\s+)?(?:to\s+(?:get|travel|go|reach|come)\s+)?from\s+${BODY}\s+to\s+${BODY}$`, 'u').exec(q) ??
    new RegExp(String.raw`^(?:what(?:'s|\s+is)\s+the\s+)?light[- ]?time\s+(?:from\s+|between\s+)?${BODY}\s+(?:to|and)\s+${BODY}$`, 'u').exec(q);
  if (m) {
    const [from, to] = [bodyOf(m[1]), bodyOf(m[2])];
    if (from && to && from !== to) return { intent: 'answer', query: 'light time speed of light', options: [[call('calc.light_time', { from, to })]] };
  }
  m = new RegExp(String.raw`^how long (?:does|would|will) (?:it take (?:for\s+)?)?(sunlight|light from the sun)\s+(?:take\s+)?to\s+(?:get to|reach)\s+${BODY}$`, 'u').exec(q);
  if (m) {
    const to = bodyOf(m[2]);
    if (to && to !== 'sun') return { intent: 'answer', query: 'light time speed of light', options: [[call('calc.light_time', { from: 'sun', to })]] };
  }

  m =
    new RegExp(String.raw`^(?:(?:plan|show(?:\s+me)?|compute|calculate|work out|what(?:'s|\s+is))\s+(?:a|the)\s+)?(?:hohmann\s+)?transfer(?:\s+orbit)?\s+from\s+${BODY}\s+to\s+${BODY}$`, 'u').exec(q) ??
    new RegExp(String.raw`^how (?:long|much delta[- ]?v|much fuel|much speed) (?:does it take|would it take|do (?:you|i|we) need|is needed|does it need)\s+to (?:fly|travel|get|go)\s+from\s+${BODY}\s+to\s+${BODY}$`, 'u').exec(q) ??
    new RegExp(String.raw`^how (?:do|would|can|could) (?:i|you|we) (?:fly|travel|get) from\s+${BODY}\s+to\s+${BODY}$`, 'u').exec(q);
  if (m) {
    const [from, to] = [bodyOf(m[1]), bodyOf(m[2])];
    if (from && to && from !== to) return { intent: 'answer', query: 'transfer orbit delta v', options: [[call('calc.hohmann', { from, to })]] };
  }
  return null;
};

function conventionOf(text: string | undefined): string | null {
  if (!text) return null;
  return CONVENTIONS.find(([re]) => re.test(text.trim()))?.[1] ?? null;
}

const islamic: Matcher = (q, _ctx, options) => {
  let m = /^(?:what(?:'s|\s+is)\s+|show(?:\s+me)?\s+|find\s+|which way is\s+|where is\s+)?(?:the\s+)?(?:qibla|qiblah|kiblah|direction of (?:the\s+)?(?:qibla|kaaba|makkah|mecca))(?:\s+direction)?\s+(?:from|at|in|for)\s+(.+)$/u.exec(q);
  if (!m) m = /^(?:which way is|which direction is|in which direction is)\s+(?:makkah|mecca|the kaaba|the qibla)\s+(?:from|in)\s+(.+)$/u.exec(q);
  if (m) {
    const where = (m[1] ?? '').trim();
    const coords = parseCoordinates(where);
    if (coords) return { intent: 'answer', query: 'qibla direction', options: [[call('islamic.qibla', coords)]] };
    if (where.length === 0 || /\d/u.test(where) || where.split(' ').length > 5 || NOT_PLACES.has(where)) return null;
    const found = options.place?.(where.replace(/^the\s+/u, '')) ?? null;
    if (!found) return null;
    return { intent: 'answer', query: 'qibla direction', options: placeOptions('islamic.qibla', found) };
  }

  m = /^(?:what(?:'s|\s+is|\s+are)\s+|show(?:\s+me)?\s+|tell me\s+|give me\s+)?(?:the\s+)?(?:prayer|salah|salat|namaz)\s+times?\s+(?:in|for|at|from)\s+(.+?)(?:\s+(?:on|for)\s+(.+?))?(?:\s+(?:using|with|by|per)\s+(?:the\s+)?(.+?)(?:\s+(?:convention|method))?)?$/u.exec(q);
  if (m) {
    const where = (m[1] ?? '').trim();
    const day = m[2] ? parseDate(m[2]) : null;
    if (m[2] && !day) return null;
    // The times depend on the convention, which the visitor names (the tool never picks one for them).
    const convention = m[3] ? conventionOf(m[3]) : null;
    if (!convention) return null;
    const extra: Record<string, unknown> = day ? { date: day, convention } : { convention };
    const coords = parseCoordinates(where);
    if (coords) return { intent: 'answer', query: 'prayer times convention', options: [[call('islamic.prayer_times', { ...coords, ...extra })]] };
    const found = /\d/u.test(where) ? null : (options.place?.(where.replace(/^the\s+/u, '')) ?? null);
    if (!found) return null;
    return { intent: 'answer', query: 'prayer times convention', options: placeOptions('islamic.prayer_times', found, extra) };
  }

  m = /^(?:what(?:'s|\s+is)\s+)?(?:the\s+|today's\s+)?(?:hijri|islamic|muslim)\s+(?:calendar\s+)?(?:date|day|month|year)(?:\s+today|\s+now)?(?:\s+(?:on|for)\s+(.+))?$/u.exec(q);
  if (!m) m = /^(?:what(?:'s|\s+is)\s+)?(.+?)\s+in the (?:hijri|islamic) calendar$|^convert\s+(.+?)\s+to (?:the\s+)?(?:hijri|islamic)(?: calendar)?(?: date)?$/u.exec(q);
  if (m) {
    const text = (m[1] ?? m[2] ?? '').trim();
    if (!text || /^(?:today|now|the date|today's date|the date today)$/u.test(text)) return { intent: 'answer', query: 'hijri calendar', options: [[call('islamic.hijri', {})]] };
    const day = parseDate(text);
    if (!day) return null;
    return { intent: 'answer', query: 'hijri calendar', options: [[call('islamic.hijri', { date: day })]] };
  }
  return null;
};

/** An experiment as lab.experiment and lab.compare take it: its id and its parameters, flat. */
interface Experiment {
  experiment: string;
  params: Readonly<Record<string, string | number>>;
}

/**
 * What "a rock", "an asteroid" or "a comet" thrown at a world means, as illustrative numbers for the
 * thought experiment (the card shows them, and the visitor confirms or cancels): a diameter in km,
 * scaled by "small", "big" or "giant"; a speed in km/s, at least one above the world's escape speed
 * (the laboratory refuses a slower one); and 45 degrees, the likeliest angle of an impact.
 */
const IMPACTOR_KM: ReadonlyArray<readonly [RegExp, number]> = [
  [/comet/u, 5],
  [/asteroid|space rock/u, 1],
  [/rock|stone|boulder|meteor/u, 0.05],
];
const IMPACTOR_SCALE: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(?:small|little|tiny)\b/u, 0.2],
  [/\b(?:big|large|huge)\b/u, 10],
  [/\bgiant\b/u, 100],
];
const IMPACT_SPEED_KMS = 20;
const COMET_SPEED_KMS = 50;
/** Above each giant planet's escape speed (about 59.5, 35.5, 21.3 and 23.5 km/s). */
const IMPACT_SPEED_FLOOR: Readonly<Partial<Record<BodyId, number>>> = { jupiter: 65, saturn: 40, uranus: 25, neptune: 25 };
const IMPACT_ANGLE_DEG = 45;

function impactOf(missile: string, target: BodyId): Experiment | null {
  // Nothing thrown can be faster than the Sun's escape speed allows (the laboratory's limit is 72 km/s).
  if (target === 'sun') return null;
  const size = IMPACTOR_KM.find(([re]) => re.test(missile))?.[1];
  if (size === undefined) return null;
  const scale = IMPACTOR_SCALE.find(([re]) => re.test(missile))?.[1] ?? 1;
  const diameterKm = Math.min(1000, Math.max(0.01, size * scale));
  const speedKmS = Math.max(/comet/u.test(missile) ? COMET_SPEED_KMS : IMPACT_SPEED_KMS, IMPACT_SPEED_FLOOR[target] ?? 0);
  return { experiment: 'impact', params: { target, diameterKm, speedKmS, angleDeg: IMPACT_ANGLE_DEG } };
}

/** An experiment named in plain words: change a mass, remove a body, throw something at one. */
function experimentOf(text: string): Experiment | null {
  const factorWords = String.raw`(twice|double|half|a half|triple|three times|thrice|a tenth|(?:two|three|four|five|six|seven|eight|nine|ten) times|\d+(?:\.\d+)?\s*(?:times|x|×))`;
  let m =
    new RegExp(String.raw`^(?:what if|what would happen if|what happens if|suppose|imagine(?: if)?)\s+${BODY}\s+(?:were|was|is|became|got|had)\s+${factorWords}\s+(?:as\s+)?(?:massive|heavy|its (?:mass|weight)|the mass|more massive|heavier)(?:\s+as\s+(?:it is|now|today))?$`, 'u').exec(text) ??
    new RegExp(String.raw`^(?:what if|what would happen if|what happens if|suppose|imagine(?: if)?)\s+${BODY}(?:'s)?\s+mass\s+(?:were|was|is)\s+(doubled|halved|tripled)$`, 'u').exec(text) ??
    new RegExp(String.raw`^make\s+${BODY}\s+${factorWords}\s+(?:as\s+)?(?:massive|heavy|heavier|more massive)$`, 'u').exec(text);
  if (m) {
    const body = bodyOf(m[1]);
    const word = m[2] ?? '';
    const factor = word === 'doubled' ? 2 : word === 'halved' ? 0.5 : word === 'tripled' ? 3 : parseFactor(word);
    if (body && factor !== null && factor !== 1) return { experiment: 'scale-mass', params: { body, factor } };
  }
  m = new RegExp(String.raw`^(double|halve|triple)\s+(?:the\s+mass\s+of\s+${BODY}|${BODY}(?:'s)?\s+mass)$`, 'u').exec(text);
  if (m) {
    const body = bodyOf(m[2] ?? m[3]);
    const factor = m[1] === 'double' ? 2 : m[1] === 'halve' ? 0.5 : 3;
    if (body) return { experiment: 'scale-mass', params: { body, factor } };
  }
  m =
    new RegExp(String.raw`^(?:remove|delete|take away|get rid of|eliminate)\s+${BODY}$`, 'u').exec(text) ??
    new RegExp(String.raw`^(?:what if|what would happen if|what happens if|suppose|imagine(?: if)?)\s+(?:there\s+(?:were|was|is)\s+no\s+${BODY}|${BODY}\s+(?:disappeared|vanished|did not exist|didn't exist|were gone|was gone|were removed|was removed|is removed))$`, 'u').exec(text);
  if (m) {
    const body = bodyOf(m[1] ?? m[2]);
    if (body) return { experiment: 'remove-body', params: { body } };
  }
  const missile = String.raw`((?:a|an|some)\s+(?:big\s+|small\s+|little\s+|tiny\s+|large\s+|huge\s+|giant\s+)?(?:rock|asteroid|meteor|meteorite|comet|stone|boulder|space rock))`;
  let thrown: string | undefined;
  let at: string | undefined;
  m = new RegExp(String.raw`^(?:throw|hurl|drop|fling|launch|send|crash|smash|fire|lob)\s+${missile}\s+(?:at|into|on|onto|towards?)\s+${BODY}$`, 'u').exec(text);
  if (m) [thrown, at] = [m[1], m[2]];
  m = thrown ? null : new RegExp(String.raw`^(?:hit|strike|bombard|smash)\s+${BODY}\s+with\s+${missile}$`, 'u').exec(text);
  if (m) [at, thrown] = [m[1], m[2]];
  m = thrown ? null : new RegExp(String.raw`^(?:what if|what would happen if|what happens if|suppose|imagine(?: if)?)\s+${missile}\s+(?:hit|hits|struck|strikes|crashed into|crashes into|slammed into|fell on|falls on)\s+${BODY}$`, 'u').exec(text);
  if (m) [thrown, at] = [m[1], m[2]];
  const target = bodyOf(at);
  if (thrown && target) return impactOf(thrown, target);
  return null;
}

const experiment: Matcher = (q) => {
  const compare = /^compare\s+(.+?)(?:\s+(?:over|for)\s+(\d+(?:\.\d+)?)\s+(years?|days?))?$/u.exec(q);
  if (compare) {
    let what = (compare[1] ?? '').trim();
    const without = new RegExp(String.raw`^(?:the\s+solar\s+system\s+)?with\s+and\s+without\s+${BODY}$`, 'u').exec(what);
    let found: Experiment | null = null;
    if (without) {
      const body = bodyOf(without[1]);
      if (body) found = { experiment: 'remove-body', params: { body } };
    } else {
      what = what.replace(/^(?:what happens|what would happen)\s+(?:if|when)\s+/u, 'what if ');
      found = experimentOf(what) ?? experimentOf(`what if ${what}`);
    }
    if (!found) return null;
    const amount = compare[2] ? Number(compare[2]) : null;
    const horizonDays = amount === null ? null : (compare[3] ?? '').startsWith('year') ? Math.round(amount * 365.25 * 100) / 100 : amount;
    // Nothing on screen changes, and the comparison is the whole answer (no passages are looked up for it).
    return { intent: 'act', options: [[call('lab.compare', { experiment: found.experiment, ...found.params, ...(horizonDays !== null ? { horizonDays } : {}) })]] };
  }
  const found = experimentOf(q);
  if (!found) return null;
  return { intent: 'act', options: [[call('lab.experiment', { experiment: found.experiment, ...found.params })]] };
};

/** In order: the most specific patterns first, so "go to chapter 3" is never taken for a place. */
const MATCHERS: readonly Matcher[] = [verse, hadith, chapter, experiment, transport, rate, explorerOpen, walk, stars, sky, calc, islamic, date, fly];

/**
 * A plan for the question, or null when the router is not sure (or the registry would not accept
 * what it would do here). Deterministic: the same question in the same context gives the same plan.
 */
/**
 * A request for a religious ruling. The app gives none (its Islamic tools are for learning), and a
 * model asked for one gave a ruling of its own from memory (Qwen3 4B on praying with shoes on,
 * docs/AI-EVALUATION.md): it is declined in the app's own words before any model sees it.
 */
const RULING = /\b(?:fatwas?|fatawa|religious\s+rulings?|islamic\s+rulings?|sharia\s+rulings?|rulings?\s+(?:on|about|for)|halal\s+or\s+haram|haram\s+or\s+halal)\b|\b(?:is|are)\s+(?:it|this|that|they|we|i)\s+(?:\w+\s+){0,2}(?:permissible|impermissible|permitted|halal|haram|makruh|mustahabb|sinful|forbidden\s+in\s+islam|allowed\s+in\s+islam)\b/u;

export function route(question: string, ctx: AiContext, registry: ToolRegistry, options: RouteOptions = {}): Plan | null {
  const q = normaliseCommand(question);
  if (q.length === 0 || q.length > 200) return null;
  if (RULING.test(q)) return { intent: 'decline', calls: [], source: 'router', questionKey: 'ai.mind.guide.noRuling' };
  for (const matcher of MATCHERS) {
    const candidate = matcher(q, ctx, options);
    if (!candidate) continue;
    for (const calls of candidate.options) {
      const validated: ToolCall[] = [];
      for (const c of calls) {
        const result = registry.validate(c, ctx);
        if (!result.ok) break;
        validated.push(result.call);
      }
      if (validated.length === calls.length) {
        return { intent: candidate.intent, calls: validated, source: 'router', ...(candidate.query ? { query: candidate.query } : {}) };
      }
    }
    // The router recognised the request but nothing it would do is accepted here: leave it to others.
    return null;
  }
  return null;
}
