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
  const all: NavBody[] = BODY_IDS.map((id) => {
    const b = system.bodies[id].basis;
    return { ...system.specs[id], position: system.bodies[id].position, pole: km(b[3] ?? 0, b[4] ?? 1, b[5] ?? 0) };
  });
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

const out = (): NavOutput => ({ position: km(), target: km(), dim: 1, cut: false, progress: 1, from: null });
const distance = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('a flight from body to body never enters one, lasts 2.6 to 8 s and ends at the framing distance', () => {
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
    expect(seconds, `flight to ${next}`).toBeGreaterThanOrEqual(2.6 - 1 / 30);
    expect(seconds, `flight to ${next}`).toBeLessThanOrEqual(8 + 1 / 30);
    const to = w.body(next);
    expect(distance(pose.position, to.position) / nav.framingKm(to)).toBeCloseTo(1, 2);
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

test('framing fits the body to the narrower side of the clear view: a phone held upright frames it by its width', () => {
  const { w } = setup();
  const nav = new Navigator('earth');
  const saturn = w.body('saturn');
  const tanHalfFov = Math.tan((25 * Math.PI) / 180);
  nav.setView({ tanHalfFov, aspect: 1280 / 800, top: 0, bottom: 0 });
  const wide = nav.framingKm(saturn);
  nav.setView({ tanHalfFov, aspect: 390 / 844, top: 0.06, bottom: 0.18 });
  const tall = nav.framingKm(saturn);
  // The rings' full width fits inside the phone's width, with a margin.
  const halfWidth = Math.atan(tanHalfFov * (390 / 844));
  expect(Math.asin(saturn.boundKm / tall)).toBeLessThan(halfWidth * 0.85);
  expect(tall).toBeGreaterThan(wide * 1.8);
});

test('a flight closes in on its destination the whole way, and passes well clear of the Sun', () => {
  const { w } = setup();
  const route: BodyId[] = ['earth', 'jupiter', 'earth', 'saturn', 'moon'];
  const nav = new Navigator('earth');
  nav.begin(w, 'earth', false);
  const pose = out();
  nav.update(w, 1 / 60, pose);
  for (const next of route.slice(1)) {
    const from = w.body(nav.focus);
    nav.flyTo(w, next);
    const to = w.body(next);
    const start = distance(pose.position, to.position);
    let closest = Infinity;
    let worstRise = 0;
    let previous = start;
    const sunFloor = 0.2 * Math.min(Math.hypot(from.position.x, from.position.y, from.position.z), Math.hypot(to.position.x, to.position.y, to.position.z));
    while (nav.travelling) {
      nav.update(w, 1 / 60, pose);
      const now = distance(pose.position, to.position);
      worstRise = Math.max(worstRise, (now - previous) / start);
      previous = now;
      closest = Math.min(closest, distance(pose.position, w.sun));
    }
    // Never back away from the destination by more than a sliver of the trip (the bodies move meanwhile).
    expect(worstRise, `flight to ${next}`).toBeLessThan(0.002);
    expect(closest, `flight to ${next}`).toBeGreaterThan(sunFloor);
  }
});

test('a reduced-motion cut moves the camera on exactly one frame, while the picture is dimmest', () => {
  const { w } = setup();
  const nav = new Navigator('earth');
  nav.reducedMotion = true;
  nav.begin(w, 'earth', false);
  const pose = out();
  nav.update(w, 1 / 60, pose);
  nav.flyTo(w, 'saturn');
  const cuts: number[] = [];
  while (nav.travelling) {
    nav.update(w, 1 / 60, pose);
    if (pose.cut) cuts.push(pose.dim);
  }
  expect(cuts).toHaveLength(1);
  expect(cuts[0]).toBeLessThan(0.2);
});

