/**
 * Where the small worlds are, and how bright: pure (no three.js), float64, for the explorer's worlds
 * chunk (./index) and the unit tests. The GPU's own propagation of the asteroids (./belt) is this
 * file's Kepler solve and frame written in TSL; `beltPosition` here is its twin, run on the CPU.
 *
 * - Asteroids and comets: two-body orbits about the Sun from JPL's Small-Body Database elements
 *   (public/assets/smallbodies, scripts/smallbodies/build.py), heliocentric ecliptic J2000.
 * - Moons: JPL's mean orbital elements on each moon's reference plane (its Laplace plane, its
 *   planet's equator or the ecliptic), the apsides advancing and the nodes regressing at the
 *   tabulated periods; the plane's pole in the ICRF turns them to the equator, the obliquity of
 *   J2000 to the ecliptic.
 * - Brightness: the IAU's H, G system for asteroids (Bowell et al. 1989), and the comets' total
 *   magnitude M1 + 5 log10(delta) + K1 log10(r).
 *
 * Two-body orbits drift from the real ones as the planets pull on them: over the explorer's decade
 * by a tenth of a degree or so for main-belt asteroids and Trojans, up to two degrees for the Hildas
 * (held in step with Jupiter), more for comets passing Jupiter (tests/unit/small-bodies.spec.ts; the
 * panel says the positions are from orbital elements, not an integration).
 */

export const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;
/** Gauss's gravitational constant: the Sun's mean motion at 1 au, radians a day. */
export const GAUSS_K = 0.01720209895;
const DAYS_PER_YEAR = 365.25;

/** The classes of the asteroid files (manifest.json `classes`): the SBDB's, and HIL the Hildas. */
export type BeltClass = 'MBA' | 'IMB' | 'OMB' | 'HIL' | 'TJN' | 'ATE' | 'APO' | 'AMO' | 'IEO' | 'MCA' | 'CEN' | 'TNO' | 'AST' | 'PAA' | 'HYA';

/** The groups the explorer names (the panel's counts): main belt, near the Earth, Trojans, Hildas, centaurs, beyond Neptune, the rest. */
export type BeltGroup = 'main' | 'near' | 'trojans' | 'hildas' | 'centaurs' | 'kuiper' | 'other';
export const BELT_GROUPS: readonly BeltGroup[] = ['main', 'near', 'trojans', 'hildas', 'centaurs', 'kuiper', 'other'];
export const GROUP_OF: Readonly<Record<BeltClass, BeltGroup>> = {
  MBA: 'main', IMB: 'main', OMB: 'main', MCA: 'main', HIL: 'hildas', TJN: 'trojans',
  ATE: 'near', APO: 'near', AMO: 'near', IEO: 'near', CEN: 'centaurs', TNO: 'kuiper', AST: 'other', PAA: 'other', HYA: 'other',
};

export interface BeltManifest {
  epochJdTdb: number;
  classes: BeltClass[];
  counts: Partial<Record<BeltClass, number>>;
  tiers: Array<{ file: string; count: number; cumulative: number; hMax: number; bytes: number; sha256: string }>;
  comets: { file: string; count: number };
  worlds: { file: string; count: number };
}

export const RECORD_BYTES = 16;

/** One asteroid, decoded (angles in radians, a in au, M0 at the files' epoch). */
export interface BeltRecord {
  a: number;
  e: number;
  i: number;
  node: number;
  peri: number;
  m0: number;
  h: number;
  cls: number;
}

/** Reads record `k` of an asteroid file (the layout in scripts/smallbodies/build.py). */
export function decodeRecord(view: DataView, k: number, out: BeltRecord): BeltRecord {
  const o = k * RECORD_BYTES;
  out.a = view.getFloat32(o, true);
  out.e = view.getUint16(o + 4, true) / 65535;
  out.i = (view.getUint16(o + 6, true) / 65535) * Math.PI;
  out.node = (view.getUint16(o + 8, true) / 65536) * TAU;
  out.peri = (view.getUint16(o + 10, true) / 65536) * TAU;
  out.m0 = (view.getUint16(o + 12, true) / 65536) * TAU;
  const packed = view.getUint16(o + 14, true);
  out.h = (packed >> 4) / 128 - 2;
  out.cls = packed & 15;
  return out;
}

