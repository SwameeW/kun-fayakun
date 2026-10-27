/**
 * Phrasing the project never uses (docs/SPEC.md, principle 1: reflection, not proof). Whole words,
 * case-insensitive, so "improves" does not match "proves".
 *
 * Shared by the validator's message rule (scripts/lib/rules/i18n.ts, rule g) and the assistant's
 * output guards (src/ai/guards.ts), so both hold the same line. Only those two import it: the shell
 * never does, so it costs the first visit nothing.
 */
export const BANNED_PHRASES: ReadonlyArray<readonly [phrase: string, pattern: RegExp]> = [
  ['predicted', /\bpredicted\b/i],
  ['foretold', /\bforetold\b/i],
  ['scientific miracle', /\bscientific\s+miracles?\b/i],
  ['proves', /\bproves\b/i],
  ['proof that', /\bproof\s+that\b/i],
  ['confirms the quran', /\bconfirms\s+the\s+qur'?an\b/i],
];

/** The banned phrases found in `text`, by their names above (in the order listed). */
export function bannedPhrasesIn(text: string): string[] {
  return BANNED_PHRASES.filter(([, pattern]) => pattern.test(text)).map(([phrase]) => phrase);
}
