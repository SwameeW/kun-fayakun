/**
 * Orbits as numbers, for the laboratory's inspector and tools (ledger SB-22, SB-31, SB-32, SB-34):
 * osculating Keplerian elements from a state and a state from elements, the five Lagrange points of a
 * pair, Roche limits, the spin-breakup period, the Hill radius, and simple measurements. Units are the
 * engine's: km, s, km/s, GM in km^3 s^-2. The reference plane is the scenario's frame (the ecliptic of
 * J2000 for the solar system), its x axis the reference direction.
 *
 * Elements are osculating: the two-body orbit a body would follow about its primary if every other
 * pull stopped now (Vallado, "Fundamentals of Astrodynamics and Applications", 4th ed., algorithms 9
 * and 10, RV2COE and COE2RV). They change as the others pull; they are a description, not a forecast.
 */

export type Vec3 = [number, number, number];

export interface Elements {
  /** Semi-major axis (km; negative for a hyperbola), eccentricity, inclination (rad). */
  a: number;
  e: number;
  i: number;
  /** Longitude of the ascending node, argument of periapsis, true anomaly (rad, 0 to 2 pi). */
  node: number;
  periapsisArg: number;
  trueAnomaly: number;
  /** Mean anomaly (rad; for a hyperbola the hyperbolic mean anomaly), and the period (s; null when unbound). */
  meanAnomaly: number;
  periodS: number | null;
  /** Periapsis and apoapsis distances from the primary's centre (km; apoapsis null when unbound). */
  periapsisKm: number;
  apoapsisKm: number | null;
  /** Specific orbital energy (km^2 s^-2) and whether the orbit is bound. */
  energy: number;
  bound: boolean;
}

const TWO_PI = 2 * Math.PI;
const EPS = 1e-11;

const dot = (a: readonly number[], b: readonly number[]): number => (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [(a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0), (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0), (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0)];
const norm = (a: readonly number[]): number => Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
const wrap = (x: number): number => ((x % TWO_PI) + TWO_PI) % TWO_PI;

/**
 * Elements of the relative state (r, v: the body's position and velocity minus its primary's) for the
 * pair's GM (the primary's plus the body's). Circular and equatorial orbits, where the node or the
 * periapsis is undefined, take Vallado's conventions: the undefined angle is 0 and the true anomaly
 * is measured from the node (circular inclined), from periapsis by its true longitude (elliptic
 * equatorial), or from the x axis (circular equatorial).
 */
export function elementsFromState(r: readonly number[], v: readonly number[], mu: number): Elements {
  const rn = norm(r);
  const vn = norm(v);
  const h = cross(r, v);
  const hn = norm(h);
  const n: Vec3 = [-h[1], h[0], 0];
  const nn = norm(n);
  const rv = dot(r, v);
  const ev: Vec3 = [0, 1, 2].map((k) => ((vn * vn - mu / rn) * (r[k] ?? 0) - rv * (v[k] ?? 0)) / mu) as Vec3;
  const e = norm(ev);
  const energy = (vn * vn) / 2 - mu / rn;
  const bound = energy < 0;
  const a = Math.abs(1 - e) < EPS ? Number.POSITIVE_INFINITY : -mu / (2 * energy);
  const i = Math.acos(Math.max(-1, Math.min(1, h[2] / hn)));
  const equatorial = nn < EPS * hn;
  const circular = e < 1e-9;
  let node = equatorial ? 0 : Math.acos(Math.max(-1, Math.min(1, n[0] / nn)));
  if (!equatorial && n[1] < 0) node = TWO_PI - node;
  let periapsisArg = 0;
  let trueAnomaly: number;
  if (circular && equatorial) {
    // True longitude: from the x axis, in the sense of the motion.
    trueAnomaly = Math.atan2(r[1] ?? 0, r[0] ?? 0);
    if (h[2] < 0) trueAnomaly = -trueAnomaly;
  } else if (circular) {
    // Argument of latitude: from the node.
    trueAnomaly = Math.acos(Math.max(-1, Math.min(1, dot(n, r) / (nn * rn))));
    if ((r[2] ?? 0) < 0) trueAnomaly = TWO_PI - trueAnomaly;
  } else {
    if (equatorial) {
      // Longitude of periapsis stands in for the argument.
      periapsisArg = Math.atan2(ev[1], ev[0]);
      if (h[2] < 0) periapsisArg = -periapsisArg;
    } else {
      periapsisArg = Math.acos(Math.max(-1, Math.min(1, dot(n, ev) / (nn * e))));
      if (ev[2] < 0) periapsisArg = TWO_PI - periapsisArg;
    }
    trueAnomaly = Math.acos(Math.max(-1, Math.min(1, dot(ev, r) / (e * rn))));
    if (rv < 0) trueAnomaly = TWO_PI - trueAnomaly;
  }
  const p = (hn * hn) / mu;
  let meanAnomaly: number;
  if (e < 1) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(trueAnomaly / 2), Math.sqrt(1 + e) * Math.cos(trueAnomaly / 2));
    meanAnomaly = wrap(E - e * Math.sin(E));
  } else if (e > 1) {
    const F = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(trueAnomaly / 2));
    meanAnomaly = e * Math.sinh(F) - F;
  } else {
    const D = Math.tan(trueAnomaly / 2);
    meanAnomaly = D + (D * D * D) / 3;
  }
  return {
    a,
    e,
    i,
    node: wrap(node),
    periapsisArg: wrap(periapsisArg),
    trueAnomaly: wrap(trueAnomaly),
    meanAnomaly,
    periodS: bound ? TWO_PI * Math.sqrt((a * a * a) / mu) : null,
    periapsisKm: p / (1 + e),
    apoapsisKm: bound ? p / (1 - e) : null,
    energy,
    bound,
  };
}

