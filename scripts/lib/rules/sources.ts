/** Rule f: data/sources.json is complete, carries the spec disclaimer verbatim and covers every cited text. */
import type { SourceEntry, SourceKind } from '../../../src/core/types';
import { citedSunnahKeys } from '../citations';
import { unavailable, type ValidationContext } from '../context';
import type { RuleLog } from '../report';
import { checkFields, duplicates, isRecord } from '../shape';
import { TANZIL_FILES } from '../tanzil';
import { isVerseKey } from '../verse-key';
import { hadithIdFor } from './hadith';

const KINDS: readonly SourceKind[] = [
  'scripture-text', 'translation', 'transliteration', 'hadith-collection',
  'font', 'dataset', 'paper', 'software', 'api', 'recording',
];

const REQUIRED_IDS = ['amiri-quran', 'planck-pr3-smica', 'threejs', 'intl-messageformat', 'quran-foundation-api'];

const PLANCK_CREDIT = 'ESA and the Planck Collaboration';

const REVIEW_AREAS = new Set(['scripture', 'tafsir', 'hadith', 'science', 'accessibility']);

function sourceProblems(entry: unknown, index: number): string[] {
  const label = `sources[${index}]${isRecord(entry) && typeof entry.id === 'string' ? ` (${entry.id})` : ''}`;
  const problems = checkFields(
    entry,
    {
      id: 'nonempty',
      kind: 'nonempty',
      title: 'nonempty',
      author: 'nonempty|null',
      url: 'nonempty',
      version: 'nonempty|null',
      license: 'nonempty',
      licenseUrl: 'nonempty|null',
      credit: 'nonempty',
      notes: 'string|null',
      review: 'object',
      'review.reviewer': 'nonempty|null',
      'review.role': 'nonempty|null',
      'review.date': 'nonempty|null',
    },
    label,
  );
  if (!isRecord(entry)) return problems;
  if (typeof entry.kind === 'string' && !KINDS.includes(entry.kind as SourceKind)) problems.push(`${label}: unknown kind "${entry.kind}"`);
  if (entry.verseKeys !== undefined) {
    const keys: unknown = entry.verseKeys;
    if (!Array.isArray(keys) || !(keys as unknown[]).every((k) => typeof k === 'string' && isVerseKey(k))) {
      problems.push(`${label}: verseKeys must be an array of "surah:ayah" keys`);
    }
  }
  if (entry.hadithIds !== undefined) {
    const ids: unknown = entry.hadithIds;
    if (!Array.isArray(ids) || !(ids as unknown[]).every((k) => typeof k === 'string' && k !== '')) {
      problems.push(`${label}: hadithIds must be an array of ids`);
    }
  }
  if (entry.kind === 'hadith-collection' && entry.hadithIds === undefined) problems.push(`${label}: hadith-collection needs hadithIds`);
  return problems;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  return sa.size === new Set(b).size && b.every((x) => sa.has(x));
}

