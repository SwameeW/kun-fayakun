/**
 * English text handling shared by retrieval (./retrieve.ts) and the output guards (../guards.ts):
 * a tokeniser that keeps verse keys ("21:30") whole, a short stop list, a light stemmer and a small
 * table of synonyms for questions. Deterministic and dependency-free, so the index builder, the
 * browser and the tests all agree on what a word is.
 */

/** Words that carry no meaning for search. Kept short on purpose: "dark", "night", "old" stay. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'of', 'in', 'on', 'at', 'to', 'for',
  'from', 'by', 'with', 'and', 'or', 'nor', 'but', 'not', 'it', 'its', 'this', 'that', 'these', 'those', 'what',
  'which', 'who', 'whom', 'whose', 'how', 'when', 'where', 'why', 'does', 'do', 'did', 'doing', 'done', 'has',
  'have', 'had', 'having', 'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'they', 'them', 'their', 'there', 'here', 'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might',
  'must', 'about', 'into', 'onto', 'than', 'then', 'so', 'if', 'as', 'also', 'just', 'very', 'much', 'any',
  'some', 'each', 'tell', 'show', 'explain', 'please', 'say', 'says', 'said', 'mean', 'means', 'meaning',
  'give', 'let', 'know', 'like', 'get', 'got', 'isn', 'aren', 'doesn', 'don', 'up', 'out', 'over', 'such',
  'only', 'own', 'same', 'other', 'more', 'most', 'too', 'yet', 'whether', 'via', 's', 't',
]);

/** A verse key inside text: "21:30", "36:38". */
export const VERSE_KEY_PATTERN = /\b(\d{1,3}):(\d{1,3})\b/gu;

/** Lower case, accents and other marks removed, apostrophes dropped ("Sun's" → "suns"). */
export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’‘`]/gu, '');
}

/** Words whose ending is part of their meaning here: "the dark ages" are not an age. */
const KEEP_WHOLE: ReadonlySet<string> = new Set(['ages', 'means', 'news', 'physics', 'species', 'series']);

/**
 * A light English stemmer: plural and verb endings, then a final "e", so "galaxies"/"galaxy",
 * "created"/"create", "orbits"/"orbit" and "spinning"/"spin" meet. Short words are left alone.
 */
export function stem(word: string): string {
  let w = word;
  if (/^\d/u.test(w) || w.length <= 3 || KEEP_WHOLE.has(w)) return w;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (/(?:x|z|ch|sh)es$/u.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(?:ss|us|is|ys)$/u.test(w)) w = w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  if (/([b-df-hj-np-tv-z])\1$/u.test(w) && !/(?:ll|ss|zz)$/u.test(w)) w = w.slice(0, -1);
  if (w.endsWith('e') && w.length > 4) w = w.slice(0, -1);
  return w;
}

/**
 * The words of a text for search: verse keys whole, then every run of letters and digits, folded,
 * stop words dropped, stemmed. The order of the words is kept (repeats included).
 */
export function tokenize(text: string): string[] {
  const folded = foldText(text);
  const out: string[] = [];
  const rest = folded.replace(VERSE_KEY_PATTERN, (key) => {
    out.push(key);
    return ' ';
  });
  for (const raw of rest.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length === 0 || STOP_WORDS.has(raw)) continue;
    if (raw.length === 1 && !/\d/u.test(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/**
 * Phrases in a question that the app's own wording says differently. Each adds its words (at a
 * lower weight) to the search, never replaces what was asked.
 */
export const SYNONYMS: ReadonlyArray<readonly [phrase: RegExp, adds: string, weight?: number]> = [
  [/\bbig\s*bang\b/u, 'beginning expansion hot dense'],
  [/\bqibla\b/u, 'kaaba direction makkah'],
  [/\bka.?ba\b/u, 'qibla makkah'],
  [/\bmecca\b/u, 'makkah', 1.5],
  [/\bblack\s+holes?\b/u, 'collapse gravity star'],
  [/\blight[\s-]*years?\b/u, 'light year distance'],
  [/\bhow\s+old\b/u, 'age', 1.5],
  [/\b(?:pray|prayers?|salah|salat)\b/u, 'prayer times'],
  [/\bhijri\b/u, 'islamic calendar month'],
  [/\b(?:new\s+moon|crescent)\b/u, 'crescent hilal visibility'],
  [/\bend\s+of\s+(?:the\s+)?(?:universe|world|time)\b|\buniverse\s+end\b/u, 'futures heat death rip crunch folding'],
  [/\bdark\b.*\bnight\b|\bnight\b.*\bdark\b/u, 'observable light reach expansion stretch', 1.5],
  [/\b(?:cmb|microwave\s+background)\b/u, 'cosmic microwave background planck first light'],
  [/\bspeed\s+of\s+light\b/u, 'light speed'],
  [/\bescape\s+velocity\b/u, 'escape speed'],
  [/\bhow\s+(?:big|large|wide)\b/u, 'radius size'],
  [/\bhow\s+heavy\b/u, 'mass'],
  [/\bhow\s+far\b/u, 'distance'],
  [/\bhow\s+hot\b/u, 'temperature'],
  [/\bexpand(?:ing|s)?\b/u, 'expansion stretch'],
  [/\bcreat(?:ion|ed|e)\b/u, 'beginning kun'],
  [/\b(?:orbit|orbits|orbiting)\b/u, 'falak course'],
  [/\b(?:sun\s*set|sunset|sun\s*rise|sunrise)\b/u, 'sun day'],
  [/\bfirst\s+stars\b/u, 'dark ages population'],
  [/\bseven\s+heavens\b/u, 'heavens galaxies'],
  [/\bwhere\s+did\s+(?:the\s+)?(?:water|life)\b/u, 'origin'],
];

/** The words a question adds through SYNONYMS, tokenised, with their weights, without the question's own words. */
export function synonymTokens(question: string): Array<[token: string, weight: number]> {
  const folded = foldText(question);
  const own = new Set(tokenize(question));
  const out = new Map<string, number>();
  for (const [phrase, adds, weight = 1] of SYNONYMS) {
    if (!phrase.test(folded)) continue;
    for (const token of tokenize(adds)) if (!own.has(token)) out.set(token, Math.max(out.get(token) ?? 0, weight));
  }
  return [...out];
}
