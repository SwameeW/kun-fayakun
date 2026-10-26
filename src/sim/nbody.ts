import { cloneClimate, type ClimateState, type StarLight } from './climate';
import { contactCrater } from './craters';
import { impactOutcome, type ImpactOutcome, type ImpactRegime } from './impacts';
import { cloneShip, dropEnded, kickThrust, spendPropellant, type ShipState } from './ships';
import { cloneSwarm, driftSwarms, kickSwarms, loseStruck, rehomeSwarms, swarmHomes, type Swarm } from './swarms';

/**
 * The orbital laboratory's gravity: direct, pairwise Newtonian N-body. Every massive body pulls
 * every other; a test particle (GM 0) feels the massive bodies and pulls nothing. Integrated with
 * a kick-drift-kick leapfrog (second order; symplectic at a fixed step).
 *
 * Units: km, s, and GM in km^3 s^-2. GM is what the ephemerides measure (DE440), so G never
 * enters: forces, momenta and energies here are all "G times" the physical ones, which leaves
 * every conservation check and ratio unchanged.
 *
 * Contact: bodies are spheres of their physical radii. Before each drift, every pair is tested along
 * the straight paths the drift will take (its closest approach within the step), so a fast impactor
 * cannot pass through a target between steps. A pair that would touch collides then, at the whole step
 * (where positions and velocities belong to the same instant, so the energy accounts exactly), with the
 * outcome Leinhardt and Stewart's scaling laws give (./impacts) for the speed and angle at contact
 * (from the pair's own two-body orbit, so gravity's focusing is in it):
 * - merge() below the merging speed: mass, momentum and the centre of mass conserved, the pair's
 *   orbital angular momentum kept as the survivor's spin, the energy the merger takes moved into
 *   `internal` (below);
 * - fragment() when the impact breaks bodies up: the largest remnant (keeping the target's id), the
 *   second, and at most MAX_DEBRIS equal debris bodies, placed just clear of the remnant and launched
 *   at 1.05 times the pair's mutual escape speed (Chambers 2013), the second remnant downrange and the
 *   debris spaced evenly round the collision's plane (their momenta cancelling), deterministically,
 *   so after a slow breakup some come back and merge again; mass, momentum and angular momentum conserved exactly
 *   and the energy given up moved into `internal`; debris that would pass MAX_BODIES is returned to
 *   the largest remnant and reported;
 * - a hit-and-run graze leaves both bodies as they are (the projectile's own erosion is not modelled),
 *   and the pair is not tested again until it has parted.
 * So bodies collide within the step in which they would touch, never later; nothing is softened, and
 * two bodies never share a centre when a force is evaluated.
 *
 * Energy at a merger: the pair's relative kinetic energy (half the reduced mass times the relative
 * speed squared) is the impact's heat; their mutual attraction becomes the merged body's own binding,
 * which point masses do not hold. Both go to `internal`, the merged bodies' internal-energy reservoir,
 * so mechanical energy plus `internal` is the closed model's total and stays constant through it.
 *
 * Oblateness (ledger SB-33): a body with a J2 (its flattening's lowest zonal harmonic, normalised to
 * its radius) pulls every other body with the J2 term of its field about its spin axis, as well as
 * as a point; the others pull it back (momentum kept), and the torque turns its spin axis (angular
 * momentum kept: the axis precesses, as the Earth's does under the Moon and the Sun). The J2 term's
 * potential energy is in the energy, so it is conserved as the point masses' is.
 *
 * Held in place (ledger SB-28): a body the visitor holds fixed has no velocity and feels no force: an
 * external constraint, so momentum and energy are no longer conserved while it holds (the drift
 * readout says so rather than counting it an error).
 */

export interface SimState {
  /** Stable ids and display names, index-aligned with the arrays below (the order changes when bodies are removed; ids do not). */
  ids: string[];
  names: string[];
  /** GM, km^3 s^-2 (0: a test particle). */
  gm: number[];
  radius: number[];
  /** Positions (km) and velocities (km s^-1), three per body. */
  pos: number[];
  vel: number[];
  /** Spin angular momentum, GM-weighted (G times kg km^2 s^-1), three per body: set by the visitor or the seed, taken up by mergers, turned by oblateness's torque. */
  spin: number[];
  /** Each body's J2 (0: spherical) and moment of inertia factor (I / M R^2; 0.4 for a uniform sphere). */
  j2: number[];
  inertia: number[];
  /** Ids of bodies held in place (no velocity, no force felt). */
  fixed: string[];
  /** Simulated seconds since the scenario's epoch, and steps taken. */
  t: number;
  step: number;
  /** Energy (G units) collisions moved from the bodies' motion and mutual attraction into the bodies (impact heat less the binding gained), so E + internal is the closed model's total. */
  internal: number;
  /** Pairs (ids joined by "|", in order) that grazed and passed on: not tested for contact again until they have parted. */
  passing: string[];
  /** Rings and belts of test particles (./swarms): moved by the bodies' gravity, pulling nothing. */
  swarms: Swarm[];
  /** Stars' light (./climate), by id: each one's luminosity at the GM it was given (it follows its mass from there). */
  stars: Record<string, StarLight>;
  /** Each solid world's climate (./climate), by id, and the time it was last stepped (s). */
  climate: Record<string, ClimateState>;
  climateAt: number;
  /** Pieces of tidally disrupted bodies (they are not torn apart again). */
  rubble: string[];
  /** Ships (./ships), by id: their mass, rocket and burns (each a test particle among the bodies). */
  ships: Record<string, ShipState>;
}

/** A collision (what happened to the target, which keeps its id, and the projectile), or a tidal disruption (the body that held, and the body torn apart). */
export interface ContactEvent {
  /** 'merge': the projectile absorbed; 'fragment': both broken into the largest remnant, a second and debris; 'graze': a hit-and-run, both carrying on; 'disrupt': torn apart by the survivor's tides. */
  kind: 'merge' | 'fragment' | 'graze' | 'disrupt';
  step: number;
  t: number;
  /** The target (the more massive, or the one kept) and the projectile. */
  survivor: string;
  absorbed: string;
  /** Leinhardt and Stewart's regime, the speed at contact (km/s) and the impact parameter (0 head-on). */
  regime: ImpactRegime | 'tidal';
  speedKmS: number;
  b: number;
  /** Bodies the collision made: the second remnant first, then the debris. */
  created: string[];
  /** Debris (GM) returned to the largest remnant for want of room. */
  unresolved: number;
  /** The impact's heat: the pair's relative kinetic energy at contact for a merger, the energy given up for a breakup (G units). */
  heat: number;
  /** The impact's energy: the pair's kinetic energy at contact in their centre of mass frame, 0.5 mu v^2 (G units), the fall included. */
  energy: number;
  /** The crater a merger or a breakup leaves on a solid target (./craters): its final diameter, depth and rim height (km) and whether it is complex; null for a graze, a giant's or a star's surface, or a giant impact. */
  crater: { diameterKm: number; complex: boolean; depthKm: number; rimKm: number } | null;
  /** Where the projectile touched: a unit vector from the target's centre, in the scenario's frame, at the moment of contact. */
  site: [number, number, number];
}
/** The engine's and the interface's earlier name for it. */
export type MergeEvent = ContactEvent;

/** Whether a collision ended the projectile (a merger or a breakup), as against a graze it carried on from. */
export const consumes = (e: ContactEvent): boolean => e.kind !== 'graze';

/** The most bodies a scenario holds (the engine's import limit too). */
export const MAX_BODIES = 64;
/** Debris bodies one collision may make, besides the second remnant. */
export const MAX_DEBRIS = 6;
/**
 * Every piece leaves at this multiple of the pair's mutual escape speed at contact, sqrt(2 (GM_t + GM_p) / (R_t + R_p)),
 * the convention of Chambers (2013, Icarus 224, 43) for N-body fragmentation: just enough to get away, so some come back.
 */
