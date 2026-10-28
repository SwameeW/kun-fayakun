/**
 * Phrasing the project never uses (docs/SPEC.md, principle 1: reflection, not proof). Whole words,
 * case-insensitive, so "improves" does not match "proves". Each phrase stands for its forms: the
 * inflections ("predicts", "foretells", "proven") and the apostrophes the Quran's name is written
 * with ("Qur'an", "Qur’an", "Koran").
 *
 * Shared by the validator's message rule (scripts/lib/rules/i18n.ts, rule g) and the assistant's
 * output guards (src/ai/guards.ts), so both hold the same line. Only those two import it: the shell
 * never does, so it costs the first visit nothing.
 */
export const BANNED_PHRASES: ReadonlyArray<readonly [phrase: string, pattern: RegExp]> = [
  ['predicted', /\bpredict(?:ed|s)\b/i],
  ['foretold', /\b(?:foretold|foretell(?:s|ing)?)\b/i],
  ['scientific miracle', /\b(?:scientific(?:ally)?\s+miracles?|miracles?\s+of\s+science)\b/i],
  ['proves', /\bprov(?:e|es|ed|en|ing)\b/i],
  ['proof that', /\bproof\s+that\b/i],
  ['confirms the quran', /\bconfirm(?:s|ed|ing)?\s+the\s+(?:qur['’ʼʾ]?an|koran)\b/i],
];

/**
 * Forms the assistant's guards remove only where a sentence speaks of scripture ("The Quran's
 * prediction", "proof of the verse"). The app's own notes use them for science ("the early-universe
 * prediction") and in denials ("not as proof of one another"), so the validator does not ban them.
 */
export const SCRIPTURE_CLAIMS: ReadonlyArray<readonly [phrase: string, pattern: RegExp]> = [
  ['prediction', /\bpredict(?:ing|ions?)?\b/i],
  ['proof of', /\bproof\s+of\b/i],
];

/** Words that make a sentence speak of scripture, for SCRIPTURE_CLAIMS. */
export const SCRIPTURE_WORDS = /\b(?:qur['’ʼʾ]?an(?:ic)?|koran|verses?|ayah?s?|ayat|surah?s?|hadiths?|scriptures?|revelation|revealed|prophet|allah)\b/i;

/** The banned phrases found in `text`, by their names above (in the order listed). */
export function bannedPhrasesIn(text: string): string[] {
  return BANNED_PHRASES.filter(([, pattern]) => pattern.test(text)).map(([phrase]) => phrase);
}
