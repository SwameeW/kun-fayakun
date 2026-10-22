/**
 * npx tsx scripts/fetch-font.ts
 *
 * Fetches Amiri Quran from the official aliftype/amiri GitHub release, checks
 * the archive and the files inside it against AMIRI, and writes:
 *
 *   public/fonts/AmiriQuran.woff2   AmiriQuran.ttf re-encoded as WOFF2 (wawoff2)
 *   public/fonts/OFL.txt            the licence, verbatim from the archive
 *
 * The font is never subset, renamed or otherwise modified: the WOFF2 is checked
 * to decode back to the same glyph outlines and the same OpenType tables.
 * The archive is cached in .cache/amiri-<version>/ so later runs (and
 * build-calligraphy.ts, which shapes with the pinned TTF) work offline.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import * as hb from 'harfbuzzjs';
import { fileExists, relPath, rootPath } from './lib/files';
import { fetchBytes } from './lib/net';
import { sha256Hex } from './lib/text';

/** The pinned release. Change deliberately: bump every field together and review the diff. */
export const AMIRI = {
  version: '1.003',
  releaseUrl: 'https://github.com/aliftype/amiri/releases/tag/1.003',
  archive: {
    url: 'https://github.com/aliftype/amiri/releases/download/1.003/Amiri-1.003.zip',
    sha256: '81af0aff7d2086d8af24cea7202f7546130997982534691373485cd96744d05e',
    bytes: 1033533,
  },
  ttf: {
    entry: 'Amiri-1.003/AmiriQuran.ttf',
    sha256: 'e2a47644762d16bdfb6d33e0d8db8c6ff30beae84150ef5a705316bbd829455c',
  },
  license: {
    entry: 'Amiri-1.003/OFL.txt',
    sha256: '72de68e5954f4fdd24702292ef5a32f003ca960ec9330dc86e5eefb5dffb9b22',
  },
} as const;

const CACHE_DIR = rootPath('.cache', `amiri-${AMIRI.version}`);
const ARCHIVE_PATH = resolve(CACHE_DIR, `Amiri-${AMIRI.version}.zip`);
const FONTS_DIR = rootPath('public', 'fonts');
export const WOFF2_PATH = resolve(FONTS_DIR, 'AmiriQuran.woff2');
const LICENSE_PATH = resolve(FONTS_DIR, 'OFL.txt');

export interface AmiriQuranFont {
  /** e.g. "Amiri Quran 1.003". */
  label: string;
  version: string;
  ttf: Uint8Array;
  ttfSha256: string;
  license: Uint8Array;
}

function assertSha256(what: string, bytes: Uint8Array, expected: string): void {
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(`${what}: sha256 ${actual} does not match the pinned ${expected}. Nothing was written.`);
  }
}

/* ------------------------------------------------------------------ */
/* Minimal ZIP reader (stored and deflated entries, no ZIP64)           */
/* ------------------------------------------------------------------ */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;

function findEndOfCentralDirectory(zip: DataView): number {
  const lowest = Math.max(0, zip.byteLength - EOCD_MIN_BYTES - MAX_COMMENT_BYTES);
  for (let at = zip.byteLength - EOCD_MIN_BYTES; at >= lowest; at -= 1) {
    if (zip.getUint32(at, true) === EOCD_SIGNATURE) return at;
  }
  throw new Error('not a ZIP archive (no end-of-central-directory record)');
}

/** Returns the bytes of one archive entry, checking its size and CRC-32. */
export function extractZipEntry(zip: Uint8Array, entryName: string): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) throw new Error('corrupt ZIP central directory');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name !== entryName) continue;

    if (flags & 0x1) throw new Error(`${name}: encrypted ZIP entries are not supported`);
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw new Error(`${name}: corrupt local header`);
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const packed = zip.subarray(dataStart, dataStart + packedSize);
    let data: Uint8Array;
    if (method === 0) data = packed;
    else if (method === 8) data = new Uint8Array(inflateRawSync(packed));
    else throw new Error(`${name}: unsupported ZIP compression method ${method}`);
    if (data.byteLength !== size || crc32(data) !== crc) throw new Error(`${name}: size or CRC-32 mismatch`);
    return data;
  }
  throw new Error(`${entryName} not found in the archive`);
}

/* ------------------------------------------------------------------ */
/* Pinned archive                                                       */
/* ------------------------------------------------------------------ */

async function loadArchive(): Promise<Uint8Array> {
  if (fileExists(ARCHIVE_PATH)) {
    const cached = new Uint8Array(readFileSync(ARCHIVE_PATH));
    if (sha256Hex(cached) === AMIRI.archive.sha256) return cached;
    console.warn(`${relPath(ARCHIVE_PATH)} does not match the pin; downloading again`);
  }
  const bytes = await fetchBytes(AMIRI.archive.url);
  assertSha256(AMIRI.archive.url, bytes, AMIRI.archive.sha256);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(ARCHIVE_PATH, bytes);
  console.log(`downloaded ${AMIRI.archive.url} (${bytes.byteLength} bytes)`);
  return bytes;
}

/** The unmodified AmiriQuran.ttf and OFL.txt from the pinned release (cached download). */
export async function loadAmiriQuran(): Promise<AmiriQuranFont> {
  const archive = await loadArchive();
  const ttf = extractZipEntry(archive, AMIRI.ttf.entry);
  assertSha256(AMIRI.ttf.entry, ttf, AMIRI.ttf.sha256);
  const license = extractZipEntry(archive, AMIRI.license.entry);
  assertSha256(AMIRI.license.entry, license, AMIRI.license.sha256);
  return { label: `Amiri Quran ${AMIRI.version}`, version: AMIRI.version, ttf, ttfSha256: AMIRI.ttf.sha256, license };
}