/** The relative state for elements (a, e, i, node, periapsis argument, true anomaly) about a pair of this GM. */
export function stateFromElements(el: Pick<Elements, 'a' | 'e' | 'i' | 'node' | 'periapsisArg' | 'trueAnomaly'>, mu: number): { r: Vec3; v: Vec3 } {
  const { e, i, node, periapsisArg, trueAnomaly } = el;
  const p = Math.abs(1 - e) < EPS ? Number.NaN : el.a * (1 - e * e);
  const rPf = p / (1 + e * Math.cos(trueAnomaly));
  const rp: Vec3 = [rPf * Math.cos(trueAnomaly), rPf * Math.sin(trueAnomaly), 0];
  const k = Math.sqrt(mu / p);
  const vp: Vec3 = [-k * Math.sin(trueAnomaly), k * (e + Math.cos(trueAnomaly)), 0];
  // Perifocal to the reference frame: R3(-node) R1(-i) R3(-argument).
  const cO = Math.cos(node);
  const sO = Math.sin(node);
  const ci = Math.cos(i);
  const si = Math.sin(i);
  const cw = Math.cos(periapsisArg);
  const sw = Math.sin(periapsisArg);
  const m = [cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci, sO * si, sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci, -cO * si, sw * si, cw * si, ci];
  const rot = (x: Vec3): Vec3 => [(m[0] ?? 0) * x[0] + (m[1] ?? 0) * x[1] + (m[2] ?? 0) * x[2], (m[3] ?? 0) * x[0] + (m[4] ?? 0) * x[1] + (m[5] ?? 0) * x[2], (m[6] ?? 0) * x[0] + (m[7] ?? 0) * x[1] + (m[8] ?? 0) * x[2]];
  return { r: rot(rp), v: rot(vp) };
}

/**
 * The five Lagrange points of a pair (the primary and its secondary) at this instant, from their
 * positions and GMs, in the scenario frame: L1 to L3 on the line through both (each the root of the
 * collinear equilibrium in the frame turning with the pair, by Newton's method from Hill's
 * approximation), L4 and L5 sixty degrees ahead of and behind the secondary in the plane of its orbit.
 * Exact for a circular orbit; for an eccentric one, the points of the pair's present separation.
 */
export function lagrangePoints(primary: { gm: number; pos: readonly number[]; vel: readonly number[] }, secondary: { gm: number; pos: readonly number[]; vel: readonly number[] }): { L1: Vec3; L2: Vec3; L3: Vec3; L4: Vec3; L5: Vec3 } {
  const m1 = primary.gm;
  const m2 = secondary.gm;
  const total = m1 + m2;
  const mu = m2 / total;
  const d: Vec3 = [0, 1, 2].map((k) => (secondary.pos[k] ?? 0) - (primary.pos[k] ?? 0)) as Vec3;
  const R = norm(d);
  const x: Vec3 = d.map((c) => c / R) as Vec3;
  const w: Vec3 = [0, 1, 2].map((k) => (secondary.vel[k] ?? 0) - (primary.vel[k] ?? 0)) as Vec3;
  const pole = cross(d, w);
  const pn = norm(pole) || 1;
  const z: Vec3 = pole.map((c) => c / pn) as Vec3;
  const y = cross(z, x);
  // The barycentre, and the frame's unit of length: positions as fractions of R from it.
  const bary: Vec3 = [0, 1, 2].map((k) => ((primary.pos[k] ?? 0) * m1 + (secondary.pos[k] ?? 0) * m2) / total) as Vec3;
  // In units of R, the primary at -mu and the secondary at 1 - mu on the x axis.
  const force = (s: number): number => s - ((1 - mu) * (s + mu)) / Math.abs(s + mu) ** 3 - (mu * (s - 1 + mu)) / Math.abs(s - 1 + mu) ** 3;
  const solve = (guess: number): number => {
    let s = guess;
    for (let k = 0; k < 60; k += 1) {
      const f = force(s);
      const h = 1e-7;
      const df = (force(s + h) - force(s - h)) / (2 * h);
      const next = s - f / df;
      if (!Number.isFinite(next)) break;
      if (Math.abs(next - s) < 1e-14) return next;
      s = next;
    }
    return s;
  };
  const hill = Math.cbrt(mu / 3);
  const s1 = solve(1 - mu - hill);
  const s2 = solve(1 - mu + hill);
  const s3 = solve(-1 - (5 / 12) * mu);
  const at = (sx: number, sy: number): Vec3 => [0, 1, 2].map((k) => (bary[k] ?? 0) + R * (sx * (x[k] ?? 0) + sy * (y[k] ?? 0))) as Vec3;
  const half = Math.sqrt(3) / 2;
  return { L1: at(s1, 0), L2: at(s2, 0), L3: at(s3, 0), L4: at(0.5 - mu, half), L5: at(0.5 - mu, -half) };
}

