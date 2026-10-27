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
 *   files' sha256 as the manifest records them, and the CPU twin of the GPU's solve agreeing with the
 *   exact one (the GPU's own answer is read back in tests/explore/small-worlds.spec.ts);
 * - points of the files as quantised (Juno, Hilda, Achilles, Ixion: manifest.json `checks`) against
 *   Horizons on both dates;
 * - the real structure in the files: the main belt an annulus from about 2.1 to 3.3 au, the Kirkwood
 *   gaps where Jupiter's resonances clear the orbits (3:1, 5:2, 7:3, 2:1), and Jupiter's Trojans in two
 *   clouds 60 degrees ahead of and behind Jupiter;
 * - the sky's glow models: the Milky Way brightest toward its centre and in its plane, darkened along
 *   the plane by its dust; the zodiacal light brightest near the Sun, with the gegenschein opposite it;
 *   the zodiacal light shown only between 0.3 and 3 au, the glow never lifted as the exposure closes,
 *   and the sphere's texture coordinates as three's SphereGeometry has them;
 * - the boxes the worlds' names keep off discs and Saturn's rings with.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { SphereGeometry } from 'three';
import { glowLight, milkyWayAlong, skyUv, zodiacalAlong, zodiacalScale } from '../../src/explore/worlds/glow';
import { boxMeetsCircle, boxMeetsConvex } from '../../src/explore/worlds/screen';
import { beltPosition, decodeRecord, eccentricAnomaly, heliocentric, hgMagnitude, moonOffset, perifocal, RECORD_BYTES, solveKeplerExact, type BeltManifest, type BeltRecord, type WorldElements } from '../../src/explore/worlds/orbits';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string): Uint8Array => readFileSync(new URL(path, ROOT));
const json = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const AU_KM = 149_597_870.7;
const OBLIQUITY = (84381.448 / 3600) * (Math.PI / 180);
const fixture = json('tests/support/astro/horizons-smallbodies.json') as { epochsJdTdb: number[]; objects: Record<string, { km: number[][] }> };
const worlds = (json('public/assets/smallbodies/worlds.json') as { worlds: Array<{ name: string; elements: WorldElements }> }).worlds;
const manifest = json('public/assets/smallbodies/manifest.json') as BeltManifest & { counts: Record<string, number>; checks: Record<string, number> };
/** Every record of the asteroid files, decoded (half a million). */
const records = ((): BeltRecord[] => {
  const out: BeltRecord[] = [];
  for (const tier of manifest.tiers) {
    const bytes = read(`public/assets/smallbodies/${tier.file}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let k = 0; k < tier.count; k += 1) out.push(decodeRecord(view, k, { a: 0, e: 0, i: 0, node: 0, peri: 0, m0: 0, h: 0, cls: 0 }));
  }
  return out;
})();
const classOf = (r: BeltRecord): string => manifest.classes[r.cls] ?? 'AST';
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

test('points of the asteroid files, as quantised, against JPL Horizons on two dates', () => {
  // In 2026, near the files' epoch (2026-06-23), what is left is the quantising: angles in steps of
  // 9.6e-5 radians (0.0055 degree). By 2035 the two-body orbits drift as the planets pull: Juno, Achilles
  // and Ixion by under a tenth of a degree; Hilda, held in step with Jupiter (the 3:2 resonance), by
  // 1.65 degrees (the panel's note says the Hildas and comets drift most).
  const limits: Record<string, readonly [number, number]> = { Juno: [0.01, 0.15], Hilda: [0.01, 2], Achilles: [0.01, 0.2], Ixion: [0.01, 0.1] };
  for (const [name, [first, second]] of Object.entries(limits)) {
    const index = manifest.checks[name];
    const record = index === undefined ? undefined : records[index];
    if (!record) throw new Error(`no record for ${name}`);
    fixture.epochsJdTdb.forEach((jd, k) => {
      const ref = fixture.objects[name]?.km[k] ?? [1, 0, 0];
      const mine = beltPosition(record, jd - manifest.epochJdTdb, [0, 0, 0]).map((v) => v * AU_KM);
      expect(angleDeg(mine, ref), `${name} on ${jd}`).toBeLessThan(k === 0 ? first : second);
      expect(Math.abs(Math.hypot(...mine) / Math.hypot(...ref) - 1), `${name} distance on ${jd}`).toBeLessThan(0.01);
    });
  }
});

test('the real structure in the files: the main belt an annulus, the Kirkwood gaps, the Trojans in two clouds about Jupiter', () => {
  const main = records.filter((r) => classOf(r) === 'MBA');
  expect(main.length).toBeGreaterThan(400_000);
  // Where they are at the files' epoch: an annulus, nearly all between 1.8 and 4 au from the Sun (their
  // orbits' eccentricities spread them), most between 2 and 3.5, none near the Sun.
  const p = [0, 0, 0];
  const distances = main.map((r) => Math.hypot(...beltPosition(r, 0, p)));
  const share = (lo: number, hi: number): number => distances.filter((d) => d > lo && d < hi).length / distances.length;
  expect(share(1.8, 4)).toBeGreaterThan(0.98);
  expect(share(2, 3.5)).toBeGreaterThan(0.85);
  expect(share(0, 1.5)).toBeLessThan(0.0005);
  // The gaps, in the orbits' sizes (bins of 0.005 au): at each of Jupiter's 3:1, 5:2, 7:3 and 2:1
  // resonances, within 0.01 au of it, a bin holding under half the mean of the bins 0.03 to 0.06 au on
  // either side (the 7:3 gap is the narrowest and shallowest: 465 against about 1,700).
  const bins = new Map<number, number>();
  for (const r of records) {
    const b = Math.floor(r.a / 0.005);
    bins.set(b, (bins.get(b) ?? 0) + 1);
  }
  const bin = (au: number): number => bins.get(Math.floor(au / 0.005)) ?? 0;
  for (const gap of [2.502, 2.825, 2.958, 3.279]) {
    const least = Math.min(...[-0.01, -0.005, 0, 0.005, 0.01].map((d) => bin(gap + d)));
    const near = [-0.06, -0.05, -0.04, -0.03, 0.03, 0.04, 0.05, 0.06].map((d) => bin(gap + d));
    const mean = near.reduce((a, b) => a + b, 0) / near.length;
    expect(least, `the gap at ${gap} au`).toBeLessThan(mean / 2);
  }
  // Jupiter's Trojans: their mean longitudes 60 degrees ahead (L4) and behind (L5) Jupiter's, which
  // is 34.39644051 + 3034.74612775 T degrees, T in centuries from J2000 (JPL's "Keplerian Elements for
  // Approximate Positions of the Major Planets", Standish, 1800 to 2050).
  const t = (manifest.epochJdTdb - 2451545) / 36525;
  const jupiter = 34.39644051 + 3034.74612775 * t;
  const trojans = records.filter((r) => classOf(r) === 'TJN');
  expect(trojans.length).toBeGreaterThan(10_000);
  const ahead = (r: BeltRecord): number => {
    const l = ((r.node + r.peri + r.m0) * 180) / Math.PI - jupiter;
    return ((((l + 180) % 360) + 360) % 360) - 180;
  };
  const cloud = (lo: number, hi: number): number => trojans.filter((r) => ahead(r) >= lo && ahead(r) <= hi).length / trojans.length;
  expect(cloud(35, 85)).toBeGreaterThan(0.4);
  expect(cloud(-85, -35)).toBeGreaterThan(0.3);
  // None near Jupiter itself, few opposite it.
  expect(cloud(-20, 20)).toBeLessThan(0.005);
  expect(cloud(150, 180) + cloud(-180, -150)).toBeLessThan(0.02);
});

test('the glow: the zodiacal light shown only from 0.3 to 3 au, never lifted as the exposure closes; the sphere’s coordinates as three’s', () => {
  expect(zodiacalScale(1)).toBeCloseTo(1, 9);
  expect(zodiacalScale(0.5)).toBeCloseTo(0.5 ** -2.3, 6);
  expect(zodiacalScale(2)).toBeCloseTo(2 ** -2.3, 6);
  // Inside 0.2 au (the Sun's own views: 2.6 million km is 0.017 au) and past 3.3 au, none.
  for (const au of [0.0174, 0.1, 0.2, 3.3, 5, 30]) expect(zodiacalScale(au), `at ${au} au`).toBe(0);
  // Coming in and going out smoothly, never above its value at 0.3 au.
  let last = 0;
  for (let au = 0.2; au <= 0.3; au += 0.005) {
    expect(zodiacalScale(au)).toBeGreaterThanOrEqual(last - 1e-9);
    last = zodiacalScale(au);
  }
  for (let au = 0.2; au < 4; au += 0.01) expect(zodiacalScale(au)).toBeLessThanOrEqual(zodiacalScale(0.3) + 1e-9);
  // Held with the stars as the exposure opens; at most the stars' light as it closes (a solar filter's 1e-4 included).
  expect(glowLight(458, 0.85, 0.2)).toBeCloseTo(0.85 * 458 ** -0.8, 9);
  for (const c of [1, 0.5, 0.18, 1e-2, 1e-4, 1e-8]) expect(glowLight(c, 0.85, 0.2)).toBeLessThanOrEqual(0.85);
  // Every vertex of the glow's sphere (away from its poles and seam) maps to its own texture coordinates.
  const sphere = new SphereGeometry(1, 96, 48);
  const pos = sphere.getAttribute('position');
  const uv = sphere.getAttribute('uv');
  const out = [0, 0];
  let worst = 0;
  for (let i = 0; i < pos.count; i += 1) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    if (v < 0.01 || v > 0.99 || u < 0.001 || u > 0.999) continue;
    skyUv(pos.getX(i), pos.getY(i), pos.getZ(i), out);
    worst = Math.max(worst, Math.abs((out[0] ?? 0) - u), Math.abs((out[1] ?? 0) - v));
  }
  expect(worst).toBeLessThan(1e-6);
});

test('the boxes names keep off discs and Saturn’s rings with', () => {
  // A disc: a box just clear of it, one touching it, one around it, one inside it.
  expect(boxMeetsCircle(110, 0, 40, 20, 100, 10, 9)).toBe(false);
  expect(boxMeetsCircle(108, 0, 40, 20, 100, 10, 9)).toBe(true);
  expect(boxMeetsCircle(0, 0, 400, 400, 100, 100, 9)).toBe(true);
  expect(boxMeetsCircle(95, 95, 4, 4, 100, 100, 50)).toBe(true);
  // A thin tilted ring's outline (an ellipse 200 by 20 turned 30 degrees, 32 corners).
  const ring: number[] = [];
  for (let k = 0; k < 32; k += 1) {
    const a = (k / 32) * 2 * Math.PI;
    const x = 200 * Math.cos(a);
    const y = 20 * Math.sin(a);
    ring.push(500 + x * Math.cos(Math.PI / 6) - y * Math.sin(Math.PI / 6), 400 + x * Math.sin(Math.PI / 6) + y * Math.cos(Math.PI / 6));
  }
  // Over its tip, across its middle; beside it above the tip, below the middle (inside its bounding box, off the ring).
  expect(boxMeetsConvex(660, 480, 30, 15, ring)).toBe(true);
  expect(boxMeetsConvex(480, 390, 40, 20, ring)).toBe(true);
  expect(boxMeetsConvex(600, 380, 60, 20, ring)).toBe(false);
  expect(boxMeetsConvex(380, 420, 60, 20, ring)).toBe(false);
  // Far from it, and around it.
  expect(boxMeetsConvex(0, 0, 50, 50, ring)).toBe(false);
  expect(boxMeetsConvex(0, 0, 1000, 1000, ring)).toBe(true);
});