const CHAMBERS_SPEED = 1.05;
/** Pieces are placed this much further out than touching the remnant, so they start clear of it. */
const CLEARANCE = 1.05;

export const count = (s: SimState): number => s.ids.length;

/** A deep copy (the engine's checkpoints and predictions run on copies). */
export function cloneState(s: SimState, withSwarms = true): SimState {
  return { ids: [...s.ids], names: [...s.names], gm: [...s.gm], radius: [...s.radius], pos: [...s.pos], vel: [...s.vel], spin: [...s.spin], j2: [...s.j2], inertia: [...s.inertia], fixed: [...s.fixed], t: s.t, step: s.step, internal: s.internal, passing: [...s.passing], swarms: withSwarms ? s.swarms.map(cloneSwarm) : [], stars: Object.fromEntries(Object.entries(s.stars).map(([id, l]) => [id, { ...l }])), climate: Object.fromEntries(Object.entries(s.climate).map(([id, c]) => [id, cloneClimate(c)])), climateAt: s.climateAt, rubble: [...s.rubble], ships: Object.fromEntries(Object.entries(s.ships).map(([id, ship]) => [id, cloneShip(ship)])) };
}

/** An empty state. */
export function emptyState(): SimState {
  return { ids: [], names: [], gm: [], radius: [], pos: [], vel: [], spin: [], j2: [], inertia: [], fixed: [], t: 0, step: 0, internal: 0, passing: [], swarms: [], stars: {}, climate: {}, climateAt: 0, rubble: [], ships: {} };
}

/** The body a gone body merged into (the latest collision that ended it), or null. */
export const successorIn = (events: readonly ContactEvent[]) => (gone: string): string | null => {
  for (let k = events.length - 1; k >= 0; k -= 1) {
    const e = events[k];
    if (e && consumes(e) && e.absorbed === gone) return e.survivor;
  }
  return null;
};

/** A uniform sphere's moment of inertia factor: the default where a body's own is not known. */
export const UNIFORM_INERTIA = 0.4;

export function addBody(s: SimState, body: { id: string; name: string; gm: number; radiusKm: number; pos: readonly number[]; vel: readonly number[]; spin?: readonly number[]; j2?: number; inertia?: number }): void {
  s.ids.push(body.id);
  s.names.push(body.name);
  s.gm.push(body.gm);
  s.radius.push(body.radiusKm);
  s.pos.push(body.pos[0] ?? 0, body.pos[1] ?? 0, body.pos[2] ?? 0);
  s.vel.push(body.vel[0] ?? 0, body.vel[1] ?? 0, body.vel[2] ?? 0);
  s.spin.push(body.spin?.[0] ?? 0, body.spin?.[1] ?? 0, body.spin?.[2] ?? 0);
  s.j2.push(body.j2 ?? 0);
  s.inertia.push(body.inertia ?? UNIFORM_INERTIA);
}

/**
 * The spin angular momentum (G units) of a body turning once every `periodS` seconds about `pole`
 * (prograde about it), from its moment of inertia factor: k GM R^2 (2 pi / period).
 */
export function spinVector(gm: number, radiusKm: number, inertia: number, periodS: number, pole: readonly number[]): [number, number, number] {
  const l = Math.hypot(pole[0] ?? 0, pole[1] ?? 0, pole[2] ?? 0);
  if (!(l > 0) || !(periodS > 0)) return [0, 0, 0];
  const L = (inertia * gm * radiusKm * radiusKm * 2 * Math.PI) / periodS;
  return [((pole[0] ?? 0) / l) * L, ((pole[1] ?? 0) / l) * L, ((pole[2] ?? 0) / l) * L];
}

/** A body's rotation from its spin: the period (s; null when it does not turn or weighs nothing) and the unit pole. */
export function rotationOf(s: SimState, i: number): { periodS: number | null; pole: [number, number, number] } {
  const L = Math.hypot(s.spin[i * 3] ?? 0, s.spin[i * 3 + 1] ?? 0, s.spin[i * 3 + 2] ?? 0);
  const g = s.gm[i] ?? 0;
  const r = s.radius[i] ?? 0;
  const k = s.inertia[i] ?? UNIFORM_INERTIA;
  if (!(L > 0) || !(g > 0)) return { periodS: null, pole: [0, 0, 1] };
  return { periodS: (k * g * r * r * 2 * Math.PI) / L, pole: [(s.spin[i * 3] ?? 0) / L, (s.spin[i * 3 + 1] ?? 0) / L, (s.spin[i * 3 + 2] ?? 0) / L] };
}

export function removeAt(s: SimState, i: number): void {
  const id = s.ids[i];
  if (id !== undefined && s.fixed.includes(id)) s.fixed.splice(s.fixed.indexOf(id), 1);
  if (id !== undefined && Object.hasOwn(s.ships, id)) s.ships = Object.fromEntries(Object.entries(s.ships).filter(([k]) => k !== id));
  s.j2.splice(i, 1);
  s.inertia.splice(i, 1);
  s.ids.splice(i, 1);
  s.names.splice(i, 1);
  s.gm.splice(i, 1);
  s.radius.splice(i, 1);
  s.pos.splice(i * 3, 3);
  s.vel.splice(i * 3, 3);
  s.spin.splice(i * 3, 3);
}

export const indexOf = (s: SimState, id: string): number => s.ids.indexOf(id);

/** The body that body `i` moves about: of the heavier ones, the one with the smallest distance over GM^(1/3) (its sphere of influence, roughly); -1 for none. */
export function primaryOf(gm: ArrayLike<number>, pos: ArrayLike<number>, i: number): number {
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  const g = gm[i] ?? 0;
  for (let j = 0; j < gm.length; j += 1) {
    const gj = gm[j] ?? 0;
    if (j === i || gj <= g) continue;
    const d = Math.hypot((pos[j * 3] ?? 0) - (pos[i * 3] ?? 0), (pos[j * 3 + 1] ?? 0) - (pos[i * 3 + 1] ?? 0), (pos[j * 3 + 2] ?? 0) - (pos[i * 3 + 2] ?? 0));
    const score = d / Math.cbrt(gj);
    if (score < bestScore) {
      bestScore = score;
      best = j;
    }
  }
  return best;
}

/**
 * Accelerations (km s^-2) of every body into `out` (three per body), followed by the torques on their
 * spins (G units per second, three per body: oblateness's). Returns the shortest dynamical timescale
 * of the massive pairs, found on the way (see timescale()). Bodies held in place feel nothing.
 */
