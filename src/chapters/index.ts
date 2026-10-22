import type { ChapterId, ChapterMeta } from '../core/types';

/** Julian year in seconds; used only to place stops on the log-scale timeline. */
const YEAR = 3.15576e7;

const meta = (
  id: ChapterId,
  epoch: ChapterMeta['epoch'],
  milestone: ChapterMeta['milestone'],
  load?: ChapterMeta['load'],
): ChapterMeta => ({
  id,
  number: Number(id.slice(2)),
  titleKey: `timeline.${id}.title`,
  stopKey: `timeline.${id}.stop`,
  epochKey: `timeline.${id}.epoch`,
  epoch,
  milestone,
  ...(load ? { load } : {}),
});

/**
 * Every labelled stop on the timeline, in story order. Chapters without a
 * loader are shown as upcoming stops and cannot be entered yet.
 */
export const CHAPTERS: readonly ChapterMeta[] = [
  meta('ch00', 'before', 'M1', () => import('./ch00/scene')),
  meta('ch01', 1e-36, 'M1', () => import('./ch01/scene')),
  meta('ch02', 380_000 * YEAR, 'M1', () => import('./ch02/scene')),
  meta('ch03', 1.5e8 * YEAR, 'M2'),
  meta('ch04', 1e9 * YEAR, 'M2'),
  meta('ch05', 3e9 * YEAR, 'M2'),
  meta('ch06', 6e9 * YEAR, 'M2'),
  meta('ch07', (13.787 - 4.567) * 1e9 * YEAR, 'M3'),
  meta('ch08', (13.787 - 4.54) * 1e9 * YEAR, 'M3'),
  meta('ch09', (13.787 - 3.7) * 1e9 * YEAR, 'M3'),
  meta('ch10', 'end', 'M3'),
];

/** "Now" marker on the timeline: the present age of the universe (Planck 2018 central value). */
export const NOW_SECONDS = 13.787e9 * YEAR;

export function chapterById(id: ChapterId): ChapterMeta {
  const found = CHAPTERS.find((c) => c.id === id);
  if (!found) throw new Error(`Unknown chapter ${id}`);
  return found;
}

export function isPlayable(c: ChapterMeta): boolean {
  return typeof c.load === 'function';
}
