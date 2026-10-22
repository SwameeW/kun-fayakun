/**
 * npm run fetch:quran [-- --update-pins | --offline]
 *
 * Downloads the Tanzil Uthmani text, the Pickthall translation and the Tanzil
 * transliteration, checks each file against PINS, saves them verbatim to
 * data/tanzil/, and extracts exactly the ayat listed in data/citations.json
 * into data/quran.json. It also keeps the verseKeys of the three Tanzil
 * entries in data/sources.json in step with quran.json.
 *
 *   (default)      download, fail on any pin mismatch, write outputs
 *   --update-pins  download, rewrite PINS in this file deliberately, write outputs
 *   --offline      rebuild quran.json from data/tanzil/ (still checked against PINS)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QuranFile, SourcesFile, VerseKey } from '../src/core/types';
import { citedVerseKeys, loadCitations } from './lib/citations';
import { fileExists, readBytes, readJson, relPath, rootPath, writeJson } from './lib/files';
import { fetchBytes } from './lib/net';
import { buildQuranFile, toRawTanzil, type RawTanzil } from './lib/quran-build';
import { TANZIL_FILES, tanzilFile, tanzilPath, type TanzilFileId } from './lib/tanzil';

export interface Pin {
  sha256: string;
  bytes: number;
}

// PINS:BEGIN (rewritten only by `npm run fetch:quran -- --update-pins`)
export const PINS: Readonly<Record<TanzilFileId, Pin>> = {
  'quran-uthmani': { sha256: '6933e133dd56db778c801bf738848454e43648105a151e8d84d86a7cae39ec5f', bytes: 1396087 },
  'en.pickthall': { sha256: '4aabbfa9d96796f5a6b0217d2c39dce1a3084f772bf6f2650e37082a774e3cc7', bytes: 864918 },
  'en.transliteration': { sha256: '8c20d95e484534e921cd2e0d2546aab7f5300090c0bd76697095b3ca1db1e01d', bytes: 1044894 },
};
// PINS:END

export const QURAN_PATH = rootPath('data', 'quran.json');
const SOURCES_PATH = rootPath('data', 'sources.json');

type Mode = 'verify' | 'update-pins' | 'offline';

function parseMode(args: readonly string[]): Mode {
  const known = new Map<string, Mode>([
    ['--update-pins', 'update-pins'],
    ['--offline', 'offline'],
  ]);
  const modes = args.map((arg) => {
    const mode = known.get(arg);
    if (!mode) throw new Error(`Unknown argument ${arg}. Usage: fetch-quran [--update-pins | --offline]`);
    return mode;
  });
  if (modes.length > 1) throw new Error('Pass at most one of --update-pins, --offline');
  return modes[0] ?? 'verify';
}

function pinMismatch(raw: RawTanzil): string | null {
  const pin = PINS[raw.file.id];
  if (pin.sha256 === raw.sha256 && pin.bytes === raw.bytes.byteLength) return null;
  return `${raw.file.filename}: sha256 ${raw.sha256} (${raw.bytes.byteLength} bytes), pinned ${pin.sha256} (${pin.bytes} bytes)`;
}

function renderPins(raws: readonly RawTanzil[]): string {
  const rows = raws.map(
    (raw) => `  '${raw.file.id}': { sha256: '${raw.sha256}', bytes: ${raw.bytes.byteLength} },`,
  );
  return [
    '// PINS:BEGIN (rewritten only by `npm run fetch:quran -- --update-pins`)',
    'export const PINS: Readonly<Record<TanzilFileId, Pin>> = {',
    ...rows,
    '};',
    '// PINS:END',
  ].join('\n');
}

function rewritePins(raws: readonly RawTanzil[]): void {
  const self = fileURLToPath(import.meta.url);
  const source = readFileSync(self, 'utf8');
  const block = /\/\/ PINS:BEGIN[^\n]*\n[\s\S]*?\/\/ PINS:END/;
  if (!block.test(source)) throw new Error('PINS markers not found in fetch-quran.ts');
  writeFileSync(self, source.replace(block, renderPins(raws)), 'utf8');
}

/** Keeps the previous fetch time when rebuilding offline from the same pinned files. */
function previousFetchTimes(): Map<VerseKey, string> {
  if (!fileExists(QURAN_PATH)) return new Map();
  const previous = readJson(QURAN_PATH) as QuranFile;
  return new Map(previous.ayat.map((a) => [a.key, a.fetchedAt]));
}

function syncSourceVerseKeys(keys: readonly VerseKey[]): boolean {
  if (!fileExists(SOURCES_PATH)) return false;
  const sources = readJson(SOURCES_PATH) as SourcesFile;
  const ids = new Set(TANZIL_FILES.map((f) => f.sourceId));
  for (const entry of sources.sources) if (ids.has(entry.id)) entry.verseKeys = [...keys];
  writeJson(SOURCES_PATH, sources);
  return true;
}

async function loadRaw(mode: Mode): Promise<RawTanzil[]> {
  const raws: RawTanzil[] = [];
  for (const file of TANZIL_FILES) {
    const bytes = mode === 'offline' ? readBytes(tanzilPath(file)) : await fetchBytes(file.url);
    raws.push(toRawTanzil(file, bytes));
    console.log(`${mode === 'offline' ? 'read' : 'downloaded'} ${file.filename} (${bytes.byteLength} bytes)`);
  }
  return raws;
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const raws = await loadRaw(mode);

  if (mode === 'update-pins') {
    rewritePins(raws);
    console.log('PINS rewritten in scripts/fetch-quran.ts. Review the diff before committing.');
  } else {
    const mismatches = raws.map(pinMismatch).filter((m): m is string => m !== null);
    if (mismatches.length > 0) {
      for (const m of mismatches) console.error(`PIN MISMATCH ${m}`);
      console.error('Nothing was written. If Tanzil changed the files on purpose, review them and run with --update-pins.');
      process.exitCode = 1;
      return;
    }
    console.log('all files match PINS');
  }

  if (mode !== 'offline') {
    mkdirSync(dirname(tanzilPath(tanzilFile('arabic'))), { recursive: true });
    for (const raw of raws) writeFileSync(tanzilPath(raw.file), raw.bytes);
  }

  const byRole = (role: 'arabic' | 'translation' | 'translit'): RawTanzil => {
    const raw = raws.find((r) => r.file.role === role);
    if (!raw) throw new Error(`missing ${role} file`);
    return raw;
  };
  const keys = citedVerseKeys(loadCitations());
  const now = new Date().toISOString();
  const previous = mode === 'offline' ? previousFetchTimes() : new Map<VerseKey, string>();
  const quran = buildQuranFile({
    arabic: byRole('arabic'),
    translation: byRole('translation'),
    translit: byRole('translit'),
    keys,
    fetchedAt: (key) => previous.get(key) ?? now,
    generatedAt: now,
  });
  writeJson(QURAN_PATH, quran);

  const rawLines = byRole('arabic').parsed.lines;
  const normalised = quran.ayat.filter((a) => rawLines.get(a.key) !== a.arabic).length;
  console.log(`wrote ${relPath(QURAN_PATH)}: ${quran.ayat.length} ayat`);
  console.log(
    `NFC changed the code-point sequence of ${normalised} of ${quran.ayat.length} ayat ` +
      '(mark order and alef+madda composition only; canonically equivalent to the raw line).',
  );
  console.log(syncSourceVerseKeys(keys) ? 'updated verseKeys in data/sources.json' : 'data/sources.json not found; verseKeys not synced');
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
