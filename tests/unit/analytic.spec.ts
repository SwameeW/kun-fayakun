/**
 * The published theories the explorer uses beyond JPL's tables (src/astro/analytic) and their seams
 * with the tables (src/astro/ephemeris): Meeus's worked example 47.a to its printed digits; his Moon
 * against JPL Horizons' table over all ten years of it and against Horizons from 1600 to 2400 (a
 * fixture written by scripts/jpl/build.py deep); Standish's Table 2 against Horizons over the same
 * span; and, once installed, no jump where a table hands over to its theory, the tables untouched
 * inside, and the span widened to the theories'.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { BLEND_DAYS, eclipticToJ2000, moonMeeusKm, moonOfDate, table2Au, table2Elements, theories, THEORY_RANGE } from '../../src/astro/analytic';
import { createEphemeris, elementsAt, installTheories, moonHermiteKm, positionFromElements, tableRange, validRange, type MoonFile, type PlanetsFile, type Vec3 } from '../../src/astro/ephemeris';
import type { PhysicalFile } from '../../src/astro/physical';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const moon = readJson('public/assets/jpl/moon.json') as MoonFile;
const planets = readJson('public/assets/jpl/planets.json') as PlanetsFile;
const physical = readJson('public/assets/jpl/physical.json') as PhysicalFile;
const deep = readJson('tests/support/astro/horizons-deep.json') as { epochsJdTdb: number[]; vectors: Record<string, number[][]> };
const DEG = Math.PI / 180;
const AU = physical.auKm;

const v = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const km = (a: Vec3, b: readonly number[] | Vec3): number => {
  const [x, y, z]: readonly number[] = 'x' in b ? [b.x, b.y, b.z] : b;
  return Math.hypot(a.x - (x ?? 0), a.y - (y ?? 0), a.z - (z ?? 0));
};
const EARTH = planets.bodies.find((b) => b.name === 'Earth') ?? planets.bodies[0];
const JUPITER = planets.bodies.find((b) => b.name === 'Jupiter') ?? planets.bodies[0];
/** The angle between two directions from the origin, arcseconds. */
const arcsec = (a: Vec3, b: readonly number[]): number => {
  const ra = Math.hypot(a.x, a.y, a.z);
  const rb = Math.hypot(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0);
  return Math.acos(Math.min(1, (a.x * (b[0] ?? 0) + a.y * (b[1] ?? 0) + a.z * (b[2] ?? 0)) / (ra * rb))) / DEG * 3600;
};

test.afterAll(() => {
  installTheories(null);
});

test('Meeus’s example 47.a: the Moon on 1992 April 12 at 0h TD, to the printed digits', () => {
  const m = moonOfDate(2_448_724.5);
  const lon = (((m.lon / DEG) % 360) + 360) % 360;
  expect(lon).toBeCloseTo(133.162655, 5);
  expect(m.lat / DEG).toBeCloseTo(-3.229126, 5);
  expect(m.distanceKm).toBeCloseTo(368_409.7, 0);
  // At J2000 the precession is nothing.
  const same = eclipticToJ2000(2_451_545, 1.234, 0.0567);
  expect(same.lon).toBeCloseTo(1.234, 12);
  expect(same.lat).toBeCloseTo(0.0567, 12);
});

test('Meeus’s Moon against JPL Horizons’ table, every day of its ten years: within 30 km and 20 arcseconds', () => {
  const out = v();
  let worstKm = 0;
  let worstArcsec = 0;
  moon.positionsKm.forEach((row, i) => {
    moonMeeusKm(moon.startJdTdb + i * moon.stepDays, out);
    worstKm = Math.max(worstKm, km(out, row));
    worstArcsec = Math.max(worstArcsec, arcsec(out, row));
  });
  expect(worstKm).toBeLessThan(30);
  expect(worstArcsec).toBeLessThan(20);
});

