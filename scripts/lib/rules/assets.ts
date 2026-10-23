/** Rule j: generated assets exist and agree with the data they were generated from. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { arabicWords } from '../arabic';
import { calligraphyCitations, type CalligraphyCitation } from '../citations';
import { deriveAnalysis, type AnalysisSpec } from '../analysis';
import type { ValidationContext } from '../context';
import { fileExists, loadJson, readBytes, relPath, rootPath } from '../files';
import type { RuleLog } from '../report';
import { checkFields, isRecord } from '../shape';
import { describeCodePoints, nfc, sha256Hex } from '../text';

const CALLIGRAPHY_OWNER = 'calligraphy builder, npm run preprocess:calligraphy';
const CMB_OWNER = 'cmb builder, npm run preprocess:cmb';
const PLANCK_CREDIT = 'ESA and the Planck Collaboration';
const SDSS_OWNER = 'SDSS builder, npm run preprocess:sdss';
/** Bytes per galaxy in galaxies.bin: four int16 values (x, y, z, redshift). */
const SDSS_STRIDE = 8;

/** The word (or the phrase of `wordCount` words from it) a calligraphy entry must show, from the NFC Tanzil text in quran.json. */
export function expectedWord(arabic: string, wordIndexFromEnd: number, wordCount = 1): string | null {
  const words = arabicWords(nfc(arabic));
  const start = words.length - wordIndexFromEnd;
  if (start < 0 || start + wordCount > words.length) return null;
  return words.slice(start, start + wordCount).join(' ');
}

function checkCalligraphy(ctx: ValidationContext, entry: CalligraphyCitation, log: RuleLog): void {
  const dir = rootPath('public', 'assets', 'calligraphy');
  const loaded = loadJson<unknown>(join(dir, `${entry.id}.json`));
  const path = relPath(loaded.path);
  if (loaded.status !== 'ok') {
    log.fail(`${path} ${loaded.status === 'missing' ? 'is missing' : `is invalid: ${loaded.error}`} (owner: ${CALLIGRAPHY_OWNER})`);
    return;
  }
  const meta = loaded.value;
  const problems = checkFields(
    meta,
    { id: 'nonempty', text: 'nonempty', verse: 'nonempty', wordIndexFromEnd: 'number', font: 'nonempty', fontSha256: 'nonempty', atlas: 'nonempty', pxRange: 'number', aspect: 'number', bounds: 'object', type: 'nonempty' },
    path,
  );
  if (!isRecord(meta) || problems.length > 0) {
    for (const p of problems) log.fail(`${p} (owner: ${CALLIGRAPHY_OWNER})`);
    return;
  }
  if (meta.id !== entry.id || meta.verse !== entry.verse || meta.wordIndexFromEnd !== entry.wordIndexFromEnd) {
    problems.push(`${path}: id/verse/wordIndexFromEnd must be ${entry.id}/${entry.verse}/${entry.wordIndexFromEnd} as in data/citations.json`);
  }
  const verse = ctx.quran.status === 'ok' ? ctx.quran.value.ayat.find((a) => a.key === entry.verse) : undefined;
  const expected = verse ? expectedWord(verse.arabic, entry.wordIndexFromEnd, entry.wordCount ?? 1) : null;
  if (expected === null) problems.push(`${path}: cannot find word ${entry.wordIndexFromEnd} from the end of ${entry.verse} in quran.json`);
  else if (meta.text !== expected) {
    problems.push(`${path}: text (${describeCodePoints(String(meta.text))}) is not the Tanzil word (${describeCodePoints(expected)})`);
  }
  const atlas = join(dir, String(meta.atlas));
  if (!fileExists(atlas)) problems.push(`${relPath(atlas)} (atlas) is missing`);
  if (problems.length > 0) for (const p of problems) log.fail(`${p} (owner: ${CALLIGRAPHY_OWNER})`);
  else log.pass(`${path}: word ${entry.wordIndexFromEnd} from the end of ${entry.verse} matches quran.json; atlas present`);
}

function checkFont(log: RuleLog): void {
  const font = rootPath('public', 'fonts', 'AmiriQuran.woff2');
  if (fileExists(font)) log.pass(`${relPath(font)} present`);
  else log.fail(`${relPath(font)} is missing (owner: calligraphy builder, scripts/fetch-font.ts)`);
}

