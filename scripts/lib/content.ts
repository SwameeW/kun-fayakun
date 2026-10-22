/** Loads src/chapters/<id>/content.json files and lists everything they reference. */
import { basename, join } from 'node:path';
import type { ChapterContent, ProseBlock } from '../../src/core/types';
import { fileExists, listDirs, readJson, relPath, rootPath } from './files';
import { checkFields, isRecord } from './shape';

export interface LoadedChapter {
  /** Directory name, e.g. "ch01". */
  dir: string;
  path: string;
  content: ChapterContent;
}

export interface ContentLoad {
  chapters: LoadedChapter[];
  /** Chapter directories without a content.json yet. */
  missing: string[];
  /** Files that exist but do not parse or do not have the ChapterContent shape. */
  invalid: Array<{ path: string; problems: string[] }>;
}

const CHAPTER_DIR = /^ch\d\d$/;

/** Structural minimum needed before walking a chapter as ChapterContent. */
function shapeProblems(value: unknown, label: string): string[] {
  const problems = checkFields(
    value,
    {
      id: 'nonempty',
      duration: 'number',
      intro: 'object',
      'intro.titleKey': 'nonempty',
      'intro.seconds': 'number',
      panel: 'object',
      'panel.text': 'array',
      'panel.scholarly': 'object',
      'panel.scholarly.classical': 'array',
      'panel.scholarly.modern': 'array',
      'panel.science': 'array',
      'panel.openQuestions': 'array',
      cues: 'array',
      camera: 'array',
      explore: 'object',
    },
    label,
  );
  if (problems.length > 0 || !isRecord(value)) return problems;
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
  list(value.cues).forEach((cue, i) => {
    problems.push(...checkFields(cue, { t: 'number', type: 'nonempty' }, `${label} cues[${i}]`));
  });
  list(value.camera).forEach((kf, i) => {
    problems.push(...checkFields(kf, { t: 'number' }, `${label} camera[${i}]`));
  });
  const panel = value.panel as Record<string, unknown>;
  list(panel.text).forEach((block, i) => {
    problems.push(...checkFields(block, { type: 'nonempty' }, `${label} panel.text[${i}]`));
  });
  const scholarly = panel.scholarly as Record<string, unknown>;
  const prose: Array<[string, unknown]> = [
    ['panel.scholarly.classical', scholarly.classical],
    ['panel.scholarly.modern', scholarly.modern],
    ['panel.science', panel.science],
    ['panel.openQuestions', panel.openQuestions],
  ];
  for (const [path, blocks] of prose) {
    list(blocks).forEach((block, i) => {
      problems.push(...checkFields(block, { key: 'nonempty' }, `${label} ${path}[${i}]`));
    });
  }
  return problems;
}

export function loadChapters(): ContentLoad {
  const result: ContentLoad = { chapters: [], missing: [], invalid: [] };
  for (const dir of listDirs(rootPath('src', 'chapters'))) {
    const name = basename(dir);
    if (!CHAPTER_DIR.test(name)) continue;
    const path = join(dir, 'content.json');
    if (!fileExists(path)) {
      result.missing.push(name);
      continue;
    }
    let value: unknown;
    try {
      value = readJson(path);
    } catch (err) {
      result.invalid.push({ path: relPath(path), problems: [err instanceof Error ? err.message : String(err)] });
      continue;
    }
    const problems = shapeProblems(value, relPath(path));
    if (problems.length > 0) result.invalid.push({ path: relPath(path), problems });
    else result.chapters.push({ dir: name, path: relPath(path), content: value as ChapterContent });
  }
  return result;
}

/** A referenced id plus where it was found, for messages. */
export interface Ref {
  value: string;
  where: string;
}

export interface ContentRefs {
  verses: Ref[];
  hadith: Ref[];
  i18n: Ref[];
  constants: Array<Ref & { field: string }>;
  cites: Ref[];
}

function proseBlocks(content: ChapterContent): Array<[string, ProseBlock]> {
  const { panel } = content;
  const named = (path: string, blocks: readonly ProseBlock[]): Array<[string, ProseBlock]> =>
    blocks.map((block, i) => [`${path}[${i}]`, block]);
  return [
    ...named('panel.scholarly.classical', panel.scholarly.classical),
    ...named('panel.scholarly.modern', panel.scholarly.modern),
    ...named('panel.science', panel.science),
    ...named('panel.openQuestions', panel.openQuestions),
  ];
}

export function collectRefs(chapter: LoadedChapter): ContentRefs {
  const refs: ContentRefs = { verses: [], hadith: [], i18n: [], constants: [], cites: [] };
  const { content, dir } = chapter;
  const at = (where: string): string => `${dir} ${where}`;

  refs.i18n.push({ value: content.intro.titleKey, where: at('intro.titleKey') });
  if (content.intro.subtitleKey !== undefined) {
    refs.i18n.push({ value: content.intro.subtitleKey, where: at('intro.subtitleKey') });
  }

  content.panel.text.forEach((block, i) => {
    const where = at(`panel.text[${i}]`);
    if (block.type === 'verse') refs.verses.push({ value: block.key, where });
    else refs.hadith.push({ value: block.id, where });
    if (block.noteKey !== undefined) refs.i18n.push({ value: block.noteKey, where: `${where}.noteKey` });
    if (block.type === 'hadith' && block.summaryKey !== undefined) {
      refs.i18n.push({ value: block.summaryKey, where: `${where}.summaryKey` });
    }
  });

  for (const [path, block] of proseBlocks(content)) {
    const where = at(path);
    refs.i18n.push({ value: block.key, where });
    for (const [name, ref] of Object.entries(block.values ?? {})) {
      refs.constants.push({ value: ref.constant, field: ref.field, where: `${where}.values.${name}` });
    }
    for (const id of block.cite ?? []) refs.cites.push({ value: id, where: `${where}.cite` });
  }

  content.cues.forEach((cue, i) => {
    const where = at(`cues[${i}] (t=${cue.t})`);
    if (cue.type === 'verse') refs.verses.push({ value: cue.key, where });
    else if (cue.type === 'hadith') refs.hadith.push({ value: cue.id, where });
    else if (cue.type === 'caption') refs.i18n.push({ value: cue.key, where });
  });
  return refs;
}
