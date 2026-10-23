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

const JPL_OWNER = 'JPL builder, npm run preprocess:jpl';
const JPL_BODIES = ['Sun', 'Earth', 'Moon', 'Jupiter', 'Saturn'] as const;
/** physical.json "sources" key -> the data/sources.json entry that credits that file. */
const JPL_SOURCE_IDS: Record<string, string> = {
  pck: 'naif-pck00011',
  de440: 'jpl-de440',
  lsk: 'naif-lsk-naif0012',
  moon: 'jpl-horizons',
  rings: 'cassini-rss-rings',
  ringsLabel: 'cassini-rss-rings',
};
const SHA256 = /^[0-9a-f]{64}$/u;

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNumberList = (v: unknown, length?: number): v is number[] =>
  Array.isArray(v) && (length === undefined || v.length === length) && (v as unknown[]).every(isFiniteNumber);

function loadJpl(name: string, problems: string[]): { path: string; value: unknown; bytes: Uint8Array } | null {
  const loaded = loadJson<unknown>(rootPath('public', 'assets', 'jpl', name));
  if (loaded.status !== 'ok') {
    problems.push(`${relPath(loaded.path)} ${loaded.status === 'missing' ? 'is missing' : `is invalid: ${loaded.error}`}`);
    return null;
  }
  return { path: relPath(loaded.path), value: loaded.value, bytes: readBytes(loaded.path) };
}

function planetsProblems(path: string, planets: unknown): string[] {
  const problems = checkFields(planets, { epochJd: 'number', bodies: 'array', source: 'nonempty' }, path);
  const bodies: unknown[] = isRecord(planets) && Array.isArray(planets.bodies) ? planets.bodies : [];
  if (bodies.length !== 8) problems.push(`${path}: ${bodies.length} bodies, expected the 8 planets`);
  bodies.forEach((body, i) => {
    problems.push(
      ...checkFields(
        body,
        {
          name: 'nonempty', meanRadiusKm: 'number',
          'elements.a': 'number', 'elements.e': 'number', 'elements.I': 'number', 'elements.L': 'number', 'elements.varpi': 'number', 'elements.Omega': 'number',
          'ratesPerCentury.a': 'number', 'ratesPerCentury.e': 'number', 'ratesPerCentury.I': 'number', 'ratesPerCentury.L': 'number', 'ratesPerCentury.varpi': 'number', 'ratesPerCentury.Omega': 'number',
        },
        `${path} bodies[${i}]`,
      ),
    );
  });
  if (!bodies.some((b) => isRecord(b) && b.name === 'Earth')) problems.push(`${path}: no Earth (Earth-Moon barycentre) row`);
  return problems;
}

function moonProblems(path: string, moon: unknown): string[] {
  const problems = checkFields(moon, { startJdTdb: 'number', stepDays: 'number', count: 'number', positionsKm: 'array', timeScale: 'nonempty', rawSha256: 'nonempty' }, path);
  if (!isRecord(moon) || problems.length > 0) return problems;
  const rows: unknown[] = Array.isArray(moon.positionsKm) ? moon.positionsKm : [];
  if (rows.length !== moon.count) problems.push(`${path}: ${rows.length} rows, but count is ${String(moon.count)}`);
  const bad = rows.findIndex((r) => !isNumberList(r, 3));
  if (bad >= 0) problems.push(`${path}: positionsKm[${bad}] is not three finite numbers`);
  if (moon.timeScale !== 'TDB') problems.push(`${path}: timeScale must be TDB`);
  if (moon.stepDays !== 1) problems.push(`${path}: stepDays must be 1 (src/astro interpolates daily rows)`);
  return problems;
}