function coverageProblems(ctx: ValidationContext, sources: readonly SourceEntry[]): string[] {
  const problems: string[] = [];
  const byId = new Map(sources.map((s) => [s.id, s]));
  for (const id of [...TANZIL_FILES.map((f) => f.sourceId), ...REQUIRED_IDS]) {
    if (!byId.has(id)) problems.push(`required source "${id}" is missing`);
  }
  if (ctx.quran.status === 'ok') {
    const quranKeys = ctx.quran.value.ayat.map((a) => a.key);
    for (const file of TANZIL_FILES) {
      const entry = byId.get(file.sourceId);
      if (entry && !sameSet(entry.verseKeys ?? [], quranKeys)) {
        problems.push(`${file.sourceId}: verseKeys must equal the ${quranKeys.length} keys in data/quran.json (run npm run fetch:quran)`);
      }
    }
    const used = new Set(ctx.quran.value.ayat.flatMap((a) => [a.source.arabic, a.source.translit, a.source.translation]));
    for (const id of used) if (!byId.has(id)) problems.push(`quran.json refers to unknown source "${id}"`);
  }
  const planck = byId.get('planck-pr3-smica');
  if (planck && planck.credit !== PLANCK_CREDIT) problems.push(`planck-pr3-smica: credit must be "${PLANCK_CREDIT}"`);

  const collections = sources.filter((s) => s.kind === 'hadith-collection');
  const listed = collections.flatMap((s) => s.hadithIds ?? []);
  problems.push(...duplicates(listed).map((id) => `hadith id ${id} is listed by more than one collection`));
  for (const key of citedSunnahKeys(ctx.citations)) {
    const id = hadithIdFor(key);
    const collection = collections.find((s) => (s.hadithIds ?? []).includes(id));
    if (!collection) problems.push(`cited hadith ${key} (id ${id}) is not in any hadith-collection hadithIds`);
    else if (!collection.url.startsWith(`https://sunnah.com/${key.split(':')[0] ?? ''}`)) {
      problems.push(`${collection.id}: url should be the sunnah.com page of the collection for ${key}`);
    }
  }
  if (ctx.hadith.status === 'ok' && Array.isArray(ctx.hadith.value.hadith)) {
    for (const h of ctx.hadith.value.hadith) {
      if (isRecord(h) && typeof h.id === 'string' && !listed.includes(h.id)) problems.push(`hadith.json id ${h.id} is not in any hadith-collection hadithIds`);
    }
  }
  return problems;
}

function reviewProblems(reviews: unknown): string[] {
  if (!Array.isArray(reviews)) return ['reviews must be an array'];
  return (reviews as unknown[]).flatMap((r, i) => {
    const problems = checkFields(r, { area: 'nonempty', reviewer: 'nonempty', role: 'nonempty', date: 'nonempty', notes: 'string|null' }, `reviews[${i}]`);
    if (isRecord(r) && typeof r.area === 'string' && !REVIEW_AREAS.has(r.area)) problems.push(`reviews[${i}]: unknown area "${r.area}"`);
    return problems;
  });
}

export function checkSources(ctx: ValidationContext, log: RuleLog): void {
  const missing = unavailable(ctx.sources, 'data builder');
  if (missing || ctx.sources.status !== 'ok') {
    log.fail(missing ?? 'data/sources.json unavailable');
    return;
  }
  const file: unknown = ctx.sources.value;
  const shape = checkFields(file, { disclaimer: 'string', sources: 'array', reviews: 'array' }, 'data/sources.json');
  if (shape.length > 0) {
    for (const p of shape) log.fail(p);
    return;
  }
  const { disclaimer, sources: raw, reviews } = ctx.sources.value;

  if (disclaimer === ctx.specDisclaimer) log.pass('disclaimer equals docs/SPEC.md section 1.7 exactly');
  else log.fail('disclaimer differs from docs/SPEC.md section 1.7');
  if (ctx.i18n.en.status === 'missing') {
    log.skip('src/i18n/en.json not written yet: ui.disclaimer comparison skipped (owner: ui builder)');
  } else {
    const ui = ctx.i18n.en.file.messages.get('ui.disclaimer');
    if (ui === disclaimer) log.pass('ui.disclaimer in src/i18n/en.json equals the disclaimer');
    else log.fail(`ui.disclaimer in src/i18n/en.json ${ui === undefined ? 'is missing' : 'differs from the spec disclaimer'} (owner: ui builder)`);
  }

  const entries: unknown[] = raw;
  log.expectNone(entries.flatMap((e, i) => sourceProblems(e, i)), `${entries.length} source(s) have every required SourceEntry field`);
  const sources = entries.filter((e): e is SourceEntry => isRecord(e) && typeof e.id === 'string');
  log.expectNone(duplicates(sources.map((s) => s.id)).map((id) => `duplicate source id ${id}`), 'source ids are unique');
  log.expectNone(coverageProblems(ctx, sources), 'sources cover quran.json, the cited hadith collections and the required software, font, data and API entries');
  log.expectNone(reviewProblems(reviews), `reviews: ${Array.isArray(reviews) ? reviews.length : 0} recorded`);
}