export function accelerations(s: SimState, out: number[]): number {
  const n = count(s);
  out.length = n * 6;
  out.fill(0);
  let shortest = Number.POSITIVE_INFINITY;
  const torn = tornPieces(s);
  for (let i = 0; i < n; i += 1) {
    const xi = s.pos[i * 3] ?? 0;
    const yi = s.pos[i * 3 + 1] ?? 0;
    const zi = s.pos[i * 3 + 2] ?? 0;
    const gi = s.gm[i] ?? 0;
    for (let j = i + 1; j < n; j += 1) {
      const gj = s.gm[j] ?? 0;
      if ((gi === 0 && gj === 0) || (torn[i] && torn[j])) continue;
      const dx = (s.pos[j * 3] ?? 0) - xi;
      const dy = (s.pos[j * 3 + 1] ?? 0) - yi;
      const dz = (s.pos[j * 3 + 2] ?? 0) - zi;
      const r2 = dx * dx + dy * dy + dz * dz;
      const r = Math.sqrt(r2);
      const inv = 1 / (r2 * r);
      const ux = (s.vel[j * 3] ?? 0) - (s.vel[i * 3] ?? 0);
      const uy = (s.vel[j * 3 + 1] ?? 0) - (s.vel[i * 3 + 1] ?? 0);
      const uz = (s.vel[j * 3 + 2] ?? 0) - (s.vel[i * 3 + 2] ?? 0);
      const u = Math.sqrt(ux * ux + uy * uy + uz * uz);
      shortest = Math.min(shortest, Math.sqrt((r2 * r) / (gi + gj)), u > 0 ? r / u : Number.POSITIVE_INFINITY);
      // Symmetric: each pair evaluated once, equal and opposite (scaled by the other's GM).
      out[i * 3] = (out[i * 3] ?? 0) + gj * dx * inv;
      out[i * 3 + 1] = (out[i * 3 + 1] ?? 0) + gj * dy * inv;
      out[i * 3 + 2] = (out[i * 3 + 2] ?? 0) + gj * dz * inv;
      out[j * 3] = (out[j * 3] ?? 0) - gi * dx * inv;
      out[j * 3 + 1] = (out[j * 3 + 1] ?? 0) - gi * dy * inv;
      out[j * 3 + 2] = (out[j * 3 + 2] ?? 0) - gi * dz * inv;
    }
  }
  // Oblateness: each oblate body's J2 term, about its spin axis, on every other body; the reaction on
  // it, and the torque on its spin (minus the sum of r x F over the bodies it pulls).
  for (let o = 0; o < n; o += 1) {
    const j2 = s.j2[o] ?? 0;
    const go = s.gm[o] ?? 0;
    if (j2 === 0 || go <= 0) continue;
    const L = Math.hypot(s.spin[o * 3] ?? 0, s.spin[o * 3 + 1] ?? 0, s.spin[o * 3 + 2] ?? 0);
    if (!(L > 0)) continue;
    const px = (s.spin[o * 3] ?? 0) / L;
    const py = (s.spin[o * 3 + 1] ?? 0) / L;
    const pz = (s.spin[o * 3 + 2] ?? 0) / L;
    const ro = s.radius[o] ?? 0;
    const k = 1.5 * j2 * go * ro * ro;
    for (let i = 0; i < n; i += 1) {
      if (i === o) continue;
      const dx = (s.pos[i * 3] ?? 0) - (s.pos[o * 3] ?? 0);
      const dy = (s.pos[i * 3 + 1] ?? 0) - (s.pos[o * 3 + 1] ?? 0);
      const dz = (s.pos[i * 3 + 2] ?? 0) - (s.pos[o * 3 + 2] ?? 0);
      const r2 = dx * dx + dy * dy + dz * dz;
      const z = dx * px + dy * py + dz * pz;
      const f = k / (r2 * r2 * Math.sqrt(r2));
      const c = 1 - (5 * z * z) / r2;
      const ax = -f * (c * dx + 2 * z * px);
      const ay = -f * (c * dy + 2 * z * py);
      const az = -f * (c * dz + 2 * z * pz);
      out[i * 3] = (out[i * 3] ?? 0) + ax;
      out[i * 3 + 1] = (out[i * 3 + 1] ?? 0) + ay;
      out[i * 3 + 2] = (out[i * 3 + 2] ?? 0) + az;
      const gi = s.gm[i] ?? 0;
      if (gi <= 0) continue;
      const w = gi / go;
      out[o * 3] = (out[o * 3] ?? 0) - w * ax;
      out[o * 3 + 1] = (out[o * 3 + 1] ?? 0) - w * ay;
      out[o * 3 + 2] = (out[o * 3 + 2] ?? 0) - w * az;
      const t = n * 3 + o * 3;
      out[t] = (out[t] ?? 0) - gi * (dy * az - dz * ay);
      out[t + 1] = (out[t + 1] ?? 0) - gi * (dz * ax - dx * az);
      out[t + 2] = (out[t + 2] ?? 0) - gi * (dx * ay - dy * ax);
    }
  }
  for (const id of s.fixed) {
    const i = s.ids.indexOf(id);
    if (i >= 0) for (let k = 0; k < 3; k += 1) out[i * 3 + k] = 0;
  }
  return shortest;
}

/** The J2 terms' potential energy (G units): over oblate bodies o and the bodies i they pull, GM_i GM_o J2 R^2 (3 z^2 - r^2) / (2 r^5). */
function oblatePotential(s: SimState): number {
  const n = count(s);
  let e = 0;
  for (let o = 0; o < n; o += 1) {
    const j2 = s.j2[o] ?? 0;
    const go = s.gm[o] ?? 0;
    if (j2 === 0 || go <= 0) continue;
    const L = Math.hypot(s.spin[o * 3] ?? 0, s.spin[o * 3 + 1] ?? 0, s.spin[o * 3 + 2] ?? 0);
    if (!(L > 0)) continue;
    const ro = s.radius[o] ?? 0;
    for (let i = 0; i < n; i += 1) {
      const gi = s.gm[i] ?? 0;
      if (i === o || gi <= 0) continue;
      const dx = (s.pos[i * 3] ?? 0) - (s.pos[o * 3] ?? 0);
      const dy = (s.pos[i * 3 + 1] ?? 0) - (s.pos[o * 3 + 1] ?? 0);
      const dz = (s.pos[i * 3 + 2] ?? 0) - (s.pos[o * 3 + 2] ?? 0);
      const r2 = dx * dx + dy * dy + dz * dz;
      const z = (dx * (s.spin[o * 3] ?? 0) + dy * (s.spin[o * 3 + 1] ?? 0) + dz * (s.spin[o * 3 + 2] ?? 0)) / L;
      e += (gi * go * j2 * ro * ro * (3 * z * z - r2)) / (2 * r2 * r2 * Math.sqrt(r2));
    }
  }
  return e;
}

/** Merges body j into body i (i the survivor, before or after j in the arrays): see the module comment. Returns the impact's heat. */
export function merge(s: SimState, i: number, j: number): number {
  const before = energy(s);
  const gi = s.gm[i] ?? 0;
  const gj = s.gm[j] ?? 0;
  const total = gi + gj;
  // Test particles weigh nothing: one absorbed by a massive body leaves it as it was.
  const wi = total > 0 ? gi / total : 1;
  const wj = total > 0 ? gj / total : 0;
  const rx = (s.pos[j * 3] ?? 0) - (s.pos[i * 3] ?? 0);
  const ry = (s.pos[j * 3 + 1] ?? 0) - (s.pos[i * 3 + 1] ?? 0);
  const rz = (s.pos[j * 3 + 2] ?? 0) - (s.pos[i * 3 + 2] ?? 0);
  const ux = (s.vel[j * 3] ?? 0) - (s.vel[i * 3] ?? 0);
  const uy = (s.vel[j * 3 + 1] ?? 0) - (s.vel[i * 3 + 1] ?? 0);
  const uz = (s.vel[j * 3 + 2] ?? 0) - (s.vel[i * 3 + 2] ?? 0);
  // The pair's orbital angular momentum about its centre of mass (reduced mass times r x u) becomes spin.
  const mu = total > 0 ? (gi * gj) / total : 0;
  const heat = 0.5 * mu * (ux * ux + uy * uy + uz * uz);
  for (let k = 0; k < 3; k += 1) {
    s.pos[i * 3 + k] = wi * (s.pos[i * 3 + k] ?? 0) + wj * (s.pos[j * 3 + k] ?? 0);
    s.vel[i * 3 + k] = wi * (s.vel[i * 3 + k] ?? 0) + wj * (s.vel[j * 3 + k] ?? 0);
    s.spin[i * 3 + k] = (s.spin[i * 3 + k] ?? 0) + (s.spin[j * 3 + k] ?? 0);
  }
  s.spin[i * 3] = (s.spin[i * 3] ?? 0) + mu * (ry * uz - rz * uy);
  s.spin[i * 3 + 1] = (s.spin[i * 3 + 1] ?? 0) + mu * (rz * ux - rx * uz);
  s.spin[i * 3 + 2] = (s.spin[i * 3 + 2] ?? 0) + mu * (rx * uy - ry * ux);
  s.gm[i] = total;
  // Volumes add (each body keeps its own density in the mix): the documented first rule, not a model of compression.
  s.radius[i] = Math.cbrt((s.radius[i] ?? 0) ** 3 + (s.radius[j] ?? 0) ** 3);
  removeAt(s, j);
  s.internal += before - energy(s);
  return heat;
}

