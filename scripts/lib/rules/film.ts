/**
 * Rule k: the film's shot list (film/shotlist.json) and the screenplay's shot tables
 * (film/screenplay.md) agree with each chapter's content.json: the same durations, shots that tile
 * each chapter exactly, every verse, hadith, caption and panel cue listed in the shot it starts in
 * (and nothing listed that no cue starts there), and the tables' times and the runtime as written.
 */
import type { Cue } from '../../../src/core/types';
import type { ValidationContext } from '../context';
import { fileExists, readJson, readText, rootPath } from '../files';
import type { RuleLog } from '../report';

interface Shot {
  id: string;
  chapter: string;
  start: number;
  duration: number;
  text: string[];
  verses: string[];
  hadith: string[];
  panel: string | null;
}

interface ShotList {
  chapters: Array<{ id: string; duration: number }>;
  shots: Shot[];
}

const EPS = 1e-6;

/** A time as the screenplay writes it: "m:ss.s". */
export function screenplayClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60 + EPS);
  return `${String(minutes)}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`;
}

/** The screenplay's runtime of the chapters together: "22 min 44 s". */
export function screenplayRuntime(seconds: number): string {
  const minutes = Math.floor(seconds / 60 + EPS);
  return `${String(minutes)} min ${String(Math.round((seconds - minutes * 60) * 10) / 10)} s`;
}

type List = 'text' | 'verses' | 'hadith' | 'panel' | 'figure';

/** What a cue puts in its shot's lists, as [list, entry]; a figure overlay is listed where it appears. */
function listed(cue: Cue): Array<readonly [List, string]> {
  if (cue.type === 'verse') return [['verses', cue.key]];
  if (cue.type === 'hadith') return [cue.id, ...(cue.also ?? [])].map((id) => ['hadith', id] as const);
  if (cue.type === 'caption') return [['text', cue.key]];
  if (cue.type === 'panel') return [['panel', cue.section]];
  if (cue.type === 'overlay' && cue.visible) return [['figure', cue.id]];
  return [];
}

/** A shot's lists; its panel field reads "text, scholarly; figure hubble-tension". */
function shotEntries(shot: Shot): Array<readonly [List, string]> {
  const panel = (shot.panel ?? '').split(/[;,]\s*/u).filter((k) => k !== '');
  return [
    ...shot.text.map((k) => ['text', k] as const),
    ...shot.verses.map((k) => ['verses', k] as const),
    ...shot.hadith.map((k) => ['hadith', k] as const),
    ...panel.map((k) => (k.startsWith('figure ') ? (['figure', k.slice('figure '.length)] as const) : (['panel', k] as const))),
  ];
}

function chapterProblems(id: string, duration: number, cues: readonly Cue[], shots: readonly Shot[]): string[] {
  const problems: string[] = [];
  if (shots.length === 0) return [`${id}: no shots in film/shotlist.json`];
  let end = 0;
  for (const shot of shots) {
    if (Math.abs(shot.start - end) > EPS) problems.push(`${shot.id}: starts at ${String(shot.start)} s, but the shot before it ends at ${String(end)} s`);
    end = shot.start + shot.duration;
  }
  if (Math.abs(end - duration) > EPS) problems.push(`${id}: the shots end at ${String(end)} s, the chapter at ${String(duration)} s`);
  const shotAt = (t: number): Shot | undefined => shots.find((s) => t >= s.start - EPS && (t < s.start + s.duration - EPS || s === shots[shots.length - 1]));
  const expected = new Map<string, Set<string>>(shots.map((s) => [s.id, new Set<string>()]));
  for (const cue of cues) {
    const shot = shotAt(cue.t);
    for (const [list, entry] of listed(cue)) {
      if (!shot) {
        problems.push(`${id}: no shot contains the ${cue.type} cue at ${String(cue.t)} s`);
        continue;
      }
      expected.get(shot.id)?.add(`${list}:${entry}`);
    }
  }
  for (const shot of shots) {
    const want = expected.get(shot.id) ?? new Set<string>();
    const have = new Set(shotEntries(shot).map(([list, entry]) => `${list}:${entry}`));
    for (const item of want) if (!have.has(item)) problems.push(`${shot.id}: a cue starting in this shot is not listed (${item.replace(':', ' ')})`);
    for (const item of have) if (!want.has(item)) problems.push(`${shot.id}: lists ${item.replace(':', ' ')}, but no such cue starts in this shot`);
  }
  return problems;
}

function screenplayProblems(text: string, list: ShotList, titles: ReadonlyMap<string, number>): string[] {
  const problems: string[] = [];
  for (const shot of list.shots) {
    const row = `| ${shot.id} | ${screenplayClock(shot.start)} | ${String(shot.duration)} s |`;
    if (!text.includes(row)) problems.push(`film/screenplay.md: no shot-table row beginning "${row}"`);
  }
  for (const [chapter, duration] of titles) {
    const number = String(Number(chapter.slice(2)));
    const heading = new RegExp(`^### Chapter ${number}\\. .+ \\((\\d+:\\d\\d\\.\\d)\\)$`, 'mu');
    const found = heading.exec(text)?.[1];
    if (found !== screenplayClock(duration)) problems.push(`film/screenplay.md: Chapter ${number}'s shot table is headed (${found ?? 'missing'}), not (${screenplayClock(duration)})`);
  }
  const total = [...titles.values()].reduce((a, b) => a + b, 0);
  if (!text.includes(`(${screenplayRuntime(total)})`)) problems.push(`film/screenplay.md: the chapters' runtime is ${screenplayRuntime(total)}; the opening paragraph says otherwise`);
  return problems;
}

export function checkFilm(ctx: ValidationContext, log: RuleLog): void {
  const listPath = rootPath('film', 'shotlist.json');
  const playPath = rootPath('film', 'screenplay.md');
  if (!fileExists(listPath) || !fileExists(playPath)) {
    log.fail('film/shotlist.json or film/screenplay.md is missing');
    return;
  }
  const list = readJson(listPath) as ShotList;
  const durations = new Map(ctx.content.chapters.map((c) => [c.dir, c.content.duration]));
  const problems: string[] = [];
  for (const entry of list.chapters) {
    const duration = durations.get(entry.id);
    if (duration === undefined) problems.push(`film/shotlist.json: chapter ${entry.id} has no content.json`);
    else if (Math.abs(duration - entry.duration) > EPS) problems.push(`film/shotlist.json: ${entry.id} lasts ${String(entry.duration)} s; its content.json, ${String(duration)} s`);
  }
  for (const chapter of ctx.content.chapters) {
    if (!list.chapters.some((c) => c.id === chapter.dir)) problems.push(`film/shotlist.json: ${chapter.dir} is not listed`);
    const shots = list.shots.filter((s) => s.chapter === chapter.dir).sort((a, b) => a.start - b.start);
    problems.push(...chapterProblems(chapter.dir, chapter.content.duration, chapter.content.cues, shots));
  }
  log.expectNone(problems, `${String(list.shots.length)} shots tile the ${String(ctx.content.chapters.length)} chapters exactly, each listing the verses, hadith, captions and panel cues that start in it`);
  log.expectNone(screenplayProblems(readText(playPath), list, durations), 'the screenplay’s shot tables, chapter headings and runtime match the shot list');
}
