/**
 * The small worlds (src/explore/worlds), from the committed files:
 *
 * - Kepler's equation as the GPU solves it (Danby's starter, four Halley steps) against a solve to
 *   convergence, for eccentricities up to 0.97;
 * - the named worlds' places against JPL Horizons (tests/support/astro/horizons-smallbodies.json, from
 *   scripts/smallbodies/build.py fixtures) on 2026-10-26 and 2035-01-01. Tolerances: the asteroids'
 *   two-body orbits from the Small-Body Database's 2026 elements drift from Horizons' integration by
 *   the planets' pulls, about 0.35 degree over the nine years for Ceres (0.5 allowed); Halley, far from
 *   the planets, 0.5; 67P/Churyumov-Gerasimenko, whose orbit Jupiter and its own outgassing change, 3
 *   degrees in 2026 only (by 2035 it is tens of degrees off: the panel says comets drift more). The
 *   moons' mean elements, fitted to Horizons in 2026 and 2034, within 3 degrees as seen from their
 *   planet (Mimas and Hyperion librate more, and are not checked); Triton, whose orbit's plane turns
 *   about Neptune's precessing pole, within 10;
 * - the H, G magnitude law (Bowell et al. 1989) at zero phase and at 90 degrees, worked by hand;
 * - the asteroid files: brightest first, every record a closed orbit, the classes' counts and the
 *   files' sha256 as the manifest records them, and the GPU's twin of a point's place agreeing with
 *   the exact solve;
 * - the sky's glow models: the Milky Way brightest toward its centre and in its plane, darkened along
 *   the plane by its dust; the zodiacal light brightest near the Sun, with the gegenschein opposite it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { milkyWayAlong, zodiacalAlong } from '../../src/explore/worlds/glow';
import { beltPosition, decodeRecord, eccentricAnomaly, heliocentric, hgMagnitude, moonOffset, perifocal, RECORD_BYTES, solveKeplerExact, type BeltManifest, type BeltRecord, type WorldElements } from '../../src/explore/worlds/orbits';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string): Uint8Array => readFileSync(new URL(path, ROOT));
const json = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const AU_KM = 149_597_870.7;
const OBLIQUITY = (84381.448 / 3600) * (Math.PI / 180);
const fixture = json('tests/support/astro/horizons-smallbodies.json') as { epochsJdTdb: number[]; objects: Record<string, { km: number[][] }> };
const worlds = (json('public/assets/smallbodies/worlds.json') as { worlds: Array<{ name: string; elements: WorldElements }> }).worlds;
const manifest = json('public/assets/smallbodies/manifest.json') as BeltManifest & { counts: Record<string, number> };
const angleDeg = (a: readonly number[], b: readonly number[]): number => {
  const c = ((a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0)) / (Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0) * Math.hypot(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};
const world = (name: string): WorldElements => {
  const w = worlds.find((x) => x.name === name || x.name.startsWith(`${name}/`));
  if (!w) throw new Error(`no world ${name}`);
  return w.elements;
};
/** Where the explorer puts a world on a date: heliocentric (km) or from its planet (km), ecliptic J2000. */
const place = (name: string, jd: number): number[] => {
  const el = world(name);
  const out = [0, 0, 0];
  if (el.aKm) return moonOffset(el, jd, OBLIQUITY, out);
  heliocentric(el, jd, out);
  return out.map((v) => v * AU_KM);
};

test('Kepler’s equation as the GPU solves it: within a millionth of a radian of the exact solve, up to e = 0.97', () => {
  let worst = 0;
  for (let e = 0; e <= 0.97001; e += 0.01) {
    for (let k = -720; k <= 720; k += 1) {
      const m = (k * Math.PI) / 180 + 0.0137;
      const fast = eccentricAnomaly(m, e);
      const exact = solveKeplerExact(m, e);
      const d = Math.abs(Math.atan2(Math.sin(fast - exact), Math.cos(fast - exact)));
      worst = Math.max(worst, d);
    }
  }
  expect(worst).toBeLessThan(1e-6);
});

test('the asteroids and comets against JPL Horizons, on two dates', () => {
  const limits: Record<string, readonly [number, number | null]> = { Ceres: [0.5, 0.5], Vesta: [0.5, 0.5], Hektor: [0.5, 0.5], Eris: [0.5, 0.5], '1P': [0.5, 0.5], '67P': [3, null] };
  for (const [name, [first, second]] of Object.entries(limits)) {
    const ref = fixture.objects[name]?.km ?? [];
    fixture.epochsJdTdb.forEach((jd, k) => {
      const limit = k === 0 ? first : second;
      if (limit === null) return;
      const r = ref[k] ?? [1, 0, 0];
      expect(angleDeg(place(name, jd), r), `${name} on ${jd}`).toBeLessThan(limit);
      // And at its distance from the Sun, within 1% (the same drift, along the orbit).
      // 67P's distance drifts most: its outgassing at its 2021 perihelion changed its orbit (10% allowed in 2026).
      expect(Math.abs(Math.hypot(...place(name, jd)) / Math.hypot(...r) - 1), `${name} distance on ${jd}`).toBeLessThan(name === '67P' ? 0.1 : name === '1P' ? 0.06 : 0.01);
    });
  }
});

