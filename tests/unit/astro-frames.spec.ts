/**
 * src/astro/time.ts and rotation.ts with the constants in public/assets/jpl/physical.json. The
 * checks are structural (orthonormal matrices, leap-second steps), plus a few that tie rotation
 * to the ephemeris: the Moon keeps its near side toward the Earth, and the Earth's pole sits one
 * obliquity from ecliptic north.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createEphemeris, positionFromElements, type MoonFile, type PlanetsFile, type Vec3 } from '../../src/astro/ephemeris';
import { obliquityRad, type PhysicalFile } from '../../src/astro/physical';
import { bodyToEcliptic, bodyToIcrf, icrfToEcliptic, orientationAt, poleIcrf } from '../../src/astro/rotation';
import { julianDateUtc, taiMinusUtc, tdbMinusTt, ttMinusUtc, utcToTdb, SECONDS_PER_DAY } from '../../src/astro/time';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const physical = readJson('public/assets/jpl/physical.json') as PhysicalFile;
const planets = readJson('public/assets/jpl/planets.json') as PlanetsFile;
const moon = readJson('public/assets/jpl/moon.json') as MoonFile;
const ephemeris = createEphemeris(planets, moon, physical);
const time = physical.time;
const eps = obliquityRad(physical);
const DEG = Math.PI / 180;

const v = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const column = (m: readonly number[], c: number): Vec3 => ({ x: m[3 * c] ?? 0, y: m[3 * c + 1] ?? 0, z: m[3 * c + 2] ?? 0 });

test('TAI - UTC steps by one second at each leap second and holds the last value afterwards', () => {
  const leaps = time.leapSeconds;
  const last = leaps[leaps.length - 1];
  if (!last) throw new Error('no leap seconds');
  leaps.forEach((leap, i) => {
    expect(taiMinusUtc(leap.jdUtc, time)).toBe(leap.taiMinusUtc);
    if (i > 0) expect(taiMinusUtc(leap.jdUtc - 1e-6, time)).toBe(leap.taiMinusUtc - 1);
  });
  const jd2030 = julianDateUtc(Date.UTC(2030, 0, 1));
  expect(taiMinusUtc(jd2030, time)).toBe(last.taiMinusUtc);
  expect(ttMinusUtc(jd2030, time)).toBe(time.deltaTA + last.taiMinusUtc);
});

test('TDB - TT stays within the K amplitude, and UTC to TDB adds about TT - UTC', () => {
  for (let jd = 2451545; jd < 2466000; jd += 37.3) {
    expect(Math.abs(tdbMinusTt(jd, time))).toBeLessThanOrEqual(time.k + 1e-12);
  }
  const jd = julianDateUtc(Date.UTC(2026, 9, 23, 12));
  const seconds = (utcToTdb(jd, time) - jd) * SECONDS_PER_DAY;
  expect(Math.abs(seconds - ttMinusUtc(jd, time))).toBeLessThan(0.002);
});

test('every body frame is a proper rotation whose z axis is the pole', () => {
  for (const [name, model] of Object.entries(physical.bodies)) {
    for (const jd of [2451545, 2461100.25, 2464000.75]) {
      const o = orientationAt(model, jd);
      const m = bodyToIcrf(o);
      const [x, y, z] = [column(m, 0), column(m, 1), column(m, 2)];
      for (const [a, b, want] of [[x, x, 1], [y, y, 1], [z, z, 1], [x, y, 0], [y, z, 0], [z, x, 0]] as const) {
        expect(dot(a, b), `${name} at ${jd}`).toBeCloseTo(want, 12);
      }
      // Right-handed: x cross y = z.
      expect(x.y * y.z - x.z * y.y).toBeCloseTo(z.x, 12);
      const pole = poleIcrf(o, v());
      expect(dot(pole, z)).toBeCloseTo(1, 12);
      expect(o.w).toBeGreaterThanOrEqual(0);
      expect(o.w).toBeLessThan(2 * Math.PI);
    }
  }
});

test("the Earth's pole at J2000 is one obliquity from ecliptic north, and W turns by its daily rate", () => {
  const earth = physical.bodies.Earth;
  const pole = icrfToEcliptic(poleIcrf(orientationAt(earth, 2451545), v()), eps, v());
  expect(Math.acos(pole.z)).toBeCloseTo(eps, 12);
  const m = bodyToEcliptic(orientationAt(earth, 2451545), eps);
  expect(column(m, 2).z).toBeCloseTo(pole.z, 12);
  const turn = (orientationAt(earth, 2461000.5).w - orientationAt(earth, 2461000.5 - 1).w) / DEG;
  expect(((turn % 360) + 360) % 360).toBeCloseTo(earth.pm[1] % 360, 6);
});

test('the Moon keeps its near side toward the Earth: the sub-Earth point stays within the librations', () => {
  // Optical libration moves the sub-Earth point by up to about 8 deg in longitude and 7 in
  // latitude, so these coarse bounds show that frame, pole and W agree with the ephemeris.
  const model = physical.bodies.Moon;
  for (let jd = moon.startJdTdb + 0.3; jd < moon.startJdTdb + moon.count - 1; jd += 23.7) {
    const toEarth = ephemeris.moonKm(jd, v());
    toEarth.x = -toEarth.x;
    toEarth.y = -toEarth.y;
    toEarth.z = -toEarth.z;
    const m = bodyToEcliptic(orientationAt(model, jd), eps);
    const local = { x: dot(column(m, 0), toEarth), y: dot(column(m, 1), toEarth), z: dot(column(m, 2), toEarth) };
    const r = Math.hypot(local.x, local.y, local.z);
    expect(Math.abs(Math.atan2(local.y, local.x) / DEG), `longitude at JD ${jd}`).toBeLessThan(9);
    expect(Math.abs(Math.asin(local.z / r) / DEG), `latitude at JD ${jd}`).toBeLessThan(8);
  }
});

test("Jupiter's and Saturn's poles tilt from their orbit normals by their known axial tilts", () => {
  // Coarse bounds around the familiar values (about 3.1 deg and 26.7 deg) catch a wrong frame or
  // swapped columns. They are not a source for the constants.
  const tilt = (name: 'Jupiter' | 'Saturn'): number => {
    const jd = 2461100.5;
    const pole = icrfToEcliptic(poleIcrf(orientationAt(physical.bodies[name], jd), v()), eps, v());
    const index = planets.bodies.findIndex((b) => b.name === name);
    const el = ephemeris.elementsAt(index, jd);
    const normal = { x: Math.sin(el.I * DEG) * Math.sin(el.Omega * DEG), y: -Math.sin(el.I * DEG) * Math.cos(el.Omega * DEG), z: Math.cos(el.I * DEG) };
    // The normal is perpendicular to the orbit the elements give.
    const p = positionFromElements(el, v());
    expect(Math.abs(dot(p, normal))).toBeLessThan(1e-9);
    return Math.acos(dot(pole, normal)) / DEG;
  };
  expect(tilt('Jupiter')).toBeGreaterThan(2.9);
  expect(tilt('Jupiter')).toBeLessThan(3.3);
  expect(tilt('Saturn')).toBeGreaterThan(26.4);
  expect(tilt('Saturn')).toBeLessThan(27);
});
