/** Rule d: data/hadith.json records are complete, reviewed when they carry wording, and never excluded narrations. */
import type { HadithEntry } from '../../../src/core/types';
import { citedSunnahKeys } from '../citations';
import { unavailable, type ValidationContext } from '../context';
import { fileExists, listTextFiles, readText, relPath, rootPath } from '../files';
import type { RuleLog } from '../report';
import { checkFields, duplicates, isRecord } from '../shape';

/** Spec section 3, Chapter 0: judged defective; must stay excluded. */
const REQUIRED_EXCLUSIONS = ['muslim:2789'];

/** "muslim:2653b" -> "muslim-2653" (the id pattern used across the project). */
export function hadithIdFor(sunnahKey: string): string {
  return sunnahKey.replace(':', '-').replace(/[a-z]+$/, '');
}

const HADITH_FIELDS = {
  id: 'nonempty',
  collection: 'nonempty',
  number: 'nonempty',
  sunnahKey: 'nonempty',
  grading: 'nonempty',
  grader: 'nonempty',
  narrator: 'string',
  parallels: 'array',
  disputedNote: 'string|null',
  reviewer: 'nonempty|null',
  reviewedAt: 'nonempty|null',
  text: 'object',
  'text.en': 'string|null',
  'text.ar': 'string|null',
  'text.source': 'string|null',
} as const;

/**
 * Matches a mention of `sunnahKey` in prose, links or ids: "muslim:2789", "muslim-2789",
 * "sunnah.com/muslim/2789", "Sahih Muslim 2789", "Muslim no. 2789". Null for an unusual key.
 */
export function mentionPattern(sunnahKey: string): RegExp | null {
  const match = /^([a-z]+):(\d+)([a-z]*)$/i.exec(sunnahKey);
  if (!match) return null;
  const [, collection = '', number = '', suffix = ''] = match;
  const tail = suffix ? `${suffix}(?![a-z0-9])` : '(?![0-9])';
  return new RegExp(`\\b${collection}[\\s:/#,.-]*(?:(?:no|number|hadith)\\.?[\\s:#]*)?${number}${tail}`, 'iu');
}

/**
 * Hard rule 3: an excluded narration is never referenced. Structured references are
 * checked elsewhere; this scans the free text that can reach the screen or cite a
 * narration: every text file under src/, data/sources.json, data/constants.json and
 * the hadith records (the `excluded` list itself is the one allowed mention).
 */
function excludedMentions(ctx: ValidationContext, excludedKeys: Iterable<string>): string[] {
  const patterns = [...excludedKeys].flatMap((key) => {
    const re = mentionPattern(key);
    return re ? [[key, re] as const] : [];
  });
  const texts: Array<[string, string]> = listTextFiles(rootPath('src')).map((f) => [relPath(f), readText(f)]);
  for (const name of ['sources.json', 'constants.json']) {
    const path = rootPath('data', name);
    if (fileExists(path)) texts.push([relPath(path), readText(path)]);
  }
  if (ctx.hadith.status === 'ok') texts.push(['data/hadith.json hadith[]', JSON.stringify(ctx.hadith.value.hadith, null, 1)]);
  const problems: string[] = [];
  for (const [label, text] of texts) {
    text.split('\n').forEach((line, i) => {
      for (const [key, re] of patterns) if (re.test(line)) problems.push(`${label}:${i + 1}: mentions excluded narration ${key}`);
    });
  }
  return problems;
}

function labelOf(entry: unknown, index: number): string {
  return `hadith[${index}]${isRecord(entry) && typeof entry.id === 'string' ? ` (${entry.id})` : ''}`;
}

function isWellFormed(entry: unknown): entry is HadithEntry {
  return checkFields(entry, HADITH_FIELDS, '').length === 0;
}

