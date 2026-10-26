/**
 * The explorer's sky (src/explore/sky.ts, public/assets/sky/sky.json): the catalogue as built
 * (brightest first, Sirius at the top, Polaris at the pole, the IAU's names, the 88 constellations),
 * and the frame the stars are placed in, checked against real stars: Regulus lies almost on the
 * ecliptic, so its direction lies in the render frame's ecliptic plane; Polaris points to the
 * celestial pole; and colours follow B-V (a Sun-like B-V gives a Sun-like temperature).
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { PhysicalFile } from '../../src/astro/physical';
import { obliquityRad } from '../../src/astro/physical';
import { bvKelvin, skyDirection, type SkyFile } from '../../src/explore/sky';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const sky = readJson('public/assets/sky/sky.json') as SkyFile;
const eps = obliquityRad(readJson('public/assets/jpl/physical.json') as PhysicalFile);
const star = (hr: number): [number, number, number, number, number | null] => {
  const s = sky.stars.find((r) => r[0] === hr);
  if (!s) throw new Error(`no HR ${hr}`);
  return s;
};
const angleDeg = (a: number[], b: number[]): number => (Math.acos(Math.min(1, (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0))) * 180) / Math.PI;

test('the catalogue: brightest first, the IAU names, the 88 constellations', () => {
  expect(sky.stars.length).toBeGreaterThan(9000);
  expect(sky.stars[0]?.[0]).toBe(2491);
  expect(sky.stars[0]?.[3]).toBe(-1.46);
  expect(star(424)[2]).toBeGreaterThan(89);
  const names = new Map(sky.names);
  expect(names.get(2491)).toBe('Sirius');
  expect(names.get(7001)).toBe('Vega');
  expect(names.get(3982)).toBe('Regulus');
  expect(sky.constellations.length).toBe(89);
  expect(sky.constellations.map((c) => c.name)).toEqual(expect.arrayContaining(['Orion', 'Ursa Major', 'Crux', 'Serpens Caput', 'Serpens Cauda']));
});

test('the frame: the ecliptic pole is up, Regulus lies on the ecliptic, Polaris at the celestial pole', () => {
  // The ecliptic's north pole (RA 18 h, Dec 90 - obliquity) is the render frame's +y.
  const pole = skyDirection(270, 90 - (eps * 180) / Math.PI, eps);
  expect(pole[0]).toBeCloseTo(0, 9);
  expect(pole[1]).toBeCloseTo(1, 9);
  expect(pole[2]).toBeCloseTo(0, 9);
  // Regulus's ecliptic latitude is about +0.46 degrees.
  const [, ra, dec] = star(3982);
  const regulus = skyDirection(ra, dec, eps);
  expect((Math.asin(regulus[1] ?? 0) * 180) / Math.PI).toBeGreaterThan(0.2);
  expect((Math.asin(regulus[1] ?? 0) * 180) / Math.PI).toBeLessThan(0.7);
  // Polaris is within a degree of the celestial pole (Dec +90).
  const [, pra, pdec] = star(424);
  expect(angleDeg(skyDirection(pra, pdec, eps), skyDirection(0, 90, eps))).toBeLessThan(1);
  // Every direction is a unit vector.
  for (const [, r, d] of sky.stars.slice(0, 50)) expect(Math.hypot(...skyDirection(r, d, eps))).toBeCloseTo(1, 12);
});

test('colours from B-V: the Sun’s B-V is a Sun-like temperature, blue stars hotter, red ones cooler', () => {
  expect(bvKelvin(0.65)).toBeGreaterThan(5600);
  expect(bvKelvin(0.65)).toBeLessThan(6000);
  expect(bvKelvin(0)).toBeGreaterThan(9000);
  expect(bvKelvin(1.85)).toBeLessThan(3800);
});