/** The time of closest approach in [0, dt] of two bodies moving straight (relative position p, relative velocity w), and that distance. */
function closest(px: number, py: number, pz: number, wx: number, wy: number, wz: number, dt: number): number {
  const w2 = wx * wx + wy * wy + wz * wz;
  const s = w2 > 0 ? Math.min(dt, Math.max(0, -(px * wx + py * wy + pz * wz) / w2)) : 0;
  return Math.hypot(px + wx * s, py + wy * s, pz + wz * s);
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Where on the target a projectile at `r` from it (km), closing at `u` (km/s), first touches within
 * `dt`: the unit vector from the target's centre through that point, along the straight path the
 * contact test uses (already touching: the line of centres; never reaching: the closest approach).
 */
export function contactSite(rx: number, ry: number, rz: number, ux: number, uy: number, uz: number, reach: number, dt: number): [number, number, number] {
  const r2 = rx * rx + ry * ry + rz * rz;
  const u2 = ux * ux + uy * uy + uz * uz;
  const ru = rx * ux + ry * uy + rz * uz;
  let tau = 0;
  if (r2 > reach * reach && u2 > 0) {
    const disc = ru * ru - u2 * (r2 - reach * reach);
    tau = disc >= 0 ? (-ru - Math.sqrt(disc)) / u2 : -ru / u2;
    tau = Math.min(Math.max(tau, 0), Math.max(dt, 0));
  }
  return unitOf(rx + ux * tau, ry + uy * tau, rz + uz * tau, [1, 0, 0]);
}

/** A unit vector (and its length), or the fallback where it has none. */
function unitOf(x: number, y: number, z: number, fallback: readonly [number, number, number]): [number, number, number] {
  const l = Math.hypot(x, y, z);
  return l > 0 ? [x / l, y / l, z / l] : [fallback[0], fallback[1], fallback[2]];
}

/** The total angular momentum (orbital about the origin, and spin), G units. */
function angularMomentum(s: SimState): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < count(s); i += 1) {
    const g = s.gm[i] ?? 0;
    const [x, y, z] = [s.pos[i * 3] ?? 0, s.pos[i * 3 + 1] ?? 0, s.pos[i * 3 + 2] ?? 0];
    const [u, v, w] = [s.vel[i * 3] ?? 0, s.vel[i * 3 + 1] ?? 0, s.vel[i * 3 + 2] ?? 0];
    out[0] += g * (y * w - z * v) + (s.spin[i * 3] ?? 0);
    out[1] += g * (z * u - x * w) + (s.spin[i * 3 + 1] ?? 0);
    out[2] += g * (x * v - y * u) + (s.spin[i * 3 + 2] ?? 0);
  }
  return out;
}

/** A fresh id for a body a collision makes (the import rule's characters), never one in use. */
function freshId(s: SimState, base: string): string {
  let id = base.slice(0, 36);
  for (let n = 1; s.ids.includes(id); n += 1) id = `${base.slice(0, 33)}-${n}`;
  return id;
}

/**
 * Breaks target `t` and projectile `p` into the outcome's largest remnant (keeping `t`'s id), its
 * second and debris (see the module comment). Returns the bodies made, the debris returned to the
 * remnant for want of room, and the energy given up (G units).
 */
export function fragment(s: SimState, t: number, p: number, o: ImpactOutcome): { created: string[]; unresolved: number; heat: number } {
  const before = energy(s);
  const L0 = angularMomentum(s);
  const mt = s.gm[t] ?? 0;
  const mp = s.gm[p] ?? 0;
  const total = mt + mp;
  const at = (arr: number[], i: number): number[] => [arr[i * 3] ?? 0, arr[i * 3 + 1] ?? 0, arr[i * 3 + 2] ?? 0];
  const [xt, xp, vt, vp] = [at(s.pos, t), at(s.pos, p), at(s.vel, t), at(s.vel, p)];
  const com = [0, 1, 2].map((k) => ((xt[k] ?? 0) * mt + (xp[k] ?? 0) * mp) / total);
  const comV = [0, 1, 2].map((k) => ((vt[k] ?? 0) * mt + (vp[k] ?? 0) * mp) / total);
  // The impact site's outward normal (from the target toward the projectile), and the projectile's way on (downrange).
  const n = unitOf((xp[0] ?? 0) - (xt[0] ?? 0), (xp[1] ?? 0) - (xt[1] ?? 0), (xp[2] ?? 0) - (xt[2] ?? 0), [1, 0, 0]);
  const down = unitOf((vp[0] ?? 0) - (vt[0] ?? 0), (vp[1] ?? 0) - (vt[1] ?? 0), (vp[2] ?? 0) - (vt[2] ?? 0), [-n[0], -n[1], -n[2]]);
  // The collision's plane (the impact normal and the way the projectile came, through the centre of mass): its second axis.
  const along = (n[0] * down[0] + n[1] * down[1] + n[2] * down[2]);
  const helper: readonly [number, number, number] = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const across = [n[1] * helper[2] - n[2] * helper[1], n[2] * helper[0] - n[0] * helper[2], n[0] * helper[1] - n[1] * helper[0]];
  const u = unitOf(down[0] - along * n[0], down[1] - along * n[1], down[2] - along * n[2], unitOf(across[0] ?? 0, across[1] ?? 0, across[2] ?? 0, [0, 1, 0]));
  // The pieces: the second remnant, then the debris in as many bodies as there is room for (else returned to the remnant).
  const room = Math.max(0, MAX_BODIES - (count(s) - 2) - 1 - (o.second > 0 ? 1 : 0));
  const pieces = o.debris > 0 ? Math.min(MAX_DEBRIS, room) : 0;
  const unresolved = pieces > 0 ? 0 : o.debris;
  const largest = o.largest + unresolved;
  const masses: number[] = [...(o.second > 0 ? [o.second] : []), ...Array.from({ length: pieces }, () => o.debris / pieces)];
  // Every piece at the pair's bulk density, leaving at 1.05 times the pair's mutual escape speed (Chambers 2013):
  // the second remnant on downrange, the debris spaced evenly round the collision's plane from the impact site.
  const pairRadius = Math.cbrt((s.radius[t] ?? 0) ** 3 + (s.radius[p] ?? 0) ** 3);
  const radiusOf = (m: number): number => pairRadius * Math.cbrt(m / total);
  const rl = radiusOf(largest);
  const launch = CHAMBERS_SPEED * Math.sqrt((2 * total) / Math.max((s.radius[t] ?? 0) + (s.radius[p] ?? 0), 1e-9));
  // The second remnant on downrange itself; the debris evenly spaced round the plane (their momenta cancel,
  // so only the second remnant's sets the largest back), turned half a step off downrange so none follows it.
  const downrange = Math.atan2(down[0] * u[0] + down[1] * u[1] + down[2] * u[2], along);
  const inPlane = (phi: number): number[] => [0, 1, 2].map((i) => Math.cos(phi) * (n[i] ?? 0) + Math.sin(phi) * (u[i] ?? 0));
  const dirs = [...(o.second > 0 ? [inPlane(downrange)] : []), ...Array.from({ length: pieces }, (_, k) => inPlane(downrange + (Math.PI * (2 * k + 1)) / pieces))];
  const speeds = masses.map(() => launch);
  // Each piece just clear of the remnant, and moved out further until clear of the pieces placed before it too;
  // the remnant set back (and slowed) so the centre of mass and the momentum stay as they were.
  const offsets: number[][] = [];
  masses.forEach((m, k) => {
    const r = radiusOf(m);
    const dir = dirs[k] ?? n;
    let reach = (rl + r) * CLEARANCE;
    const clear = (): boolean => offsets.every((o2, j) => Math.hypot(...[0, 1, 2].map((i) => (dir[i] ?? 0) * reach - (o2[i] ?? 0))) > (r + radiusOf(masses[j] ?? 0)) * CLEARANCE);
    for (let tries = 0; tries < 64 && !clear(); tries += 1) reach *= 1.1;
    offsets.push(dir.map((x) => x * reach));
  });
  const xl = [0, 1, 2].map((i) => (com[i] ?? 0) - masses.reduce((sum, m, k) => sum + m * (offsets[k]?.[i] ?? 0), 0) / total);
  const kick = [0, 1, 2].map((i) => masses.reduce((sum, m, k) => sum + m * (speeds[k] ?? 0) * (dirs[k]?.[i] ?? 0), 0) / largest);
  const names = { target: s.names[t] ?? '', projectile: s.names[p] ?? '' };
  const targetId = s.ids[t] ?? '';
  const spin = [0, 1, 2].map((k) => (s.spin[t * 3 + k] ?? 0) + (s.spin[p * 3 + k] ?? 0));
  // The remnant keeps the target's id; the projectile goes; the pieces are added at the end.
  s.gm[t] = largest;
  s.radius[t] = rl;
  removeAt(s, p);
  const ti = indexOf(s, targetId);
  const created: string[] = [];
  masses.forEach((m, k) => {
    const second = k === 0 && o.second > 0;
    const number = k + (o.second > 0 ? 0 : 1);
    const id = freshId(s, second ? `remnant-${s.step}` : `debris-${s.step}-${number}`);
    addBody(s, { id, name: second ? `${names.projectile} remnant` : `${names.target} debris ${number}`, gm: m, radiusKm: radiusOf(m), pos: [0, 0, 0], vel: [0, 0, 0] });
    created.push(id);
  });
  const first = count(s) - masses.length;
  /** Places everything, the launch speeds scaled by `scale`. */
  const place = (scale: number): void => {
    for (let i = 0; i < 3; i += 1) {
      s.pos[ti * 3 + i] = xl[i] ?? 0;
      s.vel[ti * 3 + i] = (comV[i] ?? 0) - (kick[i] ?? 0) * scale;
    }
    masses.forEach((_, k) => {
      const j = first + k;
      for (let i = 0; i < 3; i += 1) {
        s.pos[j * 3 + i] = (xl[i] ?? 0) + (offsets[k]?.[i] ?? 0);
        s.vel[j * 3 + i] = (comV[i] ?? 0) + (speeds[k] ?? 0) * scale * (dirs[k]?.[i] ?? 0);
      }
    });
  };
  // As fast as the energy the impact gives up allows (never making energy from nothing): halved until it fits.
  let scale = 1;
  for (let tries = 0; tries < 8; tries += 1) {
    place(scale);
    if (before - energy(s) >= 0) break;
    scale *= 0.5;
  }
  // The angular momentum the pieces do not carry becomes the remnant's spin, so the total is kept exactly.
  for (let i = 0; i < 3; i += 1) s.spin[ti * 3 + i] = spin[i] ?? 0;
  const L1 = angularMomentum(s);
  for (let i = 0; i < 3; i += 1) s.spin[ti * 3 + i] = (s.spin[ti * 3 + i] ?? 0) + (L0[i] ?? 0) - (L1[i] ?? 0);
  const heat = before - energy(s);
  s.internal += heat;
  return { created, unresolved, heat };
}

