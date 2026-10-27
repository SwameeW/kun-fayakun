/**
 * Loading budget (spec section 4): the shell plus Chapter 0 must stay under
 * 1.5 MB gzipped. Run after `vite build`:
 *
 *   npx tsx scripts/check-bundle.ts [distDir]
 *
 * Counted, each file once, gzipped at level 9:
 * - shell: index.html, every entry chunk and its static imports (JS, CSS, assets)
 * - ch00: the Chapter 0 dynamic chunk and its static imports
 * - data: data/*.json, the Arabic font, Chapter 0's calligraphy atlas (kun.json and the
 *   image it names) and assets/cmb/cmb.json (the UI's CMB legend fetches it at startup)
 * Exits 1 above the budget, when the shell grows more than 10 KB past its committed
 * baseline, or when anything it must count is missing.
 *
 * Also measured on its own, outside the first-visit budget: the solar-system explorer, whose
 * engine and interface chunks load only when a visitor opens it. Its code (what it adds beyond
 * the shell) must stay within 150 KB gzipped, and none of it may be in the shell. So are the parts
 * that load later still (the orbital laboratory, the qibla and new moon section, walking, photo mode,
 * the film's sound, Explore Mode's dock), each
 * against its own budget.
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

type Group = 'shell' | 'ch00' | 'data' | 'explore';

interface Row {
  group: Group;
  file: string;
  raw: number;
  gzip: number;
}

const BUDGET_BYTES = 1_500_000;
/**
 * The shell group (index.html, entry chunk and its CSS), gzipped. Everything else loads lazily,
 * so this is what every visit pays before anything else. Raise it deliberately, in the commit
 * that grows the shell on purpose. Stage 0: 320,198. Stages 3 and 4 (the explorer's host, route,
 * entry points and interface strings; the explorer itself is lazy): 327,629.
 */
const SHELL_BASELINE_BYTES = 327_629;
/** Shell growth beyond the baseline that fails the check (an accidental eager import). */
const SHELL_GROWTH_LIMIT_BYTES = 10_000;
const CH00_SOURCE = 'src/chapters/ch00/scene.ts';
/** The solar-system explorer's lazy entry points: its engine module and its interface. */
const EXPLORE_SOURCES = ['src/explore/index.ts', 'src/ui/explore/index.ts'] as const;
/** What the explorer's code may add beyond the shell, gzipped. */
const EXPLORE_BUDGET_BYTES = 150_000;
/** The orbital laboratory's lazy entry points (loaded with the first experiment): its explorer adapter, with the engine's worker, and its panel. */
const LAB_SOURCES = ['src/explore/lab.ts', 'src/ui/explore/lab-panel.ts'] as const;
/** What the laboratory may add beyond the shell and the explorer, gzipped, worker included (the brief's initial Sandbox budget). */
const LAB_BUDGET_BYTES = 250_000;
/** The qibla and the new moon's lazy entry points (loaded when their section first opens): the explorer's part and its panel. */
const ISLAMIC_SOURCES = ['src/explore/islamic/index.ts', 'src/ui/explore/islamic-panel.ts'] as const;
/** What that section may add beyond the shell and the explorer, gzipped. */
const ISLAMIC_BUDGET_BYTES = 40_000;
/** Walking on a world's ground's lazy entry points (loaded with the first walk): the walk (walker, ground, sky), its terrain tiles' reader, the Moon's and Mars's grids' reader, and the suit's readout. */
const WALK_SOURCES = ['src/explore/walk/index.ts', 'src/explore/walk/terrain.ts', 'src/explore/walk/equirect.ts', 'src/ui/explore/walk-hud.ts'] as const;
/** What walking may add beyond the shell and the explorer, gzipped. */
const WALK_BUDGET_BYTES = 30_000;
/** Photo mode's controls (loaded the first time it opens): the picture, a video, the lens, the exposure, tracking. */
const PHOTO_SOURCES = ['src/ui/explore/photo-bar.ts'] as const;
/** What photo mode's controls may add beyond the shell and the explorer, gzipped. */
const PHOTO_BUDGET_BYTES = 10_000;
/** The film's sound (loaded the first time a chapter plays with sound on): its voices and score. */
const FILM_SOUND_SOURCES = ['src/core/film-score.ts'] as const;
/** What the film's sound may add beyond the shell, gzipped. */
const FILM_SOUND_BUDGET_BYTES = 12_000;
/** Explore Mode's dock (loaded the first time a chapter is explored): its moments, process and closer looks, with their strings. */
const DISCOVER_SOURCES = ['src/ui/discover-dock.ts'] as const;
/** What the dock may add beyond the shell, gzipped. */
const DISCOVER_BUDGET_BYTES = 20_000;
/** The one calligraphy atlas Chapter 0 loads (src/chapters/ch00/scene.ts, ATLAS_META). */
const CH00_ATLAS_META = 'assets/calligraphy/kun.json';
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

