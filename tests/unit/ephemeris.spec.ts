/**
 * src/astro/ephemeris.ts against JPL Horizons, and the Chapter 7 wrapper against the code it
 * replaced. The reference vectors (tests/support/astro/horizons-reference.json) were fetched by
 * `scripts/jpl/build.py reference`. The fixture records each query and the day it was fetched.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { Vector3 } from 'three/webgpu';
import { createEphemeris, elementsAt, moonLinearKm, type MoonFile, type PlanetsFile, type Vec3 } from '../../src/astro/ephemeris';
import type { PhysicalFile } from '../../src/astro/physical';
import { chapterEphemeris } from '../../src/chapters/ch07/ephemeris';
import type { ChapterContext } from '../../src/core/types';
import { loadEphemeris as loadLegacyEphemeris } from '../support/astro/ch07-ephemeris-legacy';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));

interface Reference {
  epochsJdTdb: number[];
  vectors: Record<'moonGeo' | 'earthFromEmb' | 'embHelio' | 'earthHelio', Array<[number, number, number]>>;
}

const planets = readJson('public/assets/jpl/planets.json') as PlanetsFile;
const moon = readJson('public/assets/jpl/moon.json') as MoonFile;
const physical = readJson('public/assets/jpl/physical.json') as PhysicalFile;
const reference = readJson('tests/support/astro/horizons-reference.json') as Reference;
const ephemeris = createEphemeris(planets, moon, physical);

const TABLE_START = 2461041.5;
const TABLE_ROWS = 3653;
const TABLE_END = TABLE_START + TABLE_ROWS - 1;
/** Reference epochs at 12:00 TDB, halfway between the Moon table's rows, where interpolation is weakest. */
const MID_DAYS = reference.epochsJdTdb.filter((jd) => jd % 1 === 0);

const v = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const distance = (a: Vec3, b: readonly number[]): number => Math.hypot(a.x - (b[0] ?? 0), a.y - (b[1] ?? 0), a.z - (b[2] ?? 0));
const refAt = (name: keyof Reference['vectors'], jd: number): [number, number, number] => {
  const row = reference.vectors[name][reference.epochsJdTdb.indexOf(jd)];
  if (!row) throw new Error(`no ${name} reference at ${jd}`);
  return row;
};

test('the fixture covers the table edges and three mid-days inside it', () => {
  expect(reference.epochsJdTdb).toContain(TABLE_START);
  expect(reference.epochsJdTdb).toContain(TABLE_END);
  expect(MID_DAYS.filter((jd) => jd > TABLE_START + 1 && jd < TABLE_END - 1)).toHaveLength(3);
});

test('the Moon is within 300 km of Horizons at mid-day (Hermite), where linear interpolation sags by thousands', () => {
  for (const jd of MID_DAYS) {
    const hermite = distance(ephemeris.moonKm(jd, v()), refAt('moonGeo', jd));
    const linear = distance(moonLinearKm(moon, jd, v()), refAt('moonGeo', jd));
    expect(hermite, `Hermite Moon at JD ${jd}`).toBeLessThan(300);
    expect(linear, `linear Moon at JD ${jd}`).toBeGreaterThan(hermite);
  }
});

test("the Earth's centre is within 50 km of Horizons relative to the Earth-Moon barycentre", () => {
  for (const jd of reference.epochsJdTdb) {
    const earth = ephemeris.earthKm(jd, v());
    const emb = ephemeris.planetKm(ephemeris.embIndex, jd, v());
    const offset = { x: earth.x - emb.x, y: earth.y - emb.y, z: earth.z - emb.z };
    // The offset itself is about 4,700 km, so the barycentre correction is the thing under test.
    expect(Math.hypot(offset.x, offset.y, offset.z)).toBeGreaterThan(4000);
    expect(distance(offset, refAt('earthFromEmb', jd)), `Earth - EMB at JD ${jd}`).toBeLessThan(50);
  }
});

test("the barycentre's heliocentric place is within Standish and Williams' stated errors", () => {
  // Table 1's nominal errors for the EM barycentre, 1800 to 2050 (approx_pos.html, "Accuracy"):
  // 20 arcsec in longitude, 8 in latitude and 6,000 km in distance. They are nominal values, so
  // the test allows each one twice over.
  const ARCSEC = Math.PI / 180 / 3600;
  const spherical = (p: readonly number[]): { lon: number; lat: number; r: number } => {
    const [x = 0, y = 0, z = 0] = p;
    const r = Math.hypot(x, y, z);
    return { lon: Math.atan2(y, x), lat: Math.asin(z / r), r };
  };
  for (const jd of reference.epochsJdTdb) {
    const ours = ephemeris.planetKm(ephemeris.embIndex, jd, v());
    const a = spherical([ours.x, ours.y, ours.z]);
    const b = spherical(refAt('embHelio', jd));
    const dLon = Math.abs(Math.atan2(Math.sin(a.lon - b.lon), Math.cos(a.lon - b.lon))) / ARCSEC;
    expect(dLon, `longitude at JD ${jd} (arcsec)`).toBeLessThan(40);
    expect(Math.abs(a.lat - b.lat) / ARCSEC, `latitude at JD ${jd} (arcsec)`).toBeLessThan(16);
    expect(Math.abs(a.r - b.r), `distance at JD ${jd} (km)`).toBeLessThan(12_000);
    // Horizons' own Earth and barycentre differ by the same offset ours does.
    const earth = ephemeris.earthKm(jd, v());
    const helio = refAt('earthHelio', jd);
    const embRef = refAt('embHelio', jd);
    const oursOffset = { x: earth.x - ours.x, y: earth.y - ours.y, z: earth.z - ours.z };
    expect(distance(oursOffset, [helio[0] - embRef[0], helio[1] - embRef[1], helio[2] - embRef[2]])).toBeLessThan(50);
  }
});

