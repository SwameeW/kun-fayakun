/**
 * Rule h: cue timing per chapter. Verses stay long enough to read whole (in either English), nothing
 * runs past the end, and no scene event is timed to a verse (spec principle 1).
 */
import type { ChapterContent, Cue, QuranEntry } from '../../../src/core/types';
import type { LoadedChapter } from '../content';
import type { ValidationContext } from '../context';
import type { RuleLog } from '../report';
import { codePointLength } from '../text';

/** Seconds before a verse during which no scene event may fire. */
const SCENE_GAP_BEFORE_VERSE = 2;
const MIN_VERSE_SECONDS = 8;
const SECONDS_PER_CHARACTER = 0.06;

/** Scene events per chapter, in order (docs/CONTRACTS.md). */
const SCENE_EVENTS: Readonly<Record<string, readonly string[]>> = {
  ch00: ['kun-reveal', 'kun-hold', 'kun-fade'],
  ch01: ['ignite', 'expand', 'cool'],
  ch02: ['plasma', 'recombination', 'cmb-reveal', 'cmb-hold'],
  ch03: ['dark', 'web', 'stars', 'galaxies'],
  ch04: ['galaxies', 'stretch', 'redshift', 'tension'],
  ch05: ['milky-way', 'pull-back', 'survey'],
  ch06: ['star', 'collapse', 'white-dwarf', 'type-ia'],
  ch07: ['disk', 'ignite', 'clear', 'orrery', 'moon', 'galaxy'],
  ch08: ['molten', 'impact', 'moon', 'oceans', 'continents'],
  ch09: ['ocean', 'rise', 'oxygen', 'green'],
  ch10: ['cosmos', 'heat-death', 'big-rip', 'big-crunch', 'still', 'fold', 'light', 'calligraphy', 'silence'],
};

type TimedCue = Extract<Cue, { duration: number }>;
type VerseCue = Extract<Cue, { type: 'verse' }>;

function isTimed(cue: Cue): cue is TimedCue {
  return cue.type === 'verse' || cue.type === 'hadith' || cue.type === 'caption';
}

/**
 * A card shows the Arabic with the translation, or with the verse's plain-words explanation in the
 * translation's place (the visitor's choice; src/ui/verse-english.ts): long enough for the longer.
 */
export function minVerseSeconds(entry: QuranEntry, plain = ''): number {
  const english = Math.max(codePointLength(entry.translation), codePointLength(plain));
  return Math.max(MIN_VERSE_SECONDS, SECONDS_PER_CHARACTER * (codePointLength(entry.arabic) + english));
}

function cueTimingProblems(content: ChapterContent, at: (i: number) => string, verses: ReadonlyMap<string, QuranEntry>, plain: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const { cues, duration } = content;
  cues.forEach((cue, i) => {
    const prev = cues[i - 1];
    if (prev && cue.t < prev.t) problems.push(`${at(i)}: cues are not sorted by t`);
    if (cue.t < 0 || cue.t > duration) problems.push(`${at(i)}: t is outside [0, ${duration}]`);
    if (!isTimed(cue)) return;
    if (!(cue.duration > 0)) problems.push(`${at(i)}: ${cue.type} duration must be > 0`);
    else if (cue.t + cue.duration > duration) problems.push(`${at(i)}: ${cue.type} ends at ${cue.t + cue.duration}s, after the chapter ends (${duration}s)`);
    if (cue.type !== 'verse') return;
    const entry = verses.get(cue.key);
    const needs = entry ? minVerseSeconds(entry, plain.get(`plain.${cue.key}`)) : 0;
    if (!entry) problems.push(`${at(i)}: verse ${cue.key} not in quran.json, cannot check its reading time`);
    else if (cue.duration < needs) {
      problems.push(`${at(i)}: verse ${cue.key} shows for ${cue.duration}s; needs at least ${needs.toFixed(1)}s to read whole`);
    }
  });
  return problems;
}

function sceneProblems(content: ChapterContent, dir: string, at: (i: number) => string): string[] {
  const problems: string[] = [];
  const verseCues = content.cues.filter((c): c is VerseCue => c.type === 'verse');
  content.cues.forEach((cue, i) => {
    if (cue.type !== 'scene') return;
    for (const verse of verseCues) {
      if (cue.t >= verse.t - SCENE_GAP_BEFORE_VERSE && cue.t <= verse.t + verse.duration) {
        problems.push(`${at(i)}: scene event "${cue.event}" falls inside verse ${verse.key} window [${verse.t - SCENE_GAP_BEFORE_VERSE}, ${verse.t + verse.duration}]`);
      }
    }
  });
  const expected = SCENE_EVENTS[dir];
  if (expected) {
    const events = content.cues.flatMap((c) => (c.type === 'scene' ? [c.event] : []));
    for (const e of events) if (!expected.includes(e)) problems.push(`${dir}: unknown scene event "${e}" (expected ${expected.join(', ')})`);
    for (const e of expected) if (!events.includes(e)) problems.push(`${dir}: scene event "${e}" is missing`);
    const order = expected.filter((e) => events.includes(e));
    const firstSeen = [...new Set(events.filter((e) => expected.includes(e)))];
    if (order.join() !== firstSeen.join()) problems.push(`${dir}: scene events must occur in the order ${expected.join(' -> ')}`);
  }
  return problems;
}

function cameraProblems(content: ChapterContent, dir: string): string[] {
  const problems: string[] = [];
  content.camera.forEach((kf, i) => {
    const prev = content.camera[i - 1];
    if (prev && kf.t < prev.t) problems.push(`${dir} camera[${i}]: keyframes are not sorted by t`);
    if (kf.t < 0 || kf.t > content.duration) problems.push(`${dir} camera[${i}]: t=${kf.t} is outside [0, ${content.duration}]`);
  });
  return problems;
}

function chapterProblems(chapter: LoadedChapter, verses: ReadonlyMap<string, QuranEntry>, plain: ReadonlyMap<string, string>): string[] {
  const { content, dir } = chapter;
  const at = (i: number): string => `${dir} cues[${i}] (t=${content.cues[i]?.t ?? '?'})`;
  const problems: string[] = [];
  if (content.id !== dir) problems.push(`${dir}: content id is "${content.id}", expected "${dir}"`);
  if (!(content.duration > 0)) problems.push(`${dir}: duration must be > 0`);
  return [...problems, ...cueTimingProblems(content, at, verses, plain), ...sceneProblems(content, dir, at), ...cameraProblems(content, dir)];
}

export function checkCues(ctx: ValidationContext, log: RuleLog): void {
  if (ctx.content.chapters.length === 0) {
    log.skip('no readable content.json files (see rule c)');
    return;
  }
  const verses = new Map<string, QuranEntry>(ctx.quran.status === 'ok' ? ctx.quran.value.ayat.map((a) => [a.key, a]) : []);
  const plain: ReadonlyMap<string, string> = ctx.i18n.chapters.status === 'ok' ? ctx.i18n.chapters.file.messages : new Map();
  for (const chapter of ctx.content.chapters) {
    const { content } = chapter;
    log.expectNone(
      chapterProblems(chapter, verses, plain),
      `${chapter.dir}: ${content.cues.length} cues and ${content.camera.length} camera keyframes within ${content.duration}s; verse timing and scene gaps respected`,
    );
  }
}
