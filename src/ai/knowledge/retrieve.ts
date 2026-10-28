/**
 * Retrieval over the knowledge index: Okapi BM25 (k1 1.2, b 0.75) on each passage's title and text, with the tokeniser, stemmer and synonyms of ./text.ts. A question's own words
 * count fully, the words its synonyms add count less. Scores are then weighted by the kind of
 * passage and raised for the chapter on screen; a verse key in the question ("21:30") goes straight
 * to that verse and what explains it. Ties are broken by id, so the same question always gives the
 * same answer.
 */
import type { ChapterId } from '../../core/types';
import type { Passage, PassageKind, Retriever } from '../types';
import { foldText, synonymTokens, tokenize, VERSE_KEY_PATTERN } from './text';

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
/** Weight of the words synonyms add, against the question's own (times the synonym's own weight). */
const SYNONYM_WEIGHT = 0.6;
/** Passages on the chapter the visitor is in count this much more. */
const CHAPTER_BOOST = 1.3;
/** A passage about a verse key named in the question gets this added before weighting. */
const REFERENCE_BONUS = 12;
/** For a passage holding a phrase the question quotes, or is made of (common words only). */
const PHRASE_BONUS = 12;

/** Text as phrases are compared: folded, letters and digits only, single-spaced. */
const phraseText = (text: string): string => ` ${foldText(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/**
 * The phrases a question asks for word for word: what it quotes, or the whole question when every word
 * is a common one. "Where does the Quran say \"Be, and it is\"?" searched for nothing, its words all
 * stop words, and models then said the Quran does not hold the phrase (docs/AI-EVALUATION.md).
 */
function phrasesOf(query: string, plain: boolean): string[] {
  const quoted = [...query.matchAll(/[“"«]([^”"»]{3,120})[”"»]/gu)].map((m) => m[1] ?? '');
  const all = plain ? [query] : [];
  return [...quoted, ...all].map((q) => phraseText(q).trim()).filter((q) => q.split(' ').length >= 3);
}

/**
 * How much each kind of passage counts. The app's own explanations come first; places and stars
 * (there are many, with short texts that would otherwise outscore prose) and source titles last.
 */
export const KIND_WEIGHT: Readonly<Record<PassageKind, number>> = {
  prose: 1.2,
  explore: 1.15,
  term: 1.2,
  verse: 1.15,
  hadith: 1.1,
  help: 1.1,
  fact: 1.05,
  constant: 0.95,
  place: 0.7,
  source: 0.55,
};

/**
 * The part of a title that is searched. A chapter's prose is titled "Chapter 3: <its name>: <layer>";
 * the chapter's name would make every one of its passages match its words ("dark ages" for "how old"),
 * so only the part after it counts (the chapter's own passage keeps its whole title).
 */
function indexedTitle(passage: Passage): string {
  if (passage.id.startsWith('chapter:')) return passage.title;
  return passage.title.replace(/^Chapter \d+: [^:]*: /u, '');
}

interface Doc {
  passage: Passage;
  tf: Map<string, number>;
  length: number;
  /** Its text as phrases are compared (phraseText). */
  phrase: string;
}

export interface SearchOptions {
  kinds?: readonly PassageKind[];
  chapter?: ChapterId | null;
  limit?: number;
}

/** Builds a retriever over passages (the index's, or a test's own). */
export function createRetriever(passages: readonly Passage[]): Retriever {
  const docs: Doc[] = [];
  const df = new Map<string, number>();
  const byId = new Map<string, Passage>();
  let total = 0;
  for (const passage of passages) {
    byId.set(passage.id, passage);
    const words = [...tokenize(indexedTitle(passage)), ...tokenize(passage.text)];
    const tf = new Map<string, number>();
    for (const word of words) tf.set(word, (tf.get(word) ?? 0) + 1);
    for (const word of tf.keys()) df.set(word, (df.get(word) ?? 0) + 1);
    docs.push({ passage, tf, length: words.length, phrase: phraseText(passage.text) });
    total += words.length;
  }
  const n = docs.length;
  const avg = n > 0 ? total / n : 1;
  const idf = (word: string): number => {
    const d = df.get(word) ?? 0;
    return Math.log(1 + (n - d + 0.5) / (d + 0.5));
  };

  function search(query: string, options: SearchOptions = {}): readonly { passage: Passage; score: number }[] {
    const limit = options.limit ?? 5;
    const weights = new Map<string, number>();
    for (const word of tokenize(query)) weights.set(word, 1);
    for (const [word, weight] of synonymTokens(query)) if (!weights.has(word)) weights.set(word, weight * SYNONYM_WEIGHT);
    const keys = [...query.matchAll(VERSE_KEY_PATTERN)].map((m) => `${Number(m[1])}:${Number(m[2])}`);
    const phrases = phrasesOf(query, weights.size === 0);
    if (weights.size === 0 && keys.length === 0 && phrases.length === 0) return [];
    const kinds = options.kinds ? new Set(options.kinds) : null;
    const scored: { passage: Passage; score: number }[] = [];
    for (const doc of docs) {
      const p = doc.passage;
      if (kinds && !kinds.has(p.kind)) continue;
      let score = 0;
      for (const [word, weight] of weights) {
        const f = doc.tf.get(word);
        if (!f) continue;
        score += weight * idf(word) * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avg)));
      }
      if (phrases.some((ph) => doc.phrase.includes(` ${ph} `))) score += PHRASE_BONUS;
      if (keys.length > 0 && (keys.includes(p.ref ?? '') || keys.some((k) => p.id === `plain:${k}` || p.id.endsWith(`.${k}`) || (p.kind === 'prose' && p.title.includes(` ${k}`))))) {
        score += REFERENCE_BONUS;
      }
      if (score <= 0) continue;
      score *= KIND_WEIGHT[p.kind];
      if (options.chapter && p.chapter === options.chapter) score *= CHAPTER_BOOST;
      scored.push({ passage: p, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.passage.id < b.passage.id ? -1 : a.passage.id > b.passage.id ? 1 : 0));
    return scored.slice(0, Math.max(0, limit));
  }

  return {
    search,
    get: (id) => byId.get(id) ?? null,
  };
}
