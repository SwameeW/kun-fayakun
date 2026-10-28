/**
 * Chapter 2's polarisation lines (scripts/cmb/polarisation.py, src/chapters/ch02): they come onto the
 * globe only after the verse and are held to the end; the published texture shares the temperature
 * map's grid and orientation (cmb.json); the pipeline's checks of the conventions against the sky held
 * when it was built; and their words live in Chapter 2's own messages and the Discover dock's.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { ChapterContent, Cue, SourcesFile } from '../../src/core/types';
import { bannedPhrasesIn } from '../../src/core/phrasing';
import { CMB_LINES } from '../../src/chapters/ch02/lines-window';
import { checkLinesWindow, linesAt } from '../../src/chapters/ch02/timing';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const content = readJson('src/chapters/ch02/content.json') as ChapterContent;
const cmb = readJson('public/assets/cmb/cmb.json') as Record<string, unknown> & { temperature: { width: number; height: number } };
const lines = readJson('public/assets/cmb/cmb-polarisation.json') as Record<string, unknown> & {
  file: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  filter: { signalFraction: number };
  verification: {
    stack: {
      pass: boolean;
      hot: Record<string, number>;
      cold: Record<string, number>;
    };
    orientation: { agreement: number; controlMirroredLon: number; pass: boolean };
    losslessRoundTrip: boolean;
    neutralWhereMasked: boolean;
  };
};

const verse = content.cues.find((c): c is Extract<Cue, { type: 'verse' }> => c.type === 'verse');

test('the lines come in only after the verse (41:11, 46 to 72 s) and its lead-in, ease in by 77 s and hold to the end', () => {
  expect(verse?.key).toBe('41:11');
  const verseEnd = (verse?.t ?? 0) + (verse?.duration ?? 0);
  expect(verseEnd).toBe(72);
  expect(CMB_LINES).toEqual({ chapter: 'ch02', from: 73, to: 77 });
  // Nothing at all before 73 s, so nothing under the verse or in the 2 s before it.
  for (let t = 0; t <= 73; t += 0.05) expect(linesAt(t), `t = ${t.toFixed(2)}`).toBe(0);
  // An ease: rising, never stepping, full at 77 s and held to the chapter's end.
  let previous = 0;
  for (let t = 73; t <= 77; t += 0.05) {
    const s = linesAt(t);
    expect(s).toBeGreaterThanOrEqual(previous);
    expect(s - previous, `step at ${t.toFixed(2)}`).toBeLessThan(0.06);
    previous = s;
  }
  for (let t = 77; t <= content.duration; t += 0.5) expect(linesAt(t)).toBe(1);
  expect(() => {
    checkLinesWindow(content.cues, content.duration);
  }).not.toThrow();
});

test('a verse or hadith moved under the lines, or to start within 2 s of them, is a content error', () => {
  const moved = (t: number): Cue[] => content.cues.map((c) => (c.type === 'verse' ? { ...c, t, duration: 6 } : c));
  expect(() => {
    checkLinesWindow(moved(78), content.duration);
  }).toThrow(/41:11/);
  // Its card would start 2 s after the lines begin: inside their window's quiet lead-in.
  expect(() => {
    checkLinesWindow(moved(75), content.duration);
  }).toThrow();
  const hadith: Cue = { t: 80, type: 'hadith', id: 'bukhari:1', duration: 5 };
  expect(() => {
    checkLinesWindow([...content.cues, hadith], content.duration);
  }).toThrow(/hadith/);
});

test('the published lines share the temperature map’s grid and orientation, as cmb.json gives them', () => {
  for (const key of ['projection', 'frame', 'uAtLon0', 'lonIncreases'] as const) expect(lines[key], key).toBe(cmb[key]);
  expect([lines.width, lines.height]).toEqual([cmb.temperature.width, cmb.temperature.height]);
  const bytes = readFileSync(new URL(`public/assets/cmb/${lines.file}`, ROOT));
  expect(bytes.length).toBe(lines.bytes);
  // KTX2 header: R8_UNORM (vkFormat 9), the size above, zstd (2), rows bottom-up ("ru").
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(12, true)).toBe(9);
  expect(view.getUint32(20, true)).toBe(lines.width);
  expect(view.getUint32(24, true)).toBe(lines.height);
  expect(view.getUint32(44, true)).toBe(2);
  const kvOffset = view.getUint32(56, true);
  const kvLength = view.getUint32(60, true);
  const kv = new TextDecoder('latin1').decode(bytes.subarray(kvOffset, kvOffset + kvLength));
  expect(kv).toContain('KTXorientation\u0000ru');
  // At most a megabyte more for Chapter 2 to load.
  expect(lines.bytes).toBeLessThan(1_100_000);
});

test('the file is the one the manifest describes', async () => {
  const bytes = readFileSync(new URL(`public/assets/cmb/${lines.file}`, ROOT));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  expect([...digest].map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(lines.sha256);
});

test('the conventions were checked against the sky when the lines were built', () => {
  const { stack, orientation } = lines.verification;
  // Around hot spots the light is polarised tangentially at about 0.6 degrees and radially at about
  // 1.2 degrees, around cold spots the reverse (Komatsu et al. 2011; Planck 2015 results XVI): the
  // same direction code as the lines' reproduces both, many standard errors clear of zero.
  expect(stack.pass).toBe(true);
  expect(stack.hot.at0p6).toBeLessThan(0);
  expect(stack.hot.at1p2).toBeGreaterThan(0);
  expect(stack.cold.at0p6).toBeGreaterThan(0);
  expect(stack.cold.at1p2).toBeLessThan(0);
  for (const s of [stack.hot, stack.cold]) {
    expect(s.sigma0p6).toBeGreaterThan(10);
    expect(s.sigma1p2).toBeGreaterThan(10);
    // With U's sign left as the file has it (COSMO read as IAU, the same as a mirrored longitude) the rings vanish.
    expect(Math.abs(s.controlCosmoSign0p6 ?? Infinity)).toBeLessThan(0.1 * Math.abs(s.at0p6 ?? 0));
    expect(Math.abs(s.controlCosmoSign1p2 ?? Infinity)).toBeLessThan(0.1 * Math.abs(s.at1p2 ?? 0));
  }
  // Read back from the published file through cmb.json's (u, v), the lines follow the field; mirrored, they do not.
  expect(orientation.pass).toBe(true);
  expect(orientation.agreement).toBeGreaterThan(0.7);
  expect(Math.abs(orientation.controlMirroredLon)).toBeLessThan(0.2);
  expect(lines.verification.losslessRoundTrip).toBe(true);
  expect(lines.verification.neutralWhereMasked).toBe(true);
  // What the lines follow is Planck's best estimate, and the share of it that is signal is on record.
  expect(lines.filter.signalFraction).toBeGreaterThan(0.4);
});

test('their words: the legend’s line with the chapter, the card beside Chapter 2’s, the source listed', () => {
  const ch02 = readJson('src/i18n/en.ch02.json') as Record<string, string>;
  const eager = readJson('src/i18n/en.json') as Record<string, string>;
  const discover = readJson('src/i18n/en.discover.json') as Record<string, string>;
  expect(ch02['ch02.cmb.lines']).toBe('Lines: direction of polarisation (Planck)');
  expect(Object.keys(eager).filter((k) => k.startsWith('ch02.cmb'))).toEqual([]);
  const point = content.explore.points?.find((p) => p.id === 'lines');
  expect(point?.kind).toBe('measured');
  expect(point?.t).toBeGreaterThanOrEqual(CMB_LINES.to);
  expect(point?.t).toBeLessThanOrEqual(content.duration);
  expect(point?.text.cite).toEqual(['planck-pr3-smica', 'hu-white-1997']);
  const keys = Object.keys(discover);
  expect(keys.indexOf('discover.ch02.lines.title')).toBe(keys.indexOf('discover.ch02.globe.text') + 1);
  for (const text of [ch02['ch02.cmb.lines'], discover['discover.ch02.lines.title'], discover['discover.ch02.lines.text']]) {
    expect(text).toBeTruthy();
    expect(bannedPhrasesIn(text ?? '')).toEqual([]);
  }
  const sources = readJson('data/sources.json') as SourcesFile;
  expect(sources.sources.map((s) => s.id)).toContain('hu-white-1997');
});
