/**
 * The explorer's object information (src/explore/about.ts) from the committed JPL data: the planets
 * as JPL's "Planetary Physical Parameters" gives them, the Sun and the Moon from DE440's GM and
 * NAIF's radii, sunrise-to-sunrise days and axial tilts (backwards-turning worlds over 90 degrees).
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { PlanetsFile } from '../../src/astro/ephemeris';
import type { PhysicalFile } from '../../src/astro/physical';
import { orientationAt } from '../../src/astro/rotation';
import { BODY_IDS } from '../../src/core/types';
import { poleAtJ2000, solarDay, worldFacts } from '../../src/explore/about';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const physical = readJson('public/assets/jpl/physical.json') as PhysicalFile;
const planets = readJson('public/assets/jpl/planets.json') as PlanetsFile;

test('the planets are as JPL gives them, with their orbits from the elements', () => {
  const jupiter = worldFacts('jupiter', physical, planets);
  expect(jupiter).toMatchObject({ kind: 'planet', meanRadiusKm: 69911, equatorialRadiusKm: 71492, gravityMs2: 24.79, gravityAt: 'equator', escapeKmS: 60.2, densityGcm3: 1.3262 });
  expect(jupiter.massKg).toBeCloseTo(1898.125e24, -20);
  expect(jupiter.massEarths).toBeCloseTo(317.8, 1);
  expect(jupiter.orbit?.semiMajorKm).toBeCloseTo(5.20288700 * physical.auKm, -3);
  const earth = worldFacts('earth', physical, planets);
  expect(earth.massEarths).toBe(1);
  expect(earth.gravityEarths).toBe(1);
  expect(earth.solarDayDays).toBeCloseTo(1, 4);
  expect(earth.orbit?.periodDays).toBeCloseTo(365.256, 2);
  expect(earth.tiltDeg).toBeCloseTo(23.439, 3);
});

test('days: Venus turns backwards, slower than it orbits; sunrise to sunrise follows', () => {
  const venus = worldFacts('venus', physical, planets);
  expect(venus.rotationDays).toBe(-243.018);
  expect(venus.solarDayDays).toBeCloseTo(116.75, 1);
  expect(worldFacts('mercury', physical, planets).solarDayDays).toBeCloseTo(175.94, 1);
  expect(solarDay(1, 1e12)).toBeCloseTo(1, 9);
});

test('axial tilts, backwards-turning worlds measured from their spin axis', () => {
  const tilt = (id: Parameters<typeof worldFacts>[0]): number => worldFacts(id, physical, planets).tiltDeg ?? Number.NaN;
  expect(tilt('venus')).toBeCloseTo(177.4, 0);
  expect(tilt('uranus')).toBeCloseTo(97.8, 0);
  expect(tilt('mars')).toBeCloseTo(25.2, 0);
  expect(tilt('saturn')).toBeCloseTo(26.7, 0);
  expect(tilt('neptune')).toBeCloseTo(28.3, 0);
  expect(tilt('jupiter')).toBeCloseTo(3.1, 0);
  expect(tilt('sun')).toBeCloseTo(7.25, 1);
});

test('the Sun and the Moon from their GM: masses by the Earth’s, gravity, escape speed, density', () => {
  const sun = worldFacts('sun', physical, planets);
  expect(sun.kind).toBe('star');
  expect(sun.massEarths / 332_946).toBeCloseTo(1, 3);
  expect(sun.gravityMs2).toBeCloseTo(274.2, 0);
  expect(sun.escapeKmS).toBeCloseTo(617.7, 0);
  expect(sun.densityGcm3).toBeCloseTo(1.41, 2);
  expect(sun.rotationDays).toBeCloseTo(25.38, 2);
  expect(sun.orbit).toBeNull();
  const moon = worldFacts('moon', physical, planets);
  expect(moon.massEarths).toBeCloseTo(1 / physical.emrat, 12);
  expect(moon.gravityMs2).toBeCloseTo(1.62, 2);
  expect(moon.escapeKmS).toBeCloseTo(2.38, 2);
  expect(moon.solarDayDays).toBeCloseTo(29.53, 2);
  expect(moon.orbit).toMatchObject({ around: 'earth' });
  // Every world has its facts, each from named sources.
  for (const id of BODY_IDS) expect(worldFacts(id, physical, planets).sources.length, id).toBeGreaterThan(0);
});

test('the poles at J2000 that the tilts are worked from are the rotation model’s own at that moment', () => {
  // (About's chunk works the pole out itself, taking none of src/astro/rotation's code: the two must agree.)
  for (const [name, model] of Object.entries(physical.bodies)) {
    const pole = poleAtJ2000(model);
    const o = orientationAt(model, 2_451_545.0);
    expect(pole.ra, name).toBeCloseTo(o.ra, 12);
    expect(pole.dec, name).toBeCloseTo(o.dec, 12);
  }
});