/**
 * The perifocal frame's axes in the ecliptic, scaled: P along the perihelion times a, Q a quarter
 * turn on (in the direction of motion) times b = a sqrt(1 - e^2). Position = P (cos E - e) + Q sin E.
 */
export function perifocal(a: number, e: number, i: number, node: number, peri: number, p: number[], q: number[]): void {
  const cO = Math.cos(node);
  const sO = Math.sin(node);
  const ci = Math.cos(i);
  const si = Math.sin(i);
  const cw = Math.cos(peri);
  const sw = Math.sin(peri);
  const b = a * Math.sqrt(Math.max(0, 1 - e * e));
  p[0] = a * (cO * cw - sO * sw * ci);
  p[1] = a * (sO * cw + cO * sw * ci);
  p[2] = a * (sw * si);
  q[0] = b * (-cO * sw - sO * cw * ci);
  q[1] = b * (-sO * sw + cO * cw * ci);
  q[2] = b * (cw * si);
}

/**
 * Kepler's equation, E - e sin E = M, as the GPU solves it (./belt): Danby's starter and four of
 * Halley's third-order steps, enough for e up to 0.97 to below a millionth of a radian
 * (tests/unit/small-bodies.spec.ts). M in radians, any size.
 */
export function eccentricAnomaly(meanAnomaly: number, e: number): number {
  const m = meanAnomaly - TAU * Math.floor(meanAnomaly / TAU + 0.5);
  let E = m + 0.85 * e * Math.sign(Math.sin(m));
  for (let k = 0; k < 4; k += 1) {
    const s = e * Math.sin(E);
    const c = e * Math.cos(E);
    const f = E - s - m;
    const f1 = 1 - c;
    E -= (2 * f * f1) / (2 * f1 * f1 - f * s);
  }
  return E;
}

/** Newton to convergence, for the named worlds (and any e below 1). */
export function solveKeplerExact(meanAnomaly: number, e: number): number {
  const m = meanAnomaly - TAU * Math.floor(meanAnomaly / TAU + 0.5);
  let E = e < 0.8 ? m : Math.sign(m) * Math.PI;
  for (let k = 0; k < 50; k += 1) {
    const d = (E - e * Math.sin(E) - m) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-14) break;
  }
  return E;
}

/** Heliocentric ecliptic J2000 position (au) of a decoded asteroid `days` after the files' epoch, the GPU's way. */
export function beltPosition(r: BeltRecord, days: number, out: number[]): number[] {
  const p = [0, 0, 0];
  const q = [0, 0, 0];
  perifocal(r.a, r.e, r.i, r.node, r.peri, p, q);
  const n = GAUSS_K / r.a ** 1.5;
  const E = eccentricAnomaly(r.m0 + n * days, r.e);
  const x = Math.cos(E) - r.e;
  const y = Math.sin(E);
  out[0] = (p[0] ?? 0) * x + (q[0] ?? 0) * y;
  out[1] = (p[1] ?? 0) * x + (q[1] ?? 0) * y;
  out[2] = (p[2] ?? 0) * x + (q[2] ?? 0) * y;
  return out;
}

/** A named world's elements as worlds.json gives them (degrees; a or q in au, or aKm for a moon). */
export interface WorldElements {
  frame: 'ecliptic' | 'laplace' | 'equatorial';
  epochJdTdb: number;
  a?: number | null;
  q?: number | null;
  aKm?: number;
  e: number;
  i: number;
  om: number;
  w: number;
  ma?: number | null;
  tp?: number | null;
  /** Moons: the period of the mean anomaly (days), and the apsides' and nodes' precession periods (years; 0 none). */
  periodDays?: number;
  apsisYears?: number;
  nodeYears?: number;
  /** The reference plane's pole in the ICRF (right ascension, declination, degrees). */
  pole?: [number, number];
}