test('the moons against JPL Horizons, on two dates, as seen from their planets', () => {
  const limits: Record<string, number> = { Io: 3, Titan: 3, Oberon: 3, Phobos: 3, Charon: 3, Triton: 10 };
  for (const [name, limit] of Object.entries(limits)) {
    fixture.epochsJdTdb.forEach((jd, k) => {
      const ref = fixture.objects[name]?.km[k] ?? [1, 0, 0];
      const mine = place(name, jd);
      expect(angleDeg(mine, ref), `${name} on ${jd}`).toBeLessThan(limit);
      expect(Math.abs(Math.hypot(...mine) / Math.hypot(...ref) - 1), `${name} distance on ${jd}`).toBeLessThan(0.04);
    });
  }
});

test('the H, G magnitude law: H at 1 au from both at zero phase, and 3.18 magnitudes fainter at 90 degrees for G = 0.15', () => {
  expect(hgMagnitude(3.34, 0.12, 1, 1, 0)).toBeCloseTo(3.34, 9);
  // Ceres at opposition, 2.77 au from the Sun and 1.77 from the Earth: H + 5 log10(4.9029).
  expect(hgMagnitude(3.34, 0.12, 2.77, 1.77, 0)).toBeCloseTo(3.34 + 5 * Math.log10(2.77 * 1.77), 9);
  // At 90 degrees, tan(45) = 1: phi1 = e^-3.33, phi2 = e^-1.87, 0.85 phi1 + 0.15 phi2 = 0.05355.
  const phi = 0.85 * Math.exp(-3.33) + 0.15 * Math.exp(-1.87);
  expect(hgMagnitude(10, 0.15, 1, 1, Math.PI / 2) - 10).toBeCloseTo(-2.5 * Math.log10(phi), 9);
  expect(-2.5 * Math.log10(phi)).toBeCloseTo(3.18, 2);
  // Fainter as the phase opens.
  let last = -Infinity;
  for (let a = 0; a < 170; a += 5) {
    const v = hgMagnitude(10, 0.15, 1, 1, (a * Math.PI) / 180);
    expect(v).toBeGreaterThan(last);
    last = v;
  }
});

test('the asteroid files: brightest first, closed orbits, the classes and sha256 the manifest records, the GPU twin exact', () => {
  const record: BeltRecord = { a: 0, e: 0, i: 0, node: 0, peri: 0, m0: 0, h: 0, cls: 0 };
  const counts: Record<string, number> = {};
  let lastH = -Infinity;
  for (const tier of manifest.tiers) {
    const bytes = read(`public/assets/smallbodies/${tier.file}`);
    expect(bytes.length).toBe(tier.count * RECORD_BYTES);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(tier.sha256);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let k = 0; k < tier.count; k += 1) {
      decodeRecord(view, k, record);
      // (Checked without expect: half a million records.)
      if (record.h < lastH - 0.01) throw new Error(`record ${k} of ${tier.file}: H ${record.h} after ${lastH}`);
      lastH = record.h;
      if (record.e >= 1 || !(record.a > 0)) throw new Error(`record ${k} of ${tier.file}: a ${record.a}, e ${record.e}`);
      const cls = manifest.classes[record.cls] ?? 'AST';
      counts[cls] = (counts[cls] ?? 0) + 1;
    }
    expect(lastH).toBeLessThanOrEqual(tier.hMax + 0.01);
  }
  expect(counts).toEqual(manifest.counts);
  // The GPU's twin against the exact two-body place for the first record, a decade on.
  const firstBytes = read(`public/assets/smallbodies/${manifest.tiers[0]?.file ?? ''}`);
  const first = new DataView(firstBytes.buffer, firstBytes.byteOffset, firstBytes.byteLength);
  decodeRecord(first, 0, record);
  const twin = beltPosition(record, 3652.5, [0, 0, 0]);
  const p = [0, 0, 0];
  const q = [0, 0, 0];
  perifocal(record.a, record.e, record.i, record.node, record.peri, p, q);
  const E = solveKeplerExact(record.m0 + (0.01720209895 / record.a ** 1.5) * 3652.5, record.e);
  const exact = [0, 1, 2].map((j) => (p[j] ?? 0) * (Math.cos(E) - record.e) + (q[j] ?? 0) * Math.sin(E));
  expect(Math.hypot(...twin.map((v, j) => v - (exact[j] ?? 0)))).toBeLessThan(1e-9);
});

test('the Milky Way’s glow: brightest toward the centre and along the plane, the dust lane darker; the zodiacal light near the Sun, the gegenschein opposite', () => {
  const deg = Math.PI / 180;
  const centre = milkyWayAlong(0, 3 * deg);
  const anti = milkyWayAlong(180 * deg, 0);
  const pole = milkyWayAlong(0, 90 * deg);
  // Pioneer 10's maps of the integrated starlight give the inner Galaxy near the plane three to five times the anticentre's.
  expect(centre).toBeGreaterThan(3 * anti);
  expect(anti).toBeGreaterThan(2 * pole);
  // The dust: in the plane toward the centre, darker than just off it.
  expect(milkyWayAlong(0, 0)).toBeLessThan(milkyWayAlong(0, 3 * deg));
  const z = (elongationDeg: number, betaDeg = 0): number => zodiacalAlong(elongationDeg * deg, betaDeg * deg);
  expect(z(30)).toBeGreaterThan(3 * z(90));
  expect(z(90)).toBeGreaterThan(z(90, 60));
  expect(z(180)).toBeGreaterThan(z(150));
});
