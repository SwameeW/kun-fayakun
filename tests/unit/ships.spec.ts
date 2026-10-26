/**
 * Ships in the orbital laboratory (src/sim/ships.ts; ledger SC-1, SC-3), checked against physics,
 * not against copies of the code:
 *
 * - the rocket equation: a burn for a change of speed, in empty space, changes the speed by that
 *   much (Tsiolkovsky: Isp g0 ln(m0 / m1)) and spends the propellant it says (m0 (1 - e^(-dv / (Isp g0))));
 * - a burn begins at its time and not before, and directions are what they say (prograde along the
 *   motion, normal square to the orbit, radial out away from the body);
 * - a Hohmann transfer planned with two burns (Vallado, Fundamentals of Astrodynamics, 4th ed.,
 *   algorithm 36): from a circular orbit 7,000 km from the Earth's centre to 42,164 km (geostationary
 *   radius), the first burn's apoapsis reaching the second orbit and the second circularising it;
 * - undo takes a burn back, bit for bit; a scenario with a ship and a burn round-trips the validator.
 */
import { expect, test } from '@playwright/test';
import { DEFAULT_INTEGRATOR, Engine, ENGINE_VERSION, SCHEMA_VERSION, validateScenario, type BodySpec, type Scenario } from '../../src/sim/engine';
import { elementsFromState } from '../../src/sim/elements';
import { emptyState, step, addBody, type MergeEvent } from '../../src/sim/nbody';
import { burnDirection, burnDuration, burnStep, deltaVLeft, G0, planBurn, type ShipSpec } from '../../src/sim/ships';

const GM_EARTH = 398_600.435;
const R_EARTH = 6378.137;
const SHIP: ShipSpec = { dryKg: 10_000, fuelKg: 10_000, thrustN: 50_000, ispS: 320 };
const body = (id: string, gm: number, radiusKm: number, pos: [number, number, number], vel: [number, number, number], extra: Partial<BodySpec> = {}): BodySpec => ({ id, name: id, gm, radiusKm, pos, vel, origin: 'user-edited', sourceIds: [], ...extra });
const scenario = (bodies: BodySpec[]): Scenario => ({ schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, name: 'ships', epochJdTdb: 2_451_545, frame: 'test', seedNote: 'test', integrator: { ...DEFAULT_INTEGRATOR, dtMaxS: 60 }, bodies, log: [] });

test('the rocket equation: a burn in empty space gives the change of speed asked for and spends the propellant it says', () => {
  const s = emptyState();
  addBody(s, { id: 'ship', name: 'ship', gm: 0, radiusKm: 0.01, pos: [0, 0, 0], vel: [7, 0, 0] });
  s.ships.ship = { ...SHIP, burns: [] };
  const dv = 1500;
  const duration = burnDuration(SHIP, dv);
  // At full thrust from 20 t: mdot = 50,000 / (320 g0) = 15.93 kg/s; the burn about 9 minutes.
  expect(duration).toBeGreaterThan(400);
  expect(duration).toBeLessThan(600);
  planBurn(s.ships.ship, { startT: 0, durationS: duration, direction: 'prograde', ref: 'nothing', throttle: 1 });
  const acc: number[] = [];
  const events: MergeEvent[] = [];
  while (s.t < duration + 30) step(s, burnStep(s, 30), acc, events);
  const speed = Math.hypot(s.vel[0] ?? 0, s.vel[1] ?? 0, s.vel[2] ?? 0) * 1000;
  expect(speed - 7000).toBeCloseTo(dv, 1);
  expect(SHIP.dryKg + SHIP.fuelKg - (SHIP.dryKg + (s.ships.ship.fuelKg))).toBeCloseTo((SHIP.dryKg + SHIP.fuelKg) * (1 - Math.exp(-dv / (SHIP.ispS * G0))), 6);
  // The burn over, it is dropped; what is left still gives the rest of the rocket equation's change.
  expect(s.ships.ship.burns).toEqual([]);
  expect(deltaVLeft(SHIP) - deltaVLeft(s.ships.ship)).toBeCloseTo(dv, 6);
  expect(burnDuration(SHIP, deltaVLeft(SHIP) + 1)).toBe(Number.POSITIVE_INFINITY);
});

test('a burn begins at its time, and its directions are what they say', () => {
  const s = emptyState();
  addBody(s, { id: 'earth', name: 'earth', gm: GM_EARTH, radiusKm: R_EARTH, pos: [0, 0, 0], vel: [0, 0, 0] });
  const v = Math.sqrt(GM_EARTH / 7000);
  addBody(s, { id: 'ship', name: 'ship', gm: 0, radiusKm: 0.01, pos: [7000, 0, 0], vel: [0, v, 0] });
  s.ships.ship = { ...SHIP, burns: [] };
  const dir = (direction: 'prograde' | 'normal' | 'radialOut' | 'retrograde'): number[] => burnDirection(s, 1, { direction, ref: 'earth' });
  expect(dir('prograde')).toEqual([0, 1, 0]);
  expect(dir('retrograde')).toEqual([-0, -1, -0]);
  expect(dir('normal')).toEqual([0, 0, 1]);
  expect(dir('radialOut')[0]).toBeCloseTo(1, 12);
  planBurn(s.ships.ship, { startT: 120, durationS: 30, direction: 'prograde', ref: 'earth', throttle: 1 });
  const acc: number[] = [];
  const events: MergeEvent[] = [];
  // Steps of up to 50 s land on the start, not across it; the propellant is untouched till then.
  while (s.t < 120 - 1e-9) step(s, burnStep(s, 50), acc, events);
  expect(s.t).toBeCloseTo(120, 9);
  expect(s.ships.ship.fuelKg).toBe(SHIP.fuelKg);
  step(s, burnStep(s, 50), acc, events);
  expect(s.ships.ship.fuelKg).toBeLessThan(SHIP.fuelKg);
});

