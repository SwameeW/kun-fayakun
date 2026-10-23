/**
 * Cinematic travel (src/explore/travel.ts, through src/explore/navigation.ts) over the real solar
 * system on a fixed date: the length rule, soft starts and stops, never inside a body (round it
 * from the far side), clear of the Sun and of bodies on the way, banking and the lens within limits
 * and back to rest, and Esc stopping a trip without a jump.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { MoonFile, PlanetsFile } from '../../src/astro/ephemeris';
import type { PhysicalFile } from '../../src/astro/physical';
import { BODY_IDS, type BodyId } from '../../src/core/types';
import type { RigBody } from '../../src/explore/flight';
import { Navigator, navOutput, type NavBody, type NavWorld } from '../../src/explore/navigation';
import { km, type Km } from '../../src/explore/space/origin';
import { createSolarSystem } from '../../src/explore/system';
import { planTravel, travelFrame, travelSeconds, TRAVEL_SECONDS } from '../../src/explore/travel';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const JD = 2461336.75;
const VIEW = { tanHalfFov: Math.tan((25 * Math.PI) / 180), aspect: 1.6, top: 0.07, bottom: 0.1 };

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

interface Flown {
  seconds: number;
  speeds: number[];
  closest: Map<string, number>;
  banks: number[];
  fovs: number[];
}

/** Flies to `to` frame by frame at 60 Hz, recording what the tests check. */
function fly(nav: Navigator, world: NavWorld, to: BodyId): Flown {
  const out = navOutput();
  nav.update(world, 1 / 60, out);
  nav.flyTo(world, to);
  let seconds = 0;
  let previous = { ...out.position };
  const speeds: number[] = [];
  const banks: number[] = [];
  const fovs: number[] = [];
  const closest = new Map<string, number>();
  while (nav.travelling && seconds < 20) {
    nav.update(world, 1 / 60, out);
    seconds += 1 / 60;
    speeds.push(distance(out.position, previous) * 60);
    previous = { ...out.position };
    for (const body of world.all) closest.set(body.id, Math.min(closest.get(body.id) ?? Infinity, distance(out.position, body.position) - body.radiusKm));
    // Bank: the roll of "up" about the line of sight, against ecliptic north made square to it.
    const f = out.forward;
    const d = f.y;
    const ux = -f.x * d;
    const uy = 1 - f.y * d;
    const uz = -f.z * d;
    const l = Math.hypot(ux, uy, uz) || 1;
    banks.push(Math.acos(Math.min(1, (out.up.x * ux + out.up.y * uy + out.up.z * uz) / l)));
    fovs.push(out.fov);
  }
  return { seconds, speeds, closest, banks, fovs };
}

test('a trip lasts 2.5 s plus 0.9 s per factor of ten in distance, from 2.5 to 9 s', () => {
  expect(travelSeconds(1e5, 1e4)).toBeCloseTo(TRAVEL_SECONDS.base + TRAVEL_SECONDS.perDecade, 9);
  expect(travelSeconds(1e9, 1e5)).toBeCloseTo(2.5 + 0.9 * 4, 9);
  expect(travelSeconds(1e4, 1e4)).toBe(2.5);
  expect(travelSeconds(1e20, 1)).toBe(9);
});

test('Earth, Moon, Sun, Jupiter, Saturn and back: never inside a body, eased in and out, arriving exactly at the framing distance', () => {
  const world = setup();
  const nav = new Navigator('earth');
  nav.setView(VIEW, 50);
  nav.begin(world, 'earth', false);
  for (const next of ['moon', 'sun', 'jupiter', 'saturn', 'earth'] as const) {
    const flown = fly(nav, world, next);
    for (const [id, gap] of flown.closest) {
      const body = world.body(id as BodyId);
      expect(gap, `above ${id} on the way to ${next}`).toBeGreaterThanOrEqual(body.minAltitudeKm - 1e-6);
    }
    const peak = Math.max(...flown.speeds);
    // Soft start and soft stop: the first and last frames move a sliver of the fastest one.
    expect((flown.speeds[0] ?? 0) / peak, `start of ${next}`).toBeLessThan(0.02);
    expect((flown.speeds.at(-1) ?? 0) / peak, `end of ${next}`).toBeLessThan(0.02);
    const to = world.body(next);
    const out = navOutput();
    nav.update(world, 1 / 60, out);
    expect(distance(out.position, to.position) / nav.framingKm(to), `arrival at ${next}`).toBeCloseTo(1, 3);
  }
});