function physicalProblems(ctx: ValidationContext, path: string, physical: unknown, assets: Record<string, Uint8Array>): string[] {
  const problems = checkFields(
    physical,
    { auKm: 'number', emrat: 'number', obliquityJ2000Arcsec: 'number', bodies: 'object', saturnRings: 'object', time: 'object', sources: 'object', assets: 'object' },
    path,
  );
  if (!isRecord(physical) || problems.length > 0) return problems;
  for (const name of JPL_BODIES) {
    const body = isRecord(physical.bodies) ? physical.bodies[name] : undefined;
    if (!isRecord(body)) {
      problems.push(`${path}: bodies.${name} is missing`);
      continue;
    }
    for (const key of ['radiiKm', 'poleRa', 'poleDec', 'pm']) {
      if (!isNumberList(body[key], 3)) problems.push(`${path}: bodies.${name}.${key} must be three finite numbers`);
    }
    const np = body.nutPrec;
    if (np !== null) {
      const angles: unknown[] = isRecord(np) && Array.isArray(np.angles) ? np.angles : [];
      const termsOk = isRecord(np) && ['ra', 'dec', 'pm'].every((k) => isNumberList(np[k]) && np[k].length <= angles.length);
      if (!termsOk || angles.length === 0 || !angles.every((a) => isNumberList(a, 2))) {
        problems.push(`${path}: bodies.${name}.nutPrec must be null or ra/dec/pm terms with no more entries than its [degrees, rate] angles`);
      }
    }
  }
  const rings = physical.saturnRings;
  if (!isRecord(rings) || !isFiniteNumber(rings.innerKm) || !isFiniteNumber(rings.outerKm) || !(rings.innerKm > 0 && rings.innerKm < rings.outerKm)) {
    problems.push(`${path}: saturnRings needs 0 < innerKm < outerKm`);
  }
  // The explorer draws the rings from this profile as a mipmapped strip: a power of two of bins, all present.
  const profile = isRecord(rings) ? rings.profile : undefined;
  const bins = isRecord(profile) && isFiniteNumber(profile.bins) ? profile.bins : 0;
  const bytes = isRecord(profile) && typeof profile.transmission === 'string' ? Buffer.from(profile.transmission, 'base64').length : -1;
  if (!(bins >= 256 && (bins & (bins - 1)) === 0) || bytes !== bins) {
    problems.push(`${path}: saturnRings.profile needs a power-of-two number of bins (at least 256) and one base64 byte of transmission per bin`);
  }
  const time = physical.time;
  const leaps: unknown[] = isRecord(time) && Array.isArray(time.leapSeconds) ? time.leapSeconds : [];
  problems.push(...checkFields(time, { deltaTA: 'number', k: 'number', eb: 'number', m0: 'number', m1: 'number' }, `${path} time`));
  const ordered = leaps.every((l, i) => {
    const prev = leaps[i - 1];
    return isRecord(l) && isFiniteNumber(l.jdUtc) && isFiniteNumber(l.taiMinusUtc) && (!isRecord(prev) || (l.jdUtc > Number(prev.jdUtc) && l.taiMinusUtc === Number(prev.taiMinusUtc) + 1));
  });
  if (leaps.length === 0 || !ordered) problems.push(`${path}: time.leapSeconds must be one-second steps in date order`);

  const sourceIds = new Set(ctx.sources.status === 'ok' ? ctx.sources.value.sources.map((s) => s.id) : []);
  for (const [key, id] of Object.entries(JPL_SOURCE_IDS)) {
    const source = isRecord(physical.sources) ? physical.sources[key] : undefined;
    if (!isRecord(source) || typeof source.url !== 'string' || !source.url.startsWith('https://') || typeof source.sha256 !== 'string' || !SHA256.test(source.sha256)) {
      problems.push(`${path}: sources.${key} needs an https url and a sha256`);
    }
    if (ctx.sources.status === 'ok' && !sourceIds.has(id)) problems.push(`data/sources.json: no "${id}" entry for physical.json sources.${key}`);
  }
  for (const [name, bytes] of Object.entries(assets)) {
    const recorded = isRecord(physical.assets) ? physical.assets[name] : undefined;
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (recorded !== hash) problems.push(`public/assets/jpl/${name}: sha256 ${hash} does not match ${path} assets (${String(recorded)}); rebuild rather than edit by hand`);
  }
  return problems;
}

/** The JPL data behind Chapter 7 and src/astro: the shape of each file, the Moon's row count and the recorded hashes. */
function checkJpl(ctx: ValidationContext, log: RuleLog): void {
  const problems: string[] = [];
  const planets = loadJpl('planets.json', problems);
  const moon = loadJpl('moon.json', problems);
  const physical = loadJpl('physical.json', problems);
  if (planets) problems.push(...planetsProblems(planets.path, planets.value));
  if (moon) problems.push(...moonProblems(moon.path, moon.value));
  if (physical && planets && moon) {
    problems.push(...physicalProblems(ctx, physical.path, physical.value, { 'planets.json': planets.bytes, 'moon.json': moon.bytes }));
  }
  if (problems.length > 0) for (const p of problems) log.fail(`${p} (owner: ${JPL_OWNER})`);
  else {
    const count = isRecord(moon?.value) ? String(moon.value.count) : '?';
    log.pass(`public/assets/jpl: 8 planets, ${count} Moon rows matching count, ${JPL_BODIES.length} rotation models; planets.json and moon.json match the sha256 in physical.json`);
  }
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
  checkJpl(ctx, log);
  checkAnalyses(ctx, log);
}