test('a Hohmann transfer planned with two burns, from 7,000 km to geostationary radius', () => {
  const r1 = 7000;
  const r2 = 42_164;
  const v1 = Math.sqrt(GM_EARTH / r1);
  // A ship with the propellant for it (7.2 km/s of change of speed; the transfer needs 3.8) and a strong engine (20 m/s^2 at the start).
  const ship: ShipSpec = { dryKg: 2000, fuelKg: 18_000, thrustN: 400_000, ispS: 320 };
  const e = new Engine(scenario([body('earth', GM_EARTH, R_EARTH, [0, 0, 0], [0, 0, 0])]));
  e.apply({ kind: 'add', body: body('ship', 0, 0.01, [r1, 0, 0], [0, v1, 0], { ship }) });
  // Vallado's algorithm 36: the two changes of speed, and half the transfer orbit's period between them.
  const aT = (r1 + r2) / 2;
  const dv1 = (Math.sqrt(GM_EARTH * (2 / r1 - 1 / aT)) - v1) * 1000;
  const dv2 = (Math.sqrt(GM_EARTH / r2) - Math.sqrt(GM_EARTH * (2 / r2 - 1 / aT))) * 1000;
  const half = Math.PI * Math.sqrt(aT ** 3 / GM_EARTH);
  expect(deltaVLeft(ship)).toBeGreaterThan(dv1 + dv2);
  const d1 = burnDuration(ship, dv1);
  e.apply({ kind: 'burn', id: 'ship', burn: { startT: 0, durationS: d1, direction: 'prograde', ref: 'earth', throttle: 1 } });
  e.advanceTo(d1 + 600, 1e6);
  const at = (): { r: [number, number, number]; v: [number, number, number] } => {
    const i = e.state.ids.indexOf('ship');
    return { r: [e.state.pos[i * 3] ?? 0, e.state.pos[i * 3 + 1] ?? 0, e.state.pos[i * 3 + 2] ?? 0], v: [e.state.vel[i * 3] ?? 0, e.state.vel[i * 3 + 1] ?? 0, e.state.vel[i * 3 + 2] ?? 0] };
  };
  // After the first burn: an ellipse from the first orbit to the second (a finite burn of about a minute loses a little).
  const transfer = elementsFromState(at().r, at().v, GM_EARTH);
  expect((transfer.apoapsisKm ?? 0) / r2).toBeGreaterThan(0.985);
  expect((transfer.apoapsisKm ?? 0) / r2).toBeLessThan(1.015);
  // The second burn at the apoapsis, half a transfer orbit after the first (its middle on time).
  const fuelAfterFirst = e.state.ships.ship?.fuelKg ?? 0;
  const d2 = burnDuration({ ...ship, fuelKg: fuelAfterFirst }, dv2);
  e.apply({ kind: 'burn', id: 'ship', burn: { startT: half + d1 / 2 - d2 / 2, durationS: d2, direction: 'prograde', ref: 'earth', throttle: 1 } });
  e.advanceTo(half + d1 + d2 + 600, 1e6);
  const final = elementsFromState(at().r, at().v, GM_EARTH);
  expect(final.e).toBeLessThan(0.02);
  expect(final.a / r2).toBeGreaterThan(0.985);
  expect(final.a / r2).toBeLessThan(1.015);
  // The two burns spent what the rocket equation says for their total.
  const total = (ship.dryKg + ship.fuelKg) * (1 - Math.exp(-(dv1 + dv2) / (ship.ispS * G0)));
  expect(ship.fuelKg - (e.state.ships.ship?.fuelKg ?? 0)).toBeCloseTo(total, 0);
});

test('undo takes a burn back exactly, and a scenario with a ship and a burn passes the validator', () => {
  const r1 = 7000;
  const e = new Engine(scenario([body('earth', GM_EARTH, R_EARTH, [0, 0, 0], [0, 0, 0])]));
  e.apply({ kind: 'add', body: body('ship', 0, 0.01, [r1, 0, 0], [0, Math.sqrt(GM_EARTH / r1), 0], { ship: SHIP }) });
  e.advanceTo(300, 1e6);
  const before = { pos: [...e.state.pos], vel: [...e.state.vel], fuel: e.state.ships.ship?.fuelKg };
  e.apply({ kind: 'burn', id: 'ship', burn: { startT: e.state.t, durationS: 60, direction: 'radialOut', ref: 'earth', throttle: 0.5 } });
  e.advanceTo(600, 1e6);
  expect(e.state.ships.ship?.fuelKg).toBeLessThan(SHIP.fuelKg);
  expect(e.undo()).toBe(true);
  expect([...e.state.pos]).toEqual(before.pos);
  expect([...e.state.vel]).toEqual(before.vel);
  expect(e.state.ships.ship?.fuelKg).toBe(before.fuel);
  // Saved and read back: the ship and its burn are part of the scenario.
  e.redo();
  const saved = e.toScenario();
  const checked = validateScenario(JSON.parse(JSON.stringify(saved)));
  expect(checked.ok).toBe(true);
  const bad = JSON.parse(JSON.stringify(saved)) as Scenario;
  const last = bad.log[bad.log.length - 1];
  if (last?.command.kind === 'burn') (last.command.burn as { direction: string }).direction = 'sideways';
  expect(validateScenario(bad).ok).toBe(false);
});