/**
 * Tidal disruption (ledger SB-33): a body big enough that its own gravity, not its strength, holds it
 * together (at least TIDAL.minRadiusKm across its radius) and no more than a tenth of a neighbour's
 * mass, inside that neighbour's fluid Roche limit (2.44 R (rho_neighbour / rho_body)^(1/3)) on an
 * orbit about it that does not strike it (a body falling onto it strikes before the tide has the time
 * to pull it apart: that is the impact model's), is torn apart: into TIDAL.pieces equal pieces strung along the line to the neighbour (where the tide
 * stretches it), each moving as the body turned with its orbit (its outer pieces faster than a
 * circular orbit there, its inner slower, so they shear into an arc and then a ring), and a ring of
 * test particles of its dust about the neighbour (./swarms), where there is room. Mass and momentum
 * are kept exactly, angular momentum by the first piece's spin, and the energy the split takes moved
 * into `internal`, as a breakup's is. Pieces never disrupt again, and between two of them there is no
 * gravity and no merging (they are listed in `rubble`; the tide that tore them outpulls what held
 * them, so each goes its own way): a coarse stand-in for a body drawn out into a ring, which cannot
 * gather again into a moon outside the Roche limit. They pull, are pulled by, and can strike anything
 * else.
 * Returns whether any body was torn apart.
 */
export const TIDAL = { minRadiusKm: 100, massRatio: 10, pieces: 8, dust: 600 } as const;

