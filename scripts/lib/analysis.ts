/**
 * Letter analysis of a cited phrase (docs/SPEC.md, Chapter 7, "Each in an orbit"): the base
 * letters (the rasm) of chosen words, derived from the verified Tanzil text in data/quran.json.
 * Nothing here holds Arabic text; letters are handled as code points.
 *
 * Base letters: every combining mark (Unicode Mn: harakat, shadda, tanwin, superscript alif)
 * is removed, as are tatweel (U+0640) and the Quranic annotation signs (U+06D6..U+06ED).
 * Words are whitespace tokens that keep at least one base letter, because Tanzil writes some
 * pause marks as tokens of their own; positions count those words from 1.
 */
export interface AnalysisVerseSpec {
  key: string;
  /** Positions (from 1) of the words, counted over tokens that contain a base letter. */
  tokens: number[];
  /** Letters dropped from the front (36:40's attached conjunction wa-), with the code point expected there. */
  dropLeadingLetters?: number;
  droppedLetter?: string;
}

export interface AnalysisSpec {
  chapter: string;
  verses: AnalysisVerseSpec[];
  expectedLength: number;
}

export interface AnalysisAsset {
  $comment: string;
  id: string;
  chapter: string;
  verses: Array<{
    key: string;
    arabicSha256: string;
    tokens: number[];
    dropLeadingLetters: number;
    droppedLetter: string | null;
  }>;
  /** The base letters as code points ("U+0643"), in reading order (right to left). */
  letters: string[];
  names: string[];
  /** Index of the central letter (0-based) and the mirrored pairs, outermost first. */
  centre: number;
  pairs: Array<[number, number]>;
}

const TATWEEL = 0x0640;
const SIGNS_FIRST = 0x06d6;
const SIGNS_LAST = 0x06ed;

/** English names of the letters that can appear in a cited analysis. */
export const LETTER_NAMES: Readonly<Record<string, string>> = {
  'U+0643': 'kāf',
  'U+0644': 'lām',
  'U+0641': 'fāʾ',
  'U+0649': 'alif maqṣūra',
  'U+0648': 'wāw',
};

export const codePointLabel = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

function isRemoved(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return /\p{Mn}/u.test(ch) || cp === TATWEEL || (cp >= SIGNS_FIRST && cp <= SIGNS_LAST);
}

/** The words of a verse that contain base letters, each as its base letters (code points). */
export function baseLetterWords(arabic: string): number[][] {
  return arabic
    .split(/\s+/u)
    .map((token) => Array.from(token.normalize('NFC')).filter((ch) => !isRemoved(ch)).map((ch) => ch.codePointAt(0) ?? 0))
    .filter((letters) => letters.length > 0);
}

/** The letters of one verse's cited words, with any leading letters dropped (and checked). */
export function phraseLetters(arabic: string, spec: AnalysisVerseSpec): number[] {
  const words = baseLetterWords(arabic);
  const letters: number[] = [];
  for (const position of spec.tokens) {
    const word = words[position - 1];
    if (!word) throw new Error(`${spec.key}: there is no word ${position} (it has ${words.length} words with base letters)`);
    letters.push(...word);
  }
  const drop = spec.dropLeadingLetters ?? 0;
  if (drop > 0) {
    const dropped = letters.slice(0, drop).map(codePointLabel).join(' ');
    if (dropped !== spec.droppedLetter) throw new Error(`${spec.key}: dropped ${dropped}, expected ${spec.droppedLetter ?? '(none given)'}`);
  }
  return letters.slice(drop);
}

export function isPalindrome(letters: readonly number[]): boolean {
  return letters.every((cp, i) => cp === letters[letters.length - 1 - i]);
}

/** Derives the asset from the verified verses; throws on any mismatch the spec forbids. */
export function deriveAnalysis(
  id: string,
  spec: AnalysisSpec,
  arabicOf: (key: string) => string | undefined,
  sha256Hex: (text: string) => string,
): AnalysisAsset {
  const sequences = spec.verses.map((verse) => {
    const arabic = arabicOf(verse.key);
    if (arabic === undefined) throw new Error(`${id}: ${verse.key} is not in data/quran.json`);
    return { verse, arabic, letters: phraseLetters(arabic, verse) };
  });
  const first = sequences[0];
  if (!first) throw new Error(`${id}: no verses`);
  const reference = first.letters.map(codePointLabel).join(' ');
  for (const s of sequences) {
    const got = s.letters.map(codePointLabel).join(' ');
    if (got !== reference) throw new Error(`${id}: ${s.verse.key} gives ${got}, but ${first.verse.key} gives ${reference}`);
  }
  if (first.letters.length !== spec.expectedLength) throw new Error(`${id}: ${first.letters.length} letters, expected ${spec.expectedLength}`);
  if (!isPalindrome(first.letters)) throw new Error(`${id}: ${reference} does not read the same reversed`);
  const letters = first.letters.map(codePointLabel);
  const names = letters.map((cp) => {
    const name = LETTER_NAMES[cp];
    if (!name) throw new Error(`${id}: no English name for ${cp}; add it to LETTER_NAMES`);
    return name;
  });
  const n = letters.length;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < Math.floor(n / 2); i += 1) pairs.push([i, n - 1 - i]);
  return {
    $comment: 'Generated by scripts/build-analysis.ts from data/quran.json and data/citations.json. Do not edit by hand. Base letters only: diacritics, Quranic signs, tatweel and spaces removed. This is not the Quranic text as written.',
    id,
    chapter: spec.chapter,
    verses: sequences.map((s) => ({
      key: s.verse.key,
      arabicSha256: sha256Hex(s.arabic),
      tokens: s.verse.tokens,
      dropLeadingLetters: s.verse.dropLeadingLetters ?? 0,
      droppedLetter: s.verse.droppedLetter ?? null,
    })),
    letters,
    names,
    centre: Math.floor(n / 2),
    pairs,
  };
}