function checkCmb(log: RuleLog): void {
  const dir = rootPath('public', 'assets', 'cmb');
  const loaded = loadJson<unknown>(join(dir, 'cmb.json'));
  const path = relPath(loaded.path);
  if (loaded.status !== 'ok') {
    log.fail(`${path} ${loaded.status === 'missing' ? 'is missing' : `is invalid: ${loaded.error}`} (owner: ${CMB_OWNER})`);
    return;
  }
  const meta = loaded.value;
  const problems = checkFields(meta, { credit: 'nonempty', files: 'object' }, path);
  if (isRecord(meta) && meta.credit !== PLANCK_CREDIT) problems.push(`${path}: credit must be "${PLANCK_CREDIT}"`);
  const files = isRecord(meta) && isRecord(meta.files) ? Object.values(meta.files) : [];
  if (files.length === 0) problems.push(`${path}: lists no texture files`);
  for (const f of files) {
    if (typeof f !== 'string' || !fileExists(join(dir, f))) problems.push(`${path}: listed file ${String(f)} is missing`);
  }
  if (problems.length > 0) for (const p of problems) log.fail(`${p} (owner: ${CMB_OWNER})`);
  else log.pass(`${path}: credit "${PLANCK_CREDIT}", ${files.length} listed texture file(s) present`);
}

/** The SDSS galaxy sample: its binary matches the manifest (size and hash), and the panel's count matches both. */
function checkSdss(ctx: ValidationContext, log: RuleLog): void {
  const dir = rootPath('public', 'assets', 'sdss');
  const loaded = loadJson<unknown>(join(dir, 'galaxies.json'));
  const path = relPath(loaded.path);
  if (loaded.status !== 'ok') {
    log.fail(`${path} ${loaded.status === 'missing' ? 'is missing' : `is invalid: ${loaded.error}`} (owner: ${SDSS_OWNER})`);
    return;
  }
  const meta = loaded.value;
  const problems = checkFields(
    meta,
    { file: 'nonempty', count: 'number', scaleMpc: 'number', redshiftScale: 'number', nearLimit: 'number', sha256: 'nonempty', credit: 'nonempty' },
    path,
  );
  if (!isRecord(meta) || problems.length > 0) {
    for (const p of problems) log.fail(`${p} (owner: ${SDSS_OWNER})`);
    return;
  }
  const binary = join(dir, String(meta.file));
  if (!fileExists(binary)) problems.push(`${relPath(binary)} is missing`);
  else {
    const bytes = readBytes(binary);
    if (bytes.byteLength !== Number(meta.count) * SDSS_STRIDE) {
      problems.push(`${relPath(binary)}: ${bytes.byteLength} bytes, expected ${Number(meta.count) * SDSS_STRIDE} for ${String(meta.count)} galaxies`);
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== meta.sha256) problems.push(`${relPath(binary)}: sha256 ${hash} does not match the manifest`);
  }
  const constant = ctx.constants.status === 'ok' ? ctx.constants.value.constants.find((c) => c.id === 'sdss.sample.count') : undefined;
  if (!constant) problems.push('data/constants.json: no sdss.sample.count');
  else if (constant.value !== meta.count) problems.push(`data/constants.json: sdss.sample.count is ${String(constant.value)}, the sample holds ${String(meta.count)}`);
  if (problems.length > 0) for (const p of problems) log.fail(`${p} (owner: ${SDSS_OWNER})`);
  else log.pass(`${path}: ${String(meta.count)} galaxies; binary size and sha256 match; sdss.sample.count agrees`);
}

/** Letter analyses: each asset must equal what scripts/build-analysis.ts derives from the verified text now. */
function checkAnalyses(ctx: ValidationContext, log: RuleLog): void {
  const citations = loadJson<{ analysis?: Record<string, AnalysisSpec | string> }>(rootPath('data', 'citations.json'));
  if (citations.status !== 'ok' || ctx.quran.status !== 'ok') return;
  const ayat = ctx.quran.value.ayat;
  for (const [id, spec] of Object.entries(citations.value.analysis ?? {})) {
    if (typeof spec === 'string') continue;
    const loaded = loadJson<unknown>(rootPath('public', 'assets', 'analysis', `${id}.json`));
    const path = relPath(loaded.path);
    if (loaded.status !== 'ok') {
      log.fail(`${path} ${loaded.status === 'missing' ? 'is missing' : `is invalid: ${loaded.error}`} (owner: analysis builder, npm run preprocess:analysis)`);
      continue;
    }
    try {
      const expected = deriveAnalysis(id, spec, (key) => ayat.find((a) => a.key === key)?.arabic, sha256Hex);
      if (JSON.stringify(expected) !== JSON.stringify(loaded.value)) log.fail(`${path} differs from what data/quran.json gives now; rerun npm run preprocess:analysis`);
      else log.pass(`${path}: re-derived from data/quran.json (${expected.letters.length} base letters, the same in both directions, verses ${expected.verses.map((v) => v.key).join(' and ')})`);
    } catch (error) {
      log.fail(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function checkAssets(ctx: ValidationContext, log: RuleLog): void {
  for (const entry of calligraphyCitations(ctx.citations)) checkCalligraphy(ctx, entry, log);
  checkFont(log);
  checkCmb(log);
  checkSdss(ctx, log);
  checkAnalyses(ctx, log);
}
