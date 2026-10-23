/**
 * npm run preprocess:calligraphy
 *
 * Builds the calligraphy atlases listed under "calligraphy" in data/citations.json.
 * For each entry:
 *
 *  1. Word: taken from the NFC Tanzil text in data/quran.json (never typed here);
 *     its base letters are asserted against EXPECTED_BASE_LETTERS (code points).
 *  2. Shaping: HarfBuzz with the pinned Amiri Quran TTF (script arab, RTL, default
 *     features), so joining forms and the vowel mark position come from the font.
 *  3. Outline: every shaped glyph is drawn with HarfBuzz draw funcs at its shaped
 *     position; together the contours form one outline.
 *  4. Field (MTSDF): RGB is msdfgen-wasm's MSDF of that outline. msdfgen-wasm can
 *     only load shapes from a font, so the outline is wrapped as the single glyph
 *     of an in-memory TrueType container (never written or shipped); msdfgen's
 *     Skia preprocessing merges the overlapping joined letters into one shape.
 *     A is the true signed distance to the same outline with the same range,
 *     computed here because msdfgen-wasm 1.0.0 has no MTSDF mode.
 *  5. Check: the atlas is decoded at 4x (median of RGB, threshold 0.5; and A) and
 *     compared with a direct rasterisation of the outline. The build fails if they
 *     disagree anywhere beyond EDGE_TOLERANCE. Previews go to .cache/calligraphy/.
 *
 * Writes public/assets/calligraphy/<id>.png (lossless RGBA) and <id>.json, whose
 * shape is fixed in docs/CONTRACTS.md. PNG rows are stored top row first (the word
 * is upright when the file is viewed), so flipY is false; bounds are normalised
 * with the origin at the bottom-left, as UVs are with three's default
 * texture.flipY = true.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hb from 'harfbuzzjs';
import type { QuranFile } from '../src/core/types';
import { loadAmiriQuran, type AmiriQuranFont } from './fetch-font';
import { calligraphyCitations, loadCitations, type CalligraphyCitation } from './lib/citations';
import { readJson, relPath, rootPath, writeJson } from './lib/files';
import { expectedWord } from './lib/rules/assets';
import { describeCodePoints } from './lib/text';

/** Atlas size of the entry being built: a single word gets 1024 x 512, a phrase twice the width. */
let atlasWidth = 1024;
let atlasHeight = 512;
/** Distance range in atlas pixels: the field spans PX_RANGE / 2 on each side of the edge. */
const PX_RANGE = 8;
/** Minimum empty border around the ink, in atlas pixels (room for the glow and for filtering). */
const MARGIN = 32;
/** Upscale factor of the decode check and the previews. */
const CHECK_UPSCALE = 4;
/** Largest allowed distance, in atlas pixels, between the true edge and a sample the decoded atlas gets wrong. */
const EDGE_TOLERANCE = 0.35;

const OUT_DIR = rootPath('public', 'assets', 'calligraphy');
const PREVIEW_DIR = rootPath('.cache', 'calligraphy');
const QURAN_PATH = rootPath('data', 'quran.json');

/** Base letters (combining marks removed) each calligraphy id must have. Code points only. */
const EXPECTED_BASE_LETTERS: Readonly<Record<string, readonly number[]>> = {
  kun: [0x0643, 0x0646], // kaf, nun
  // 21:104, five words from the twelfth from the end ("as We began the first creation, We will repeat it");
  // NFD letters with spaces (alef forms decompose to bare alef plus a mark), ending in the small waw U+06E5.
  'kama-badana': [
    0x0643, 0x0645, 0x0627, 0x0020, 0x0628, 0x062f, 0x0627, 0x0646, 0x0627, 0x0020, 0x0627, 0x0648, 0x0644, 0x0020, 0x062e, 0x0644, 0x0642,
    0x0020, 0x0646, 0x0639, 0x064a, 0x062f, 0x0647, 0x06e5,
  ],
};

/* ------------------------------------------------------------------ */
/* Geometry types                                                       */
/* ------------------------------------------------------------------ */

interface Point {
  x: number;
  y: number;
}

type Segment = { kind: 'line'; to: Point } | { kind: 'quad'; control: Point; to: Point };

