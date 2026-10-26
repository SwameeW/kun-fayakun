/**
 * Rings and belts of test particles (ledger IM-6): particles that feel the bodies' gravity and pull
 * nothing, so they never change the bodies' motion (a run with a ring and without it is the same for
 * the bodies, bit for bit). Thousands of them cost what a few bodies would.
 *
 * Each swarm is carried relative to a primary (the body it was made about): every step each particle
 * moves exactly along its conic about the primary (./kepler) between two half kicks from everything
 * else, the other bodies' pulls, every oblate body's J2 term (the primary's own included) and, as the
 * primary itself is accelerated, the opposite of its acceleration (the indirect term). That is the
 * Wisdom and Holman (1991) split for test particles: the step the bodies need can be a large part of a
 * ring's orbit (a ring about the Earth turns in hours) and the ring still turns as it should, since the
 * dominant pull is followed exactly. The bodies' own step is unchanged; particles do not set it.
 *
 * A particle that comes within a body's radius strikes it and is gone (counted, not added: it has no
 * mass). One passing through a body within a single step is not caught. If the primary merges into
 * another body, its particles go on about the survivor; if it is removed, about the most massive body.
 *
 * Particles are made deterministically from a seed (a ring is part of the scenario's log, so it is
 * made again identically on replay): semi-major axes uniform between the inner and outer radius,
 * eccentricities and inclinations uniform up to the limits given, the angles uniform, in the plane
 * the spec names (a planet's equator for a ring, the ecliptic for a belt about the Sun).
 */

import type { Vec3 } from './elements';
import { stateFromElements } from './elements';
import { keplerDrift } from './kepler';

/** A ring or belt as made: what the scenario's log records. */
export interface SwarmSpec {
  id: string;
  name: string;
  /** The body it is made about. */
  primary: string;
  count: number;
  /** Semi-major axes from inner to outer (km), eccentricities up to `eccentricity`, inclinations to the plane up to `inclinationDeg`. */
  innerKm: number;
  outerKm: number;
  eccentricity: number;
  inclinationDeg: number;
  /** The plane's pole (scenario frame; normalised when used). */
  normal: [number, number, number];
  seed: number;
}

/** A swarm in the state: its particles relative to its primary. */
export interface Swarm {
  id: string;
  name: string;
  primary: string;
  /** Positions (km) and velocities (km/s) relative to the primary, three per particle. */
  pos: number[];
  vel: number[];
  /** Particles that struck a body and are gone. */
  lost: number;
}

/** The most particles in one swarm, and in a scenario. */
export const SWARM_LIMITS = { perSwarm: 2000, total: 4000 } as const;

/** What the swarm code needs of the state (the bodies, and the swarms). */
interface Bodies {
  ids: string[];
  gm: number[];
  radius: number[];
  pos: number[];
  vel: number[];
  spin: number[];
  j2: number[];
  swarms: Swarm[];
}

/** Mulberry32: a small, fast, well-mixed 32-bit generator; the same seed gives the same numbers on every machine. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The particles a spec makes about its primary (null when the primary is not there or has no mass). */
export function makeSwarm(s: Bodies, spec: SwarmSpec): Swarm | null {
  const p = s.ids.indexOf(spec.primary);
  const mu = p >= 0 ? (s.gm[p] ?? 0) : 0;
  if (p < 0 || !(mu > 0)) return null;
  const radius = s.radius[p] ?? 0;
  const { x, y, z } = planeAxes(spec.normal);
  const random = generator(spec.seed);
  const pos: number[] = [];
  const vel: number[] = [];
  for (let k = 0; k < spec.count; k += 1) {
    const a = spec.innerKm + (spec.outerKm - spec.innerKm) * random();
    // Never starting with its periapsis inside the primary.
    const e = Math.min(spec.eccentricity * random(), Math.max(0, 1 - (radius * 1.01) / a));
    const i = ((spec.inclinationDeg * Math.PI) / 180) * random();
    const node = 2 * Math.PI * random();
    const periapsisArg = 2 * Math.PI * random();
    // The mean anomaly uniform (evenly in time round the orbit), turned into the true anomaly by Kepler's equation.
    const M = 2 * Math.PI * random();
    let E = M;
    for (let n = 0; n < 30; n += 1) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const trueAnomaly = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
    const state = stateFromElements({ a, e, i, node, periapsisArg, trueAnomaly }, mu);
    for (const [from, to] of [[state.r, pos], [state.v, vel]] as const) {
      for (let c = 0; c < 3; c += 1) to.push((x[c] ?? 0) * from[0] + (y[c] ?? 0) * from[1] + (z[c] ?? 0) * from[2]);
    }
  }
  return { id: spec.id, name: spec.name, primary: spec.primary, pos, vel, lost: 0 };
}

/**
 * A gravitating ring's places: `count` circular orbits about the primary evenly round the plane (a
 * little jitter in angle and radius from the seed), relative to it. Null where the primary is missing.
 */