test('table edges: the first and last rows are exact, dates beyond them are held there', () => {
  const range = ephemeris.validRange();
  expect(moon.count).toBe(TABLE_ROWS);
  expect(moon.positionsKm).toHaveLength(TABLE_ROWS);
  expect(range.moon).toEqual({ startJd: TABLE_START, endJd: TABLE_END });
  const first = moon.positionsKm[0] ?? [0, 0, 0];
  const last = moon.positionsKm[TABLE_ROWS - 1] ?? [0, 0, 0];
  expect(ephemeris.moonKm(TABLE_START, v())).toEqual({ x: first[0], y: first[1], z: first[2] });
  expect(ephemeris.moonKm(TABLE_END, v())).toEqual({ x: last[0], y: last[1], z: last[2] });
  // The table is rounded to 1 km per axis.
  expect(distance(ephemeris.moonKm(TABLE_START, v()), refAt('moonGeo', TABLE_START))).toBeLessThan(1);
  expect(distance(ephemeris.moonKm(TABLE_END, v()), refAt('moonGeo', TABLE_END))).toBeLessThan(1);
  expect(ephemeris.moonKm(TABLE_START - 40, v())).toEqual(ephemeris.moonKm(TABLE_START, v()));
  expect(ephemeris.moonKm(TABLE_END + 40, v())).toEqual(ephemeris.moonKm(TABLE_END, v()));
  // The half days next to each edge use one-sided tangents; they must hold the same 300 km.
  for (const jd of [TABLE_START + 0.5, TABLE_END - 0.5]) {
    expect(distance(ephemeris.moonKm(jd, v()), refAt('moonGeo', jd)), `JD ${jd}`).toBeLessThan(300);
  }
});

test("the planets' range is Table 1's 1800 to 2050 fit, with elements held at its edges", () => {
  const { planets: range } = ephemeris.validRange();
  expect(range).toEqual({ startJd: 2451545 - 2 * 36525, endJd: 2451545 + 0.5 * 36525 });
  const jupiter = planets.bodies.findIndex((b) => b.name === 'Jupiter');
  expect(ephemeris.elementsAt(jupiter, range.endJd + 5000)).toEqual(ephemeris.elementsAt(jupiter, range.endJd));
  expect(ephemeris.elementsAt(jupiter, range.startJd - 5000)).toEqual(ephemeris.elementsAt(jupiter, range.startJd));
  const body = planets.bodies[jupiter];
  if (!body) throw new Error('no Jupiter');
  expect(elementsAt(body, 2451545)).toEqual(body.elements);
});

test("Chapter 7's wrapper gives exactly the numbers of the code it replaced", async () => {
  const fakeContext = {
    assets: { json: (url: string) => Promise.resolve(url.endsWith('planets.json') ? planets : moon) },
  } as unknown as ChapterContext;
  const legacy = await loadLegacyEphemeris(fakeContext);
  const current = chapterEphemeris(planets, moon);
  const same = (a: Vector3, b: Vector3, what: string): void => {
    expect([Object.is(a.x, b.x), Object.is(a.y, b.y), Object.is(a.z, b.z)], `${what}: ${a.toArray().join()} vs ${b.toArray().join()}`).toEqual([true, true, true]);
  };
  // Inside and outside both tables, on and between the Moon's rows, and at their edges.
  const dates = [
    2_300_000.25, 2378495.0, 2_400_000.5, 2451545.0, 2_460_000.123, TABLE_START - 3.7, TABLE_START, TABLE_START + 0.5,
    ...MID_DAYS, 2_462_500.987654, 2_463_333.3333, TABLE_END - 0.25, TABLE_END, TABLE_END + 12.5, 2469807.5, 2_470_100.75, 2_500_000,
  ];
  const a = new Vector3();
  const b = new Vector3();
  for (const jd of dates) {
    for (let i = 0; i < planets.bodies.length; i += 1) same(legacy.planetAu(i, jd, a), current.planetAu(i, jd, b), `planet ${i} at JD ${jd}`);
    same(legacy.moonKm(jd, a), current.moonKm(jd, b), `Moon at JD ${jd}`);
    expect(Object.is(legacy.moonElongation(jd), current.moonElongation(jd)), `elongation at JD ${jd}`).toBe(true);
  }
  expect(legacy.planetAu(99, 2451545, a)).toEqual(current.planetAu(99, 2451545, b));
});
