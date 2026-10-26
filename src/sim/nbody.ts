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
 * cannot pass through a target between steps. A pair that would touch merges then, at the whole step
 * (where positions and velocities belong to the same instant, so the energy accounts exactly):
 * merge() conserves mass, momentum and the centre of mass, keeps the pair's orbital angular momentum
 * as the survivor's spin, and moves the energy the merger takes into `internal` (below). So bodies merge
 * within the step in which they would touch, never later; nothing is softened, and two bodies never
 * share a centre when a force is evaluated.
 *
 * Energy at a merger: the pair's relative kinetic energy (half the reduced mass times the relative
 * speed squared) is the impact's heat; their mutual attraction becomes the merged body's own binding,
 * which point masses do not hold. Both go to `internal`, the merged bodies' internal-energy reservoir,
 * so mechanical energy plus `internal` is the closed model's total and stays constant through it.
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
  /** Spin angular momentum taken up by mergers, GM-weighted (km^5 s^-3 / ... in G units), three per body. */
  spin: number[];
  /** Simulated seconds since the scenario's epoch, and steps taken. */
  t: number;
  step: number;
  /** Energy (G units) mergers moved from the bodies' motion and mutual attraction into the merged bodies (impact heat less the binding gained), so E + internal is the closed model's total. */
  internal: number;
}

export interface MergeEvent {
  kind: 'merge';
  step: number;
  t: number;
  /** The body that remains (the more massive), and the one absorbed. */
  survivor: string;
  absorbed: string;
  /** The impact's heat: the pair's relative kinetic energy (G units). */
  heat: number;
}

export const count = (s: SimState): number => s.ids.length;

/** A deep copy (the engine's checkpoints and predictions run on copies). */
export function cloneState(s: SimState): SimState {
  return { ids: [...s.ids], names: [...s.names], gm: [...s.gm], radius: [...s.radius], pos: [...s.pos], vel: [...s.vel], spin: [...s.spin], t: s.t, step: s.step, internal: s.internal };
}

export function addBody(s: SimState, body: { id: string; name: string; gm: number; radiusKm: number; pos: readonly number[]; vel: readonly number[] }): void {
  s.ids.push(body.id);
  s.names.push(body.name);
  s.gm.push(body.gm);
  s.radius.push(body.radiusKm);
  s.pos.push(body.pos[0] ?? 0, body.pos[1] ?? 0, body.pos[2] ?? 0);
  s.vel.push(body.vel[0] ?? 0, body.vel[1] ?? 0, body.vel[2] ?? 0);
  s.spin.push(0, 0, 0);
}

export function removeAt(s: SimState, i: number): void {
  s.ids.splice(i, 1);
  s.names.splice(i, 1);
  s.gm.splice(i, 1);
  s.radius.splice(i, 1);
  s.pos.splice(i * 3, 3);
  s.vel.splice(i * 3, 3);
  s.spin.splice(i * 3, 3);
}

export const indexOf = (s: SimState, id: string): number => s.ids.indexOf(id);

/**
 * Accelerations (km s^-2) of every body into `out` (three per body). Returns the shortest dynamical
 * timescale of the massive pairs, found on the way (see timescale()).
 */