/** A closed contour: segments run from `start` and the last one ends at `start`. */
interface Contour {
  start: Point;
  segments: Segment[];
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Straight piece of a flattened outline, in atlas pixels (y up, origin bottom-left). */
interface Piece {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

function mapContours(contours: readonly Contour[], map: (p: Point) => Point): Contour[] {
  return contours.map((c) => ({
    start: map(c.start),
    segments: c.segments.map((s) =>
      s.kind === 'line' ? { kind: 'line', to: map(s.to) } : { kind: 'quad', control: map(s.control), to: map(s.to) },
    ),
  }));
}

/** Exact bounds, including the extrema of quadratic segments. */
function contourBounds(contours: readonly Contour[]): Box {
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const include = (x: number, y: number): void => {
    box.minX = Math.min(box.minX, x);
    box.minY = Math.min(box.minY, y);
    box.maxX = Math.max(box.maxX, x);
    box.maxY = Math.max(box.maxY, y);
  };
  const extremum = (a: number, c: number, b: number): number | null => {
    const denominator = a - 2 * c + b;
    const t = denominator === 0 ? -1 : (a - c) / denominator;
    return t > 0 && t < 1 ? (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b : null;
  };
  for (const contour of contours) {
    let from = contour.start;
    include(from.x, from.y);
    for (const s of contour.segments) {
      include(s.to.x, s.to.y);
      if (s.kind === 'quad') {
        const ex = extremum(from.x, s.control.x, s.to.x);
        const ey = extremum(from.y, s.control.y, s.to.y);
        if (ex !== null) include(ex, from.y);
        if (ey !== null) include(from.x, ey);
      }
      from = s.to;
    }
  }
  if (!Number.isFinite(box.minX)) throw new Error('outline is empty');
  return box;
}

/** Splits the outline into straight pieces no longer than maxLength and within `tolerance` of the curve. */
function flatten(contours: readonly Contour[], maxLength: number, tolerance: number): Piece[] {
  const pieces: Piece[] = [];
  for (const contour of contours) {
    let from = contour.start;
    for (const s of contour.segments) {
      if (s.kind === 'line') {
        const n = Math.max(1, Math.ceil(Math.hypot(s.to.x - from.x, s.to.y - from.y) / maxLength));
        for (let i = 0; i < n; i += 1) {
          const t0 = i / n;
          const t1 = (i + 1) / n;
          pieces.push({
            x0: from.x + (s.to.x - from.x) * t0,
            y0: from.y + (s.to.y - from.y) * t0,
            x1: from.x + (s.to.x - from.x) * t1,
            y1: from.y + (s.to.y - from.y) * t1,
          });
        }
      } else {
        const c = s.control;
        // A quadratic deviates from an n-piece chord polyline by at most |p0 - 2c + p1| / (4 n^2).
        const bend = Math.hypot(from.x - 2 * c.x + s.to.x, from.y - 2 * c.y + s.to.y);
        const length = Math.hypot(c.x - from.x, c.y - from.y) + Math.hypot(s.to.x - c.x, s.to.y - c.y);
        const n = Math.max(1, Math.ceil(Math.sqrt(bend / (4 * tolerance))), Math.ceil(length / maxLength));
        let px = from.x;
        let py = from.y;
        for (let i = 1; i <= n; i += 1) {
          const t = i / n;
          const u = 1 - t;
          const x = u * u * from.x + 2 * u * t * c.x + t * t * s.to.x;
          const y = u * u * from.y + 2 * u * t * c.y + t * t * s.to.y;
          pieces.push({ x0: px, y0: py, x1: x, y1: y });
          px = x;
          py = y;
        }
      }
      from = s.to;
    }
  }
  return pieces;
}

function distanceSquaredToPiece(px: number, py: number, p: Piece): number {
  const dx = p.x1 - p.x0;
  const dy = p.y1 - p.y0;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((px - p.x0) * dx + (py - p.y0) * dy) / lengthSquared)) : 0;
  const ex = p.x0 + t * dx - px;
  const ey = p.y0 + t * dy - py;
  return ex * ex + ey * ey;
}

/* ------------------------------------------------------------------ */
/* Non-zero winding (direct rasterisation, inside tests)                */
/* ------------------------------------------------------------------ */

interface Crossing {
  x: number;
  direction: number;
}

/** Pieces bucketed by 1-pixel rows, for horizontal ray casts with the non-zero rule. */
class WindingIndex {
  private readonly rows: Piece[][];

  constructor(pieces: readonly Piece[], height: number) {
    this.rows = Array.from({ length: height }, () => []);
    for (const p of pieces) {
      if (p.y0 === p.y1) continue;
      const first = Math.max(0, Math.floor(Math.min(p.y0, p.y1)));
      const last = Math.min(height - 1, Math.floor(Math.max(p.y0, p.y1)));
      for (let row = first; row <= last; row += 1) this.rows[row]?.push(p);
    }
  }

  /** Pieces crossing the line at height y (half-open in y, so shared vertices count once), sorted by x. */
  crossings(y: number): Crossing[] {
    const out: Crossing[] = [];
    for (const p of this.rows[Math.floor(y)] ?? []) {
      const up = p.y1 > p.y0;
      const low = up ? p.y0 : p.y1;
      const high = up ? p.y1 : p.y0;
      if (y < low || y >= high) continue;
      out.push({ x: p.x0 + ((y - p.y0) * (p.x1 - p.x0)) / (p.y1 - p.y0), direction: up ? 1 : -1 });
    }
    return out.sort((a, b) => a.x - b.x);
  }

  inside(x: number, y: number): boolean {
    let winding = 0;
    for (const c of this.crossings(y)) if (c.x > x) winding += c.direction;
    return winding !== 0;
  }
}

/** A grid of sample points in atlas space: column c, row r (top row first) sit at (x0 + c * step, y0 - r * step). */
interface SampleGrid {
  columns: number;
  rows: number;
  x0: number;
  y0: number;
  step: number;
}

/** 1 where the sample point is inside the outline (non-zero rule), else 0. Rows top first. */
function insideMask(index: WindingIndex, grid: SampleGrid): Uint8Array {
  const mask = new Uint8Array(grid.columns * grid.rows);
  for (let r = 0; r < grid.rows; r += 1) {
    const crossings = index.crossings(grid.y0 - r * grid.step);
    let winding = crossings.reduce((sum, c) => sum + c.direction, 0);
    let next = 0;
    for (let c = 0; c < grid.columns; c += 1) {
      const x = grid.x0 + c * grid.step;
      for (let k = crossings[next]; k !== undefined && k.x <= x; k = crossings[next]) {
        winding -= k.direction;
        next += 1;
      }
      mask[r * grid.columns + c] = winding !== 0 ? 1 : 0;
    }
  }
  return mask;
}

/** Marks pieces that lie on the boundary of the filled region (inside on exactly one side). */
function boundaryPieces(pieces: readonly Piece[], index: WindingIndex): Piece[] {
  const epsilon = 1e-3;
  return pieces.filter((p) => {
    const length = Math.hypot(p.x1 - p.x0, p.y1 - p.y0);
    if (length === 0) return false;
    const nx = -(p.y1 - p.y0) / length;
    const ny = (p.x1 - p.x0) / length;
    const mx = (p.x0 + p.x1) / 2;
    const my = (p.y0 + p.y1) / 2;
    return index.inside(mx + epsilon * nx, my + epsilon * ny) !== index.inside(mx - epsilon * nx, my - epsilon * ny);
  });
}

/** Boundary pieces bucketed by 1-pixel cells, for exact distances near the edge. */
class EdgeGrid {
  private readonly cells = new Map<number, Piece[]>();

