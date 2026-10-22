/**
 * Reads the project's frozen data and chapter content straight from disk, so
 * tests compare what the browser shows against the source of truth rather
 * than against anything the app itself fetched.
 */
import { readFileSync } from 'node:fs';
import { CHAPTERS, isPlayable } from '../../src/chapters/index';
import type {
  ChapterContent,
  ChapterId,
  ChapterMeta,
  FigureId,
  QuranEntry,
  QuranFile,
  VerseKey,
} from '../../src/core/types';

const ROOT = new URL('../../', import.meta.url);

function readText(relativePath: string): string {
  return readFileSync(new URL(relativePath, ROOT), 'utf8');
}

function readJson(relativePath: string): unknown {
  return JSON.parse(readText(relativePath));
}

/** Every chapter that can be entered today, in story order. */
export const PLAYABLE_CHAPTERS: readonly ChapterMeta[] = CHAPTERS.filter(isPlayable);

export function chapterContent(id: ChapterId): ChapterContent {
  return readJson(`src/chapters/${id}/content.json`) as ChapterContent;
}

export function quranFile(): QuranFile {
  return readJson('data/quran.json') as QuranFile;
}

export function quranByKey(): ReadonlyMap<VerseKey, QuranEntry> {
  return new Map(quranFile().ayat.map((entry) => [entry.key, entry]));
}

/** Verse keys a chapter can put on screen: its panel's text layer and its verse cues. */
export function chapterVerseKeys(content: ChapterContent): VerseKey[] {
  const keys = new Set<VerseKey>();
  for (const block of content.panel.text) if (block.type === 'verse') keys.add(block.key);
  for (const cue of content.cues) if (cue.type === 'verse') keys.add(cue.key);
  return [...keys];
}

/** Verse keys shown in the panel's text layer only. */
export function panelVerseKeys(content: ChapterContent): VerseKey[] {
  return content.panel.text.flatMap((block) => (block.type === 'verse' ? [block.key] : []));
}

/**
 * The scene event after which each chapter is visibly lit, plus a settling
 * offset in seconds. Chapter 0 is dark by design until its reveal.
 */
const VISIBLE_AFTER: Partial<Record<ChapterId, { event: string; offset: number }>> = {
  ch00: { event: 'kun-hold', offset: 1 },
  ch01: { event: 'expand', offset: 3 },
  ch02: { event: 'cmb-hold', offset: 1 },
};

/** A chapter time (seconds) at which the scene should be clearly visible. */
export function visibleTime(content: ChapterContent): number {
  const rule = VISIBLE_AFTER[content.id];
  const cue = rule
    ? content.cues.find((c) => c.type === 'scene' && c.event === rule.event)
    : undefined;
  if (rule && cue) return Math.min(cue.t + rule.offset, content.duration - 1);
  return Math.round(content.duration / 2);
}

/** Whether the chapter's overlay cues leave figure `id` showing at chapter time t. */
export function overlayVisibleAt(content: ChapterContent, id: FigureId, t: number): boolean {
  let visible = false;
  for (const cue of content.cues) {
    if (cue.type === 'overlay' && cue.id === id && cue.t <= t) visible = cue.visible;
  }
  return visible;
}

/** The disclaimer exactly as docs/SPEC.md (Core Principle 7) words it. */
export function specDisclaimer(): string {
  const spec = readText('docs/SPEC.md');
  const match = /On-screen disclaimer[^“]*“([^”]+)”/u.exec(spec);
  if (!match?.[1]) throw new Error('Could not find the on-screen disclaimer in docs/SPEC.md');
  return match[1];
}

/** Credit line the spec requires wherever the Planck map appears. */
export const PLANCK_CREDIT = 'ESA and the Planck Collaboration';

/** Collapses runs of whitespace so text can be compared across HTML layouts. */
export function normalizeSpace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