test('from a start far out from the body it leaves, the arrival still only closes in: never nearer than where it ends', () => {
  const world = setup();
  for (const [from, to] of [['earth', 'moon'], ['earth', 'saturn'], ['moon', 'sun'], ['jupiter', 'earth']] as const) {
    const nav = new Navigator(from);
    nav.setView(VIEW, 50);
    const A = world.body(from);
    const B = world.body(to);
    nav.place(from, km(0.3, 0.4, 0.86), 4 * nav.framingKm(A), world);
    const out = navOutput();
    nav.update(world, 1 / 60, out);
    nav.flyTo(world, to);
    const end = nav.framingKm(B);
    let previous = Infinity;
    let rises = 0;
    let nearest = Infinity;
    while (nav.travelling) {
      nav.update(world, 1 / 60, out);
      const d = distance(out.position, B.position);
      nearest = Math.min(nearest, d);
      if (d > previous + 1e-6 * previous) rises += 1;
      previous = d;
    }
    expect(nearest / end, `${from} to ${to}`).toBeGreaterThan(0.999);
    expect(rises, `${from} to ${to}`).toBe(0);
  }
});

test('left from its far side, the camera swings round the body it leaves, never through it', () => {
  const world = setup();
  for (const [from, to] of [['earth', 'moon'], ['jupiter', 'earth'], ['moon', 'sun']] as const) {
    const nav = new Navigator(from);
    nav.setView(VIEW, 50);
    const A = world.body(from);
    const B = world.body(to);
    // Behind A, as seen from B: B is hidden behind A.
    const d = { x: A.position.x - B.position.x, y: A.position.y - B.position.y, z: A.position.z - B.position.z };
    const l = Math.hypot(d.x, d.y, d.z);
    const start = nav.framingKm(A);
    nav.place(from, km(d.x / l, d.y / l, d.z / l), start, world);
    const flown = fly(nav, world, to);
    // It never comes nearer A than it started (beyond a sliver), so it went round, not through.
    expect(flown.closest.get(from) ?? 0, `${from} to ${to}`).toBeGreaterThan((start - A.radiusKm) * 0.98);
  }
});

test('a trip between two other bodies passes well clear of the Sun, and of any body in the way', () => {
  const world = setup();
  // Saturn and the Earth are far apart; the Sun must not be skimmed even when it lies between them.
  const nav = new Navigator('earth');
  nav.setView(VIEW, 50);
  nav.begin(world, 'earth', false);
  const flown = fly(nav, world, 'saturn');
  const sunGap = flown.closest.get('sun') ?? 0;
  const nearer = Math.min(Math.hypot(world.body('earth').position.x, world.body('earth').position.y, world.body('earth').position.z), Math.hypot(world.body('saturn').position.x, world.body('saturn').position.y, world.body('saturn').position.z));
  expect(sunGap).toBeGreaterThan(0.4 * nearer);

  // A synthetic line-up: an obstacle exactly on the straight path is cleared by its margin.
  const body = (id: string, position: Km, radiusKm: number): RigBody => ({ id, radiusKm, boundKm: radiusKm, minAltitudeKm: radiusKm * 0.02, position });
  const A = body('a', km(0, 0, 0), 1_000);
  const B = body('b', km(1e7, 0, 0), 1_000);
  const C = body('c', km(5e6, 0, 0), 50_000);
  const pose = { position: km(-30_000, 0, 0), forward: km(1, 0, 0), up: km(0, 1, 0) };
  const plan = planTravel({ from: A, to: B, pose, endDir: km(-1, 0, 0), endDistance: 20_000, bodies: [A, B, C], sun: null });
  const frame = { position: km(), forward: km(), up: km(), pace: 0 };
  let nearest = Infinity;
  for (let i = 0; i <= 600; i++) {
    travelFrame(plan, i / 600, frame);
    nearest = Math.min(nearest, distance(frame.position, C.position) - C.radiusKm);
  }
  expect(nearest).toBeGreaterThan(C.radiusKm * 2);
});

