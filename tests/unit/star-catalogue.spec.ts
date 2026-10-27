/**
 * The deep star catalogue (public/assets/stars/catalogue.json and its packs, src/explore/neighbourhood/
 * catalogue.ts): the packs decoded as the worker decodes them; Hipparcos's stars placed only where the
 * parallax is five times its error, the neighbourhood's own left out by number (none drawn twice) and
 * no Hipparcos number among the directions twice; the octahedral directions unit vectors to some ten
 * arcseconds; Tycho-2's stars brightest first. And the names that never overlap
 * (src/explore/neighbourhood/labels.ts), and a star's size from its light and colour
 * (src/explore/neighbourhood/surface.ts).
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { decodePack, renderDirection, unpackDirection, vOf, type CatalogueManifest } from '../../src/explore/neighbourhood/catalogue';
import type { NeighbourhoodFile } from '../../src/explore/neighbourhood/data';
import { placeLabels, tagBox } from '../../src/explore/neighbourhood/labels';
import { bolometricCorrection, estimatedRadius } from '../../src/explore/neighbourhood/surface';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string): ArrayBuffer => {
  const b = readFileSync(new URL(path, ROOT));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const manifest = JSON.parse(readFileSync(new URL('public/assets/stars/catalogue.json', ROOT), 'utf8')) as CatalogueManifest;
const hood = JSON.parse(readFileSync(new URL('public/assets/stars/neighbourhood.json', ROOT), 'utf8')) as NeighbourhoodFile;
const OBLIQUITY = (23.4392911 * Math.PI) / 180;
const LUT = new Uint8Array(256 * 3).fill(200);

test('Hipparcos’s other stars: placed where the parallax is five times its error, the neighbourhood’s left out, none twice', () => {
  const pack = manifest.packs.find((p) => p.kind === 'hipparcos');
  if (!pack) throw new Error('no Hipparcos pack');
  const buffer = read(`public/assets/stars/${pack.file}`);
  const exclude = new Set(hood.stars.map((s) => s[0]));
  const all = decodePack('hipparcos', buffer, pack.count, OBLIQUITY, LUT, new Set());
  const without = decodePack('hipparcos', buffer, pack.count, OBLIQUITY, LUT, exclude);
  expect(all.placedHip.length + all.farHip.length).toBe(pack.count);
  // The neighbourhood's own (the stars within 25 pc not in the Bright Star Catalogue) are in the pack for the sky, left out among the stars.
  const placed = new Set(without.placedHip);
  const far = new Set(without.farHip);
  expect([...exclude].filter((hip) => placed.has(hip) || far.has(hip))).toEqual([]);
  expect([...placed].filter((hip) => far.has(hip))).toEqual([]);
  expect(placed.size).toBe(without.placedHip.length);
  expect(placed.size).toBeGreaterThan(45_000);
  // Each placed star's parallax at least five times its error: its distance and absolute magnitude agree with the record.
  const view = new DataView(buffer);
  const byHip = new Map<number, number>();
  for (let k = 0; k < pack.count; k += 1) byHip.set(view.getUint32(k * 16, true), k);
  for (let k = 0; k < without.placedHip.length; k += 97) {
    const i = byHip.get(without.placedHip[k] ?? 0) ?? -1;
    const plx = view.getFloat32(i * 16 + 8, true);
    const ePlx = view.getUint16(i * 16 + 12, true) / 100;
    expect(plx / ePlx).toBeGreaterThanOrEqual(5);
    const d = Math.hypot(without.placed[k * 4] ?? 0, without.placed[k * 4 + 1] ?? 0, without.placed[k * 4 + 2] ?? 0);
    expect(d).toBeCloseTo(1000 / plx, 2);
    expect(without.placed[k * 4 + 3] ?? 0).toBeCloseTo(vOf(view.getUint8(i * 16 + 14)) - 5 * Math.log10(d / 10), 4);
  }
});

test('Tycho-2’s stars: directions to some ten arcseconds, brightest first, as many as the manifest says', () => {
  let previous = -Infinity;
  let total = 0;
  for (const pack of manifest.packs.filter((p) => p.kind === 'tycho2')) {
    const buffer = read(`public/assets/stars/${pack.file}`);
    expect(buffer.byteLength).toBe(pack.count * 6);
    total += pack.count;
    // The first pack decoded as the worker does; every pack's magnitudes in order across them.
    const p = pack.file === 'tycho2-0.bin' ? decodePack('tycho2', buffer, pack.count, OBLIQUITY, LUT, new Set()) : null;
    if (p) expect(p.far.length / 2).toBe(pack.count);
    const bytes = new Uint8Array(buffer);
    for (let k = 0; k < pack.count; k += 1013) {
      const v = vOf(bytes[k * 6 + 4] ?? 0);
      expect(v).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = v;
      if (!p) continue;
      expect(vOf(p.farColour[k * 4 + 3] ?? 0)).toBe(v);
      const d = unpackDirection(p.far[k * 2] ?? 0, p.far[k * 2 + 1] ?? 0);
      expect(Math.hypot(...d)).toBeCloseTo(1, 9);
      expect(Math.hypot(...renderDirection(d, OBLIQUITY))).toBeCloseTo(1, 9);
    }
  }
  expect(total).toBe(manifest.counts.tycho2);
  expect(total).toBeGreaterThan(2_400_000);
  // The packing's worst error: over a grid of directions, under 15 arcseconds (a twentieth of a pixel at the explorer's widest view).
  let worst = 0;
  for (let i = 0; i < 60; i += 1)
    for (let j = 0; j < 30; j += 1) {
      const ra = (i / 60) * 2 * Math.PI;
      const dec = (j / 29 - 0.5) * Math.PI * 0.999;
      const v: [number, number, number] = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
      const s = Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]);
      let x = v[0] / s;
      let y = v[1] / s;
      if (v[2] < 0) [x, y] = [(1 - Math.abs(y)) * (x >= 0 ? 1 : -1), (1 - Math.abs(x)) * (y >= 0 ? 1 : -1)];
      const back = unpackDirection(Math.round(((x + 1) / 2) * 65535), Math.round(((y + 1) / 2) * 65535));
      worst = Math.max(worst, Math.acos(Math.min(1, back[0] * v[0] + back[1] * v[1] + back[2] * v[2])));
    }
  expect((worst * 180 * 3600) / Math.PI).toBeLessThan(15);
});

test('names: the most important first, none over another, none outside the clear part of the view, at most as many as asked', () => {
  const area = { left: 0, top: 0, right: 600, bottom: 400 };
  const candidates = [
    { id: 'focus', text: 'Sirius', x: 300, y: 200 },
    { id: 'overlapping', text: 'Adhara', x: 305, y: 203 },
    { id: 'clear', text: 'Procyon', x: 100, y: 300 },
    { id: 'outside', text: 'Rigel', x: 590, y: 300 },
    { id: 'high', text: 'Canopus', x: 100, y: 5 },
    { id: 'far', text: 'Betelgeuse', x: 450, y: 100 },
  ];
  const placed = placeLabels(candidates, area, 10);
  expect(placed).toEqual(['focus', 'clear', 'far']);
  expect(placeLabels(candidates, area, 2)).toEqual(['focus', 'clear']);
  const boxes = placed.map((id) => tagBox(candidates.find((c) => c.id === id) ?? { id, text: '', x: 0, y: 0 }));
  for (let i = 0; i < boxes.length; i += 1)
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a && b) expect(a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom).toBe(false);
    }
});

test('a star’s size from its light and colour (Torres 2010’s bolometric corrections): the Sun’s 1, Sirius’s about 1.7', () => {
  expect(bolometricCorrection(5772)).toBeCloseTo(-0.08, 1);
  expect(estimatedRadius(4.81, 5772)).toBeCloseTo(1, 1);
  expect(Math.abs(estimatedRadius(4.81, 5772) - 1)).toBeLessThan(0.05);
  // Sirius: V -1.46 at 2.637 pc, B-V 0.009 (about 10,000 K): 1.71 Suns measured (Kervella et al. 2003).
  const sirius = estimatedRadius(-1.46 - 5 * Math.log10(2.637 / 10), 10_000);
  expect(Math.abs(sirius - 1.71) / 1.71).toBeLessThan(0.15);
});