/** The atlas metadata and the image it names, exactly as Chapter 0 fetches them. */
function chapter0Calligraphy(): string[] {
  const metaPath = join(DIST, CH00_ATLAS_META);
  if (!existsSync(metaPath)) throw new Error(`dist/${CH00_ATLAS_META} is missing`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { atlas?: unknown };
  if (typeof meta.atlas !== 'string' || meta.atlas === '') throw new Error(`${CH00_ATLAS_META} names no atlas image`);
  const dir = CH00_ATLAS_META.slice(0, CH00_ATLAS_META.lastIndexOf('/') + 1);
  return [CH00_ATLAS_META, `${dir}${meta.atlas}`];
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
    // Only Chapter 0's atlas: the directory also holds later chapters' atlases (Chapter 10's
    // is about 190 KB), which load with their own chapters and are not part of the first visit.
    ...chapter0Calligraphy(),
    // Fetched by src/ui/figures.ts (CMB legend) when the UI mounts, on every route.
    'assets/cmb/cmb.json',
  ];
  for (const file of data) if (!files.has(file)) files.set(file, 'data');
  return files;
}

/**
 * The explorer's chunks and their static imports that the shell does not already load (chunks
 * shared with chapters count: a visitor opening the explorer first pays for them).
 */
function exploreFiles(manifest: Manifest, shell: ReadonlySet<string>, sources: readonly string[] = EXPLORE_SOURCES): Map<string, Group> {
  const files = new Map<string, Group>([...shell].map((file) => [file, 'shell'] as const));
  for (const source of sources) {
    const key = Object.keys(manifest).find((k) => k === source || manifest[k]?.src === source);
    if (!key) throw new Error(`manifest has no chunk for ${source}`);
    if (shell.has(manifest[key]?.file ?? '')) throw new Error(`${source} is in the shell: it must load lazily`);
    collectChunk(manifest, key, 'explore', files);
  }
  return new Map([...files].filter(([, group]) => group === 'explore'));
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
  const rows = measure(budgetFiles(manifest));
  const total = printTable(rows);

  const shellRows = rows.filter((row) => row.group === 'shell');
  const shell = shellRows.reduce((sum, row) => sum + row.gzip, 0);
  const entryChunk = shellRows.filter((row) => row.file.endsWith('.js')).reduce((sum, row) => sum + row.gzip, 0);
  const growth = shell - SHELL_BASELINE_BYTES;
  const shellOk = growth <= SHELL_GROWTH_LIMIT_BYTES;
  console.log(
    `\n${shellOk ? 'PASS' : 'FAIL'}: shell = ${formatBytes(shell)} bytes gzipped (entry chunk ${formatBytes(entryChunk)}); ` +
      `baseline ${formatBytes(SHELL_BASELINE_BYTES)}, ${growth >= 0 ? '+' : ''}${formatBytes(growth)} ` +
      `(limit +${formatBytes(SHELL_GROWTH_LIMIT_BYTES)})`,
  );

  const totalOk = total <= BUDGET_BYTES;
  console.log(`${totalOk ? 'PASS' : 'FAIL'}: shell + Chapter 0 = ${formatBytes(total)} bytes gzipped (budget ${formatBytes(BUDGET_BYTES)})`);

  // The explorer, outside the first-visit total: what opening it adds.
  const shellFiles = new Set(shellRows.map((row) => row.file));
  const exploreRows = measure(exploreFiles(manifest, shellFiles));
  console.log('');
  for (const row of [...exploreRows].sort((a, b) => b.gzip - a.gzip)) {
    console.log(`explore  ${row.file}  ${formatBytes(row.raw)} raw, ${formatBytes(row.gzip)} gzip`);
  }
  const explore = exploreRows.reduce((sum, row) => sum + row.gzip, 0);
  const exploreOk = explore <= EXPLORE_BUDGET_BYTES;
  console.log(
    `${exploreOk ? 'PASS' : 'FAIL'}: solar-system explorer (lazy, ${exploreRows.length} files) = ${formatBytes(explore)} bytes gzipped (budget ${formatBytes(EXPLORE_BUDGET_BYTES)})`,
  );
  // The laboratory, beyond the shell and the explorer: what starting an experiment adds (its worker counted).
  const loaded = new Set([...shellFiles, ...exploreRows.map((row) => row.file)]);
  const labRows = measure(exploreFiles(manifest, loaded, LAB_SOURCES));
  for (const row of [...labRows].sort((a, b) => b.gzip - a.gzip)) {
    console.log(`lab      ${row.file}  ${formatBytes(row.raw)} raw, ${formatBytes(row.gzip)} gzip`);
  }
  const labBytes = labRows.reduce((sum, row) => sum + row.gzip, 0);
  const labOk = labBytes <= LAB_BUDGET_BYTES;
  console.log(`${labOk ? 'PASS' : 'FAIL'}: orbital laboratory (lazy, ${labRows.length} files) = ${formatBytes(labBytes)} bytes gzipped (budget ${formatBytes(LAB_BUDGET_BYTES)})`);
  // The qibla and the new moon, beyond the shell and the explorer: what opening their section adds.
  const islamicRows = measure(exploreFiles(manifest, loaded, ISLAMIC_SOURCES));
  for (const row of [...islamicRows].sort((a, b) => b.gzip - a.gzip)) {
    console.log(`islamic  ${row.file}  ${formatBytes(row.raw)} raw, ${formatBytes(row.gzip)} gzip`);
  }
  const islamicBytes = islamicRows.reduce((sum, row) => sum + row.gzip, 0);
  const islamicOk = islamicRows.length > 0 && islamicBytes <= ISLAMIC_BUDGET_BYTES;
  console.log(`${islamicOk ? 'PASS' : 'FAIL'}: qibla and new moon (lazy, ${islamicRows.length} files) = ${formatBytes(islamicBytes)} bytes gzipped (budget ${formatBytes(ISLAMIC_BUDGET_BYTES)})`);
  // Walking, beyond the shell and the explorer: what the first walk adds.
  const walkRows = measure(exploreFiles(manifest, loaded, WALK_SOURCES));
  for (const row of [...walkRows].sort((a, b) => b.gzip - a.gzip)) {
    console.log(`walk  ${row.file}  ${formatBytes(row.raw)} raw, ${formatBytes(row.gzip)} gzip`);
  }
  const walkBytes = walkRows.reduce((sum, row) => sum + row.gzip, 0);
  const walkOk = walkRows.length > 0 && walkBytes <= WALK_BUDGET_BYTES;
  console.log(`${walkOk ? 'PASS' : 'FAIL'}: walking (lazy, ${walkRows.length} files) = ${formatBytes(walkBytes)} bytes gzipped (budget ${formatBytes(WALK_BUDGET_BYTES)})`);
  // Photo mode's controls, beyond the shell and the explorer: what opening photo mode adds.
  const photoRows = measure(exploreFiles(manifest, loaded, PHOTO_SOURCES));
  for (const row of [...photoRows].sort((a, b) => b.gzip - a.gzip)) {
    console.log(`photo  ${row.file}  ${formatBytes(row.raw)} raw, ${formatBytes(row.gzip)} gzip`);
  }
  const photoBytes = photoRows.reduce((sum, row) => sum + row.gzip, 0);
  const photoOk = photoRows.length > 0 && photoBytes <= PHOTO_BUDGET_BYTES;
  console.log(`${photoOk ? 'PASS' : 'FAIL'}: photo mode (lazy, ${photoRows.length} files) = ${formatBytes(photoBytes)} bytes gzipped (budget ${formatBytes(PHOTO_BUDGET_BYTES)})`);
  // The film's sound, beyond the shell: what the first chapter played with sound on adds.
  const soundRows = measure(exploreFiles(manifest, shellFiles, FILM_SOUND_SOURCES));
  for (const row of [...soundRows].sort((a, b) => b.gzip - a.gzip)) {
    console.log(`sound  ${row.file}  ${formatBytes(row.raw)} raw, ${formatBytes(row.gzip)} gzip`);
  }
  const soundBytes = soundRows.reduce((sum, row) => sum + row.gzip, 0);
  const soundOk = soundRows.length > 0 && soundBytes <= FILM_SOUND_BUDGET_BYTES;
  console.log(`${soundOk ? 'PASS' : 'FAIL'}: the film's sound (lazy, ${soundRows.length} files) = ${formatBytes(soundBytes)} bytes gzipped (budget ${formatBytes(FILM_SOUND_BUDGET_BYTES)})`);
  // Explore Mode's dock, beyond the shell: what the first exploration of a chapter adds.
  const discoverRows = measure(exploreFiles(manifest, shellFiles, DISCOVER_SOURCES));
  for (const row of [...discoverRows].sort((a, b) => b.gzip - a.gzip)) {
    console.log(`discover  ${row.file}  ${formatBytes(row.raw)} raw, ${formatBytes(row.gzip)} gzip`);
  }
  const discoverBytes = discoverRows.reduce((sum, row) => sum + row.gzip, 0);
  const discoverOk = discoverRows.length > 0 && discoverBytes <= DISCOVER_BUDGET_BYTES;
  console.log(`${discoverOk ? 'PASS' : 'FAIL'}: Explore Mode's dock (lazy, ${discoverRows.length} files) = ${formatBytes(discoverBytes)} bytes gzipped (budget ${formatBytes(DISCOVER_BUDGET_BYTES)})`);
  if (!totalOk || !shellOk || !exploreOk || !labOk || !islamicOk || !walkOk || !photoOk || !soundOk || !discoverOk) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`check-bundle: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
