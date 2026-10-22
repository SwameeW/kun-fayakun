/** Rule j: M1 assets exist and agree with the data they were generated from. */
import { join } from 'node:path';
import { arabicWords } from '../arabic';
import { calligraphyCitations, type CalligraphyCitation } from '../citations';
import type { ValidationContext } from '../context';
import { fileExists, loadJson, relPath, rootPath } from '../files';
import type { RuleLog } from '../report';
import { checkFields, isRecord } from '../shape';
import { describeCodePoints, nfc } from '../text';

const CALLIGRAPHY_OWNER = 'calligraphy builder, npm run preprocess:calligraphy';
const CMB_OWNER = 'cmb builder, npm run preprocess:cmb';
const PLANCK_CREDIT = 'ESA and the Planck Collaboration';

/** The word a calligraphy entry must show, from the NFC Tanzil text in quran.json. */
export function expectedWord(arabic: string, wordIndexFromEnd: number): string | null {
  const words = arabicWords(nfc(arabic));
  return words[words.length - wordIndexFromEnd] ?? null;
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
  const expected = verse ? expectedWord(verse.arabic, entry.wordIndexFromEnd) : null;
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

export function checkAssets(ctx: ValidationContext, log: RuleLog): void {
  for (const entry of calligraphyCitations(ctx.citations)) checkCalligraphy(ctx, entry, log);
  checkFont(log);
  checkCmb(log);
}
