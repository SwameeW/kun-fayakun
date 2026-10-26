import type { SimState } from './nbody';

/**
 * Ships in the orbital laboratory (ledger SC-1, SC-3; docs/LAB.md): a body of the experiment with a
 * rocket. It weighs too little to pull on anything (a test particle in the integration), and carries
 * its own mass: dry, and propellant. A burn pushes it along a direction set by its motion about a
 * reference body (prograde, retrograde, normal, anti-normal, radial out or in), at the engine's
 * thrust over the ship's mass as it is then, spending propellant at thrust over (specific impulse
 * times standard gravity), until its time is up or the propellant is gone. So the change of speed a
 * burn gives is the rocket equation's, Isp g0 ln(m0 / m1), nothing assumed instantaneous.
 *
 * Burns can be planned for later: the integration starts each at its time (shortening the step so
 * as to begin and end on time), and a prediction of the path (the laboratory's own) runs through the
 * planned burns as it would through the experiment, which is how a manoeuvre is planned here.
 */

/** Standard gravity (m/s^2): the specific impulse's unit, by definition (CGPM 1901). */
export const G0 = 9.80665;
/** A burn's steps are no longer than this (s), nor than a fortieth of the burn. */
const BURN_STEP_S = 10;
const BURN_STEPS = 40;

export interface ShipSpec {
  dryKg: number;
  fuelKg: number;
  thrustN: number;
  ispS: number;
}

export type BurnDirection = 'prograde' | 'retrograde' | 'normal' | 'antinormal' | 'radialOut' | 'radialIn';
export const BURN_DIRECTIONS: readonly BurnDirection[] = ['prograde', 'retrograde', 'normal', 'antinormal', 'radialOut', 'radialIn'];

export interface Burn {
  /** When it begins (s, the experiment's clock) and how long it lasts (s, at its throttle). */
  startT: number;
  durationS: number;
  direction: BurnDirection;
  /** The body its directions are reckoned against (its motion relative to it). */
  ref: string;
  /** A share of full thrust, (0, 1]. */
  throttle: number;
}

export interface ShipState extends ShipSpec {
  /** Planned and running burns, in order of their start. */
  burns: Burn[];
}

/** The change of speed (m/s) the ship's propellant can still give it (the rocket equation). */
export const deltaVLeft = (ship: ShipSpec): number => (ship.dryKg > 0 && ship.fuelKg > 0 ? ship.ispS * G0 * Math.log((ship.dryKg + ship.fuelKg) / ship.dryKg) : 0);

/** How long a burn at `throttle` must last (s) to change the speed by `dvMs` (m/s), from the ship's mass now; Infinity beyond its propellant. */
export function burnDuration(ship: ShipSpec, dvMs: number, throttle = 1): number {
  if (!(dvMs > 0)) return 0;
  if (dvMs >= deltaVLeft(ship)) return Number.POSITIVE_INFINITY;
  const m0 = ship.dryKg + ship.fuelKg;
  const mdot = (throttle * ship.thrustN) / (ship.ispS * G0);
  return (m0 / mdot) * (1 - Math.exp(-dvMs / (ship.ispS * G0)));
}

/** The burn running at time t (the first that has begun), or null. */
const running = (ship: ShipState, t: number): Burn | null => {
  const b = ship.burns[0];
  return b && b.startT <= t + 1e-9 && ship.fuelKg > 0 ? b : null;
};

/** Whether any ship is burning at time t. */
export const anyBurning = (s: SimState): boolean => Object.values(s.ships).some((ship) => running(ship, s.t) !== null);

/**
 * A step no longer than `dt` that does not cross a burn's start or end (so each begins and ends on
 * time) and stays short while one runs.
 */
export function burnStep(s: SimState, dt: number): number {
  let out = dt;
  for (const ship of Object.values(s.ships)) {
    const b = ship.burns[0];
    if (!b || ship.fuelKg <= 0) continue;
    const end = b.startT + b.durationS;
    if (b.startT > s.t + 1e-9) out = Math.min(out, b.startT - s.t);
    else {
      out = Math.min(out, end - s.t, Math.max(BURN_STEP_S / 10, Math.min(BURN_STEP_S, b.durationS / BURN_STEPS)));
    }
  }
  return Math.max(out, 1e-3);
}

