/**
 * The explorer's discoveries (src/explore/discoveries.ts): every fact derived from the cited data
 * files (never typed in), notes that come and go without flicker, and a plain log of what was seen.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { PlanetsFile } from '../../src/astro/ephemeris';
import type { PhysicalFile } from '../../src/astro/physical';
import type { BodyId, ConstantsFile } from '../../src/core/types';
import { deriveFacts, Discoveries, DISCOVERY_CONSTANTS, type DiscoveryInput } from '../../src/explore/discoveries';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const physical = readJson('public/assets/jpl/physical.json') as PhysicalFile;
const planets = readJson('public/assets/jpl/planets.json') as PlanetsFile;
const constants = readJson('data/constants.json') as ConstantsFile;
const constant = (id: string): number => {
  const found = constants.constants.find((c) => c.id === id);
  if (!found) throw new Error(`no constant ${id}`);
  return found.value;
};
const facts = deriveFacts(physical, planets, constant);

const each = <T>(value: T): Record<BodyId, T> => ({ mercury: value, venus: value, mars: value, uranus: value, neptune: value, sun: value, earth: value, moon: value, jupiter: value, saturn: value });
function input(patch: Partial<DiscoveryInput>): DiscoveryInput {
  return {
    focus: 'earth',
    travelling: false,
    altitudeKm: 20_000,
    radiusKm: 6378.1366,
    framedAltitudeKm: 19_000,
    phaseAngle: each(1),
    discPx: each(100),
    inView: each(true),
    moonLit: 0.6,
    moonWaxing: true,
    earthLitFromMoon: 0.4,
    ringTiltDeg: 3,
    sunEarthKm: 1.496e8,
    sunCameraKm: 1.496e8,
    sunlight: 1,
    solarFilter: false,
    ...patch,
  };
}

test('the constants the notes need are in data/constants.json, cited', () => {
  for (const id of Object.values(DISCOVERY_CONSTANTS)) {
    const entry = constants.constants.find((c) => c.id === id);
    expect(entry, id).toBeDefined();
    expect(entry?.citation.url).toMatch(/^https:\/\//);
  }
});

test('facts are derived from the data: day lengths, the tilt, the month, the rings', () => {
  // The Earth turns once against the stars in about 23 h 56 min; 24 h from noon to noon.
  expect(facts.earth.siderealDayHours).toBeCloseTo(23.934, 3);
  expect(facts.earth.solarDayHours).toBeCloseTo(24, 2);
  expect(facts.earth.tiltDeg).toBeCloseTo(23.439, 3);
  expect(facts.moon.rotationDays).toBeCloseTo(27.32, 2);
  expect(facts.moon.synodicDays).toBeCloseTo(29.53, 2);
  expect(facts.moon.terminatorKmH).toBeGreaterThan(15);
  expect(facts.moon.terminatorKmH).toBeLessThan(16);
  expect(facts.jupiter.dayHours).toBeCloseTo(9.925, 3);
  expect(facts.jupiter.flatteningPercent).toBeCloseTo(6.49, 2);
  expect(facts.saturn.dayHours).toBeCloseTo(10.656, 3);
  // Cassini's profile: the C ring's inner edge and the A ring's outer edge.
  expect(facts.saturn.ringInnerKm).toBeGreaterThan(74_000);
  expect(facts.saturn.ringInnerKm).toBeLessThan(75_000);
  expect(facts.saturn.ringOuterKm).toBeGreaterThan(136_500);
  expect(facts.saturn.ringOuterKm).toBeLessThan(137_000);
  expect(facts.saturn.edgeOnYears).toBeCloseTo(14.7, 1);
  expect(facts.lightKmS).toBe(299_792.458);
  expect(facts.sun.rotationDays).toBeCloseTo(25.38, 2);
  expect(facts.sun.temperatureK).toBe(5772);
});

test('a note shows near a body, turns to the air low over the Earth, never during a trip, and does not flicker at its edge', () => {
  const d = new Discoveries(facts);
  expect(d.update(input({ altitudeKm: 20_000 }))?.id).toBe('earth');
  expect(d.update(input({ altitudeKm: 5_000 }))?.id).toBe('earth-air');
  // A little above the air's threshold it stays (slack), well above it turns back.
  expect(d.update(input({ altitudeKm: 6378 * 1.3 }))?.id).toBe('earth-air');
  expect(d.update(input({ altitudeKm: 6378 * 2 }))?.id).toBe('earth');
  expect(d.update(input({ travelling: true }))).toBeNull();
  // Shown up to 12 radii once showing, but only from 10 radii when coming in.
  const fresh = new Discoveries(facts);
  expect(fresh.update(input({ altitudeKm: 6378 * 11 }))).toBeNull();
  expect(fresh.update(input({ altitudeKm: 6378 * 9 }))?.id).toBe('earth');
  expect(fresh.update(input({ altitudeKm: 6378 * 11 }))?.id).toBe('earth');
  expect(fresh.update(input({ altitudeKm: 6378 * 13 }))).toBeNull();
  // Values come from the facts and the view.
  const saturn = fresh.update(input({ focus: 'saturn', radiusKm: 60_268, altitudeKm: 200_000, ringTiltDeg: -4.2 }));
  expect(saturn?.id).toBe('saturn');
  expect(saturn?.values.tilt).toBeCloseTo(4.2, 6);
  expect(saturn?.values.inner).toBe(facts.saturn.ringInnerKm);
  const sun = fresh.update(input({ focus: 'sun', radiusKm: 695_700, altitudeKm: 1e6 }));
  expect(sun?.values.lightSeconds).toBeCloseTo((1.496e8 - 695_700) / 299_792.458, 6);
});

test('the log lists what was seen once each, in the order first seen, with no score', () => {
  const d = new Discoveries(facts);
  d.update(input({ focus: 'earth', altitudeKm: 3_000 }));
  d.update(input({ focus: 'earth', altitudeKm: 3_000 }));
  d.update(input({ solarFilter: true }));
  d.update(input({ focus: 'saturn', radiusKm: 60_268, altitudeKm: 200_000 }));
  expect(d.witnessed).toEqual(['earth-air', 'earth-and-moon', 'sun-filter', 'saturn-rings']);
  // Nothing is logged while travelling.
  const moving = new Discoveries(facts);
  moving.update(input({ travelling: true, solarFilter: true }));
  expect(moving.witnessed).toEqual([]);
});