/* ------------------------------------------------------------------ */
/* Licence and name checks                                              */
/* ------------------------------------------------------------------ */

const OFL_PREAMBLE = 'This Font Software is licensed under the SIL Open Font License';
const NAME_COPYRIGHT = 0;
const NAME_VERSION = 5;
const NAME_LICENSE = 13;

/**
 * Reserved Font Names declared in the OFL copyright header (the lines above the
 * licence text, conventionally `with Reserved Font Name "X"`) or in the font's
 * copyright and licence name records.
 */
function reservedFontNames(licenseText: string, face: hb.Face): string[] {
  // Only the copyright header can declare names; the OFL body defines the term and must not match.
  const headers = [licenseText, face.getName(NAME_COPYRIGHT, 'en'), face.getName(NAME_LICENSE, 'en')].map(
    (text) => text.split(OFL_PREAMBLE)[0] ?? '',
  );
  const names = new Set<string>();
  for (const header of headers) {
    for (const match of header.matchAll(/Reserved\s+Font\s+Names?([^\n]*)/giu)) {
      const quoted = [...(match[1] ?? '').matchAll(/"([^"]+)"/gu)].map((m) => m[1] ?? '');
      for (const name of quoted.length > 0 ? quoted : ['(unparsed declaration)']) names.add(name);
    }
  }
  return [...names];
}

/* ------------------------------------------------------------------ */
/* WOFF2 encoding and round-trip check                                  */
/* ------------------------------------------------------------------ */

interface Wawoff2 {
  compress(ttf: Uint8Array): Promise<Uint8Array>;
  decompress(woff2: Uint8Array): Promise<Uint8Array>;
}

/** wawoff2 is CommonJS without type declarations; loaded on first use so importers of loadAmiriQuran skip it. */
function wawoff2(): Wawoff2 {
  return createRequire(import.meta.url)('wawoff2') as Wawoff2;
}

function tableTags(ttf: Uint8Array): string[] {
  const view = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
  const count = view.getUint16(4);
  const tags: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = 12 + i * 16;
    tags.push(String.fromCharCode(...ttf.subarray(at, at + 4)));
  }
  return tags.sort();
}

function glyphCount(face: hb.Face): number {
  const maxp = face.referenceTable('maxp');
  if (!maxp) throw new Error('font has no maxp table');
  return new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4);
}

/** WOFF2 rewrites these tables' bytes (glyf/loca/hmtx transforms, head flags); their content is compared below. */
const TRANSFORMED_TABLES = new Set(['glyf', 'loca', 'hmtx', 'head']);

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return a !== undefined && b !== undefined && Buffer.compare(a, b) === 0;
}

/** Throws unless `decoded` has the same tables, outlines and advances as `original`. */
function assertLosslessRoundTrip(original: Uint8Array, decoded: Uint8Array): void {
  const tags = tableTags(original);
  if (tags.join() !== tableTags(decoded).join()) throw new Error('WOFF2 round trip changed the table list');
  const a = new hb.Face(new hb.Blob(original));
  const b = new hb.Face(new hb.Blob(decoded));
  for (const tag of tags) {
    if (TRANSFORMED_TABLES.has(tag)) continue;
    if (!sameBytes(a.referenceTable(tag), b.referenceTable(tag))) throw new Error(`WOFF2 round trip changed table ${tag}`);
  }
  if (a.upem !== b.upem) throw new Error('WOFF2 round trip changed unitsPerEm');
  const count = glyphCount(a);
  if (count !== glyphCount(b)) throw new Error('WOFF2 round trip changed the glyph count');
  const fa = new hb.Font(a);
  const fb = new hb.Font(b);
  for (let gid = 0; gid < count; gid += 1) {
    if (fa.glyphToPath(gid) !== fb.glyphToPath(gid) || fa.glyphHAdvance(gid) !== fb.glyphHAdvance(gid)) {
      throw new Error(`WOFF2 round trip changed glyph ${gid}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const font = await loadAmiriQuran();
  console.log(`archive ${AMIRI.archive.url}: sha256 ${AMIRI.archive.sha256} matches the pin`);
  console.log(`${AMIRI.ttf.entry}: sha256 ${font.ttfSha256} (${font.ttf.byteLength} bytes) matches the pin`);

  const face = new hb.Face(new hb.Blob(font.ttf));
  const nameVersion = face.getName(NAME_VERSION, 'en');
  if (!nameVersion.includes(AMIRI.version)) {
    throw new Error(`name table version "${nameVersion}" does not mention the pinned ${AMIRI.version}`);
  }
  const licenseText = new TextDecoder('utf-8').decode(font.license);
  const reserved = reservedFontNames(licenseText, face);
  console.log(
    reserved.length === 0
      ? 'Reserved Font Names: none declared (OFL header, name IDs 0 and 13)'
      : `Reserved Font Names declared: ${reserved.join(', ')}. The font is shipped unmodified under its own name.`,
  );

  const woff2 = await wawoff2().compress(font.ttf);
  assertLosslessRoundTrip(font.ttf, await wawoff2().decompress(woff2));
  console.log(`WOFF2 decodes to the same tables, ${glyphCount(face)} glyph outlines and advances`);

  mkdirSync(FONTS_DIR, { recursive: true });
  writeFileSync(WOFF2_PATH, woff2);
  writeFileSync(LICENSE_PATH, font.license);
  console.log(`wrote ${relPath(WOFF2_PATH)} (${woff2.byteLength} bytes, sha256 ${sha256Hex(woff2)})`);
  console.log(`wrote ${relPath(LICENSE_PATH)} (verbatim from ${AMIRI.license.entry})`);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