/** Rotates (x, y, z) about the x axis by `a` (radians), into out. */
function rotX(v: number[], a: number): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const y = v[1] ?? 0;
  const z = v[2] ?? 0;
  v[1] = c * y - s * z;
  v[2] = s * y + c * z;
}
function rotZ(v: number[], a: number): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = v[0] ?? 0;
  const y = v[1] ?? 0;
  v[0] = c * x - s * y;
  v[1] = s * x + c * y;
}

/**
 * A heliocentric world's ecliptic J2000 position (au) on a date (TDB Julian date): its orbit from the
 * elements' epoch, by its mean anomaly then (or its time of perihelion, for a comet).
 */
export function heliocentric(el: WorldElements, jd: number, out: number[]): number[] {
  const a = el.a ?? (el.q ?? 1) / (1 - el.e);
  const n = GAUSS_K / a ** 1.5;
  const m = el.ma !== null && el.ma !== undefined ? el.ma * DEG + n * (jd - el.epochJdTdb) : n * (jd - (el.tp ?? el.epochJdTdb));
  const E = solveKeplerExact(m, el.e);
  out[0] = a * (Math.cos(E) - el.e);
  out[1] = a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
  out[2] = 0;
  rotZ(out, el.w * DEG);
  rotX(out, el.i * DEG);
  rotZ(out, el.om * DEG);
  return out;
}

/**
 * A moon's position from its planet (km, ecliptic J2000) on a date: JPL's mean elements carried
 * from their epoch, the argument of periapsis advancing and the node regressing over their periods,
 * the mean anomaly at the tabulated period; then from its reference plane to the ICRF equator (the
 * plane's ascending node on the equator lies at the pole's right ascension plus 90 degrees, its
 * inclination 90 degrees less the pole's declination) and to the ecliptic.
 */
export function moonOffset(el: WorldElements, jd: number, obliquity: number, out: number[]): number[] {
  const dt = jd - el.epochJdTdb;
  const apsis = el.apsisYears ? (360 * dt) / (el.apsisYears * DAYS_PER_YEAR) : 0;
  const node = el.nodeYears ? (360 * dt) / (el.nodeYears * DAYS_PER_YEAR) : 0;
  const m = ((el.ma ?? 0) + (360 * dt) / (el.periodDays ?? 1)) * DEG;
  const e = el.e;
  const E = solveKeplerExact(m, e);
  const a = el.aKm ?? 0;
  out[0] = a * (Math.cos(E) - e);
  out[1] = a * Math.sqrt(1 - e * e) * Math.sin(E);
  out[2] = 0;
  rotZ(out, (el.w + apsis) * DEG);
  rotX(out, el.i * DEG);
  rotZ(out, (el.om - node) * DEG);
  const [ra, dec] = el.pole ?? [270, 90 - obliquity / DEG];
  rotX(out, (90 - dec) * DEG);
  rotZ(out, (ra + 90) * DEG);
  rotX(out, -obliquity);
  return out;
}

/**
 * The H, G system (Bowell et al. 1989): a body's V magnitude at `r` au from the Sun and `delta` au
 * from the observer, at phase angle `alpha` (radians), from its absolute magnitude H and slope G.
 */
export function hgMagnitude(h: number, g: number, r: number, delta: number, alpha: number): number {
  const t = Math.tan(Math.min(alpha, Math.PI - 1e-6) / 2);
  const phi1 = Math.exp(-3.33 * t ** 0.63);
  const phi2 = Math.exp(-1.87 * t ** 1.22);
  return h + 5 * Math.log10(r * delta) - 2.5 * Math.log10(Math.max(1e-12, (1 - g) * phi1 + g * phi2));
}

/** A comet's total visual magnitude, nucleus and coma: M1 + 5 log10(delta) + K1 log10(r). */
export const cometMagnitude = (m1: number, k1: number, r: number, delta: number): number => m1 + 5 * Math.log10(delta) + k1 * Math.log10(r);

/** A body's diameter (km) from its absolute magnitude and geometric albedo: 1329 km / sqrt(p) x 10^(-H/5). */
export const diameterFromH = (h: number, albedo: number): number => (1329 / Math.sqrt(albedo)) * 10 ** (-h / 5);
