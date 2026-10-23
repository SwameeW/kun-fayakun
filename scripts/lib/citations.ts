/** data/citations.json: the manifest of every verse key and hadith reference the project cites. */
import type { VerseKey } from '../../src/core/types';
import { readJson, rootPath } from './files';
import { isVerseKey, sortedUniqueKeys } from './verse-key';

export interface CalligraphyCitation {
  id: string;
  verse: string;
  wordIndexFromEnd: number;
  /** Words from that one onward (a short phrase); 1 when absent. */
  wordCount?: number;
}

export interface CitationsFile {
  verses: Record<string, string[]>;
  hadith: Record<string, string[]>;
  calligraphy: Record<string, CalligraphyCitation[]>;
}

export const CITATIONS_PATH = rootPath('data', 'citations.json');

export function loadCitations(): CitationsFile {
  return readJson(CITATIONS_PATH) as CitationsFile;
}

/** All verse keys (every chapter plus "optional"), deduplicated, in Mushaf order. Throws on a malformed key. */
export function citedVerseKeys(citations: CitationsFile): VerseKey[] {
  const keys: VerseKey[] = [];
  for (const [group, list] of Object.entries(citations.verses)) {
    for (const key of list) {
      if (!isVerseKey(key)) throw new Error(`citations.json verses.${group}: invalid verse key "${key}"`);
      keys.push(key);
    }
  }
  return sortedUniqueKeys(keys);
}

/** All sunnah.com keys cited (e.g. "muslim:2653b"), deduplicated. */
export function citedSunnahKeys(citations: CitationsFile): string[] {
  return [...new Set(Object.values(citations.hadith).flat())];
}

export function calligraphyCitations(citations: CitationsFile): CalligraphyCitation[] {
  return Object.values(citations.calligraphy).flat();
}