export function tidalDisruptions(s: SimState, events: ContactEvent[], keep: (id: string) => boolean = () => false): boolean {
  let changed = false;
  for (let i = 0; i < count(s); i += 1) {
    const id = s.ids[i] ?? '';
    const gi = s.gm[i] ?? 0;
    const ri = s.radius[i] ?? 0;
    if (!(gi > 0) || ri < TIDAL.minRadiusKm || s.rubble.includes(id) || keep(id) || s.fixed.includes(id)) continue;
    // The neighbour whose tide reaches deepest: the heaviest body (a tenth or more heavier) whose fluid Roche limit it is inside.
    let j = -1;
    for (let k = 0; k < count(s); k += 1) {
      const gk = s.gm[k] ?? 0;
      if (k === i || gk < TIDAL.massRatio * gi) continue;
      const rk = s.radius[k] ?? 0;
      const limit = 2.44 * rk * Math.cbrt((gk / rk ** 3) / (gi / ri ** 3));
      const rx = (s.pos[i * 3] ?? 0) - (s.pos[k * 3] ?? 0);
      const ry = (s.pos[i * 3 + 1] ?? 0) - (s.pos[k * 3 + 1] ?? 0);
      const rz = (s.pos[i * 3 + 2] ?? 0) - (s.pos[k * 3 + 2] ?? 0);
      const d = Math.hypot(rx, ry, rz);
      if (!(d < limit && d > rk + ri) || (j >= 0 && gk <= (s.gm[j] ?? 0))) continue;
      // Only on an orbit about it that does not strike it: a body falling onto it strikes before the tide can pull it apart (the impact model's).
      const ux = (s.vel[i * 3] ?? 0) - (s.vel[k * 3] ?? 0);
      const uy = (s.vel[i * 3 + 1] ?? 0) - (s.vel[k * 3 + 1] ?? 0);
      const uz = (s.vel[i * 3 + 2] ?? 0) - (s.vel[k * 3 + 2] ?? 0);
      const mu = gk + gi;
      const energyPer = 0.5 * (ux * ux + uy * uy + uz * uz) - mu / d;
      const h2 = (ry * uz - rz * uy) ** 2 + (rz * ux - rx * uz) ** 2 + (rx * uy - ry * ux) ** 2;
      const e = Math.sqrt(Math.max(0, 1 + (2 * energyPer * h2) / (mu * mu)));
      const periapsis = h2 / (mu * (1 + e));
      if (energyPer < 0 && periapsis > rk + ri) j = k;
    }
    if (j < 0) continue;
    // Room for the pieces (the body itself makes one of them).
    const pieces = Math.min(TIDAL.pieces, MAX_BODIES - count(s) + 1);
    if (pieces < 2) continue;
    const before = energy(s);
    const L0 = angularMomentum(s);
    const at = (arr: number[], k: number): number[] => [arr[k * 3] ?? 0, arr[k * 3 + 1] ?? 0, arr[k * 3 + 2] ?? 0];
    const [xi, vi, xj, vj] = [at(s.pos, i), at(s.vel, i), at(s.pos, j), at(s.vel, j)];
    const r = [0, 1, 2].map((k) => (xi[k] ?? 0) - (xj[k] ?? 0));
    const v = [0, 1, 2].map((k) => (vi[k] ?? 0) - (vj[k] ?? 0));
    const d = Math.hypot(r[0] ?? 0, r[1] ?? 0, r[2] ?? 0);
    const radial = r.map((x) => x / d);
    // Its orbit's turn (angular velocity, rad/s, about r x v): the pieces keep it, as a body locked to its orbit does.
    const h = [(r[1] ?? 0) * (v[2] ?? 0) - (r[2] ?? 0) * (v[1] ?? 0), (r[2] ?? 0) * (v[0] ?? 0) - (r[0] ?? 0) * (v[2] ?? 0), (r[0] ?? 0) * (v[1] ?? 0) - (r[1] ?? 0) * (v[0] ?? 0)];
    const omega = h.map((x) => x / (d * d));
    const name = s.names[i] ?? id;
    const spin = [0, 1, 2].map((k) => s.spin[i * 3 + k] ?? 0);
    const m = gi / pieces;
    const rp = ri / Math.cbrt(pieces);
    const created: string[] = [];
    removeAt(s, i);
    for (let k = 0; k < pieces; k += 1) {
      // Strung along the radial line through the body's own extent (they overlap: torn pieces neither pull nor merge with one another).
      const offset = pieces > 1 ? (k / (pieces - 1) - 0.5) * 2 * (ri - rp) : 0;
      const pos = [0, 1, 2].map((c) => (xi[c] ?? 0) + (radial[c] ?? 0) * offset);
      const lever = radial.map((x) => x * offset);
      const turn = [(omega[1] ?? 0) * (lever[2] ?? 0) - (omega[2] ?? 0) * (lever[1] ?? 0), (omega[2] ?? 0) * (lever[0] ?? 0) - (omega[0] ?? 0) * (lever[2] ?? 0), (omega[0] ?? 0) * (lever[1] ?? 0) - (omega[1] ?? 0) * (lever[0] ?? 0)];
      const vel = [0, 1, 2].map((c) => (vi[c] ?? 0) + (turn[c] ?? 0));
      const pid = freshId(s, `${id}-piece-${k + 1}`.slice(0, 36));
      addBody(s, { id: pid, name: `${name} ${k + 1}`.slice(0, 60), gm: m, radiusKm: rp, pos, vel });
      s.rubble.push(pid);
      created.push(pid);
    }
    // The angular momentum the pieces do not carry goes to the first piece's spin, so the total is kept exactly.
    const first = indexOf(s, created[0] ?? '');
    for (let c = 0; c < 3; c += 1) s.spin[first * 3 + c] = spin[c] ?? 0;
    const L1 = angularMomentum(s);
    for (let c = 0; c < 3; c += 1) s.spin[first * 3 + c] = (s.spin[first * 3 + c] ?? 0) + (L0[c] ?? 0) - (L1[c] ?? 0);
    const heat = before - energy(s);
    s.internal += heat;
    // Its dust, about the neighbour: test particles where it broke, a little spread in speed (they pull nothing).
    const jNow = indexOf(s, s.ids[j > i ? j - 1 : j] ?? '');
    const survivor = s.ids[jNow] ?? '';
    const room = Math.min(TIDAL.dust, 4000 - s.swarms.reduce((n, w) => n + w.pos.length / 3, 0));
    if (room > 0 && jNow >= 0) {
      const dust = { id: freshSwarmId(s, `dust-${id}`), name: `${name} dust`.slice(0, 60), primary: survivor, pos: [] as number[], vel: [] as number[], lost: 0, torn: true };
      for (let k = 0; k < room; k += 1) {
        // On a shell just outside the body (a Fibonacci spiral over the sphere, 1.1 to 1.6 of its radius), with its orbit's turn.
        const z = 1 - (2 * (k + 0.5)) / room;
        const around = k * Math.PI * (3 - Math.sqrt(5));
        const rho = Math.sqrt(Math.max(0, 1 - z * z));
        const reach = ri * (1.1 + 0.5 * ((k * 0.618034) % 1));
        const lever = [rho * Math.cos(around) * reach, rho * Math.sin(around) * reach, z * reach];
        const turn = [(omega[1] ?? 0) * (lever[2] ?? 0) - (omega[2] ?? 0) * (lever[1] ?? 0), (omega[2] ?? 0) * (lever[0] ?? 0) - (omega[0] ?? 0) * (lever[2] ?? 0), (omega[0] ?? 0) * (lever[1] ?? 0) - (omega[1] ?? 0) * (lever[0] ?? 0)];
        for (let c = 0; c < 3; c += 1) {
          dust.pos.push((r[c] ?? 0) + (lever[c] ?? 0));
          dust.vel.push((v[c] ?? 0) + (turn[c] ?? 0));
        }
      }
      s.swarms.push(dust);
    }
    events.push({ kind: 'disrupt', step: s.step, t: s.t, survivor, absorbed: id, regime: 'tidal', speedKmS: Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0), b: 0, created, unresolved: 0, heat, energy: 0, crater: null, site: [(radial[0] ?? 0), (radial[1] ?? 0), (radial[2] ?? 0)] });
    changed = true;
    i = -1;
  }
  return changed;
}

/** A swarm id not in use. */
function freshSwarmId(s: SimState, base: string): string {
  let id = base.slice(0, 36);
  for (let n = 1; s.swarms.some((w) => w.id === id); n += 1) id = `${base.slice(0, 33)}-${n}`;
  return id;
}

/**
 * Collides every pair that touches now or would touch during a drift of `dt` (its straight path at
 * the velocities after the half kick `acc` gives), repeatedly: the more massive is the target (or the
 * one `keep` names: a scenario's light source keeps its identity). With dt 0 (or no accelerations)
 * only pairs touching now collide. Pairs that grazed are passed over until they have parted.
 */