export function accelerations(s: SimState, out: number[]): number {
  const n = count(s);
  out.length = n * 3;
  out.fill(0);
  let shortest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i += 1) {
    const xi = s.pos[i * 3] ?? 0;
    const yi = s.pos[i * 3 + 1] ?? 0;
    const zi = s.pos[i * 3 + 2] ?? 0;
    const gi = s.gm[i] ?? 0;
    for (let j = i + 1; j < n; j += 1) {
      const gj = s.gm[j] ?? 0;
      if (gi === 0 && gj === 0) continue;
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
  return shortest;
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

/**
 * Merges every pair that touches now or would touch during a drift of `dt` (its straight path at the
 * velocities after the half kick `acc` gives), repeatedly, the more massive surviving (or the one
 * `keep` names: a scenario's light source keeps its identity). With dt 0 (or no accelerations) only
 * pairs touching now merge.
 */
export function resolveContacts(s: SimState, dt: number, acc: readonly number[] | null, events: MergeEvent[], keep: (id: string) => boolean = () => false): boolean {
  let merged = false;
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
        if (d < reach) {
          hit = [i, j];
          break;
        }
      }
    }
    if (!hit) return merged;
    const [a, b] = hit;
    const kept = keep(s.ids[a] ?? '') ? a : keep(s.ids[b] ?? '') ? b : -1;
    const survivor = kept >= 0 ? kept : (s.gm[b] ?? 0) > (s.gm[a] ?? 0) ? b : a;
    const absorbed = survivor === a ? b : a;
    const ids = { survivor: s.ids[survivor] ?? '', absorbed: s.ids[absorbed] ?? '' };
    const heat = merge(s, survivor, absorbed);
    events.push({ kind: 'merge', step: s.step, t: s.t, survivor: ids.survivor, absorbed: ids.absorbed, heat });
    merged = true;
    acc = null;
  }
}

/**
 * One kick-drift-kick step of `dt` seconds. `acc` holds the accelerations at the start (recomputed
 * when stale) and is left holding the end's. Returns the shortest dynamical timescale at the end.
 */
export function step(s: SimState, dt: number, acc: number[], events: MergeEvent[], keep?: (id: string) => boolean): number {
  let n = count(s);
  if (acc.length !== n * 3) accelerations(s, acc);
  // Contacts the coming drift would make, merged now, at the whole step.
  if (resolveContacts(s, dt, acc, events, keep)) {
    n = count(s);
    accelerations(s, acc);
  }
  for (let k = 0; k < n * 3; k += 1) s.vel[k] = (s.vel[k] ?? 0) + (acc[k] ?? 0) * dt * 0.5;
  for (let k = 0; k < n * 3; k += 1) s.pos[k] = (s.pos[k] ?? 0) + (s.vel[k] ?? 0) * dt;
  s.t += dt;
  s.step += 1;
  const shortest = accelerations(s, acc);
  for (let k = 0; k < n * 3; k += 1) s.vel[k] = (s.vel[k] ?? 0) + (acc[k] ?? 0) * dt * 0.5;
  return shortest;
}

/** The shortest dynamical timescale (s): over massive pairs sqrt(r^3 / (GM_i + GM_j)), and the time to close each pair's gap at its relative speed. */
export function timescale(s: SimState): number {
  const n = count(s);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const g = (s.gm[i] ?? 0) + (s.gm[j] ?? 0);
      if (g <= 0) continue;
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
  let e = 0;
  for (let i = 0; i < n; i += 1) {
    const g = s.gm[i] ?? 0;
    e += 0.5 * g * ((s.vel[i * 3] ?? 0) ** 2 + (s.vel[i * 3 + 1] ?? 0) ** 2 + (s.vel[i * 3 + 2] ?? 0) ** 2);
    for (let j = i + 1; j < n; j += 1) {
      const r = Math.hypot((s.pos[j * 3] ?? 0) - (s.pos[i * 3] ?? 0), (s.pos[j * 3 + 1] ?? 0) - (s.pos[i * 3 + 1] ?? 0), (s.pos[j * 3 + 2] ?? 0) - (s.pos[i * 3 + 2] ?? 0));
      e -= (g * (s.gm[j] ?? 0)) / r;
    }
  }
  return e;
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
  const e = kinetic - potential;
  return { gm, momentum: p, angularMomentum: l, energy: e, totalEnergy: e + s.internal, momentumScale: pScale, angularScale: lScale, energyScale: kinetic + potential };
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
  return s.pos.every(Number.isFinite) && s.vel.every(Number.isFinite) && s.gm.every((g) => Number.isFinite(g) && g >= 0) && s.radius.every((r) => Number.isFinite(r) && r > 0);
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
