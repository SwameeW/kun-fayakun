/**
 * The letter analysis (docs/SPEC.md, Chapter 7) is derived from the verified Tanzil text.
 * These tests pin the extraction rules on the real verses and on small synthetic inputs built
 * from code points (no Arabic is typed here).
 */
import { expect, test } from '@playwright/test';
import { baseLetterWords, codePointLabel, deriveAnalysis, isPalindrome, phraseLetters, type AnalysisSpec } from '../../scripts/lib/analysis';
import { quranByKey } from '../support/data';

const verses = quranByKey();
const arabicOf = (key: string): string | undefined => verses.get(key as never)?.arabic;
const labels = (cps: readonly number[]): string => cps.map(codePointLabel).join(' ');
const text = (...cps: number[]): string => String.fromCodePoint(...cps);
/** The hash is checked by the validator; these tests only need a stand-in. */
const sha = (s: string): string => `len:${s.length}`;

const SPEC: AnalysisSpec = {
  chapter: 'ch07',
  verses: [
    { key: '21:33', tokens: [8, 9, 10] },
    { key: '36:40', tokens: [12, 13, 14], dropLeadingLetters: 1, droppedLetter: 'U+0648' },
  ],
  expectedLength: 7,
};
const PHRASE = 'U+0643 U+0644 U+0641 U+0649 U+0641 U+0644 U+0643';

test('21:33 gives the seven base letters, symmetric about alif maqsura', () => {
  const letters = phraseLetters(arabicOf('21:33') ?? '', { key: '21:33', tokens: [8, 9, 10] });
  expect(labels(letters)).toBe(PHRASE);
  expect(codePointLabel(letters[3] ?? 0)).toBe('U+0649');
  expect(isPalindrome(letters)).toBe(true);
});

test('36:40 gives the same letters once its conjunction wa- is set aside', () => {
  const withConjunction = phraseLetters(arabicOf('36:40') ?? '', { key: '36:40', tokens: [12, 13, 14] });
  expect(labels(withConjunction)).toBe(`U+0648 ${PHRASE}`);
  expect(isPalindrome(withConjunction)).toBe(false);
  const without = phraseLetters(arabicOf('36:40') ?? '', SPEC.verses[1] ?? { key: '36:40', tokens: [] });
  expect(labels(without)).toBe(PHRASE);
});

test('dropping a letter other than the expected one is refused', () => {
  expect(() => phraseLetters(arabicOf('36:40') ?? '', { key: '36:40', tokens: [12, 13, 14], dropLeadingLetters: 1, droppedLetter: 'U+0643' })).toThrow(/dropped U\+0648/u);
});

test('standalone pause marks are not counted as words', () => {
  // kaf + fatha, then a lone small high meem (a pause mark), then lam: two words, not three.
  const words = baseLetterWords(`${text(0x0643, 0x064e)} ${text(0x06e2)} ${text(0x0644)}`);
  expect(words.map((w) => labels(w))).toEqual(['U+0643', 'U+0644']);
});

test('marks, tatweel and Quranic signs are removed; letters, including alif maqsura, are kept', () => {
  const words = baseLetterWords(text(0x0641, 0x0650, 0x0640, 0x0649, 0x06e1, 0x0670));
  expect(words.map((w) => labels(w))).toEqual(['U+0641 U+0649']);
});

test('the asset is derived only when both verses agree and read the same reversed', () => {
  const asset = deriveAnalysis('kullun-fi-falak', SPEC, arabicOf, sha);
  expect(asset.letters.join(' ')).toBe(PHRASE);
  expect(asset.names).toEqual(['kāf', 'lām', 'fāʾ', 'alif maqṣūra', 'fāʾ', 'lām', 'kāf']);
  expect(asset.pairs).toEqual([[0, 6], [1, 5], [2, 4]]);
  expect(asset.centre).toBe(3);
  const wrong: AnalysisSpec = { ...SPEC, verses: [SPEC.verses[0] ?? { key: '21:33', tokens: [] }, { key: '36:40', tokens: [12, 13, 14] }] };
  expect(() => deriveAnalysis('kullun-fi-falak', wrong, arabicOf, sha)).toThrow(/36:40 gives/u);
});