  constructor(
    pieces: readonly Piece[],
    private readonly width: number,
  ) {
    for (const p of pieces) {
      for (let cy = Math.floor(Math.min(p.y0, p.y1)); cy <= Math.floor(Math.max(p.y0, p.y1)); cy += 1) {
        for (let cx = Math.floor(Math.min(p.x0, p.x1)); cx <= Math.floor(Math.max(p.x0, p.x1)); cx += 1) {
          const key = cy * width + cx;
          const list = this.cells.get(key);
          if (list) list.push(p);
          else this.cells.set(key, [p]);
        }
      }
    }
  }

  /** Distance from (x, y) to the nearest boundary piece, capped at `reach` pixels. */
  distance(x: number, y: number, reach: number): number {
    let best = reach * reach;
    const cx0 = Math.floor(x - reach);
    const cy0 = Math.floor(y - reach);
    for (let cy = cy0; cy <= Math.floor(y + reach); cy += 1) {
      for (let cx = cx0; cx <= Math.floor(x + reach); cx += 1) {
        for (const p of this.cells.get(cy * this.width + cx) ?? []) best = Math.min(best, distanceSquaredToPiece(x, y, p));
      }
    }
    return Math.sqrt(best);
  }
}

/* ------------------------------------------------------------------ */
/* Word and shaping                                                     */
/* ------------------------------------------------------------------ */

function baseLetters(word: string): number[] {
  return Array.from(word.normalize('NFD'))
    .filter((ch) => !/\p{M}/u.test(ch))
    .map((ch) => ch.codePointAt(0) ?? 0);
}

const hex = (cps: readonly number[]): string => cps.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`).join(' ');

/** The cited word, from data/quran.json, after asserting its base letters. */
function citedWord(quran: QuranFile, entry: CalligraphyCitation): string {
  const verse = quran.ayat.find((a) => a.key === entry.verse);
  if (!verse) throw new Error(`${entry.id}: verse ${entry.verse} is not in data/quran.json`);
  const word = expectedWord(verse.arabic, entry.wordIndexFromEnd, entry.wordCount ?? 1);
  if (word === null) throw new Error(`${entry.id}: ${entry.verse} has no word ${entry.wordIndexFromEnd} from the end (or not ${entry.wordCount ?? 1} words from it)`);
  const expected = EXPECTED_BASE_LETTERS[entry.id];
  if (!expected) throw new Error(`${entry.id}: add its expected base letters to EXPECTED_BASE_LETTERS`);
  const actual = baseLetters(word);
  if (hex(actual) !== hex(expected)) {
    throw new Error(`${entry.id}: base letters ${hex(actual)} are not the expected ${hex(expected)}`);
  }
  return word;
}

interface ShapedGlyph {
  gid: number;
  cluster: number;
  /** Glyph origin in font units: pen position plus the shaping offset. */
  x: number;
  y: number;
  mark: boolean;
}

function shapeWord(font: hb.Font, face: hb.Face, word: string): ShapedGlyph[] {
  const buffer = new hb.Buffer();
  buffer.addText(word);
  buffer.setDirection(hb.Direction.RTL);
  buffer.setScript('arab');
  hb.shape(font, buffer);
  const positions = buffer.getGlyphPositions();
  let penX = 0;
  let penY = 0;
  return buffer.getGlyphInfos().map((info, i) => {
    const pos = positions[i];
    if (!pos) throw new Error('HarfBuzz returned fewer positions than glyphs');
    const glyph: ShapedGlyph = {
      gid: info.codepoint,
      cluster: info.cluster,
      x: penX + pos.xOffset,
      y: penY + pos.yOffset,
      mark: face.getGlyphClass(info.codepoint) === hb.GlyphClass.MARK,
    };
    penX += pos.xAdvance;
    penY += pos.yAdvance;
    return glyph;
  });
}

/** The glyph's contours in font units, moved to its shaped position. */
function glyphContours(font: hb.Font, glyph: ShapedGlyph): Contour[] {
  const contours: Contour[] = [];
  // Counted rather than thrown: an exception must not unwind through HarfBuzz's wasm frames.
  const drawn = { cubics: 0 };
  const at = (x: number, y: number): Point => ({ x: x + glyph.x, y: y + glyph.y });
  const last = (): Contour => {
    const contour = contours[contours.length - 1];
    if (!contour) throw new Error(`glyph ${glyph.gid}: drawing started without move-to`);
    return contour;
  };
  const funcs = new hb.DrawFuncs();
  funcs.setMoveToFunc((x, y) => contours.push({ start: at(x, y), segments: [] }));
  funcs.setLineToFunc((x, y) => last().segments.push({ kind: 'line', to: at(x, y) }));
  funcs.setQuadraticToFunc((cx, cy, x, y) => last().segments.push({ kind: 'quad', control: at(cx, cy), to: at(x, y) }));
  funcs.setCubicToFunc(() => {
    drawn.cubics += 1;
  });
  funcs.setClosePathFunc(() => undefined);
  if (!font.drawGlyphOrFail(glyph.gid, funcs)) throw new Error(`glyph ${glyph.gid} has no outline`);
  if (drawn.cubics > 0) throw new Error(`glyph ${glyph.gid} has cubic segments; a TrueType (quadratic) outline was expected`);

  for (const contour of contours) {
    contour.segments = contour.segments.filter((s, i, all) => {
      const from = i === 0 ? contour.start : (all[i - 1]?.to ?? contour.start);
      return s.kind === 'quad' || !samePoint(from, s.to);
    });
    const end = contour.segments[contour.segments.length - 1]?.to;
    if (end && !samePoint(end, contour.start)) contour.segments.push({ kind: 'line', to: contour.start });
  }
  return contours.filter((c) => c.segments.length > 0);
}

/**
 * Sanity checks on the shaping result: no missing glyphs, letters laid out right
 * to left in logical order, and every mark horizontally over its own base letter.
 */
function checkShaping(word: string, glyphs: readonly ShapedGlyph[], inks: readonly (Box | null)[]): void {
  if (glyphs.some((g) => g.gid === 0)) throw new Error('shaping produced .notdef: the font lacks a character');
  const clusters = new Set(glyphs.map((g) => g.cluster));
  const bases = glyphs.map((g, i) => ({ g, ink: inks[i] })).filter((b) => !b.g.mark);
  const letterCount = baseLetters(word).length;
  if (bases.length !== letterCount || clusters.size !== letterCount) {
    throw new Error(`expected ${letterCount} letter glyphs and clusters, got ${bases.length} and ${clusters.size}`);
  }
  const logical = [...bases].sort((a, b) => a.g.cluster - b.g.cluster);
  for (let i = 1; i < logical.length; i += 1) {
    const prev = logical[i - 1];
    const cur = logical[i];
    if (prev && cur && !(cur.g.x < prev.g.x)) throw new Error('letters are not laid out right to left');
  }
  glyphs.forEach((g, i) => {
    if (!g.mark) return;
    const ink = inks[i];
    const base = bases.find((b) => b.g.cluster === g.cluster);
    if (!ink || !base?.ink) throw new Error(`mark glyph ${g.gid} has no base letter in its cluster`);
    const centre = (ink.minX + ink.maxX) / 2;
    if (centre < base.ink.minX || centre > base.ink.maxX) throw new Error(`mark glyph ${g.gid} is not over its base letter`);
  });
}

/* ------------------------------------------------------------------ */
/* In-memory TrueType container for msdfgen-wasm                        */
/* ------------------------------------------------------------------ */

/** Container units per font unit. TrueType implied on-curve points are midpoints, i.e. multiples of 0.5. */
const CONTAINER_SCALE = 2;
const CONTAINER_UNITS_PER_EM = 2000;
/** Private-use code point the container maps to its one glyph. */
const CONTAINER_CODE_POINT = 0xe000;

class BigEndianWriter {
  private readonly bytes: number[] = [];

  u8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }

  u16(v: number): this {
    return this.u8(v >>> 8).u8(v);
  }

  i16(v: number): this {
    if (!Number.isInteger(v) || v < -32768 || v > 32767) throw new Error(`int16 out of range: ${v}`);
    return this.u16(v & 0xffff);
  }

  u32(v: number): this {
    return this.u16(v >>> 16).u16(v & 0xffff);
  }

  bytesOf(data: Uint8Array): this {
    for (const b of data) this.bytes.push(b);
    return this;
  }

  get length(): number {
    return this.bytes.length;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

interface TrueTypePoint {
  x: number;
  y: number;
  onCurve: boolean;
}

function trueTypeContour(contour: Contour): TrueTypePoint[] {
  const toUnits = (v: number): number => {
    const units = v * CONTAINER_SCALE;
    if (!Number.isInteger(units)) throw new Error(`outline coordinate ${v} is not representable in the container`);
    return units;
  };
  const point = (p: Point, onCurve: boolean): TrueTypePoint => ({ x: toUnits(p.x), y: toUnits(p.y), onCurve });
  const points = [point(contour.start, true)];
  for (const s of contour.segments) {
    if (s.kind === 'quad') points.push(point(s.control, false));
    points.push(point(s.to, true));
  }
  // The closing on-curve point repeats the start; TrueType closes contours implicitly.
  points.pop();
  return points;
}

function encodeSimpleGlyph(contours: readonly TrueTypePoint[][], box: Box): Uint8Array {
  const w = new BigEndianWriter();
  w.i16(contours.length).i16(box.minX).i16(box.minY).i16(box.maxX).i16(box.maxY);
  let end = -1;
  for (const c of contours) w.u16((end += c.length));
  w.u16(0); // no instructions
  const points = contours.flat();
  for (const p of points) w.u8(p.onCurve ? 1 : 0); // every coordinate as an int16 delta
  let x = 0;
  for (const p of points) {
    w.i16(p.x - x);
    x = p.x;
  }
  let y = 0;
  for (const p of points) {
    w.i16(p.y - y);
    y = p.y;
  }
  while (w.length % 4 !== 0) w.u8(0);
  return w.finish();
}

function tableChecksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum = (sum + (((data[i] ?? 0) << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0))) >>> 0;
  }
  return sum;
}

/** A two-glyph TrueType font (.notdef and the outline) mapping CONTAINER_CODE_POINT to the outline. */
function buildContainerFont(contours: readonly Contour[]): Uint8Array {
  const glyph = contours.map(trueTypeContour);
  const points = glyph.flat();
  const box: Box = {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
  const glyf = encodeSimpleGlyph(glyph, box);
  const advance = Math.max(0, box.maxX);

  const head = new BigEndianWriter()
    .u16(1).u16(0).u32(0x00010000).u32(0).u32(0x5f0f3cf5).u16(0x0003).u16(CONTAINER_UNITS_PER_EM)
    .u32(0).u32(0).u32(0).u32(0)
    .i16(box.minX).i16(box.minY).i16(box.maxX).i16(box.maxY)
    .u16(0).u16(8).i16(2).i16(1).i16(0)
    .finish();
  const hhea = new BigEndianWriter()
    .u32(0x00010000).i16(box.maxY).i16(Math.min(0, box.minY)).i16(0).u16(advance)
    .i16(Math.min(0, box.minX)).i16(0).i16(box.maxX).i16(1).i16(0).i16(0)
    .u16(0).u16(0).u16(0).u16(0).i16(0).u16(2)
    .finish();
  const maxp = new BigEndianWriter()
    .u32(0x00010000).u16(2).u16(points.length).u16(glyph.length)
    .u16(0).u16(0).u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0)
    .finish();
  const delta = (1 - CONTAINER_CODE_POINT) & 0xffff;
  const cmap = new BigEndianWriter()
    .u16(0).u16(1).u16(3).u16(1).u32(12)
    .u16(4).u16(32).u16(0).u16(4).u16(4).u16(1).u16(0)
    .u16(CONTAINER_CODE_POINT).u16(0xffff).u16(0)
    .u16(CONTAINER_CODE_POINT).u16(0xffff)
    .u16(delta).u16(1)
    .u16(0).u16(0)
    .finish();
  const loca = new BigEndianWriter().u32(0).u32(0).u32(glyf.length).finish();
  const hmtx = new BigEndianWriter().u16(0).i16(0).u16(advance).i16(box.minX).finish();
  const name = new BigEndianWriter().u16(0).u16(0).u16(6).finish();
  const post = new BigEndianWriter().u32(0x00030000).u32(0).i16(0).i16(0).u32(0).u32(0).u32(0).u32(0).u32(0).finish();

  const tables: Array<[string, Uint8Array]> = [
    ['cmap', cmap], ['glyf', glyf], ['head', head], ['hhea', hhea], ['hmtx', hmtx],
    ['loca', loca], ['maxp', maxp], ['name', name], ['post', post],
  ];
  const entrySelector = Math.floor(Math.log2(tables.length));
  const searchRange = 16 * 2 ** entrySelector;
  const font = new BigEndianWriter()
    .u32(0x00010000).u16(tables.length).u16(searchRange).u16(entrySelector).u16(tables.length * 16 - searchRange);
  let offset = 12 + tables.length * 16;
  let headOffset = 0;
  const padded = tables.map(([tag, data]) => {
    const body = new Uint8Array(Math.ceil(data.length / 4) * 4);
    body.set(data);
    if (tag === 'head') headOffset = offset;
    const record = { tag, length: data.length, body, offset };
    offset += body.length;
    return record;
  });
  for (const t of padded) {
    font.u8(t.tag.charCodeAt(0)).u8(t.tag.charCodeAt(1)).u8(t.tag.charCodeAt(2)).u8(t.tag.charCodeAt(3));
    font.u32(tableChecksum(t.body)).u32(t.offset).u32(t.length);
  }
  for (const t of padded) font.bytesOf(t.body);
  const bytes = font.finish();
  // head.checkSumAdjustment, so the container is a well-formed font.
  new DataView(bytes.buffer).setUint32(headOffset + 8, (0xb1b0afba - tableChecksum(bytes)) >>> 0);
  return bytes;
}

/* ------------------------------------------------------------------ */
/* msdfgen-wasm                                                         */
/* ------------------------------------------------------------------ */

// msdfgen-wasm's types are not reachable through its package exports, and its ESM
// build uses extensionless imports, so load the CommonJS build with these shapes.
interface MsdfgenGlyph {
  unicode: number;
  index: number;
  left: number;
  bottom: number;
  right: number;
  top: number;
}

interface MsdfgenConfig {
  scale: number;
  xTranslate: number;
  yTranslate: number;
  range: number;
  edgeColoring: 'simple' | 'inktrap' | 'distance';
  edgeThresholdAngle: number;
  width: number;
  height: number;
  scanline: boolean;
}

interface MsdfgenBitmap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint32Array;
}

interface Msdfgen {
  loadFont(data: Uint8Array): void;
  loadGlyphs(codePoints: number[], options?: { preprocess: boolean }): void;
  getGlyph(codePoint: number): MsdfgenGlyph;
  /** RGB in 0..255 (distance / range + 0.5), alpha 255; rows top first. */
  generateBitmap(glyph: MsdfgenGlyph, config: MsdfgenConfig): MsdfgenBitmap;
  /** Lossless PNG of an RGBA bitmap. */
  createPng(bitmap: MsdfgenBitmap, compressionLevel?: number): Uint8Array;
}

interface MsdfgenModule {
  Msdfgen: { create(wasm: Uint8Array): Promise<Msdfgen> };
  Bitmap: new (width: number, height: number, data?: ArrayBuffer) => MsdfgenBitmap;
}

const loadCommonJs = createRequire(import.meta.url);

async function createMsdfgen(): Promise<{ msdfgen: Msdfgen; module: MsdfgenModule }> {
  const module = loadCommonJs('msdfgen-wasm') as MsdfgenModule;
  const wasm = new Uint8Array(readFileSync(loadCommonJs.resolve('msdfgen-wasm/wasm')));
  return { msdfgen: await module.Msdfgen.create(wasm), module };
}

/** Atlas placement: atlas = font units * scale + offset (pixels, y up, origin bottom-left). */
interface Layout {
  scale: number;
  offsetX: number;
  offsetY: number;
}

function fitLayout(ink: Box): Layout {
  const scale = Math.min((atlasWidth - 2 * MARGIN) / (ink.maxX - ink.minX), (atlasHeight - 2 * MARGIN) / (ink.maxY - ink.minY));
  return {
    scale,
    offsetX: atlasWidth / 2 - ((ink.minX + ink.maxX) / 2) * scale,
    offsetY: atlasHeight / 2 - ((ink.minY + ink.maxY) / 2) * scale,
  };
}

/** RGBA pixels (rows top first): MSDF in RGB, alpha still 255. */
function generateMsdf(msdfgen: Msdfgen, contours: readonly Contour[], ink: Box, layout: Layout): Uint8Array {
  msdfgen.loadFont(buildContainerFont(contours));
  msdfgen.loadGlyphs([CONTAINER_CODE_POINT], { preprocess: true });
  const glyph = msdfgen.getGlyph(CONTAINER_CODE_POINT);
  // msdfgen-wasm reports shapes in em-normalised units.
  const unitsPerFontUnit = CONTAINER_SCALE / CONTAINER_UNITS_PER_EM;
  const expected = [ink.minX, ink.minY, ink.maxX, ink.maxY].map((v) => v * unitsPerFontUnit);
  const reported = [glyph.left, glyph.bottom, glyph.right, glyph.top];
  if (reported.some((v, i) => Math.abs(v - (expected[i] ?? NaN)) > 1e-6)) {
    throw new Error(`msdfgen sees bounds ${reported.join(', ')}, expected ${expected.join(', ')}`);
  }
  const scale = layout.scale / unitsPerFontUnit;
  const bitmap = msdfgen.generateBitmap(glyph, {
    scale,
    xTranslate: layout.offsetX / scale,
    yTranslate: layout.offsetY / scale,
    range: PX_RANGE / scale,
    edgeColoring: 'simple',
    edgeThresholdAngle: 3,
    width: atlasWidth,
    height: atlasHeight,
    // Sign-correction pass. A no-op for the Skia-merged outline (identical output); kept as a guard.
    scanline: true,
  });
  return new Uint8Array(bitmap.data.buffer, bitmap.data.byteOffset, bitmap.data.byteLength);
}

/** Writes the true signed distance (same range as the MSDF) into the alpha channel. */
function writeTrueDistanceAlpha(rgba: Uint8Array, index: WindingIndex, edges: EdgeGrid): void {
  const reach = PX_RANGE / 2 + 1;
  const grid: SampleGrid = { columns: atlasWidth, rows: atlasHeight, x0: 0.5, y0: atlasHeight - 0.5, step: 1 };
  const inside = insideMask(index, grid);
  for (let r = 0; r < atlasHeight; r += 1) {
    for (let c = 0; c < atlasWidth; c += 1) {
      const i = r * atlasWidth + c;
      const distance = edges.distance(c + 0.5, atlasHeight - r - 0.5, reach);
      const signed = inside[i] ? distance : -distance;
      rgba[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, signed / PX_RANGE + 0.5)) * 255);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Decode check and previews                                            */
/* ------------------------------------------------------------------ */

const median3 = (a: number, b: number, c: number): number => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

/**
 * Bilinear sample (clamp to edge, as a GPU sampler) of the atlas at atlas point (x, y),
 * decoded as a shader would (byte / 255). Writes median(RGB) and A into `out`.
 */
function sampleAtlas(rgba: Uint8Array, x: number, y: number, out: Float32Array): void {
  const fx = Math.max(0, Math.min(atlasWidth - 1, x - 0.5));
  const fy = Math.max(0, Math.min(atlasHeight - 1, atlasHeight - y - 0.5));
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fy);
  const tx = fx - c0;
  const ty = fy - r0;
  const i00 = (r0 * atlasWidth + c0) * 4;
  const i01 = (r0 * atlasWidth + Math.min(atlasWidth - 1, c0 + 1)) * 4;
  const i10 = (Math.min(atlasHeight - 1, r0 + 1) * atlasWidth + c0) * 4;
  const i11 = (Math.min(atlasHeight - 1, r0 + 1) * atlasWidth + Math.min(atlasWidth - 1, c0 + 1)) * 4;
  const channel = (k: number): number => {
    const top = (rgba[i00 + k] ?? 0) * (1 - tx) + (rgba[i01 + k] ?? 0) * tx;
    const bottom = (rgba[i10 + k] ?? 0) * (1 - tx) + (rgba[i11 + k] ?? 0) * tx;
    return (top * (1 - ty) + bottom * ty) / 255;
  };
  out[0] = median3(channel(0), channel(1), channel(2));
  out[1] = channel(3);
}

interface DecodeReport {
  samples: number;
  mismatches: number;
  iou: number;
  maxEdgeDistance: number;
}

interface DecodeCheck {
  grid: SampleGrid;
  truth: Uint8Array;
  msdf: Float32Array;
  alpha: Float32Array;
  rgb: DecodeReport;
  trueDistance: DecodeReport;
}

function compareMasks(grid: SampleGrid, truth: Uint8Array, decoded: Float32Array, edges: EdgeGrid): DecodeReport {
  let union = 0;
  let intersection = 0;
  let mismatches = 0;
  let maxEdgeDistance = 0;
  for (let i = 0; i < truth.length; i += 1) {
    const a = truth[i] === 1;
    const b = (decoded[i] ?? 0) >= 0.5;
    if (a || b) union += 1;
    if (a && b) intersection += 1;
    if (a === b) continue;
    mismatches += 1;
    const x = grid.x0 + (i % grid.columns) * grid.step;
    const y = grid.y0 - Math.floor(i / grid.columns) * grid.step;
    maxEdgeDistance = Math.max(maxEdgeDistance, edges.distance(x, y, PX_RANGE));
  }
  return { samples: truth.length, mismatches, iou: union === 0 ? 0 : intersection / union, maxEdgeDistance };
}

/**
 * Decodes the whole atlas at CHECK_UPSCALE (the quad shows all of it, so a stray
 * artefact anywhere would be visible) and compares it with the outline.
 *
 * The grid is aligned to texel centres so it includes the bilinear midpoints
 * (t = 0.5), where a seam between two differently saturated channels peaks at
 * median 0.5; a grid offset by half a sample never lands there and would miss it.
 * Beyond the outer texel centres the clamping sampler repeats the edge texels.
 */
function decodeCheck(rgba: Uint8Array, index: WindingIndex, edges: EdgeGrid): DecodeCheck {
  const step = 1 / CHECK_UPSCALE;
  const grid: SampleGrid = {
    columns: (atlasWidth - 1) * CHECK_UPSCALE + 1,
    rows: (atlasHeight - 1) * CHECK_UPSCALE + 1,
    x0: 0.5,
    y0: atlasHeight - 0.5,
    step,
  };
  const truth = insideMask(index, grid);
  const msdf = new Float32Array(truth.length);
  const alpha = new Float32Array(truth.length);
  const sample = new Float32Array(2);
  for (let r = 0; r < grid.rows; r += 1) {
    for (let c = 0; c < grid.columns; c += 1) {
      sampleAtlas(rgba, grid.x0 + c * step, grid.y0 - r * step, sample);
      msdf[r * grid.columns + c] = sample[0] ?? 0;
      alpha[r * grid.columns + c] = sample[1] ?? 0;
    }
  }
  return {
    grid,
    truth,
    msdf,
    alpha,
    rgb: compareMasks(grid, truth, msdf, edges),
    trueDistance: compareMasks(grid, truth, alpha, edges),
  };
}

type Rgb = readonly [number, number, number];

/** A rectangle of the check grid: the ink box plus `pad` atlas pixels. */
interface Crop {
  column: number;
  row: number;
  columns: number;
  rows: number;
}

function inkCrop(grid: SampleGrid, inkAtlas: Box, pad: number): Crop {
  const column = Math.max(0, Math.floor((inkAtlas.minX - pad - grid.x0) / grid.step));
  const row = Math.max(0, Math.floor((grid.y0 - inkAtlas.maxY - pad) / grid.step));
  return {
    column,
    row,
    columns: Math.min(grid.columns, Math.ceil((inkAtlas.maxX + pad - grid.x0) / grid.step)) - column,
    rows: Math.min(grid.rows, Math.ceil((grid.y0 - inkAtlas.minY + pad) / grid.step)) - row,
  };
}

/** `colour` receives check-grid indices; the PNG shows the crop. */
function previewPng(msdfgen: Msdfgen, module: MsdfgenModule, grid: SampleGrid, crop: Crop, colour: (i: number) => Rgb): Uint8Array {
  const rgba = new Uint8Array(crop.columns * crop.rows * 4);
  for (let r = 0; r < crop.rows; r += 1) {
    for (let c = 0; c < crop.columns; c += 1) {
      rgba.set([...colour((crop.row + r) * grid.columns + crop.column + c), 255], (r * crop.columns + c) * 4);
    }
  }
  return msdfgen.createPng(new module.Bitmap(crop.columns, crop.rows, rgba.buffer), 6);
}

/** Direct rasterisation (non-zero rule, 4x4 samples per pixel) of the outline over the crop; indexed like the check grid. */
function outlineCoverage(index: WindingIndex, grid: SampleGrid, crop: Crop): (i: number) => number {
  const ss = 4;
  const fineStep = grid.step / ss;
  const fine = insideMask(index, {
    columns: crop.columns * ss,
    rows: crop.rows * ss,
    x0: grid.x0 + crop.column * grid.step - grid.step / 2 + fineStep / 2,
    y0: grid.y0 - crop.row * grid.step + grid.step / 2 - fineStep / 2,
    step: fineStep,
  });
  return (i) => {
    const c = (i % grid.columns) - crop.column;
    const r = Math.floor(i / grid.columns) - crop.row;
    let sum = 0;
    for (let dy = 0; dy < ss; dy += 1) {
      for (let dx = 0; dx < ss; dx += 1) sum += fine[(r * ss + dy) * crop.columns * ss + c * ss + dx] ?? 0;
    }
    return sum / (ss * ss);
  };
}

function writePreviews(
  id: string,
  check: DecodeCheck,
  inkAtlas: Box,
  index: WindingIndex,
  msdfgen: Msdfgen,
  module: MsdfgenModule,
): string[] {
  const { grid, truth, msdf, alpha } = check;
  const crop = inkCrop(grid, inkAtlas, 12);
  const coverage = outlineCoverage(index, grid, crop);
  // Screen-space antialiasing as in a shader: preview pixels per unit of decoded distance.
  const pxPerUnit = PX_RANGE * CHECK_UPSCALE;
  const unit = (v: number): number => Math.max(0, Math.min(1, v));
  const rgb = (r: number, g: number, b: number): Rgb => [Math.round(unit(r) * 255), Math.round(unit(g) * 255), Math.round(unit(b) * 255)];
  const grey = (v: number): Rgb => rgb(v, v, v);
  const previews: Array<[string, (i: number) => Rgb]> = [
    ['msdf-decoded', (i) => grey(((msdf[i] ?? 0) - 0.5) * pxPerUnit + 0.5)],
    ['outline-raster', (i) => grey(coverage(i))],
    [
      'diff',
      (i) => {
        const a = truth[i] === 1;
        const b = (msdf[i] ?? 0) >= 0.5;
        if (a && b) return [190, 190, 190];
        if (b) return [255, 40, 40];
        if (a) return [40, 200, 255];
        return [0, 0, 0];
      },
    ],
    [
      'glow',
      (i) => {
        const fill = unit(((msdf[i] ?? 0) - 0.5) * pxPerUnit + 0.5);
        const glow = unit((alpha[i] ?? 0) * 2) ** 2 * 0.8;
        return rgb(Math.max(fill, glow), Math.max(fill, glow * 0.75), Math.max(fill, glow * 0.35));
      },
    ],
  ];
  mkdirSync(PREVIEW_DIR, { recursive: true });
  return previews.map(([name, colour]) => {
    const path = resolve(PREVIEW_DIR, `${id}-${name}.png`);
    writeFileSync(path, previewPng(msdfgen, module, grid, crop, colour));
    return relPath(path);
  });
}

/* ------------------------------------------------------------------ */
/* Build                                                                */
/* ------------------------------------------------------------------ */

interface CalligraphyMeta {
  id: string;
  text: string;
  verse: string;
  wordIndexFromEnd: number;
  wordCount: number;
  font: string;
  fontSha256: string;
  atlas: string;
  width: number;
  height: number;
  pxRange: number;
  aspect: number;
  bounds: { left: number; bottom: number; right: number; top: number };
  type: 'msdf' | 'mtsdf';
  flipY: boolean;
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

function formatReport(name: string, r: DecodeReport): string {
  return (
    `${name}: ${r.mismatches} of ${r.samples} samples differ from the outline ` +
    `(IoU ${r.iou.toFixed(5)}, farthest ${r.maxEdgeDistance.toFixed(3)} atlas px from the edge)`
  );
}

function buildEntry(
  entry: CalligraphyCitation,
  quran: QuranFile,
  amiri: AmiriQuranFont,
  msdfgen: Msdfgen,
  module: MsdfgenModule,
): void {
  atlasWidth = (entry.wordCount ?? 1) > 1 ? 2048 : 1024;
  atlasHeight = 512;
  const word = citedWord(quran, entry);
  console.log(`${entry.id}: word ${entry.wordIndexFromEnd} from the end of ${entry.verse} is ${describeCodePoints(word)}`);

  const face = new hb.Face(new hb.Blob(amiri.ttf));
  const font = new hb.Font(face);
  const glyphs = shapeWord(font, face, word);
  const perGlyph = glyphs.map((g) => glyphContours(font, g));
  // A space between the words of a phrase has no outline (null ink).
  const inks = perGlyph.map((contours) => (contours.length > 0 ? contourBounds(contours) : null));
  checkShaping(word, glyphs, inks);
  for (const [i, g] of glyphs.entries()) {
    const ink = inks[i];
    console.log(
      `  glyph ${g.gid} cluster ${g.cluster}${g.mark ? ' (mark)' : ''} at (${g.x}, ${g.y}); ` +
        `ink x ${ink?.minX.toFixed(0)}..${ink?.maxX.toFixed(0)}, y ${ink?.minY.toFixed(0)}..${ink?.maxY.toFixed(0)}`,
    );
  }

  const contours = perGlyph.flat();
  const ink = contourBounds(contours);
  const layout = fitLayout(ink);
  const rgba = generateMsdf(msdfgen, contours, ink, layout);

  const atlasContours = mapContours(contours, (p) => ({ x: p.x * layout.scale + layout.offsetX, y: p.y * layout.scale + layout.offsetY }));
  const inkAtlas = contourBounds(atlasContours);
  const pieces = flatten(atlasContours, 0.1, 1e-3);
  const index = new WindingIndex(pieces, atlasHeight);
  const edges = new EdgeGrid(boundaryPieces(pieces, index), atlasWidth);
  writeTrueDistanceAlpha(rgba, index, edges);

  const check = decodeCheck(rgba, index, edges);
  console.log(`  ${formatReport(`MSDF median at ${CHECK_UPSCALE}x`, check.rgb)}`);
  console.log(`  ${formatReport(`true-distance alpha at ${CHECK_UPSCALE}x`, check.trueDistance)}`);
  for (const path of writePreviews(entry.id, check, inkAtlas, index, msdfgen, module)) console.log(`  preview ${path}`);
  // The tolerance is a share of the atlas width (0.35 px of 1024), so a wider phrase atlas is held to the same accuracy on screen.
  const tolerance = EDGE_TOLERANCE * (atlasWidth / 1024);
  if (Math.max(check.rgb.maxEdgeDistance, check.trueDistance.maxEdgeDistance) > tolerance) {
    throw new Error(`${entry.id}: the atlas does not reproduce the outline (tolerance ${tolerance} px); nothing was written`);
  }

  const meta: CalligraphyMeta = {
    id: entry.id,
    text: word,
    verse: entry.verse,
    wordIndexFromEnd: entry.wordIndexFromEnd,
    wordCount: entry.wordCount ?? 1,
    font: amiri.label,
    fontSha256: amiri.ttfSha256,
    atlas: `${entry.id}.png`,
    width: atlasWidth,
    height: atlasHeight,
    pxRange: PX_RANGE,
    aspect: atlasWidth / atlasHeight,
    bounds: {
      left: round6(inkAtlas.minX / atlasWidth),
      bottom: round6(inkAtlas.minY / atlasHeight),
      right: round6(inkAtlas.maxX / atlasWidth),
      top: round6(inkAtlas.maxY / atlasHeight),
    },
    type: 'mtsdf',
    flipY: false,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const pngPath = resolve(OUT_DIR, meta.atlas);
  writeFileSync(pngPath, msdfgen.createPng(new module.Bitmap(atlasWidth, atlasHeight, rgba.slice().buffer), 9));
  const jsonPath = resolve(OUT_DIR, `${entry.id}.json`);
  writeJson(jsonPath, meta);
  console.log(`  wrote ${relPath(pngPath)} and ${relPath(jsonPath)}`);
}

async function main(): Promise<void> {
  const entries = calligraphyCitations(loadCitations());
  if (entries.length === 0) throw new Error('data/citations.json lists no calligraphy entries');
  const quran = readJson(QURAN_PATH) as QuranFile;
  const amiri = await loadAmiriQuran();
  const { msdfgen, module } = await createMsdfgen();
  console.log(`shaping with ${amiri.label} (sha256 ${amiri.ttfSha256}), HarfBuzz ${hb.versionString()}`);
  for (const entry of entries) buildEntry(entry, quran, amiri, msdfgen, module);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