export function resolveContacts(s: SimState, dt: number, acc: readonly number[] | null, events: ContactEvent[], keep: (id: string) => boolean = () => false): boolean {
  let changed = false;
  // Grazing pairs that have parted (or are gone) are tested again.
  s.passing = s.passing.filter((key) => {
    const [ia, ib] = key.split('|').map((id) => indexOf(s, id));
    if (ia === undefined || ib === undefined || ia < 0 || ib < 0) return false;
    const d = Math.hypot((s.pos[ib * 3] ?? 0) - (s.pos[ia * 3] ?? 0), (s.pos[ib * 3 + 1] ?? 0) - (s.pos[ia * 3 + 1] ?? 0), (s.pos[ib * 3 + 2] ?? 0) - (s.pos[ia * 3 + 2] ?? 0));
    return d < (s.radius[ia] ?? 0) + (s.radius[ib] ?? 0);
  });
  for (;;) {
    const n = count(s);
    const half = acc && acc.length === n * 3 ? dt * 0.5 : 0;
    let hit: [number, number] | null = null;
    for (let i = 0; i < n && !hit; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const reach = (s.radius[i] ?? 0) + (s.radius[j] ?? 0);
        const px = (s.pos[j * 3] ?? 0) - (s.pos[i * 3] ?? 0);
        const py = (s.pos[j * 3 + 1] ?? 0) - (s.pos[i * 3 + 1] ?? 0);
        const pz = (s.pos[j * 3 + 2] ?? 0) - (s.pos[i * 3 + 2] ?? 0);
        let d = Math.hypot(px, py, pz);
        if (d >= reach && dt > 0) {
          const a = (k: number): number => (acc && half > 0 ? (acc[j * 3 + k] ?? 0) - (acc[i * 3 + k] ?? 0) : 0) * half;
          const wx = (s.vel[j * 3] ?? 0) - (s.vel[i * 3] ?? 0) + a(0);
          const wy = (s.vel[j * 3 + 1] ?? 0) - (s.vel[i * 3 + 1] ?? 0) + a(1);
          const wz = (s.vel[j * 3 + 2] ?? 0) - (s.vel[i * 3 + 2] ?? 0) + a(2);
          d = closest(px, py, pz, wx, wy, wz, dt);
        }
        // Two pieces of a torn body pass rather than gather again: the tide that tore them outpulls their mutual gravity.
        const rubble = s.rubble.includes(s.ids[i] ?? '') && s.rubble.includes(s.ids[j] ?? '');
        if (d < reach && !rubble && !s.passing.includes(pairKey(s.ids[i] ?? '', s.ids[j] ?? ''))) {
          hit = [i, j];
          break;
        }
      }
    }
    if (!hit) return changed;
    const [a, b] = hit;
    const kept = keep(s.ids[a] ?? '') ? a : keep(s.ids[b] ?? '') ? b : -1;
    const t = kept >= 0 ? kept : (s.gm[b] ?? 0) > (s.gm[a] ?? 0) ? b : a;
    const p = t === a ? b : a;
    const ids = { survivor: s.ids[t] ?? '', absorbed: s.ids[p] ?? '' };
    // The speed and angle at contact, from the pair's own two-body orbit (energy and angular momentum kept on the way in).
    const rx = (s.pos[p * 3] ?? 0) - (s.pos[t * 3] ?? 0);
    const ry = (s.pos[p * 3 + 1] ?? 0) - (s.pos[t * 3 + 1] ?? 0);
    const rz = (s.pos[p * 3 + 2] ?? 0) - (s.pos[t * 3 + 2] ?? 0);
    const ux = (s.vel[p * 3] ?? 0) - (s.vel[t * 3] ?? 0);
    const uy = (s.vel[p * 3 + 1] ?? 0) - (s.vel[t * 3 + 1] ?? 0);
    const uz = (s.vel[p * 3 + 2] ?? 0) - (s.vel[t * 3 + 2] ?? 0);
    const reach = (s.radius[t] ?? 0) + (s.radius[p] ?? 0);
    const dist = Math.hypot(rx, ry, rz);
    const gmPair = (s.gm[t] ?? 0) + (s.gm[p] ?? 0);
    const speed = Math.sqrt(Math.max(0, ux * ux + uy * uy + uz * uz + (dist > reach ? 2 * gmPair * (1 / reach - 1 / dist) : 0)));
    const h = Math.hypot(ry * uz - rz * uy, rz * ux - rx * uz, rx * uy - ry * ux);
    const bImpact = speed > 0 ? Math.min(1, h / (Math.max(reach, 1e-9) * speed)) : 0;
    const site = contactSite(rx, ry, rz, ux, uy, uz, reach, dt);
    // Test particles have no mass to break: they merge.
    const outcome = (s.gm[t] ?? 0) > 0 && (s.gm[p] ?? 0) > 0 ? impactOutcome({ gm: s.gm[t] ?? 0, radiusKm: s.radius[t] ?? 0 }, { gm: s.gm[p] ?? 0, radiusKm: s.radius[p] ?? 0 }, speed, bImpact) : null;
    const mu = gmPair > 0 ? ((s.gm[t] ?? 0) * (s.gm[p] ?? 0)) / gmPair : 0;
    const base = { step: s.step, t: s.t, survivor: ids.survivor, absorbed: ids.absorbed, speedKmS: speed, b: bImpact, energy: 0.5 * mu * speed * speed, site };
    // The crater it leaves, where the target keeps its surface (none for a graze, a giant or a giant impact).
    const crater = outcome?.regime === 'hit-and-run' ? null : contactCrater({ gm: s.gm[t] ?? 0, radiusKm: s.radius[t] ?? 0 }, { gm: s.gm[p] ?? 0, radiusKm: s.radius[p] ?? 0 }, speed, bImpact);
    if (!outcome || outcome.regime === 'merge') {
      const heat = merge(s, t, p);
      events.push({ ...base, kind: 'merge', regime: 'merge', created: [], unresolved: 0, heat, crater });
    } else if (outcome.regime === 'hit-and-run') {
      s.passing.push(pairKey(ids.survivor, ids.absorbed));
      events.push({ ...base, kind: 'graze', regime: 'hit-and-run', created: [], unresolved: 0, heat: 0, crater: null });
      continue;
    } else {
      const made = fragment(s, t, p, outcome);
      events.push({ ...base, kind: 'fragment', regime: outcome.regime, created: made.created, unresolved: made.unresolved, heat: made.heat, crater });
    }
    changed = true;
    acc = null;
  }
}

/**
 * One kick-drift-kick step of `dt` seconds. `acc` holds the accelerations at the start (recomputed
 * when stale) and is left holding the end's. Returns the shortest dynamical timescale at the end.
 */
export function step(s: SimState, dt: number, acc: number[], events: MergeEvent[], keep?: (id: string) => boolean): number {
  let n = count(s);
  if (acc.length !== n * 6) accelerations(s, acc);
  const homes = s.swarms.length > 0 ? swarmHomes(s) : null;
  // Contacts the coming drift would make, merged now, at the whole step; then bodies the tides tear apart.
  const struck = resolveContacts(s, dt, acc, events, keep);
  const torn = tidalDisruptions(s, events, keep);
  if (struck || torn) {
    n = count(s);
    accelerations(s, acc);
    // Rings whose primary merged away go on about the body it merged into.
    if (homes) rehomeSwarms(s, homes, successorIn(events));
  }
  // Held bodies stay where they are (a merger may have given one a velocity).
  for (const id of s.fixed) {
    const i = s.ids.indexOf(id);
    if (i >= 0) for (let k = 0; k < 3; k += 1) s.vel[i * 3 + k] = 0;
  }
  // Test particles: half a kick from everything but their primary's central pull, with the bodies where they start.
  if (s.swarms.length > 0) kickSwarms(s, acc, dt * 0.5);
  // Ships' rockets: half a kick of thrust with the mass at the start.
  const t0 = s.t;
  const burning = kickThrust(s, dt * 0.5, t0);
  for (let k = 0; k < n * 3; k += 1) s.vel[k] = (s.vel[k] ?? 0) + (acc[k] ?? 0) * dt * 0.5;
  for (let k = 0; k < n * 3; k += 1) s.spin[k] = (s.spin[k] ?? 0) + (acc[n * 3 + k] ?? 0) * dt * 0.5;
  for (let k = 0; k < n * 3; k += 1) s.pos[k] = (s.pos[k] ?? 0) + (s.vel[k] ?? 0) * dt;
  s.t += dt;
  s.step += 1;
  const shortest = accelerations(s, acc);
  if (s.swarms.length > 0) {
    // Along their conics about the primary, then the second half kick with the bodies where they end.
    driftSwarms(s, dt);
    kickSwarms(s, acc, dt * 0.5);
    loseStruck(s);
  }
  for (let k = 0; k < n * 3; k += 1) s.vel[k] = (s.vel[k] ?? 0) + (acc[k] ?? 0) * dt * 0.5;
  for (let k = 0; k < n * 3; k += 1) s.spin[k] = (s.spin[k] ?? 0) + (acc[n * 3 + k] ?? 0) * dt * 0.5;
  // The rest of the thrust, with the step's propellant spent; then burns that have ended.
  if (burning) {
    spendPropellant(s, t0);
    kickThrust(s, dt * 0.5, t0);
  }
  dropEnded(s);
  return shortest;
}

