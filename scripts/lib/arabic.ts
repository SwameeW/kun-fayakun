/** Arabic-script detection and comparison helpers (code points only; no glyphs in source). */

/** Unicode blocks treated as Arabic script by the "no Arabic in src/" rule. */
export const ARABIC_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0600, 0x06ff], // Arabic
  [0x0750, 0x077f], // Arabic Supplement
  [0x08a0, 0x08ff], // Arabic Extended-A
  [0xfb50, 0xfdff], // Arabic Presentation Forms-A
  [0xfe70, 0xfeff], // Arabic Presentation Forms-B
];

/** The salawat ligature, allowed in i18n files for the honorific after the Prophet's name. */
export const SALAWAT_LIGATURE = 0xfdfa;

export function isArabicCodePoint(cp: number): boolean {
  return ARABIC_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

export interface ArabicHit {
  line: number;
  column: number;
  codePoint: number;
}

/** Every Arabic-script code point in `text`, with 1-based line/column. */
export function findArabic(text: string): ArabicHit[] {
  const hits: ArabicHit[] = [];
  let line = 1;
  let column = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '\n') {
      line += 1;
      column = 0;
      continue;
    }
    column += 1;
    if (isArabicCodePoint(cp)) hits.push({ line, column, codePoint: cp });
  }
  return hits;
}

/** One escape (JS/JSON \uXXXX or \u{X}, HTML &#xX; or &#N;); ESCAPE_OR_RANGE also matches "escape-escape" ranges. */
const ESCAPE = String.raw`\\u([0-9A-Fa-f]{4})|\\u\{([0-9A-Fa-f]{1,6})\}|&#[xX]([0-9A-Fa-f]{1,6});|&#([0-9]{1,7});`;
const ESCAPE_OR_RANGE = new RegExp(`(?:${ESCAPE})(?:-(?:${ESCAPE}))?`, 'g');

/**
 * Arabic code points written as escapes (a backslash-u escape of U+0643, or "&#x643;"),
 * which would put Arabic on screen without a literal glyph in the source. A range of two
 * such escapes joined by "-" (a character class for direction detection) is not text and
 * is skipped.
 */
export function findArabicEscapes(text: string): ArabicHit[] {
  const hits: ArabicHit[] = [];
  for (const match of text.matchAll(ESCAPE_OR_RANGE)) {
    if (match[0].includes('-')) continue;
    const [, u4, uBraced, hex, dec] = match;
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(u4 ?? uBraced ?? hex ?? '', 16);
    if (!isArabicCodePoint(cp)) continue;
    const before = text.slice(0, match.index);
    const line = before.split('\n').length;
    hits.push({ line, column: match.index - before.lastIndexOf('\n'), codePoint: cp });
  }
  return hits;
}

/** Whitespace-separated tokens. Tanzil pause marks are their own tokens. */
export function arabicWords(text: string): string[] {
  return text.split(/\s+/u).filter((w) => w.length > 0);
}

const TATWEEL = 0x0640;
/** Small high signs and pause marks used as Quranic annotations (U+06D6..U+06ED). */
const QURANIC_SIGNS_FIRST = 0x06d6;
const QURANIC_SIGNS_LAST = 0x06ed;

function isLetterSkeletonNoise(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return /\p{M}/u.test(ch) || cp === TATWEEL || (cp >= QURANIC_SIGNS_FIRST && cp <= QURANIC_SIGNS_LAST);
}

/**
 * Letters only: drops combining marks, tatweel and Quranic annotation signs,
 * so two encodings of the same ayah can be told apart from a real text change.
 * Used only for diagnostics; scripture checks always compare full strings.
 */
export function letterSkeleton(text: string): string {
  return Array.from(text.normalize('NFD'))
    .filter((ch) => !isLetterSkeletonNoise(ch))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}
