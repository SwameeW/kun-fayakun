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
import { Navigator, navOutput, type NavBody, type NavOutput, type NavWorld } from '../../src/explore/navigation';
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

const out = (): NavOutput => navOutput();
const distance = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('a flight from body to body never enters one, lasts 2.5 to 9 s and ends at the framing distance', () => {
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
    expect(seconds, `flight to ${next}`).toBeGreaterThanOrEqual(2.5 - 1 / 30);
    expect(seconds, `flight to ${next}`).toBeLessThanOrEqual(9 + 1 / 30);
    const to = w.body(next);
    expect(distance(pose.position, to.position) / nav.framingKm(to)).toBeCloseTo(1, 2);
  }
});

test('orbiting never goes below the floor over the body, however far the zoom is pushed', () => {
  const { w } = setup();
  const nav = new Navigator('earth');
  nav.begin(w, 'earth', false);
  const pose = out();
  nav.zoom(w, -50);
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


/** The laboratory's own bodies as the explorer lists them (src/explore/lab navBodies): live positions, a floor of 2% of the radius. */
function withLab(system: SolarSystem, lab: Array<{ id: `lab:${string}`; radiusKm: number; at: [number, number, number] }>): { w: NavWorld; bodies: NavBody[]; drop: (id: string) => void } {
  const ten = world(system).all;
  const known: NavBody[] = lab.map((b) => ({ id: b.id, radiusKm: b.radiusKm, boundKm: b.radiusKm, minAltitudeKm: Math.max(0.02 * b.radiusKm, 0.003), fill: 0.6, view: { azimuth: 0.85, latitude: 0.12, litFace: false }, position: km(...b.at), pole: km(0, 1, 0) }));
  const all: NavBody[] = [...ten, ...known];
  // A body gone keeps its last place for a lookup (a trip from it starts there), and leaves the list the camera keeps out of.
  const w: NavWorld = {
    all,
    sun: system.bodies.sun.position,
    body(id) {
      const found = all.find((b) => b.id === id) ?? known.find((b) => b.id === id);
      if (!found) throw new Error(`no body ${id}`);
      return found;
    },
  };
  return {
    w,
    bodies: known,
    drop: (id) => {
      all.splice(all.findIndex((b) => b.id === id), 1);
    },
  };
}

test('a laboratory body followed is kept at its framing distance as it moves, and the camera keeps out of one it passes', () => {
  const { system } = setup();
  const earth = system.bodies.earth.position;
  // A rock 500 km across, 60,000 km from the Earth, going at 40 km/s; a moon of 1,000 km beside its way,
  // 1,600 km from its line (clear of the rock), so the camera framing the rock from that side runs into it.
  const { w, bodies } = withLab(system, [
    { id: 'lab:rock', radiusKm: 250, at: [earth.x + 60_000, earth.y, earth.z] },
    { id: 'lab:moonlet', radiusKm: 1000, at: [earth.x + 61_600, earth.y, earth.z + 30_000] },
  ]);
  const [rock, moonlet] = bodies as [NavBody, NavBody];
  const nav = new Navigator('earth');
  nav.reducedMotion = true;
  const pose = out();
  nav.place('lab:rock', km(1, 0, 0), 1, w);
  nav.flyTo(w, 'lab:rock');
  nav.update(w, 1 / 60, pose);
  const framing = nav.framingKm(rock);
  expect(nav.focus).toBe('lab:rock');
  expect(distance(pose.position, rock.position) / framing).toBeCloseTo(1, 9);
  // An hour of its flight, a second a frame: the distance held but where the moon is in the way, never inside either.
  let worst = 0;
  let lowest = Infinity;
  for (let k = 0; k < 3600; k += 1) {
    rock.position.z += 40;
    nav.update(w, 1 / 60, pose);
    const d = distance(pose.position, rock.position);
    if (distance(rock.position, moonlet.position) > framing + moonlet.radiusKm + moonlet.minAltitudeKm) worst = Math.max(worst, Math.abs(d / framing - 1));
    for (const b of bodies) lowest = Math.min(lowest, distance(pose.position, b.position) - b.radiusKm - b.minAltitudeKm);
  }
  expect(worst).toBeLessThan(1e-9);
  // It did come to the moon's floor (held there), and never below it.
  expect(lowest).toBeLessThan(1);
  expect(lowest).toBeGreaterThan(-1e-6);
});

test('a laboratory body that goes is let go of: the camera stays where it is, flying freely; a cut to it finishes first', () => {
  const { system } = setup();
  const earth = system.bodies.earth.position;
  const { w, drop } = withLab(system, [
    { id: 'lab:rock', radiusKm: 250, at: [earth.x + 60_000, earth.y, earth.z] },
    { id: 'lab:stone', radiusKm: 1, at: [earth.x - 60_000, earth.y, earth.z] },
  ]);
  const nav = new Navigator('earth');
  const pose = out();
  nav.place('lab:rock', km(0, 1, 0), 5000, w);
  nav.update(w, 1 / 60, pose);
  const before = { ...pose.position };
  drop('lab:rock');
  nav.release(w);
  nav.update(w, 1 / 60, pose);
  expect(nav.mode).toBe('flight');
  expect(nav.focus).not.toBe('lab:rock');
  expect(distance(pose.position, before)).toBeLessThan(1e-6);
  // With reduced motion, one going while the cut to it dims: the light comes back first (no step), then the camera is let go.
  nav.reducedMotion = true;
  nav.flyTo(w, 'lab:stone');
  for (let k = 0; k < 10; k += 1) nav.update(w, 1 / 60, pose);
  drop('lab:stone');
  let last = pose.dim;
  let steepest = 0;
  for (let k = 0; k < 600 && nav.focus === 'lab:stone'; k += 1) {
    nav.release(w);
    nav.update(w, 1 / 60, pose);
    steepest = Math.max(steepest, Math.abs(pose.dim - last));
    last = pose.dim;
  }
  expect(nav.focus).not.toBe('lab:stone');
  expect(nav.mode).toBe('flight');
  expect(pose.dim).toBe(1);
  expect(steepest).toBeLessThan(0.1);
});

test('a body asked for while the camera flies to one that goes (a merger’s survivor) is flown to from where the camera lets go, and framed', () => {
  const { system } = setup();
  const earth = system.bodies.earth.position;
  const { w, drop } = withLab(system, [
    { id: 'lab:rock', radiusKm: 250, at: [earth.x + 600_000, earth.y, earth.z] },
    { id: 'lab:moonlet', radiusKm: 1000, at: [earth.x + 600_000, earth.y, earth.z + 20_000] },
  ]);
  const nav = new Navigator('earth');
  nav.begin(w, 'earth', false);
  const pose = out();
  nav.update(w, 1 / 60, pose);
  nav.flyTo(w, 'lab:rock');
  for (let k = 0; k < 60; k += 1) nav.update(w, 1 / 60, pose);
  // On the way, the moonlet asked for (waiting for the trip), then the rock goes.
  nav.flyTo(w, 'lab:moonlet');
  expect(nav.tripState?.to).toBe('lab:rock');
  const before = { ...pose.position };
  drop('lab:rock');
  nav.release(w);
  expect(nav.tripState?.to).toBe('lab:moonlet');
  nav.update(w, 1 / 60, pose);
  // No jump: on from where the camera was (it had been going at most a few hundred km a frame).
  expect(distance(pose.position, before)).toBeLessThan(1000);
  for (let k = 0; k < 900 && nav.travelling; k += 1) nav.update(w, 1 / 60, pose);
  const moonlet = w.body('lab:moonlet');
  expect(nav.focus).toBe('lab:moonlet');
  expect(nav.mode).toBe('orbit');
  expect(distance(pose.position, moonlet.position) / nav.framingKm(moonlet)).toBeCloseTo(1, 2);
  // Let go of on leaving (now), nothing asked for is kept: the camera stays, flying freely.
  nav.flyTo(w, 'earth');
  nav.flyTo(w, 'lab:moonlet');
  nav.release(w, true);
  expect(nav.travelling).toBe(false);
  expect(nav.mode).toBe('flight');
});