/** The unit direction of a burn for body i (render nothing: zero) from its motion relative to the reference body. */
export function burnDirection(s: SimState, i: number, burn: Pick<Burn, 'direction' | 'ref'>): [number, number, number] {
  const j = s.ids.indexOf(burn.ref);
  const rx = (s.pos[i * 3] ?? 0) - (j >= 0 ? (s.pos[j * 3] ?? 0) : 0);
  const ry = (s.pos[i * 3 + 1] ?? 0) - (j >= 0 ? (s.pos[j * 3 + 1] ?? 0) : 0);
  const rz = (s.pos[i * 3 + 2] ?? 0) - (j >= 0 ? (s.pos[j * 3 + 2] ?? 0) : 0);
  const vx = (s.vel[i * 3] ?? 0) - (j >= 0 ? (s.vel[j * 3] ?? 0) : 0);
  const vy = (s.vel[i * 3 + 1] ?? 0) - (j >= 0 ? (s.vel[j * 3 + 1] ?? 0) : 0);
  const vz = (s.vel[i * 3 + 2] ?? 0) - (j >= 0 ? (s.vel[j * 3 + 2] ?? 0) : 0);
  const v = Math.hypot(vx, vy, vz);
  if (!(v > 0)) return [0, 0, 0];
  const p: [number, number, number] = [vx / v, vy / v, vz / v];
  // The orbit's normal (r x v), and radial out in the orbit's plane, square to the motion (v x n).
  let nx = ry * vz - rz * vy;
  let ny = rz * vx - rx * vz;
  let nz = rx * vy - ry * vx;
  const n = Math.hypot(nx, ny, nz);
  if (n > 0) {
    nx /= n;
    ny /= n;
    nz /= n;
  }
  const out: [number, number, number] = [p[1] * nz - p[2] * ny, p[2] * nx - p[0] * nz, p[0] * ny - p[1] * nx];
  switch (burn.direction) {
    case 'prograde':
      return p;
    case 'retrograde':
      return [-p[0], -p[1], -p[2]];
    case 'normal':
      return [nx, ny, nz];
    case 'antinormal':
      return [-nx, -ny, -nz];
    case 'radialOut':
      return out;
    case 'radialIn':
      return [-out[0], -out[1], -out[2]];
  }
}

/**
 * Half a kick of thrust (`h` seconds) to every ship whose burn was running when the step began (at
 * `since`), along its direction now, at its mass now; returns whether any did. (The leapfrog takes
 * one before the drift, with the mass at the start, and one after, with the step's propellant spent.)
 */
export function kickThrust(s: SimState, h: number, since: number): boolean {
  let any = false;
  for (const [id, ship] of Object.entries(s.ships)) {
    const burn = running(ship, since);
    const i = s.ids.indexOf(id);
    if (!burn || i < 0 || s.fixed.includes(id)) continue;
    const d = burnDirection(s, i, burn);
    // N / kg is m/s^2; the integration's units are km and s.
    const a = (burn.throttle * ship.thrustN) / (ship.dryKg + ship.fuelKg) / 1000;
    for (let k = 0; k < 3; k += 1) s.vel[i * 3 + k] = (s.vel[i * 3 + k] ?? 0) + a * (d[k] ?? 0) * h;
    any = true;
  }
  return any;
}

/** Propellant spent over the step just taken (from t0 to the state's time). */
export function spendPropellant(s: SimState, t0: number): void {
  for (const ship of Object.values(s.ships)) {
    const b = ship.burns[0];
    if (!b) continue;
    const from = Math.max(t0, b.startT);
    const to = Math.min(s.t, b.startT + b.durationS);
    if (to > from && ship.fuelKg > 0) ship.fuelKg = Math.max(0, ship.fuelKg - ((b.throttle * ship.thrustN) / (ship.ispS * G0)) * (to - from));
  }
}

/** Burns that have ended by the state's time (or run out of propellant) dropped. */
export function dropEnded(s: SimState): void {
  for (const ship of Object.values(s.ships)) {
    const b = ship.burns[0];
    if (b && (s.t >= b.startT + b.durationS - 1e-9 || ship.fuelKg <= 0)) ship.burns.shift();
    if (ship.fuelKg <= 0) ship.burns.length = 0;
  }
}

/** A planned burn added in order of its start (one at a time: a burn planned to start inside another begins when that one ends). */
export function planBurn(ship: ShipState, burn: Burn): void {
  ship.burns.push({ ...burn });
  ship.burns.sort((a, b) => a.startT - b.startT);
  for (let k = 1; k < ship.burns.length; k += 1) {
    const before = ship.burns[k - 1];
    const b = ship.burns[k];
    if (before && b && b.startT < before.startT + before.durationS) b.startT = before.startT + before.durationS;
  }
}

export const cloneShip = (ship: ShipState): ShipState => ({ ...ship, burns: ship.burns.map((b) => ({ ...b })) });