export function ringPlaces(s: Pick<Bodies, 'ids' | 'gm'>, spec: Pick<SwarmSpec, 'primary' | 'count' | 'innerKm' | 'outerKm' | 'normal' | 'seed'>): Array<{ pos: Vec3; vel: Vec3 }> | null {
  const p = s.ids.indexOf(spec.primary);
  const mu = p >= 0 ? (s.gm[p] ?? 0) : 0;
  if (p < 0 || !(mu > 0)) return null;
  const { x, y } = planeAxes(spec.normal);
  const random = generator(spec.seed);
  return Array.from({ length: spec.count }, (_, k) => {
    const a = spec.innerKm + (spec.outerKm - spec.innerKm) * random();
    const angle = ((k + 0.3 * (random() - 0.5)) * 2 * Math.PI) / spec.count;
    const speed = Math.sqrt(mu / a);
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    const pos = [0, 1, 2].map((i) => a * (c * (x[i] ?? 0) + sn * (y[i] ?? 0))) as Vec3;
    const vel = [0, 1, 2].map((i) => speed * (-sn * (x[i] ?? 0) + c * (y[i] ?? 0))) as Vec3;
    return { pos, vel };
  });
}

/** A plane's axes from its pole: x and y in it, z the pole. */
function planeAxes(normal: readonly number[]): { x: Vec3; y: Vec3; z: Vec3 } {
  const nl = Math.hypot(normal[0] ?? 0, normal[1] ?? 0, normal[2] ?? 0);
  const z: Vec3 = nl > 0 ? [(normal[0] ?? 0) / nl, (normal[1] ?? 0) / nl, (normal[2] ?? 0) / nl] : [0, 0, 1];
  const helper: Vec3 = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const xRaw: Vec3 = [helper[1] * z[2] - helper[2] * z[1], helper[2] * z[0] - helper[0] * z[2], helper[0] * z[1] - helper[1] * z[0]];
  const xl = Math.hypot(...xRaw);
  const x: Vec3 = [xRaw[0] / xl, xRaw[1] / xl, xRaw[2] / xl];
  const y: Vec3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return { x, y, z };
}

export function cloneSwarm(w: Swarm): Swarm {
  return { ...w, pos: [...w.pos], vel: [...w.vel] };
}

/** Particles in all the swarms. */
export const particleCount = (s: Pick<Bodies, 'swarms'>): number => s.swarms.reduce((n, w) => n + w.pos.length / 3, 0);

/**
 * Half a kick (`h` seconds) for every particle: the pulls of every body but its primary, every oblate
 * body's J2 term, less the primary's own acceleration (from `acc`, the bodies' accelerations now).
 */
export function kickSwarms(s: Bodies, acc: readonly number[], h: number): void {
  const n = s.ids.length;
  for (const w of s.swarms) {
    const p = s.ids.indexOf(w.primary);
    if (p < 0) continue;
    const px = s.pos[p * 3] ?? 0;
    const py = s.pos[p * 3 + 1] ?? 0;
    const pz = s.pos[p * 3 + 2] ?? 0;
    const apx = acc[p * 3] ?? 0;
    const apy = acc[p * 3 + 1] ?? 0;
    const apz = acc[p * 3 + 2] ?? 0;
    const m = w.pos.length / 3;
    for (let k = 0; k < m; k += 1) {
      const rx = w.pos[k * 3] ?? 0;
      const ry = w.pos[k * 3 + 1] ?? 0;
      const rz = w.pos[k * 3 + 2] ?? 0;
      let ax = -apx;
      let ay = -apy;
      let az = -apz;
      for (let j = 0; j < n; j += 1) {
        const g = s.gm[j] ?? 0;
        if (g <= 0) continue;
        // From the particle to body j, through the primary (no large numbers subtracted).
        const dx = (s.pos[j * 3] ?? 0) - px - rx;
        const dy = (s.pos[j * 3 + 1] ?? 0) - py - ry;
        const dz = (s.pos[j * 3 + 2] ?? 0) - pz - rz;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (j !== p) {
          const inv = g / (r2 * Math.sqrt(r2));
          ax += dx * inv;
          ay += dy * inv;
          az += dz * inv;
        }
        const j2 = s.j2[j] ?? 0;
        if (j2 === 0) continue;
        const L = Math.hypot(s.spin[j * 3] ?? 0, s.spin[j * 3 + 1] ?? 0, s.spin[j * 3 + 2] ?? 0);
        if (!(L > 0)) continue;
        // The J2 term about body j's spin axis, at the particle (d points from the particle to j).
        const ox = (s.spin[j * 3] ?? 0) / L;
        const oy = (s.spin[j * 3 + 1] ?? 0) / L;
        const oz = (s.spin[j * 3 + 2] ?? 0) / L;
        const rj = s.radius[j] ?? 0;
        const zj = -(dx * ox + dy * oy + dz * oz);
        const f = (1.5 * j2 * g * rj * rj) / (r2 * r2 * Math.sqrt(r2));
        const c = 1 - (5 * zj * zj) / r2;
        ax -= f * (c * -dx + 2 * zj * ox);
        ay -= f * (c * -dy + 2 * zj * oy);
        az -= f * (c * -dz + 2 * zj * oz);
      }
      w.vel[k * 3] = (w.vel[k * 3] ?? 0) + ax * h;
      w.vel[k * 3 + 1] = (w.vel[k * 3 + 1] ?? 0) + ay * h;
      w.vel[k * 3 + 2] = (w.vel[k * 3 + 2] ?? 0) + az * h;
    }
  }
}