function entryProblems(entry: unknown, index: number): string[] {
  const label = labelOf(entry, index);
  const problems = checkFields(entry, HADITH_FIELDS, label);
  if (!isWellFormed(entry)) return problems;
  if ((entry.text.en !== null || entry.text.ar !== null) && (entry.reviewer === null || entry.reviewedAt === null)) {
    problems.push(`${label}: has wording (text.en or text.ar) but no reviewer/reviewedAt`);
  }
  const expectedId = hadithIdFor(entry.sunnahKey);
  if (expectedId !== entry.id) problems.push(`${label}: id should be "${expectedId}" for sunnahKey ${entry.sunnahKey}`);
  return problems;
}

export function checkHadith(ctx: ValidationContext, log: RuleLog): void {
  const missing = unavailable(ctx.hadith, 'content builder');
  if (missing || ctx.hadith.status !== 'ok') {
    log.fail(missing ?? 'data/hadith.json unavailable');
    return;
  }
  const file: unknown = ctx.hadith.value;
  const shape = checkFields(file, { hadith: 'array', excluded: 'array' }, 'data/hadith.json');
  if (shape.length > 0) {
    for (const p of shape) log.fail(p);
    return;
  }
  const all: unknown[] = ctx.hadith.value.hadith;
  const entryIssues = all.flatMap((entry, i) => entryProblems(entry, i));
  log.expectNone(entryIssues, `${all.length} hadith record(s) have collection, number, sunnahKey, grading and grader; wording only with a reviewer`);

  const hadith = all.filter(isWellFormed);
  const excludedRaw: unknown[] = ctx.hadith.value.excluded;
  const excludedShape = excludedRaw.flatMap((e, i) => checkFields(e, { sunnahKey: 'nonempty', reason: 'nonempty' }, `excluded[${i}]`));
  const excludedKeys = new Set(excludedRaw.filter(isRecord).map((e) => String(e.sunnahKey)));
  const exclusionIssues = [
    ...excludedShape,
    ...REQUIRED_EXCLUSIONS.filter((k) => !excludedKeys.has(k)).map((k) => `excluded must list ${k}`),
    ...hadith
      .filter((h) => [h.sunnahKey, ...h.parallels].some((k) => excludedKeys.has(k)))
      .map((h) => `${h.id}: refers to an excluded narration (${[h.sunnahKey, ...h.parallels].filter((k) => excludedKeys.has(k)).join(', ')})`),
    ...citedSunnahKeys(ctx.citations)
      .filter((k) => excludedKeys.has(k))
      .map((k) => `data/citations.json cites excluded narration ${k}`),
  ];
  log.expectNone(exclusionIssues, `excluded narrations (${[...excludedKeys].join(', ')}) are listed and never used`);
  log.expectNone(
    excludedMentions(ctx, new Set([...excludedKeys, ...REQUIRED_EXCLUSIONS])),
    'no file under src/, no source or constant entry and no hadith record mentions an excluded narration',
  );

  const byId = new Map(hadith.map((h) => [h.id, h]));
  const refIssues = [
    ...duplicates(hadith.map((h) => h.id)).map((id) => `duplicate hadith id ${id}`),
    ...ctx.refs.flatMap(({ refs }) =>
      refs.hadith.flatMap((ref) => {
        const entry = byId.get(ref.value);
        if (!entry) return [`${ref.where}: hadith id ${ref.value} is not in data/hadith.json`];
        return excludedKeys.has(entry.sunnahKey) ? [`${ref.where}: references excluded narration ${entry.sunnahKey}`] : [];
      }),
    ),
  ];
  const refCount = ctx.refs.reduce((n, { refs }) => n + refs.hadith.length, 0);
  log.expectNone(refIssues, `${refCount} hadith reference(s) in content resolve to data/hadith.json`);

  const recorded = new Set(hadith.map((h) => h.sunnahKey));
  for (const key of citedSunnahKeys(ctx.citations)) {
    if (!recorded.has(key)) log.warn(`${key} is cited in data/citations.json but has no record in data/hadith.json yet`);
  }
}