test('Meeus’s Moon and Standish’s Table 2 against Horizons from 1600 to 2400', () => {
  const out = v();
  // Seen from the Sun (arcseconds): the inner planets within tens, the giants within the arcminutes Table 2 allows.
  const limit: Record<string, [string, number]> = { mercuryHelio: ['Mercury', 30], venusHelio: ['Venus', 40], embHelio: ['Earth', 40], marsHelio: ['Mars', 150], jupiterHelio: ['Jupiter', 800], saturnHelio: ['Saturn', 1300], uranusHelio: ['Uranus', 1200], neptuneHelio: ['Neptune', 400] };
  deep.epochsJdTdb.forEach((jd, k) => {
    moonMeeusKm(jd, out);
    const m = deep.vectors.moonGeo?.[k] ?? [];
    expect(km(out, m), `the Moon at JD ${jd}`).toBeLessThan(20);
    for (const [key, [name, most]] of Object.entries(limit)) {
      const body = planets.bodies.find((b) => b.name === name);
      expect(body && table2Au(body, jd, out)).toBe(true);
      expect(arcsec(out, deep.vectors[key]?.[k] ?? []), `${name} at JD ${jd}`).toBeLessThan(most);
    }
  });
});

test('installed: the tables untouched inside, no jump at their ends, the theories beyond, the span widened', () => {
  const own = tableRange(moon);
  const inside = 2_461_336.75;
  const before = moonHermiteKm(moon, inside, v());
  if (!EARTH || !JUPITER) throw new Error('planets.json has no Earth or Jupiter');
  const earthBefore = positionFromElements(elementsAt(EARTH, inside), v());
  installTheories(theories);
  try {
    expect(validRange(moon)).toEqual({ planets: THEORY_RANGE, moon: THEORY_RANGE });
    // Well inside the tables: exactly as before.
    expect(moonHermiteKm(moon, inside, v())).toEqual(before);
    expect(positionFromElements(elementsAt(EARTH, inside), v())).toEqual(earthBefore);
    // At the Moon table's ends (a tenth of a second either side): no jump beyond its motion (about 1 km/s).
    const e = 1e-6;
    for (const edge of [own.moon.startJd, own.moon.endJd]) {
      expect(km(moonHermiteKm(moon, edge - e, v()), moonHermiteKm(moon, edge + e, v()))).toBeLessThan(0.5);
      // Across the whole hand-over, each tenth of a day moves the Moon no more than its own motion does (no step).
      let prev = moonHermiteKm(moon, edge - BLEND_DAYS - 1, v());
      for (let d = -BLEND_DAYS - 1 + 0.1; d <= BLEND_DAYS + 1; d += 0.1) {
        const p = moonHermiteKm(moon, edge + d, v());
        expect(km(p, prev)).toBeLessThan(0.1 * 86_400 * 1.2);
        prev = p;
      }
    }
    // Beyond the table, Meeus's Moon (the one the explorer shows on 4 August 2000, and in 1850 and 2150).
    for (const jd of [2_451_760.5, 2_396_758.5, 2_506_331.5]) expect(moonHermiteKm(moon, jd, v())).toEqual(moonMeeusKm(jd, v()));
    // The planets at Table 1's ends: no jump; beyond them, Table 2.
    const eph = createEphemeris(planets, moon, physical);
    for (const edge of [own.planets.startJd, own.planets.endJd]) {
      for (const [k, body] of planets.bodies.entries()) {
        expect(km(eph.planetKm(k, edge - e, v()), eph.planetKm(k, edge + e, v()))).toBeLessThan(10);
        // Through the two years' hand-over, a day never moves a planet much more than its own day's motion (it never laps its orbit).
        const at = (jd: number): Vec3 => {
          const el = table2Elements(body.name, jd);
          return el ? positionFromElements(el, v()) : v();
        };
        const daily = (jd: number): number => km(at(jd), at(jd + 1)) * AU;
        for (let d = -800; d < 800; d += 10) {
          const jd = edge + d;
          expect(km(eph.planetKm(k, jd, v()), eph.planetKm(k, jd + 1, v())), `${body.name} at JD ${jd}`).toBeLessThan(1.1 * daily(jd) + 50);
        }
      }
    }
    const far = eph.planetAu(planets.bodies.indexOf(JUPITER), 2_524_593.5, v());
    const t2 = v();
    table2Au(JUPITER, 2_524_593.5, t2);
    expect(km(far, t2) * AU).toBeLessThan(0.001);
    // The Earth from the barycentre and Meeus's Moon in 1700: where Horizons has it, within a few thousand km at 1 au.
    const earth = eph.earthKm(2_341_972.5, v());
    expect(km(earth, deep.vectors.embHelio?.[1] ?? [])).toBeLessThan(10_000);
  } finally {
    installTheories(null);
  }
  // Uninstalled, dates outside are held at the tables' edges again.
  expect(validRange(moon)).toEqual(own);
});
