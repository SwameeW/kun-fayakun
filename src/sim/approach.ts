import { TIDAL } from './nbody';

/**
 * Seeing an event coming (ledger IM-4; docs/SANDBOX-ROADMAP.md W1.13): the next contact between two
 * bodies, or the next body to cross a heavier one's fluid Roche limit, each from the pair's own
 * two-body orbit now (Kepler's equation, exactly; the other bodies' pulls are left out, so the time
 * is a guide that sharpens as the pair closes, refreshed with every snapshot). It never changes the
 * run: the page slows the clock it shows for what is coming (src/explore/lab), and the physics is the
 * same whatever the rate.
 */

/** What is coming: an impact or a tidal disruption, between which bodies, when (simulated seconds from now), how fast and at what angle from the horizontal (an impact), and a rate that shows it (s/s). */
export interface Approach {
  kind: 'impact' | 'disrupt';
  /** The heavier body (the target, or the one whose tides tear) and the other. */
  target: string;
  body: string;
  inS: number;
  speedKmS: number;
  angleDeg: number;
  /** A rate (simulated seconds a second) that shows it: an eighth of the time the impactor takes to cross the target's radius (R / v), or a twentieth of an orbit at the Roche limit. */
  showRate: number;
}

/**
 * The time (s) until a relative two-body orbit (`r` km, `v` km/s about `mu` km^3 s^-2) first comes within
 * `reach` km going inward: 0 when already within, null when it never does (its nearest point is beyond
 * reach, or it is leaving on an open orbit). Kepler's equation for an ellipse, its hyperbolic form, or
 * Barker's for a parabola; a straight line with no gravity.
 */
export function timeToReach(r: ArrayLike<number>, v: ArrayLike<number>, mu: number, reach: number): number | null {
  const rx = r[0] ?? 0;
  const ry = r[1] ?? 0;
  const rz = r[2] ?? 0;
  const vx = v[0] ?? 0;
  const vy = v[1] ?? 0;
  const vz = v[2] ?? 0;
  const d = Math.hypot(rx, ry, rz);
  if (!(d > reach)) return 0;
  const rv = rx * vx + ry * vy + rz * vz;
  const v2 = vx * vx + vy * vy + vz * vz;
  if (!(mu > 0)) {
    if (!(rv < 0) || !(v2 > 0)) return null;
    const disc = rv * rv - v2 * (d * d - reach * reach);
    return disc >= 0 ? (-rv - Math.sqrt(disc)) / v2 : null;
  }
  const h2 = (ry * vz - rz * vy) ** 2 + (rz * vx - rx * vz) ** 2 + (rx * vy - ry * vx) ** 2;
  // Straight in (no angular momentum: the anomalies degenerate): a millionth of the speed across the line, which moves the time by far less than a step.
  if (h2 < 1e-12 * d * d * v2) {
    const ax = Math.abs(rx) < 0.9 * d ? 1 : 0;
    const ay = ax === 1 ? 0 : 1;
    const ux = ry * 0 - rz * ay;
    const uy = rz * ax - rx * 0;
    const uz = rx * ay - ry * ax;
    const lu = Math.hypot(ux, uy, uz) || 1;
    const nudge = (Math.sqrt(v2) * 1e-6) / lu;
    return timeToReach(r, [vx + ux * nudge, vy + uy * nudge, vz + uz * nudge], mu, reach);
  }
  const p = h2 / mu;
  // The eccentricity vector, ((v^2 - mu/d) r - (r.v) v) / mu.
  const k = v2 - mu / d;
  const e = Math.hypot(k * rx - rv * vx, k * ry - rv * vy, k * rz - rv * vz) / mu;
  if (!(p / (1 + e) < reach)) return null;
  if (!(e > 1e-12)) return null;
  const clamp = (x: number): number => Math.min(1, Math.max(-1, x));
  // True anomalies now (negative coming in) and where the orbit first crosses `reach` coming in.
  const f0 = Math.acos(clamp((p / d - 1) / e)) * (rv < 0 ? -1 : 1);
  const fR = -Math.acos(clamp((p / reach - 1) / e));
  if (Math.abs(e - 1) < 1e-7) {
    if (!(rv < 0)) return null;
    const barker = (f: number): number => {
      const D = Math.tan(f / 2);
      return 0.5 * Math.sqrt((p * p * p) / mu) * (D + (D * D * D) / 3);
    };
    const t = barker(fR) - barker(f0);
    return t >= 0 ? t : null;
  }
  if (e < 1) {
    const a = p / (1 - e * e);
    const n = Math.sqrt(mu / (a * a * a));
    const mean = (f: number): number => {
      const E = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(f / 2));
      return E - e * Math.sin(E);
    };
    let t = (mean(fR) - mean(f0)) / n;
    const period = (2 * Math.PI) / n;
    while (t < 0) t += period;
    return t;
  }
  if (!(rv < 0)) return null;
  const a = p / (e * e - 1);
  const n = Math.sqrt(mu / (a * a * a));
  const mean = (f: number): number => {
    const F = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(f / 2));
    return e * Math.sinh(F) - F;
  };
  const t = (mean(fR) - mean(f0)) / n;
  return t >= 0 ? t : null;
}

