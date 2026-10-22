/**
 * Loading budget (spec section 4): the shell plus Chapter 0 must stay under
 * 1.5 MB gzipped. Run after `vite build`:
 *
 *   npx tsx scripts/check-bundle.ts [distDir]
 *
 * Counted, each file once, gzipped at level 9:
 * - shell: index.html, every entry chunk and its static imports (JS, CSS, assets)
 * - ch00: the Chapter 0 dynamic chunk and its static imports
 * - data: data/*.json, the Arabic font, the kun calligraphy assets and
 *   assets/cmb/cmb.json (the UI's CMB legend fetches it at startup)
 * Exits 1 above the budget or when anything it must count is missing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** One entry of dist/.vite/manifest.json (Vite build manifest). */
interface ManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
}
type Manifest = Record<string, ManifestChunk>;

type Group = 'shell' | 'ch00' | 'data';

interface Row {
  group: Group;
  file: string;
  raw: number;
  gzip: number;
}

const BUDGET_BYTES = 1_500_000;
const CH00_SOURCE = 'src/chapters/ch00/scene.ts';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = resolve(process.argv[2] ?? join(ROOT, 'dist'));

/** Collects a chunk's file, CSS and assets, then follows its static imports. */
function collectChunk(manifest: Manifest, key: string, group: Group, files: Map<string, Group>): void {
  const chunk = manifest[key];
  if (!chunk) throw new Error(`manifest has no chunk "${key}"`);
  if (files.has(chunk.file)) return;
  files.set(chunk.file, group);
  for (const file of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
    if (!files.has(file)) files.set(file, group);
  }
  for (const imported of chunk.imports ?? []) collectChunk(manifest, imported, group, files);
}

function listDir(relativeDir: string, filter: (name: string) => boolean): string[] {
  const dir = join(DIST, relativeDir);
  if (!existsSync(dir)) throw new Error(`dist/${relativeDir} is missing`);
  return readdirSync(dir)
    .filter((name) => filter(name) && statSync(join(dir, name)).isFile())
    .map((name) => `${relativeDir}/${name}`);
}

function budgetFiles(manifest: Manifest): Map<string, Group> {
  const files = new Map<string, Group>([['index.html', 'shell']]);
  const entries = Object.keys(manifest).filter((key) => manifest[key]?.isEntry === true);
  if (entries.length === 0) throw new Error('manifest has no entry chunk');
  for (const key of entries) collectChunk(manifest, key, 'shell', files);

  const ch00 = Object.keys(manifest).find(
    (key) => key === CH00_SOURCE || manifest[key]?.src === CH00_SOURCE,
  );
  if (!ch00) throw new Error(`manifest has no chunk for ${CH00_SOURCE}`);
  collectChunk(manifest, ch00, 'ch00', files);

  const data = [
    ...listDir('data', (name) => name.endsWith('.json')),
    'fonts/AmiriQuran.woff2',
    ...listDir('assets/calligraphy', () => true),
    // Fetched by src/ui/figures.ts (CMB legend) when the UI mounts, on every route.
    'assets/cmb/cmb.json',
  ];
  for (const file of data) if (!files.has(file)) files.set(file, 'data');
  return files;
}

function measure(files: Map<string, Group>): Row[] {
  return [...files].map(([file, group]) => {
    const path = join(DIST, file);
    if (!existsSync(path)) throw new Error(`dist/${file} is missing`);
    const bytes = readFileSync(path);
    return { group, file, raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
  });
}

const formatBytes = (n: number): string => n.toLocaleString('en-US');

function printTable(rows: Row[]): number {
  const sorted = [...rows].sort((a, b) => a.group.localeCompare(b.group) || b.gzip - a.gzip);
  const width = Math.max(4, ...sorted.map((row) => row.file.length));
  const line = (group: string, file: string, raw: string, gzip: string): string =>
    `${group.padEnd(6)}  ${file.padEnd(width)}  ${raw.padStart(11)}  ${gzip.padStart(11)}`;
  console.log(line('group', 'file', 'raw bytes', 'gzip bytes'));
  console.log('-'.repeat(width + 34));
  for (const row of sorted) console.log(line(row.group, row.file, formatBytes(row.raw), formatBytes(row.gzip)));
  console.log('-'.repeat(width + 34));
  for (const group of ['shell', 'ch00', 'data'] as const) {
    const inGroup = rows.filter((row) => row.group === group);
    const raw = inGroup.reduce((sum, row) => sum + row.raw, 0);
    const gzip = inGroup.reduce((sum, row) => sum + row.gzip, 0);
    console.log(line(group, `(${inGroup.length} files)`, formatBytes(raw), formatBytes(gzip)));
  }
  const total = rows.reduce((sum, row) => sum + row.gzip, 0);
  const rawTotal = rows.reduce((sum, row) => sum + row.raw, 0);
  console.log(line('total', '', formatBytes(rawTotal), formatBytes(total)));
  return total;
}

function main(): void {
  const manifestPath = join(DIST, '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`${manifestPath} not found: run \`npx vite build\` first`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const total = printTable(measure(budgetFiles(manifest)));
  const verdict = total <= BUDGET_BYTES ? 'PASS' : 'FAIL';
  console.log(`\n${verdict}: shell + Chapter 0 = ${formatBytes(total)} bytes gzipped (budget ${formatBytes(BUDGET_BYTES)})`);
  if (total > BUDGET_BYTES) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`check-bundle: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
