/**
 * Rule l: the assistant's knowledge index (public/assets/ai/index.json) is what the sources say,
 * and nothing the project withholds. It must exist and equal a fresh build from the files on disk
 * (scripts/build-ai-index.ts), byte for byte; hold no Arabic script (bar the honorific U+FDFA,
 * allowed as in the message files) and no transliteration; never name an excluded narration (read
 * from data/hadith.json's own list) nor any hadith's wording; give every verse exactly its
 * data/quran.json translation; and point only at message keys that exist.
 */
import { AI_INDEX_FILE, PASSAGE_KINDS, serialiseAiIndex, type AiIndexFile } from '../../../src/ai/knowledge/build';
import type { Passage } from '../../../src/ai/types';
import { buildAiIndexFromDisk } from '../../build-ai-index';
import { findArabic, SALAWAT_LIGATURE } from '../arabic';
import type { ValidationContext } from '../context';
import { fileExists, readText, rootPath } from '../files';
import type { RuleLog } from '../report';
import { hadithIdFor, mentionPattern } from './hadith';

const KNOWLEDGE = new Set(['observed', 'model', 'simulation', 'scripture', 'explanation']);

function describe(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function messageKeys(ctx: ValidationContext): Set<string> {
  const keys = new Set<string>();
  for (const load of Object.values(ctx.i18n).flat()) {
    if (load.status !== 'ok') continue;
    for (const key of load.file.messages.keys()) keys.add(key);
  }
  return keys;
}

export function checkAiIndex(ctx: ValidationContext, log: RuleLog): void {
  const path = rootPath(AI_INDEX_FILE);
  if (!fileExists(path)) {
    log.fail(`${AI_INDEX_FILE} is missing: run npm run preprocess:ai`);
    return;
  }
  const text = readText(path);
  let index: AiIndexFile;
  try {
    index = JSON.parse(text) as AiIndexFile;
  } catch (err) {
    log.fail(`${AI_INDEX_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const passages: Passage[] = Array.isArray(index.passages) ? index.passages : [];

  // A fresh build from what is on disk now.
  const fresh = buildAiIndexFromDisk();
  const freshText = serialiseAiIndex(fresh);
  if (freshText === text) log.pass(`${AI_INDEX_FILE} equals a fresh build (${fresh.passages.length} passages)`);
  else {
    const byId = new Map(passages.map((p) => [p.id, JSON.stringify(p)]));
    const changed = fresh.passages.find((p) => byId.get(p.id) !== JSON.stringify(p))?.id ?? passages.find((p) => !fresh.passages.some((f) => f.id === p.id))?.id;
    log.fail(`${AI_INDEX_FILE} differs from a fresh build${changed ? ` (first at ${changed})` : ''}: run npm run preprocess:ai`);
  }

  const shape: string[] = [];
  const ids = new Set<string>();
  for (const p of passages) {
    const raw = p as unknown as Record<string, unknown>;
    if (typeof raw.id !== 'string' || ids.has(p.id)) shape.push(`passage ${describe(raw.id)}: id missing or repeated`);
    ids.add(p.id);
    if (!PASSAGE_KINDS.includes(p.kind)) shape.push(`${p.id}: unknown kind ${describe(raw.kind)}`);
    if (!KNOWLEDGE.has(p.knowledge)) shape.push(`${p.id}: unknown knowledge kind ${describe(raw.knowledge)}`);
    if (typeof p.title !== 'string' || typeof p.text !== 'string' || p.text.length === 0) shape.push(`${p.id}: title and text must be non-empty strings`);
  }
  log.expectNone(shape, `${passages.length} passages have unique ids, known kinds and text`);

  const arabic = findArabic(text).filter((h) => h.codePoint !== SALAWAT_LIGATURE);
  log.expectNone(
    arabic.slice(0, 10).map((h) => `${AI_INDEX_FILE}:${h.line}:${h.column}: Arabic code point U+${h.codePoint.toString(16).toUpperCase()}`),
    'no Arabic script in the index (the honorific U+FDFA aside)',
  );

  const withheld: string[] = [];
  if (ctx.quran.status === 'ok') {
    for (const ayah of ctx.quran.value.ayat) {
      if (ayah.translit.length >= 20 && text.includes(JSON.stringify(ayah.translit).slice(1, -1))) withheld.push(`${ayah.key}: its transliteration appears in the index`);
    }
  }
  if (ctx.hadith.status === 'ok') {
    for (const entry of ctx.hadith.value.hadith) {
      for (const wording of [entry.text.en, entry.text.ar]) {
        if (wording && wording.length >= 20 && text.includes(JSON.stringify(wording).slice(1, -1).slice(0, 80))) withheld.push(`${entry.id}: its wording appears in the index`);
      }
    }
    for (const { sunnahKey } of ctx.hadith.value.excluded) {
      const re = mentionPattern(sunnahKey);
      if (re && re.test(text)) withheld.push(`the index mentions an excluded narration (${sunnahKey})`);
      if (ids.has(`hadith:${hadithIdFor(sunnahKey)}`)) withheld.push(`the index has a passage for an excluded narration (${sunnahKey})`);
    }
  } else log.fail('data/hadith.json is unavailable, so excluded narrations cannot be checked');
  log.expectNone(withheld, 'no transliteration, no hadith wording and no excluded narration in the index');

  const verses: string[] = [];
  if (ctx.quran.status === 'ok') {
    const byKey = new Map(ctx.quran.value.ayat.map((a) => [a.key as string, a.translation]));
    for (const p of passages.filter((x) => x.kind === 'verse')) {
      const translation = p.ref ? byKey.get(p.ref) : undefined;
      if (translation === undefined) verses.push(`${p.id}: no such verse in data/quran.json`);
      else if (p.text !== translation) verses.push(`${p.id}: text differs from its data/quran.json translation`);
      if (p.id !== `verse:${p.ref ?? ''}`) verses.push(`${p.id}: id and ref disagree`);
    }
    for (const key of byKey.keys()) if (!ids.has(`verse:${key}`)) verses.push(`verse ${key} has no passage`);
  } else verses.push('data/quran.json is unavailable');
  log.expectNone(verses, 'every verse passage is exactly its data/quran.json translation');

  const keys = messageKeys(ctx);
  const missing = passages.filter((p) => p.key !== undefined && !keys.has(p.key)).map((p) => `${p.id}: message key ${p.key ?? ''} is not defined`);
  log.expectNone(missing, `${passages.filter((p) => p.key !== undefined).length} message key reference(s) in the index are defined`);
}
