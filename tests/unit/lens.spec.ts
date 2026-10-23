/**
 * The explorer's lens (src/explore/space/lens.ts): near and far follow the altitude above the
 * nearest surface, so 24-bit depth covers the view from 150 km over the Earth to 50 au out.
 */
import { expect, test } from '@playwright/test';
import { LENS, lensFor, nearestAltitude } from '../../src/explore/space/lens';
import { km } from '../../src/explore/space/origin';

test('the lens table', () => {
  // altitude (km) -> near (km), far (km)
  const table: Array<[number, number, number]> = [
    [0, 1e-3, 20],
    [1e-3, 1e-3, 20],
    [1, 0.4, 8_000],
    [150, 60, 1_200_000],
    [13_621.8634, 5_448.74536, 108_974_907.2],
    [1e5, 4e4, 8e8],
    [2.5e5, 1e5, 2e9],
    [7.5e9, 1e5, 2e9],
  ];
  for (const [altitude, near, far] of table) {
    const lens = lensFor(altitude);
    expect(lens.near, `near at ${altitude} km`).toBeCloseTo(near, 6);
    expect(lens.far / far, `far at ${altitude} km`).toBeCloseTo(1, 12);
  }
});

test('inside a body, or with no body at all, the lens stays usable', () => {
  expect(lensFor(-500)).toEqual({ near: LENS.minNearKm, far: LENS.minNearKm * LENS.ratio });
  expect(lensFor(Infinity)).toEqual({ near: LENS.maxNearKm, far: LENS.maxNearKm * LENS.ratio });
  expect(lensFor(Number.NaN)).toEqual({ near: LENS.maxNearKm, far: LENS.maxNearKm * LENS.ratio });
});

test('the nearest surface sets the altitude, and its point is always 2.5 near planes away', () => {
  const spheres = [
    { centre: km(20_000, 0, 0), radius: 6_378.1366 },
    { centre: km(0, 384_000, 0), radius: 1_737.4 },
    { centre: km(1.5e8, 0, 0), radius: 695_700 },
  ];
  const altitude = nearestAltitude(spheres);
  expect(altitude).toBeCloseTo(20_000 - 6_378.1366, 9);
  expect(altitude / lensFor(altitude).near).toBeCloseTo(1 / LENS.nearShare, 9);
  expect(nearestAltitude([])).toBe(Infinity);
});

test('the starfield sits inside the far plane, behind everything scaled space places', () => {
  expect(LENS.starShare).toBeLessThan(1);
  expect(LENS.starShare).toBeGreaterThan(0.95);
});
