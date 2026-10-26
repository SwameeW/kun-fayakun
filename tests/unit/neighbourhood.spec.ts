/**
 * The stars around the Sun (src/explore/neighbourhood/data.ts) from the committed file: the nearest
 * stars at their Hipparcos distances (Proxima Centauri about 1.30 parsecs, Sirius 2.64), only stars
 * whose parallax is known to a fifth placed, absolute magnitudes from distance, the IAU's names and
 * the planet hosts', the Exoplanet Archive's calculated values flagged, and the search.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { KM_PER_PC, LY_PER_PC, readNeighbours, type NeighbourhoodFile } from '../../src/explore/neighbourhood/data';

const ROOT = new URL('../../', import.meta.url);
const file = JSON.parse(readFileSync(new URL('public/assets/stars/neighbourhood.json', ROOT), 'utf8')) as NeighbourhoodFile;
const OBLIQUITY = (23.4392911 * Math.PI) / 180;
const data = readNeighbours(file, OBLIQUITY, { absoluteV: 4.81, bv: 0.653 });

test('units: a parsec is 3.0857e13 km and 3.2616 light years', () => {
  expect(KM_PER_PC / 1e13).toBeCloseTo(3.0857, 4);
  expect(LY_PER_PC).toBeCloseTo(3.2616, 4);
});

test('the nearest stars where Hipparcos puts them, the Sun at the origin', () => {
  const near = data.nearest([0, 0, 0], 6);
  expect(near[0]?.name).toBe('Sun');
  const names = near.map((s) => s.name);
  expect(names).toContain('Proxima Centauri');
  expect(names).toContain('Rigil Kentaurus');
  const proxima = data.stars.find((s) => s.hip === 70890);
  expect(proxima?.distPc ?? 0).toBeCloseTo(1000 / 771.64, 6);
  expect((proxima?.distPc ?? 0) * LY_PER_PC).toBeCloseTo(4.23, 2);
  const sirius = data.stars.find((s) => s.hip === 32349);
  expect(sirius?.distPc ?? 0).toBeCloseTo(2.637, 2);
  // Its absolute magnitude: V - 5 log10(d / 10 pc).
  expect(sirius?.absoluteV ?? 0).toBeCloseTo((sirius?.vmag ?? 0) - 5 * Math.log10((sirius?.distPc ?? 0) / 10), 9);
  // Its place: the distance along its direction.
  const p = sirius?.position ?? [0, 0, 0];
  expect(Math.hypot(...p)).toBeCloseTo(sirius?.distPc ?? 0, 9);
});

test('only stars whose parallax is known to a fifth are placed', () => {
  for (const s of data.stars) expect(s.position !== null).toBe(s.plxMas / s.ePlxMas >= 5);
  expect(data.stars.filter((s) => s.position).length).toBeGreaterThan(8000);
});

test('names, hosts and the archive’s calculated values: Proxima’s planets, Barnard’s Star’s, a mass that is only a lower limit', () => {
  const proxima = data.stars.find((s) => s.hip === 70890);
  expect(proxima?.system?.planets.map((p) => p.name)).toEqual(expect.arrayContaining(['Proxima Cen b', 'Proxima Cen d']));
  // Proxima b was found by its star's wobble: its radius is the archive's calculation, not a measurement.
  const b = proxima?.system?.planets.find((p) => p.name === 'Proxima Cen b');
  expect(b?.radiusCalculated).toBe(true);
  expect(b?.method).toBe('Radial Velocity');
  // A host with no IAU name takes the archive's: GJ 411 (Lalande 21185, HIP 54035).
  expect(data.stars.find((s) => s.hip === 54035)?.name).toBe('GJ 411');
  // Some masses are minimums (M sin i).
  expect(file.systems.some((s) => s.planets.some((p) => p.massKind === 'Msini'))).toBe(true);
});

test('search: names, hosts and catalogue numbers, the places one can go first', () => {
  expect(data.search('sirius')[0]?.hip).toBe(32349);
  expect(data.search('Proxima')[0]?.hip).toBe(70890);
  // The IAU's file writes its name with a straight apostrophe.
  expect(data.search('HIP 87937')[0]?.name).toBe("Barnard's Star");
  expect(data.search('hr 7001')[0]?.name).toBe('Vega');
  expect(data.search('sun')[0]?.name).toBe('Sun');
  expect(data.search('')).toEqual([]);
});