test('a trip banks a little into its turns and widens the lens a touch, both back to rest on arrival; with reduced motion neither', () => {
  const world = setup();
  const nav = new Navigator('earth');
  nav.setView(VIEW, 50);
  nav.begin(world, 'earth', false);
  const flown = fly(nav, world, 'jupiter');
  expect(Math.max(...flown.banks)).toBeLessThanOrEqual(0.14 + 1e-6);
  expect(Math.max(...flown.fovs)).toBeGreaterThan(51);
  expect(Math.max(...flown.fovs)).toBeLessThanOrEqual(55.01);
  const out = navOutput();
  for (let i = 0; i < 240; i++) nav.update(world, 1 / 60, out);
  expect(out.fov).toBeCloseTo(50, 3);

  const calm = new Navigator('earth');
  calm.reducedMotion = true;
  calm.setView(VIEW, 50);
  calm.begin(world, 'earth', false);
  const cut = fly(calm, world, 'jupiter');
  expect(Math.max(...cut.fovs)).toBe(50);
  expect(Math.max(...cut.banks)).toBeLessThan(1e-6);
});

test('Esc stops a trip where it is: no jump, and the camera coasts to rest in free flight', () => {
  const world = setup();
  const nav = new Navigator('earth');
  nav.setView(VIEW, 50);
  nav.begin(world, 'earth', false);
  const out = navOutput();
  nav.update(world, 1 / 60, out);
  nav.flyTo(world, 'jupiter');
  for (let i = 0; i < 90; i++) nav.update(world, 1 / 60, out);
  const at = { ...out.position };
  const speed = (): number => {
    const before = { ...out.position };
    nav.update(world, 1 / 60, out);
    return distance(out.position, before) * 60;
  };
  const cruising = speed();
  expect(nav.cancelTravel(world)).toBe(true);
  expect(nav.travelling).toBe(false);
  expect(nav.mode).toBe('flight');
  const first = speed();
  // The step after stopping is no longer than one at cruising speed: no jump.
  expect(distance(out.position, at)).toBeLessThan(cruising * 3);
  expect(first).toBeLessThanOrEqual(cruising * 1.05);
  for (let i = 0; i < 300; i++) nav.update(world, 1 / 60, out);
  expect(speed()).toBeLessThan(cruising * 1e-3);
  // Nothing to stop now.
  expect(nav.cancelTravel(world)).toBe(false);
});

test('taking the flight controls during a trip stops it too, and a body asked for mid-trip is flown to after arrival', () => {
  const world = setup();
  const nav = new Navigator('earth');
  nav.setView(VIEW, 50);
  nav.begin(world, 'earth', false);
  const out = navOutput();
  nav.update(world, 1 / 60, out);
  nav.flyTo(world, 'moon');
  for (let i = 0; i < 30; i++) nav.update(world, 1 / 60, out);
  nav.setFlightKeys(world, km(0, 0, 1), 0, false);
  expect(nav.travelling).toBe(false);
  expect(nav.mode).toBe('flight');
  nav.setFlightKeys(world, km(0, 0, 0), 0, false);

  const queued = new Navigator('earth');
  queued.setView(VIEW, 50);
  queued.begin(world, 'earth', false);
  queued.update(world, 1 / 60, out);
  queued.flyTo(world, 'moon');
  queued.update(world, 1 / 60, out);
  queued.flyTo(world, 'sun');
  expect(queued.focus).toBe('moon');
  let frames = 0;
  while (queued.focus !== 'sun' && frames < 2000) {
    queued.update(world, 1 / 60, out);
    frames += 1;
  }
  expect(queued.focus).toBe('sun');
  expect(queued.travelling).toBe(true);
});
