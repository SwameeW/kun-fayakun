/**
 * The zodiacal light near the Sun (src/explore/worlds/glow.ts heldAt): within 24 degrees of the Sun
 * the table is held by the true angle from the Sun, each direction reading it where its own great
 * circle from the Sun crosses 24 degrees, so the Sun's surroundings are a soft glow brightest along the
 * ecliptic; held by ecliptic longitude alone they were a flat band 48 degrees wide from pole to pole.
 */
import { expect, test } from '@playwright/test';
import { heldAt } from '../../src/explore/worlds/glow';

const HELD = (24 * Math.PI) / 180;
/** Elongation from the Sun (radians) of table coordinates (along: 0 to 1 for 0 to 180 degrees; lat: 0 to 1 for 0 to 90). */
const elongation = (along: number, lat: number): number => Math.acos(Math.cos((lat * Math.PI) / 2) * Math.cos(along * Math.PI));
/** Position angle about the Sun's direction (its sine: the share of the elongation that is latitude). */
const tilt = (along: number, lat: number): number => Math.sin((lat * Math.PI) / 2) / Math.max(Math.sin(elongation(along, lat)), 1e-9);

test('beyond 24 degrees from the Sun every direction reads the table as it is', () => {
  for (const [along, lat] of [
    [0.5, 0],
    [0.2, 0.1],
    [0, 0.6],
    [0.05, 0.3],
    [1, 1],
  ] as const) {
    expect(heldAt(along, lat, [0, 0])).toEqual([along, lat]);
  }
  // 60 degrees above the Sun, straight up from it: before, the longitude hold read it 24 degrees along the ecliptic.
  expect(heldAt(0, 60 / 90, [0, 0])).toEqual([0, 60 / 90]);
});

test('within 24 degrees, the table at 24 degrees in the same direction from the Sun', () => {
  for (const [along, lat] of [
    [0.02, 0],
    [0.05, 0.05],
    [0.01, 0.2],
    [0, 0.1],
    [0.1, 0.02],
  ] as const) {
    expect(elongation(along, lat)).toBeLessThan(HELD);
    const [a = 0, b = 0] = heldAt(along, lat, [0, 0]);
    expect(elongation(a, b), `${along}, ${lat}`).toBeCloseTo(HELD, 5);
    expect(tilt(a, b), `${along}, ${lat}`).toBeCloseTo(tilt(along, lat), 5);
  }
});

test('the hold is continuous at 24 degrees, and brightest along the ecliptic', () => {
  // Just inside and just outside the circle read almost the same place.
  for (const lat of [0, 0.1, 0.2]) {
    const b = (lat * Math.PI) / 2;
    const along = Math.acos(Math.cos(HELD) / Math.cos(b)) / Math.PI;
    const inside = heldAt(along - 1e-4, lat, [0, 0]);
    const outside = heldAt(along + 1e-4, lat, [0, 0]);
    expect(Math.abs((inside[0] ?? 0) - (outside[0] ?? 0))).toBeLessThan(1e-3);
    expect(Math.abs((inside[1] ?? 0) - (outside[1] ?? 0))).toBeLessThan(1e-3);
  }
  // Beside the Sun along the ecliptic it reads the ecliptic at 24 degrees; straight above, 24 degrees of latitude.
  const [a0 = 0, b0 = 0] = heldAt(0.01, 0, [0, 0]);
  expect(a0).toBeCloseTo(24 / 180, 6);
  expect(b0).toBeCloseTo(0, 6);
  const [a1 = 0, b1 = 0] = heldAt(0, 0.05, [0, 0]);
  expect(a1).toBeCloseTo(0, 5);
  expect(b1).toBeCloseTo(24 / 90, 5);
});
