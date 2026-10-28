/**
 * The zodiacal light near the Sun (src/explore/worlds/glow.ts heldAt, heldLight): within 24 degrees of
 * the Sun the table is read by the true angle from the Sun, each direction where its own great circle
 * from the Sun crosses 24 degrees, and the light rises from that value toward the Sun in every direction
 * alike, eased into one ceiling all round it, so the Sun's surroundings are a soft glow whose contours,
 * drawn out along the ecliptic at 24 degrees, round off about the Sun. Held by ecliptic longitude alone
 * they were a flat band 48 degrees wide from pole to pole; held by the angle without the rise, a bow tie
 * (bright wedges along the ecliptic, dark lobes above and below the Sun, as bright all along each line).
 */
import { expect, test } from '@playwright/test';
import { heldAt, heldLight, zodiacalAlong } from '../../src/explore/worlds/glow';

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

/** The table's value (arbitrary units) where heldAt reads it for a direction, and the ceiling: twice the ecliptic's at 24 degrees. */
const circleAt = (along: number, lat: number): number => {
  const [a = 0, b = 0] = heldAt(along, lat, [0, 0]);
  return zodiacalAlong(a * Math.PI, (b * Math.PI) / 2);
};
const CAP = 2 * zodiacalAlong(HELD, 0);
/** Table coordinates of the direction `deg` from the Sun at position angle `angle` (degrees from the ecliptic). */
const toward = (deg: number, angle: number): [number, number] => {
  const e = (deg * Math.PI) / 180;
  const p = (angle * Math.PI) / 180;
  const latitude = Math.asin(Math.sin(e) * Math.sin(p));
  return [Math.abs(Math.atan2(Math.sin(e) * Math.cos(p), Math.cos(e))) / Math.PI, latitude / (Math.PI / 2)];
};
const light = (deg: number, angle: number): number => {
  const [along, lat] = toward(deg, angle);
  return heldLight(circleAt(along, lat), along, lat, CAP);
};

test('beyond 24 degrees the light is the table’s; across the circle it runs on without a step', () => {
  for (const angle of [0, 30, 60, 90]) {
    const [along, lat] = toward(30, angle);
    expect(heldLight(circleAt(along, lat), along, lat, CAP)).toBe(circleAt(along, lat));
    const inside = light(23.99, angle);
    const outside = light(24.01, angle);
    expect(Math.abs(inside - outside) / outside, `${angle} degrees round`).toBeLessThan(0.01);
  }
});

test('within 24 degrees the light brightens toward the Sun along every line from it, never past the ceiling', () => {
  for (const angle of [0, 15, 30, 45, 60, 75, 90]) {
    let previous = 0;
    for (let deg = 23.5; deg >= 0.5; deg -= 1) {
      const value = light(deg, angle);
      expect(value, `${angle} degrees round, ${deg} from the Sun`).toBeGreaterThan(previous);
      expect(value).toBeLessThanOrEqual(CAP);
      previous = value;
    }
  }
});

test('its contours round off about the Sun: no dark lobes above and below it', () => {
  // On the circle straight above the Sun the table is about a quarter of the ecliptic's; held along
  // each line, that quarter ran all the way in (the bow tie). Rising toward the Sun, it closes up.
  const ratio = (deg: number): number => light(deg, 90) / light(deg, 0);
  expect(ratio(23.9)).toBeLessThan(0.3);
  expect(ratio(12)).toBeGreaterThan(0.45);
  expect(ratio(6)).toBeGreaterThan(0.8);
  expect(ratio(1)).toBeGreaterThan(0.99);
});
