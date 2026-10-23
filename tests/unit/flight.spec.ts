/**
 * The explorer's camera rigs (src/explore/flight.ts) and the navigator's hand-offs between them
 * (src/explore/navigation.ts), over the real solar system on a fixed date: exact springs, log-height
 * zoom, free flight paced by altitude, and seamless switches between orbiting and flying.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { MoonFile, PlanetsFile } from '../../src/astro/ephemeris';
import type { PhysicalFile } from '../../src/astro/physical';
import { BODY_IDS, type BodyId } from '../../src/core/types';
import { FLIGHT, MAX_ALTITUDE_KM, OrbitRig, springOf, stepSpring, type Spring } from '../../src/explore/flight';
import { Navigator, navOutput, type NavBody, type NavOutput, type NavWorld } from '../../src/explore/navigation';
import { km, type Km } from '../../src/explore/space/origin';
import { createSolarSystem } from '../../src/explore/system';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const JD = 2461336.75;

function setup(): NavWorld {
  const system = createSolarSystem(
    readJson('public/assets/jpl/planets.json') as PlanetsFile,
    readJson('public/assets/jpl/moon.json') as MoonFile,
    readJson('public/assets/jpl/physical.json') as PhysicalFile,
  );
  system.update(JD);
  const all: NavBody[] = BODY_IDS.map((id) => {
    const b = system.bodies[id].basis;
    return { ...system.specs[id], position: system.bodies[id].position, pole: km(b[3] ?? 0, b[4] ?? 1, b[5] ?? 0) };
  });
  return { all, sun: system.bodies.sun.position, body: (id: BodyId) => all.find((b) => b.id === id) ?? (all[0] as NavBody) };
}

const distance = (a: Km, b: Km): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const angle = (a: Km, b: Km): number => Math.acos(Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z)));

function stepFor(s: Spring, goal: number, omega: number, seconds: number, hz: number): Spring {
  const n = Math.round(seconds * hz);
  for (let i = 0; i < n; i++) stepSpring(s, goal, omega, 1 / hz);
  return s;
}

test('the springs are exact: the same motion at 30, 60 and 144 Hz or in one step, and no overshoot', () => {
  const at = (hz: number): Spring => stepFor({ x: 0, v: 0 }, 1, 6, 0.5, hz);
  const one = { x: 0, v: 0 };
  stepSpring(one, 1, 6, 0.5);
  for (const hz of [30, 60, 144]) {
    expect(at(hz).x).toBeCloseTo(one.x, 9);
    expect(at(hz).v).toBeCloseTo(one.v, 9);
  }
  // Critically damped: from rest it approaches the goal monotonically and never passes it.
  const s = springOf(0);
  let last = 0;
  for (let i = 0; i < 600; i++) {
    stepSpring(s, 1, 6, 1 / 60);
    expect(s.x).toBeGreaterThanOrEqual(last);
    expect(s.x).toBeLessThanOrEqual(1);
    last = s.x;
  }
  // At rest it snaps exactly to the goal (so "moving" can end).
  expect(s.x).toBe(1);
  expect(s.v).toBe(0);
});

test('zooming is in the logarithm of the height: a notch is the same share at 200 km as at 5 au, and the floor holds', () => {
  const world = setup();
  const earth = world.body('earth');
  for (const altitude of [200, 7.5e8]) {
    const rig = new OrbitRig();
    rig.settle(km(0, 0, 1), altitude);
    rig.zoom(Math.log(0.85));
    for (let i = 0; i < 240; i++) rig.update(earth, 1 / 60);
    expect(rig.altitudeKm / altitude).toBeCloseTo(0.85, 6);
  }
  const rig = new OrbitRig();
  rig.settle(km(0, 0, 1), 300);
  rig.zoom(-20);
  for (let i = 0; i < 240; i++) rig.update(earth, 1 / 60);
  expect(rig.altitudeKm).toBeCloseTo(earth.minAltitudeKm, 6);
});

test('free flight is paced by altitude: ten times higher, ten times faster; Shift five times faster still', () => {
  const world = setup();
  const travelled = (altitude: number, boost: boolean): number => {
    const nav = new Navigator('earth');
    const out = navOutput();
    // Above the Earth, looking away from it, so flying forward climbs straight out.
    nav.place('earth', km(1, 0.2, 0.3), world.body('earth').radiusKm + altitude, world);
    nav.update(world, 1 / 60, out);
    nav.drag(world, 0, 0);
    const start = { ...out.position };
    nav.setFlightKeys(world, km(0, 0, -1), 0, boost);
    // Backward: away from the Earth (the camera looks at it).
    for (let i = 0; i < 6; i++) nav.update(world, 1 / 60, out);
    return distance(out.position, start);
  };
  const low = travelled(1_000, false);
  const high = travelled(10_000, false);
  const boosted = travelled(1_000, true);
  expect(high / low).toBeGreaterThan(8);
  expect(high / low).toBeLessThan(12);
  expect(boosted / low).toBeGreaterThan(FLIGHT.boost * 0.8);
  expect(boosted / low).toBeLessThan(FLIGHT.boost * 1.2);
});

test('flying into a world stops at its floor: no frame of free flight is inside a body', () => {
  const world = setup();
  const nav = new Navigator('earth');
  const out = navOutput();
  const earth = world.body('earth');
  nav.place('earth', km(0, 0.3, 1), earth.radiusKm + 2_000, world);
  nav.update(world, 1 / 60, out);
  nav.setFlightKeys(world, km(0, 0, 1), 0, true);
  for (let i = 0; i < 600; i++) {
    nav.update(world, 1 / 60, out);
    expect(distance(out.position, earth.position)).toBeGreaterThanOrEqual(earth.radiusKm + earth.minAltitudeKm - 1e-6);
  }
  expect(nav.mode).toBe('flight');
});

test('leaving orbit for free flight, and handing back, never jumps: the camera stays put and the gaze eases', () => {
  const world = setup();
  const nav = new Navigator('earth');
  const out: NavOutput = navOutput();
  nav.place('earth', km(0.3, 0.2, 1), 30_000, world);
  nav.update(world, 1 / 60, out);
  const before = { position: { ...out.position }, forward: { ...out.forward } };
  // A flight key: the next frame starts exactly where the orbit was (one frame of slow drift at most).
  nav.setFlightKeys(world, km(0, 0, 1), 0, false);
  nav.update(world, 1 / 60, out);
  expect(nav.mode).toBe('flight');
  expect(distance(out.position, before.position)).toBeLessThan(30_000 * 0.01);
  expect(angle(out.forward, before.forward)).toBeLessThan(1e-6);
  // Turn away, fly a little, then let go and orbit again.
  nav.setFlightKeys(world, km(0, 0, 0), 0, false);
  nav.drag(world, 300, 0);
  for (let i = 0; i < 60; i++) nav.update(world, 1 / 60, out);
  const handoff = { position: { ...out.position }, forward: { ...out.forward } };
  nav.orbitNearest(world);
  let worst = 0;
  let previous = { ...out.forward };
  for (let i = 0; i < 120; i++) {
    nav.update(world, 1 / 60, out);
    worst = Math.max(worst, angle(out.forward, previous));
    previous = { ...out.forward };
    if (i === 0) expect(distance(out.position, handoff.position)).toBeLessThan(1);
  }
  expect(nav.mode).toBe('orbit');
  // Eased round: under 4 degrees a frame, and in the end looking at the Earth.
  expect(worst).toBeLessThan((4 * Math.PI) / 180);
  const toEarth = { x: world.body('earth').position.x - out.position.x, y: world.body('earth').position.y - out.position.y, z: world.body('earth').position.z - out.position.z };
  const l = Math.hypot(toEarth.x, toEarth.y, toEarth.z);
  expect(angle(out.forward, { x: toEarth.x / l, y: toEarth.y / l, z: toEarth.z / l })).toBeLessThan(0.01);
});

test('a drag low over a world turns gently (precise close in), far away at full rate', () => {
  const world = setup();
  const turned = (distanceKm: number): number => {
    const nav = new Navigator('earth');
    const out = navOutput();
    nav.place('earth', km(0, 0, 1), distanceKm, world);
    nav.update(world, 1 / 60, out);
    const a = { ...out.position };
    nav.drag(world, 100, 0);
    for (let i = 0; i < 120; i++) nav.update(world, 1 / 60, out);
    const earth = world.body('earth').position;
    const u = { x: a.x - earth.x, y: a.y - earth.y, z: a.z - earth.z };
    const v = { x: out.position.x - earth.x, y: out.position.y - earth.y, z: out.position.z - earth.z };
    return Math.acos((u.x * v.x + u.y * v.y + u.z * v.z) / (Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z)));
  };
  const low = turned(6_378 + 300);
  const far = turned(500_000);
  expect(far).toBeGreaterThan(0.5);
  expect(low).toBeLessThan(far * 0.12);
});

test('free flight has a ceiling: a boost held outward for an hour stops at the orbit rig’s limit, never at Infinity', () => {
  const w = setup();
  const nav = new Navigator('earth');
  nav.begin(w, 'earth', false);
  const out: NavOutput = navOutput();
  nav.update(w, 1 / 60, out);
  // Back away from the Earth (the view looks at it), on and on, with Shift held.
  nav.setFlightKeys(w, km(0, 0, -1), 0, true);
  const nearest = (): number => Math.min(...w.all.map((b) => distance(out.position, b.position) - b.radiusKm));
  for (let i = 0; i < 36_000; i++) {
    nav.update(w, 0.1, out);
    if (!Number.isFinite(out.position.x + out.position.y + out.position.z)) throw new Error(`not finite after ${i} frames`);
  }
  expect(nearest()).toBeLessThanOrEqual(MAX_ALTITUDE_KM * 1.0001);
  expect(nearest()).toBeGreaterThan(MAX_ALTITUDE_KM * 0.5);
  // Held at the ceiling, it is not still pushing outward at full speed.
  expect(out.speedKmS).toBeLessThan(FLIGHT.speedPerAltitude * FLIGHT.boost * MAX_ALTITUDE_KM);
});
