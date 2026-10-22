/** Verse key parsing and canonical ordering. */
import type { VerseKey } from '../../src/core/types';

export function parseVerseKey(key: string): { surah: number; ayah: number } | null {
  const match = /^(\d{1,3}):(\d{1,3})$/.exec(key);
  if (!match) return null;
  const surah = Number(match[1]);
  const ayah = Number(match[2]);
  if (surah < 1 || surah > 114 || ayah < 1) return null;
  return { surah, ayah };
}

export function isVerseKey(key: string): key is VerseKey {
  return parseVerseKey(key) !== null;
}

export function toVerseKey(surah: number, ayah: number): VerseKey {
  return `${surah}:${ayah}`;
}

/** Mushaf order: by surah, then ayah. Invalid keys sort last. */
export function compareVerseKeys(a: string, b: string): number {
  const pa = parseVerseKey(a);
  const pb = parseVerseKey(b);
  if (!pa || !pb) return pa ? -1 : pb ? 1 : a.localeCompare(b);
  return pa.surah - pb.surah || pa.ayah - pb.ayah;
}

/** Deduplicated keys in Mushaf order. */
export function sortedUniqueKeys(keys: Iterable<VerseKey>): VerseKey[] {
  return [...new Set(keys)].sort(compareVerseKeys);
}