/** Every particle `dt` seconds along its conic about its primary (a straight line where the primary has no mass). */
export function driftSwarms(s: Bodies, dt: number): void {
  const out = [0, 0, 0, 0, 0, 0];
  for (const w of s.swarms) {
    const p = s.ids.indexOf(w.primary);
    const mu = p >= 0 ? (s.gm[p] ?? 0) : 0;
    const m = w.pos.length / 3;
    for (let k = 0; k < m; k += 1) {
      if (keplerDrift(w.pos, w.vel, k * 3, mu, dt, out)) {
        for (let c = 0; c < 3; c += 1) {
          w.pos[k * 3 + c] = out[c] ?? 0;
          w.vel[k * 3 + c] = out[c + 3] ?? 0;
        }
      } else {
        for (let c = 0; c < 3; c += 1) w.pos[k * 3 + c] = (w.pos[k * 3 + c] ?? 0) + (w.vel[k * 3 + c] ?? 0) * dt;
      }
    }
  }
}

/** Particles within a body's radius strike it: gone, and counted. */
export function loseStruck(s: Bodies): void {
  const n = s.ids.length;
  for (const w of s.swarms) {
    const p = s.ids.indexOf(w.primary);
    if (p < 0) continue;
    const px = s.pos[p * 3] ?? 0;
    const py = s.pos[p * 3 + 1] ?? 0;
    const pz = s.pos[p * 3 + 2] ?? 0;
    const m = w.pos.length / 3;
    let kept = 0;
    for (let k = 0; k < m; k += 1) {
      const rx = w.pos[k * 3] ?? 0;
      const ry = w.pos[k * 3 + 1] ?? 0;
      const rz = w.pos[k * 3 + 2] ?? 0;
      let struck = false;
      for (let j = 0; j < n && !struck; j += 1) {
        const R = s.radius[j] ?? 0;
        const dx = j === p ? rx : rx + px - (s.pos[j * 3] ?? 0);
        const dy = j === p ? ry : ry + py - (s.pos[j * 3 + 1] ?? 0);
        const dz = j === p ? rz : rz + pz - (s.pos[j * 3 + 2] ?? 0);
        struck = dx * dx + dy * dy + dz * dz < R * R;
      }
      if (struck) {
        w.lost += 1;
        continue;
      }
      if (kept !== k) {
        for (let c = 0; c < 3; c += 1) {
          w.pos[kept * 3 + c] = w.pos[k * 3 + c] ?? 0;
          w.vel[kept * 3 + c] = w.vel[k * 3 + c] ?? 0;
        }
      }
      kept += 1;
    }
    w.pos.length = kept * 3;
    w.vel.length = kept * 3;
  }
}

/** Each swarm's primary's position and velocity now (to carry the particles over should it go). */
export function swarmHomes(s: Bodies): Array<{ pos: Vec3; vel: Vec3 } | null> {
  return s.swarms.map((w) => {
    const p = s.ids.indexOf(w.primary);
    if (p < 0) return null;
    return { pos: [s.pos[p * 3] ?? 0, s.pos[p * 3 + 1] ?? 0, s.pos[p * 3 + 2] ?? 0], vel: [s.vel[p * 3] ?? 0, s.vel[p * 3 + 1] ?? 0, s.vel[p * 3 + 2] ?? 0] };
  });
}

/**
 * Swarms whose primary is gone go on about another body: `successor` names it (the body their
 * primary merged into), else the most massive body. Their particles keep their places and motions.
 */
export function rehomeSwarms(s: Bodies, homes: ReadonlyArray<{ pos: Vec3; vel: Vec3 } | null>, successor: (gone: string) => string | null): void {
  s.swarms.forEach((w, k) => {
    const home = homes[k];
    if (!home || s.ids.includes(w.primary)) return;
    let next = successor(w.primary);
    if (next === null || !s.ids.includes(next)) {
      let best = -1;
      for (let j = 0; j < s.ids.length; j += 1) if (best < 0 || (s.gm[j] ?? 0) > (s.gm[best] ?? 0)) best = j;
      next = best >= 0 ? (s.ids[best] ?? null) : null;
    }
    const q = next === null ? -1 : s.ids.indexOf(next);
    if (q < 0 || next === null) return;
    const m = w.pos.length / 3;
    for (let i = 0; i < m; i += 1) {
      for (let c = 0; c < 3; c += 1) {
        w.pos[i * 3 + c] = (w.pos[i * 3 + c] ?? 0) + (home.pos[c] ?? 0) - (s.pos[q * 3 + c] ?? 0);
        w.vel[i * 3 + c] = (w.vel[i * 3 + c] ?? 0) + (home.vel[c] ?? 0) - (s.vel[q * 3 + c] ?? 0);
      }
    }
    w.primary = next;
  });
}