/**
 * Roche limits of a satellite about its primary (km): rigid, d = R (2 rho_P / rho_s)^(1/3) (Roche
 * 1849, a rigid spherical satellite held by its own gravity alone); fluid, d = 2.44 R (rho_P /
 * rho_s)^(1/3) (a fluid satellite free to deform, Chandrasekhar 1969 gives 2.455). R and rho_P the
 * primary's radius and density, rho_s the satellite's.
 */
export function rocheLimits(primaryRadiusKm: number, primaryDensity: number, satelliteDensity: number): { rigidKm: number; fluidKm: number } {
  const q = Math.cbrt(primaryDensity / satelliteDensity);
  return { rigidKm: primaryRadiusKm * Math.cbrt(2) * q, fluidKm: 2.44 * primaryRadiusKm * q };
}

/** The shortest rotation period a body held together by its own gravity alone can have (s): where the equator's spin equals orbital speed, 2 pi sqrt(R^3 / GM). */
export function breakupPeriodS(gm: number, radiusKm: number): number {
  return TWO_PI * Math.sqrt((radiusKm * radiusKm * radiusKm) / gm);
}

/** The Hill radius (km) of a body of GM m on an orbit of semi-major axis a and eccentricity e about a primary of GM M: a (1 - e) (m / 3M)^(1/3). */
export function hillRadiusKm(a: number, e: number, m: number, M: number): number {
  return a * (1 - e) * Math.cbrt(m / (3 * M));
}

/** The speed of light, km/s (exact, by the definition of the metre). */
export const LIGHT_KM_S = 299_792.458;

/** Measurements between bodies: distance (km), light time (s), and the angular size (rad) of a body of radius `radiusKm` at that distance. */
export function measure(from: readonly number[], to: readonly number[], radiusKm: number): { distanceKm: number; lightS: number; angularSize: number } {
  const distanceKm = Math.hypot((to[0] ?? 0) - (from[0] ?? 0), (to[1] ?? 0) - (from[1] ?? 0), (to[2] ?? 0) - (from[2] ?? 0));
  return { distanceKm, lightS: distanceKm / LIGHT_KM_S, angularSize: distanceKm > radiusKm ? 2 * Math.asin(radiusKm / distanceKm) : Math.PI };
}

/** The angle (rad) between two bodies as seen from a third. */
export function separation(from: readonly number[], a: readonly number[], b: readonly number[]): number {
  const u = [0, 1, 2].map((k) => (a[k] ?? 0) - (from[k] ?? 0));
  const w = [0, 1, 2].map((k) => (b[k] ?? 0) - (from[k] ?? 0));
  return Math.acos(Math.max(-1, Math.min(1, dot(u, w) / ((norm(u) || 1) * (norm(w) || 1)))));
}

/** The local orbital frame of a body about its primary: prograde (along the relative velocity), normal (along the orbit's pole), radial (outward, completing the frame). */
export function orbitalFrame(r: readonly number[], v: readonly number[]): { prograde: Vec3; normal: Vec3; radial: Vec3 } {
  const vn = norm(v) || 1;
  const prograde: Vec3 = [(v[0] ?? 0) / vn, (v[1] ?? 0) / vn, (v[2] ?? 0) / vn];
  const h = cross(r, v);
  const hn = norm(h) || 1;
  const normal: Vec3 = [h[0] / hn, h[1] / hn, h[2] / hn];
  const radial = cross(prograde, normal);
  return { prograde, normal, radial };
}