/** The shortest dynamical timescale (s): over massive pairs sqrt(r^3 / (GM_i + GM_j)), and the time to close each pair's gap at its relative speed. */
export function timescale(s: SimState): number {
  const n = count(s);
  const torn = tornPieces(s);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const g = (s.gm[i] ?? 0) + (s.gm[j] ?? 0);
      if (g <= 0 || (torn[i] && torn[j])) continue;
      const dx = (s.pos[j * 3] ?? 0) - (s.pos[i * 3] ?? 0);
      const dy = (s.pos[j * 3 + 1] ?? 0) - (s.pos[i * 3 + 1] ?? 0);
      const dz = (s.pos[j * 3 + 2] ?? 0) - (s.pos[i * 3 + 2] ?? 0);
      const r = Math.hypot(dx, dy, dz);
      const orbital = Math.sqrt((r * r * r) / g);
      const u = Math.hypot((s.vel[j * 3] ?? 0) - (s.vel[i * 3] ?? 0), (s.vel[j * 3 + 1] ?? 0) - (s.vel[i * 3 + 1] ?? 0), (s.vel[j * 3 + 2] ?? 0) - (s.vel[i * 3 + 2] ?? 0));
      const approach = u > 0 ? r / u : Number.POSITIVE_INFINITY;
      best = Math.min(best, orbital, approach);
    }
  }
  return best;
}

export interface Diagnostics {
  /** Total GM (km^3 s^-2), momentum and angular momentum (G units), and energy: mechanical, and the closed model's total (with mergers' internal reservoir). */
  gm: number;
  momentum: [number, number, number];
  angularMomentum: [number, number, number];
  energy: number;
  totalEnergy: number;
  /** Scales the errors are measured against (never zero for a moving system). */
  momentumScale: number;
  angularScale: number;
  energyScale: number;
}

export function energy(s: SimState): number {
  const n = count(s);
  const torn = tornPieces(s);
  let e = oblatePotential(s);
  for (let i = 0; i < n; i += 1) {
    const g = s.gm[i] ?? 0;
    e += 0.5 * g * ((s.vel[i * 3] ?? 0) ** 2 + (s.vel[i * 3 + 1] ?? 0) ** 2 + (s.vel[i * 3 + 2] ?? 0) ** 2);
    for (let j = i + 1; j < n; j += 1) {
      if (torn[i] && torn[j]) continue;
      const r = Math.hypot((s.pos[j * 3] ?? 0) - (s.pos[i * 3] ?? 0), (s.pos[j * 3 + 1] ?? 0) - (s.pos[i * 3 + 1] ?? 0), (s.pos[j * 3 + 2] ?? 0) - (s.pos[i * 3 + 2] ?? 0));
      e -= (g * (s.gm[j] ?? 0)) / r;
    }
  }
  return e;
}

/**
 * Which bodies are pieces of a torn body (`rubble`). Between two of them there is no gravity: inside
 * the Roche limit the tide outpulls what holds them to one another, so each goes its own way (and
 * they pass rather than merge); they pull, and are pulled by, everything else.
 */
function tornPieces(s: SimState): boolean[] {
  if (s.rubble.length === 0) return new Array<boolean>(count(s)).fill(false);
  return s.ids.map((id) => s.rubble.includes(id));
}

export function diagnostics(s: SimState): Diagnostics {
  const n = count(s);
  const p: [number, number, number] = [0, 0, 0];
  const l: [number, number, number] = [0, 0, 0];
  let gm = 0;
  let pScale = 0;
  let lScale = 0;
  let kinetic = 0;
  let potential = 0;
  for (let i = 0; i < n; i += 1) {
    const g = s.gm[i] ?? 0;
    const x = s.pos[i * 3] ?? 0;
    const y = s.pos[i * 3 + 1] ?? 0;
    const z = s.pos[i * 3 + 2] ?? 0;
    const vx = s.vel[i * 3] ?? 0;
    const vy = s.vel[i * 3 + 1] ?? 0;
    const vz = s.vel[i * 3 + 2] ?? 0;
    gm += g;
    p[0] += g * vx;
    p[1] += g * vy;
    p[2] += g * vz;
    pScale += g * Math.hypot(vx, vy, vz);
    const lx = g * (y * vz - z * vy) + (s.spin[i * 3] ?? 0);
    const ly = g * (z * vx - x * vz) + (s.spin[i * 3 + 1] ?? 0);
    const lz = g * (x * vy - y * vx) + (s.spin[i * 3 + 2] ?? 0);
    l[0] += lx;
    l[1] += ly;
    l[2] += lz;
    lScale += Math.hypot(lx, ly, lz);
    kinetic += 0.5 * g * (vx * vx + vy * vy + vz * vz);
    for (let j = i + 1; j < n; j += 1) {
      const r = Math.hypot((s.pos[j * 3] ?? 0) - x, (s.pos[j * 3 + 1] ?? 0) - y, (s.pos[j * 3 + 2] ?? 0) - z);
      potential += (g * (s.gm[j] ?? 0)) / r;
    }
  }
  const oblate = oblatePotential(s);
  const e = kinetic - potential + oblate;
  return { gm, momentum: p, angularMomentum: l, energy: e, totalEnergy: e + s.internal, momentumScale: pScale, angularScale: lScale, energyScale: kinetic + potential + Math.abs(oblate) };
}

/** Relative drift of `now` from `ref` (total energy, momentum, angular momentum), each against the reference's own scale. */
export function drift(ref: Diagnostics, now: Diagnostics): { energy: number; momentum: number; angularMomentum: number } {
  const v = (a: readonly number[], b: readonly number[]): number => Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
  return {
    energy: Math.abs(now.totalEnergy - ref.totalEnergy) / Math.max(ref.energyScale, Number.MIN_VALUE),
    momentum: v(now.momentum, ref.momentum) / Math.max(ref.momentumScale, Number.MIN_VALUE),
    angularMomentum: v(now.angularMomentum, ref.angularMomentum) / Math.max(ref.angularScale, Number.MIN_VALUE),
  };
}

/** Whether every number is finite and every body physical (positive radius; GM not negative). */
export function healthy(s: SimState): boolean {
  return s.pos.every(Number.isFinite) && s.vel.every(Number.isFinite) && s.spin.every(Number.isFinite) && s.gm.every((g) => Number.isFinite(g) && g >= 0) && s.radius.every((r) => Number.isFinite(r) && r > 0);
}

/**
 * The position and velocity, relative to the frame, of a body on a circular orbit of radius `r`
 * about a primary (index `p`): the primary's own position and velocity plus the relative orbit, in
 * the plane whose pole is `normal` (prograde about it), starting along `along`.
 */
export function circularOrbit(s: SimState, p: number, r: number, gmNew: number, normal: readonly number[], along: readonly number[]): { pos: number[]; vel: number[] } {
  const n = unit(normal);
  // The start direction, made perpendicular to the pole.
  const a0 = unit(along);
  const dot = (a0[0] ?? 0) * (n[0] ?? 0) + (a0[1] ?? 0) * (n[1] ?? 0) + (a0[2] ?? 0) * (n[2] ?? 0);
  const a = unit([(a0[0] ?? 0) - dot * (n[0] ?? 0), (a0[1] ?? 0) - dot * (n[1] ?? 0), (a0[2] ?? 0) - dot * (n[2] ?? 0)]);
  // Prograde: the pole crossed with the start direction.
  const t = [(n[1] ?? 0) * (a[2] ?? 0) - (n[2] ?? 0) * (a[1] ?? 0), (n[2] ?? 0) * (a[0] ?? 0) - (n[0] ?? 0) * (a[2] ?? 0), (n[0] ?? 0) * (a[1] ?? 0) - (n[1] ?? 0) * (a[0] ?? 0)];
  const speed = Math.sqrt(((s.gm[p] ?? 0) + gmNew) / r);
  return {
    pos: [0, 1, 2].map((k) => (s.pos[p * 3 + k] ?? 0) + (a[k] ?? 0) * r),
    vel: [0, 1, 2].map((k) => (s.vel[p * 3 + k] ?? 0) + (t[k] ?? 0) * speed),
  };
}

function unit(v: readonly number[]): number[] {
  const l = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0) || 1;
  return [(v[0] ?? 0) / l, (v[1] ?? 0) / l, (v[2] ?? 0) / l];
}
