/**
 * The explorer's camera (src/explore/navigation.ts) over the real solar system on a fixed date:
 * flights end where they should, never pass inside a body, and orbiting keeps above the floor.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { MoonFile, PlanetsFile } from '../../src/astro/ephemeris';
import type { PhysicalFile } from '../../src/astro/physical';
import type { BodyId } from '../../src/core/types';
import { BODY_IDS } from '../../src/core/types';
import { Navigator, type NavBody, type NavOutput, type NavWorld } from '../../src/explore/navigation';
import { km } from '../../src/explore/space/origin';
import { createSolarSystem, type SolarSystem } from '../../src/explore/system';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const JD = 2461336.75;

function world(system: SolarSystem): NavWorld {
  const all: NavBody[] = BODY_IDS.map((id) => ({ ...system.specs[id], position: system.bodies[id].position }));
  return {
    all,
    sun: system.bodies.sun.position,
    body: (id: BodyId) => all.find((b) => b.id === id) ?? (all[0] as NavBody),
  };
}

function setup(): { system: SolarSystem; w: NavWorld } {
  const system = createSolarSystem(
    readJson('public/assets/jpl/planets.json') as PlanetsFile,
    readJson('public/assets/jpl/moon.json') as MoonFile,
    readJson('public/assets/jpl/physical.json') as PhysicalFile,
  );
  system.update(JD);
  return { system, w: world(system) };
}

const out = (): NavOutput => ({ position: km(), target: km(), dim: 1, progress: 1, from: null });
const distance = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('a flight from body to body never enters one, lasts 2.8 to 9 s and ends at the framing distance', () => {
  const { w } = setup();
  const route: BodyId[] = ['earth', 'moon', 'sun', 'jupiter', 'saturn', 'earth'];
  const nav = new Navigator('earth');
  nav.begin(w, 'earth', false);
  const pose = out();
  nav.update(w, 1 / 60, pose);
  for (const next of route.slice(1)) {
    nav.flyTo(w, next);
    expect(nav.travelling).toBe(true);
    let seconds = 0;
    while (nav.travelling && seconds < 20) {
      nav.update(w, 1 / 60, pose);
      seconds += 1 / 60;
      for (const body of w.all) {
        expect(distance(pose.position, body.position), `inside ${body.id} on the way to ${next}`).toBeGreaterThanOrEqual(body.radiusKm);
      }
    }
    expect(seconds, `flight to ${next}`).toBeGreaterThanOrEqual(2.8 - 1 / 30);
    expect(seconds, `flight to ${next}`).toBeLessThanOrEqual(9 + 1 / 30);
    const to = w.body(next);
    expect(distance(pose.position, to.position) / Navigator.framingKm(to)).toBeCloseTo(1, 2);
  }
});

test('orbiting never goes below the floor over the body, however far the zoom is pushed', () => {
  const { w } = setup();
  const nav = new Navigator('earth');
  nav.begin(w, 'earth', false);
  const pose = out();
  nav.zoom(-50);
  for (let i = 0; i < 600; i += 1) nav.update(w, 1 / 60, pose);
  const earth = w.body('earth');
  expect(distance(pose.position, earth.position) - earth.radiusKm).toBeCloseTo(earth.minAltitudeKm, 3);
  // The Earth's floor is above its drawn atmosphere.
  expect(earth.minAltitudeKm).toBeGreaterThan(earth.radiusKm * 0.02);
});

test('low over a body the gaze lifts toward the horizon; far away it looks at the centre', () => {
  const { w } = setup();
  const nav = new Navigator('earth');
  const earth = w.body('earth');
  const pose = out();
  nav.place('earth', km(1, 0, 0), 30_000, w);
  nav.update(w, 1 / 60, pose);
  expect(distance(pose.target, earth.position)).toBeLessThan(1e-6);
  nav.place('earth', km(1, 0, 0), earth.radiusKm + 400, w);
  nav.update(w, 1 / 60, pose);
  expect(distance(pose.target, earth.position)).toBeGreaterThan(100);
});

test('with reduced motion a flight is a dimmed cut: no frame between the two bodies', () => {
  const { w } = setup();
  const nav = new Navigator('earth');
  nav.reducedMotion = true;
  nav.begin(w, 'earth', true);
  const pose = out();
  nav.update(w, 1 / 60, pose);
  nav.flyTo(w, 'jupiter');
  const earth = w.body('earth');
  const jupiter = w.body('jupiter');
  let dimmest = 1;
  while (nav.travelling) {
    nav.update(w, 1 / 60, pose);
    dimmest = Math.min(dimmest, pose.dim);
    const near = Math.min(distance(pose.position, earth.position), distance(pose.position, jupiter.position));
    expect(near).toBeLessThan(2e6);
  }
  expect(dimmest).toBeLessThan(0.2);
  expect(pose.dim).toBe(1);
});
