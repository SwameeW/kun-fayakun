import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { MoonFile, PlanetsFile } from '../../src/astro/ephemeris';
import type { PhysicalFile } from '../../src/astro/physical';
import { orientationAt } from '../../src/astro/rotation';
import { BODY_IDS } from '../../src/core/types';
import { createSolarSystem } from '../../src/explore/system';
import { formatRoute, parseHash } from '../../src/core/router';

const read = (file: string): unknown => JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
const planets = read('public/assets/jpl/planets.json') as PlanetsFile;
const moon = read('public/assets/jpl/moon.json') as MoonFile;
const physical = read('public/assets/jpl/physical.json') as PhysicalFile;
const reference = read('tests/support/astro/horizons-reference.json') as { epochsJdTdb: number[]; vectors: Record<string, Array<[number, number, number]>> };
const added = ['mercury', 'venus', 'mars', 'uranus', 'neptune'] as const;

for (const body of added) {
  test(`${body}: route, true radius and heliocentric position agree with the cited data`, () => {
    const route = { name: 'universe', body, jd: 2461336.75 } as const;
    expect(parseHash(formatRoute(route))).toEqual(route);
    const system = createSolarSystem(planets, moon, physical);
    expect(BODY_IDS).toHaveLength(10);
    expect(system.specs[body].radiusKm).toBe(physical.bodies[body === 'mercury' ? 'Mercury' : body === 'venus' ? 'Venus' : body === 'mars' ? 'Mars' : body === 'uranus' ? 'Uranus' : 'Neptune'].radiiKm[0]);
    for (const [i, jd] of reference.epochsJdTdb.entries()) {
      system.update(jd);
      const expected = reference.vectors[`${body}Helio`]?.[i];
      if (!expected) throw new Error(`missing Horizons reference for ${body}`);
      const p = system.bodies[body].position;
      // Ecliptic (x,y,z) is rendered as (x,z,-y). Table 1 is an approximation, not DE440.
      const error = Math.hypot(p.x - expected[0], p.y - expected[2], p.z + expected[1]);
      expect(error / Math.hypot(...expected), `${body} at ${jd}: relative position error`).toBeLessThan(0.005);
    }
  });
}

test('retrograde planets retain signed spin and the full Mars/Neptune pole models', () => {
  for (const model of [physical.bodies.Venus, physical.bodies.Uranus]) {
    expect(model.pm[1]).toBeLessThan(0);
    const a = orientationAt(model, 2461336.75).w;
    const b = orientationAt(model, 2461336.76).w;
    const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    expect(delta).toBeLessThan(0);
  }
  expect(physical.bodies.Mars.nutPrec?.angles.some((angle) => angle.length === 3)).toBe(true);
  expect(physical.bodies.Neptune.nutPrec?.ra.some((term) => term !== 0)).toBe(true);
});
