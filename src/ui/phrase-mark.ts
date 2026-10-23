/**
 * Marks cited words of a verse in place (docs/SPEC.md, Chapter 7, discovery step 2) with the
 * CSS Custom Highlight API: the browser paints a soft underline over Ranges of the existing
 * text node, so the verse's DOM text is never split, wrapped, re-ordered or altered. Where the
 * API is missing the mark is simply skipped; the analysis names the verses in words anyway.
 *
 * Word positions follow scripts/lib/analysis.ts: whitespace tokens that keep at least one base
 * letter once combining marks (Unicode Mn), tatweel and the Quranic annotation signs are set
 * aside, counted from 1. Characters are tested by property and code point; no Arabic is held here.
 */

export interface PhraseWords {
  key: string;
  tokens: readonly number[];
}

const HIGHLIGHT_NAME = 'kf-falak';
const TATWEEL = 0x0640;
const SIGNS_FIRST = 0x06d6;
const SIGNS_LAST = 0x06ed;

function isSetAside(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return /\p{Mn}/u.test(ch) || cp === TATWEEL || (cp >= SIGNS_FIRST && cp <= SIGNS_LAST);
}

/** Start and end offsets (UTF-16, as Ranges count) of the words that carry base letters. */
function wordSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(/\S+/gu)) {
    if (Array.from(match[0]).some((ch) => !isSetAside(ch))) spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/** Underlines the words wherever the verses are on screen (panel article, stage card). Returns the unmark. */
export function markPhrase(verses: readonly PhraseWords[]): () => void {
  const registry = typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null;
  if (!registry || typeof Highlight === 'undefined') return () => undefined;
  const ranges: Range[] = [];
  for (const verse of verses) {
    for (const el of document.querySelectorAll(`[data-verse="${CSS.escape(verse.key)}"] [lang="ar"]`)) {
      const node = el.firstChild;
      if (!(node instanceof Text) || node !== el.lastChild) continue;
      const words = wordSpans(node.data);
      for (const position of verse.tokens) {
        const word = words[position - 1];
        if (!word) continue;
        const range = document.createRange();
        range.setStart(node, word.start);
        range.setEnd(node, word.end);
        ranges.push(range);
      }
    }
  }
  if (ranges.length === 0) return () => undefined;
  registry.set(HIGHLIGHT_NAME, new Highlight(...ranges));
  return () => {
    registry.delete(HIGHLIGHT_NAME);
  };
}