/** The speed at `reach` (km/s) of a two-body orbit now at `d` with speed^2 `v2` (energy kept), and the angle there from the horizontal (degrees) given its angular momentum `h`. */
export function contactSpeed(v2: number, d: number, mu: number, reach: number, h: number): { speedKmS: number; angleDeg: number } {
  const speed = Math.sqrt(Math.max(0, v2 + 2 * mu * (1 / reach - 1 / d)));
  const cos = speed > 0 ? Math.min(1, h / (reach * speed)) : 0;
  return { speedKmS: speed, angleDeg: (Math.acos(cos) * 180) / Math.PI };
}

/** What the scan needs of the state. */
interface Bodies {
  ids: string[];
  gm: number[];
  radius: number[];
  pos: number[];
  vel: number[];
  rubble: string[];
  passing: string[];
  fixed: string[];
}

/**
 * The soonest event within `horizonS` simulated seconds: every pair's contact (pieces of one torn body
 * excepted: they pass), and every body big enough to be torn crossing a much heavier one's fluid Roche
 * limit on an orbit that does not strike it (src/sim/nbody tidalDisruptions' own conditions); or null.
 * Pairs is O(n^2) at most 64 bodies: a few thousand cheap tests a snapshot.
 */
export function nextApproach(s: Bodies, horizonS: number, keep: (id: string) => boolean = () => false): Approach | null {
  let best: Approach | null = null;
  const n = s.ids.length;
  const r = [0, 0, 0];
  const v = [0, 0, 0];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const gi = s.gm[i] ?? 0;
      const gj = s.gm[j] ?? 0;
      const mu = gi + gj;
      if (!(mu > 0)) continue;
      const t = gj > gi ? j : i;
      const b = t === i ? j : i;
      const idT = s.ids[t] ?? '';
      const idB = s.ids[b] ?? '';
      if (s.rubble.includes(idT) && s.rubble.includes(idB)) continue;
      for (let c = 0; c < 3; c += 1) {
        r[c] = (s.pos[b * 3 + c] ?? 0) - (s.pos[t * 3 + c] ?? 0);
        v[c] = (s.vel[b * 3 + c] ?? 0) - (s.vel[t * 3 + c] ?? 0);
      }
      const d = Math.hypot(r[0] ?? 0, r[1] ?? 0, r[2] ?? 0);
      const rT = s.radius[t] ?? 0;
      const rB = s.radius[b] ?? 0;
      const reach = rT + rB;
      const v2 = (v[0] ?? 0) ** 2 + (v[1] ?? 0) ** 2 + (v[2] ?? 0) ** 2;
      const h = Math.hypot((r[1] ?? 0) * (v[2] ?? 0) - (r[2] ?? 0) * (v[1] ?? 0), (r[2] ?? 0) * (v[0] ?? 0) - (r[0] ?? 0) * (v[2] ?? 0), (r[0] ?? 0) * (v[1] ?? 0) - (r[1] ?? 0) * (v[0] ?? 0));
      // A quick bound first: no closer than the gap can close at the fastest the pair could fall together within the horizon.
      const fastest = Math.sqrt(v2 + (2 * mu) / Math.max(reach, 1e-9));
      const near = d - reach <= fastest * horizonS;
      const passing = s.passing.includes(idT < idB ? `${idT}|${idB}` : `${idB}|${idT}`);
      const inS = !near || passing ? null : timeToReach(r, v, mu, reach);
      if (inS !== null && inS <= horizonS && (!best || inS < best.inS)) {
        const c = contactSpeed(v2, d, mu, reach, h);
        best = { kind: 'impact', target: idT, body: idB, inS, speedKmS: c.speedKmS, angleDeg: c.angleDeg, showRate: c.speedKmS > 0 ? rT / c.speedKmS / 8 : 1 };
        continue;
      }
      // The tide: the lighter body big enough to tear, the other a tenth or more heavier, an orbit that does not strike.
      const gb = s.gm[b] ?? 0;
      const gt = s.gm[t] ?? 0;
      if (!(gb > 0) || rB < TIDAL.minRadiusKm || gt < TIDAL.massRatio * gb || s.rubble.includes(idB) || keep(idB) || s.fixed.includes(idB)) continue;
      const limit = 2.44 * rT * Math.cbrt((gt / rT ** 3) / (gb / rB ** 3));
      if (!(limit > reach) || d - limit > fastest * horizonS) continue;
      const energy = 0.5 * v2 - mu / d;
      const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
      const periapsis = (h * h) / (mu * (1 + e));
      if (!(energy < 0) || !(periapsis > reach)) continue;
      const tide = timeToReach(r, v, mu, limit);
      if (tide !== null && tide <= horizonS && (!best || tide < best.inS)) {
        const period = 2 * Math.PI * Math.sqrt((limit * limit * limit) / mu);
        best = { kind: 'disrupt', target: idT, body: idB, inS: tide, speedKmS: Math.sqrt(v2), angleDeg: 0, showRate: period / 20 };
      }
    }
  }
  return best;
}
