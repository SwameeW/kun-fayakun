/** Rule a: pinned Tanzil files match their pins, and data/quran.json matches them exactly. */
import type { QuranEntry, QuranFile } from '../../../src/core/types';
import { PINS } from '../../fetch-quran';
import { citedVerseKeys } from '../citations';
import { unavailable, type ValidationContext } from '../context';
import { fileExists, readBytes, relPath } from '../files';
import { toRawTanzil, type RawTanzil } from '../quran-build';
import type { RuleLog } from '../report';
import { duplicates } from '../shape';
import { TANZIL_FILES, TANZIL_URL, TRANSLATION_ID, stripTranslitMarkup, tanzilPath, tanzilVersion } from '../tanzil';
import { codePoints, describeCodePoints, nfc, sha256Hex } from '../text';
import { parseVerseKey } from '../verse-key';

/** Pinned files that exist and match their pins; a field is checked only when its file is trustworthy. */
type Roles = Partial<Record<'arabic' | 'translation' | 'translit', RawTanzil>>;

function loadPinnedFiles(log: RuleLog): Roles {
  const found: Roles = {};
  for (const file of TANZIL_FILES) {
    const path = tanzilPath(file);
    if (!fileExists(path)) {
      log.fail(`${relPath(path)} is missing (run npm run fetch:quran)`);
      continue;
    }
    const bytes = readBytes(path);
    const pin = PINS[file.id];
    const sha = sha256Hex(bytes);
    if (sha !== pin.sha256 || bytes.byteLength !== pin.bytes) {
      log.fail(`${relPath(path)}: sha256 ${sha} (${bytes.byteLength} bytes) does not match pin ${pin.sha256} (${pin.bytes} bytes)`);
      continue;
    }
    try {
      found[file.role] = toRawTanzil(file, bytes);
      log.pass(`${relPath(path)} matches its pin (sha256 ${sha.slice(0, 16)}..., ${bytes.byteLength} bytes)`);
    } catch (err) {
      log.fail(`${relPath(path)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return found;
}

function firstDifference(a: string, b: string): string {
  const ca = codePoints(a);
  const cb = codePoints(b);
  const i = ca.findIndex((ch, idx) => ch !== cb[idx]);
  const at = i === -1 ? Math.min(ca.length, cb.length) : i;
  return `first difference at code point ${at}: ${describeCodePoints(ca.slice(at, at + 4).join(''))} vs ${describeCodePoints(cb.slice(at, at + 4).join(''))}`;
}

function arabicProblems(entry: QuranEntry, arabic: RawTanzil): string[] {
  const key = entry.key;
  const rawArabic = arabic.parsed.lines.get(key);
  if (rawArabic === undefined) return [`${key}: not found in the pinned Tanzil file`];
  const problems: string[] = [];
  const expected = nfc(rawArabic);
  if (entry.arabic !== expected) {
    const equivalent = entry.arabic.normalize('NFD') === rawArabic.normalize('NFD');
    problems.push(
      `${key}: arabic is not NFC(pinned line)${equivalent ? ' (canonically equivalent but not NFC)' : ''}; ${firstDifference(entry.arabic, expected)}`,
    );
  }
  if (entry.sha256 !== sha256Hex(entry.arabic)) problems.push(`${key}: sha256 does not match the stored arabic`);
  if (entry.sha256 !== sha256Hex(expected)) problems.push(`${key}: sha256 does not match NFC(pinned line)`);
  const version = tanzilVersion(arabic.parsed.comment);
  if (entry.sourceVersion !== version) problems.push(`${key}: sourceVersion must be "${version}"`);
  return problems;
}

function translitProblem(entry: QuranEntry, translit: RawTanzil): string | null {
  const raw = translit.parsed.lines.get(entry.key);
  try {
    if (raw !== undefined && entry.translit === stripTranslitMarkup(raw)) return null;
  } catch (err) {
    return `${entry.key}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return `${entry.key}: translit differs from the pinned transliteration (markup removed)`;
}

function entryProblems(entry: QuranEntry, files: Roles): string[] {
  const problems: string[] = [];
  const key = entry.key;
  const parsed = parseVerseKey(key);
  if (!parsed || parsed.surah !== entry.surah || parsed.ayah !== entry.ayah) {
    problems.push(`${key}: key does not match surah ${entry.surah} / ayah ${entry.ayah}`);
  }
  if (files.arabic) problems.push(...arabicProblems(entry, files.arabic));
  const translit = files.translit ? translitProblem(entry, files.translit) : null;
  if (translit) problems.push(translit);
  if (files.translation && entry.translation !== files.translation.parsed.lines.get(key)) {
    problems.push(`${key}: translation differs from the pinned translation file`);
  }
  if (entry.translationId !== TRANSLATION_ID) problems.push(`${key}: translationId must be ${TRANSLATION_ID}`);
  const sources = Object.fromEntries(TANZIL_FILES.map((f) => [f.role, f.sourceId]));
  for (const [role, id] of Object.entries(sources)) {
    if (entry.source[role as keyof QuranEntry['source']] !== id) problems.push(`${key}: source.${role} must be "${id}"`);
  }
  if (!entry.license.trim()) problems.push(`${key}: license is empty`);
  if (Number.isNaN(Date.parse(entry.fetchedAt))) problems.push(`${key}: fetchedAt is not an ISO date`);
  return problems;
}

function metaProblems(quran: QuranFile, files: Roles): string[] {
  const problems: string[] = [];
  if (files.arabic && quran.meta.tanzilCopyright !== files.arabic.parsed.comment) {
    problems.push('meta.tanzilCopyright is not the verbatim copyright block of the pinned Tanzil file');
  }
  if (quran.meta.tanzilUrl !== TANZIL_URL) problems.push(`meta.tanzilUrl must be ${TANZIL_URL}`);
  for (const raw of [files.arabic, files.translation, files.translit]) {
    if (!raw) continue;
    const recorded = quran.meta.files.find((f) => f.sourceId === raw.file.sourceId);
    if (!recorded || recorded.sha256 !== raw.sha256 || recorded.bytes !== raw.bytes.byteLength || recorded.url !== raw.file.url) {
      problems.push(`meta.files entry for ${raw.file.sourceId} does not match the pinned file`);
    }
  }
  return problems;
}

export function checkScripture(ctx: ValidationContext, log: RuleLog): void {
  const files = loadPinnedFiles(log);
  const missing = unavailable(ctx.quran, 'data builder, npm run fetch:quran');
  if (missing) log.fail(missing);
  if (ctx.quran.status !== 'ok') return;

  const quran = ctx.quran.value;
  const unchecked = TANZIL_FILES.filter((f) => !files[f.role]).map((f) => f.role);
  if (unchecked.length > 0) log.fail(`not checked against an unpinned or missing file: ${unchecked.join(', ')}`);
  log.expectNone(metaProblems(quran, files), 'quran.json meta: verbatim Tanzil copyright block, tanzil.net link, file hashes match pins');

  const problems = quran.ayat.flatMap((entry) => entryProblems(entry, files));
  log.expectNone(
    problems,
    `${quran.ayat.length} ayat: arabic === NFC(pinned Tanzil line), sha256 matches, translit and translation match their pinned files`,
  );

  const keys = quran.ayat.map((a) => a.key);
  const present = new Set<string>(keys);
  const cited = citedVerseKeys(ctx.citations);
  const coverage = [
    ...duplicates(keys).map((k) => `${k}: appears more than once in quran.json`),
    ...cited.filter((k) => !present.has(k)).map((k) => `${k}: listed in data/citations.json but missing from quran.json`),
    ...keys.filter((k) => !cited.includes(k)).map((k) => `${k}: in quran.json but not listed in data/citations.json`),
  ];
  log.expectNone(coverage, `quran.json holds exactly the ${cited.length} verse keys listed in data/citations.json`);

  const rawLines = files.arabic?.parsed.lines;
  const normalised = rawLines ? quran.ayat.filter((a) => rawLines.get(a.key) !== a.arabic).length : 0;
  if (normalised > 0) {
    log.warn(
      `${normalised} of ${quran.ayat.length} ayat differ from the raw Tanzil bytes because of NFC (mark reordering, alef+madda composition); ` +
        'they are canonically equivalent to the Tanzil text',
    );
  }

  // The plain-words explanations (en.plain.json "plain.<key>"): one for every verse, and none for a verse that is not there.
  const plain = ctx.i18n.plain.status === 'ok' ? [...ctx.i18n.plain.file.messages.keys()].filter((k) => k.startsWith('plain.')).map((k) => k.slice('plain.'.length)) : [];
  const explained = new Set(plain);
  log.expectNone(
    [
      ...plain.filter((k) => !present.has(k)).map((k) => `en.plain.json plain.${k}: no such verse in quran.json`),
      ...keys.filter((k) => !explained.has(k)).map((k) => `${k}: has no plain-words explanation (en.plain.json plain.${k})`),
    ],
    `every one of the ${keys.length} verses has a plain-words explanation, and every explanation names a verse in quran.json`,
  );
}
