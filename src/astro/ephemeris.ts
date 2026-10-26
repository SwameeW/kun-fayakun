/**
 * Where the planets, the Earth and the Moon are on a given date, from NASA JPL data
 * (public/assets/jpl, built by scripts/jpl/build.py). Pure: no three.js and no DOM, so the same
 * code runs in the browser, in workers and in the unit tests.
 *
 * Frame: the ecliptic and mean equinox of J2000 (x toward the vernal equinox, z toward ecliptic
 * north), the frame of both JPL files. Time: Julian dates in TDB (./time converts from UTC).
 *
 * Planets: the Keplerian elements and rates of Standish and Williams' Table 1, solved with
 * Kepler's equation. The fit holds for 1800 to 2050 AD. The Earth row of that table is the
 * Earth-Moon barycentre (EMB), not the Earth.
 * Moon: Horizons' geocentric positions, one row a day, interpolated with cubic Hermite
 * polynomials whose tangents come from five-point differences of the table.
 *
 * Beyond the tables: once the published theories are installed (installTheories, ./analytic: its own
 * lazy chunk), the Moon outside its table comes from Meeus's truncated ELP-2000/82 and the planets
 * outside 1800 to 2050 from Standish's Table 2, each blended into its table over the table's last
 * stretch (no jump at the seam), and validRange reports the theories' span. Until then (and for code
 * that never installs them) dates outside are held at the tables' edges.
 */

/** Anything with writable x, y and z, such as a three.js Vector3. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Elements {
  a: number;
  e: number;
  I: number;
  L: number;
  varpi: number;
  Omega: number;
}

export interface PlanetBody {
  name: string;
  elements: Elements;
  ratesPerCentury: Elements;
  meanRadiusKm: number;
  /** The planet's row of JPL's "Planetary Physical Parameters", as the table gives it. */
  physical: PlanetPhysical;
}

/** Units: km; 10^24 kg; g cm^-3; sidereal days (negative: retrograde); Julian years; mag; m s^-2; km s^-1. */
export interface PlanetPhysical {
  equatorialRadiusKm: number;
  massE24Kg: number;
  densityGcm3: number;
  rotationDays: number;
  orbitYears: number;
  absoluteMagnitude: number;
  geometricAlbedo: number;
  equatorialGravityMs2: number;
  escapeVelocityKmS: number;
}

/** public/assets/jpl/planets.json (the fields used here). */
export interface PlanetsFile {
  epochJd: number;
  bodies: PlanetBody[];
}

/** public/assets/jpl/moon.json (the fields used here). */
export interface MoonFile {
  startJdTdb: number;
  stepDays: number;
  count: number;
  positionsKm: Array<[number, number, number]>;
}

/** The two constants of public/assets/jpl/physical.json that positions need. */
export interface EphemerisConstants {
  /** Kilometres per astronomical unit (DE440 header). */
  auKm: number;
  /** Earth/Moon mass ratio (DE440 header). */
  emrat: number;
}

export interface JdRange {
  startJd: number;
  endJd: number;
}

export const J2000 = 2451545.0;
export const DAYS_PER_CENTURY = 36525;
const DEG = Math.PI / 180;
/** Table 1's fit interval, in Julian centuries from J2000: 1800 to 2050 AD. */
const PLANET_T_MIN = -2;
const PLANET_T_MAX = 0.5;

/** The published theories beyond the tables (./analytic, which hands each table over to its theory at its ends). */
export interface Theories {
  range: JdRange;
  /** The geocentric Moon (km); `table` gives the table's own (clamped to its rows). */
  moon(moon: MoonFile, jd: number, out: Vec3, table: (moon: MoonFile, jd: number, out: Vec3) => Vec3): Vec3;
  /** A planet's elements: `out` holds Table 1's (T held to its fit interval), made the long-span ones beyond it. */
  elements(body: PlanetBody, jd: number, out: Elements): Elements;
}
let theories: Theories | null = null;

/** Installs the published theories for every ephemeris (the explorer's, the laboratory's seeds, the qibla and new moon's). */
export function installTheories(t: Theories | null): void {
  theories = t;
}

export function solveKepler(meanAnomaly: number, e: number): number {
  let E = meanAnomaly + e * Math.sin(meanAnomaly);
  for (let i = 0; i < 8; i += 1) E -= (E - e * Math.sin(E) - meanAnomaly) / (1 - e * Math.cos(E));
  return E;
}

/** Table 1's fit interval as dates (TDB Julian dates). */
export const PLANET_TABLE: JdRange = { startJd: J2000 + PLANET_T_MIN * DAYS_PER_CENTURY, endJd: J2000 + PLANET_T_MAX * DAYS_PER_CENTURY };

/** The tables' own spans: Table 1's fit and the Moon's rows. */
export function tableRange(moon: MoonFile): { planets: JdRange; moon: JdRange } {
  return {
    planets: PLANET_TABLE,
    moon: { startJd: moon.startJdTdb, endJd: moon.startJdTdb + (moon.count - 1) * moon.stepDays },
  };
}

/** The dates positions are good for: the tables', or the theories' once installed. Outside them positions are held at the nearest edge. */
export function validRange(moon: MoonFile): { planets: JdRange; moon: JdRange } {
  return theories ? { planets: theories.range, moon: theories.range } : tableRange(moon);
}


/**
 * The body's elements on the date (a in au, angles in degrees): Table 1's, with T clamped to its fit
 * interval (its linear rates do not hold outside it); beyond it, once installed, the long-span ones.
 */
export function elementsAt(body: PlanetBody, jd: number, out: Elements = { a: 0, e: 0, I: 0, L: 0, varpi: 0, Omega: 0 }): Elements {
  const T = Math.min(PLANET_T_MAX, Math.max(PLANET_T_MIN, (jd - J2000) / DAYS_PER_CENTURY));
  const el = body.elements;
  const rate = body.ratesPerCentury;
  out.a = el.a + rate.a * T;
  out.e = el.e + rate.e * T;
  out.I = el.I + rate.I * T;
  out.L = el.L + rate.L * T;
  out.varpi = el.varpi + rate.varpi * T;
  out.Omega = el.Omega + rate.Omega * T;
  return theories ? theories.elements(body, jd, out) : out;
}

/** Heliocentric position for a set of elements, in the elements' unit (au), ecliptic J2000. */
export function positionFromElements(el: Elements, out: Vec3): Vec3 {
  // The operation order matches the Chapter 7 code this was extracted from, so its output stays
  // bit for bit the same (tests/unit/ephemeris.spec.ts).
  const I = el.I * DEG;
  const Omega = el.Omega * DEG;
  const omega = el.varpi * DEG - Omega;
  let M = (el.L - el.varpi) % 360;
  if (M > 180) M -= 360;
  if (M < -180) M += 360;
  const E = solveKepler(M * DEG, el.e);
  const xp = el.a * (Math.cos(E) - el.e);
  const yp = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
  const cw = Math.cos(omega);
  const sw = Math.sin(omega);
  const cO = Math.cos(Omega);
  const sO = Math.sin(Omega);
  const cI = Math.cos(I);
  const sI = Math.sin(I);
  out.x = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
  out.y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
  out.z = sw * sI * xp + cw * sI * yp;
  return out;
}

/**
 * The Moon by linear interpolation between daily rows, clamped to the table. Kept for Chapter 7,
 * which only uses the Moon's direction. At true scale it sags inward by up to about 3,000 km
 * between rows, so new code uses moonHermiteKm.
 */
export function moonLinearKm(moon: MoonFile, jd: number, out: Vec3): Vec3 {
  const f = (jd - moon.startJdTdb) / moon.stepDays;
  const i = Math.floor(f);
  const a = moon.positionsKm[Math.min(moon.count - 1, Math.max(0, i))];
  const b = moon.positionsKm[Math.min(moon.count - 1, Math.max(0, i + 1))];
  if (!a || !b) {
    out.x = 384_400;
    out.y = 0;
    out.z = 0;
    return out;
  }
  const t = Math.min(1, Math.max(0, f - i));
  out.x = a[0] + (b[0] - a[0]) * t;
  out.y = a[1] + (b[1] - a[1]) * t;
  out.z = a[2] + (b[2] - a[2]) * t;
  return out;
}

/**
 * Five-point first-derivative weights (times 12) at each node of a five-row window. The middle
 * row uses the central difference, and rows near the table's ends use one-sided windows. All of
 * them are fourth order, so the tangents are good to a few metres a day and the Hermite curve
 * stays within a few km of Horizons between rows (instead of 2,500 km for linear).
 */
const STENCILS: readonly (readonly number[])[] = [
  [-25, 48, -36, 16, -3],
  [-3, -10, 18, -6, 1],
  [1, -8, 0, 8, -1],
  [-1, 6, -18, 10, 3],
  [3, -16, 36, -48, 25],
];

/** d(position)/d(row) at row k, axis 0..2. */
function moonTangent(rows: MoonFile['positionsKm'], count: number, k: number, axis: 0 | 1 | 2): number {
  const start = Math.min(count - 5, Math.max(0, k - 2));
  const weights = STENCILS[k - start] ?? STENCILS[2] ?? [];
  let sum = 0;
  for (let j = 0; j < 5; j += 1) sum += (weights[j] ?? 0) * (rows[start + j]?.[axis] ?? 0);
  return sum / 12;
}

/** The geocentric Moon in km: from the table, or (installed) beyond it from its theory. */
export function moonHermiteKm(moon: MoonFile, jd: number, out: Vec3): Vec3 {
  return theories ? theories.moon(moon, jd, out, moonTableKm) : moonTableKm(moon, jd, out);
}

/** The geocentric Moon in km by cubic Hermite interpolation, clamped to the table's first and last rows. */
function moonTableKm(moon: MoonFile, jd: number, out: Vec3): Vec3 {
  const rows = moon.positionsKm;
  const count = Math.min(moon.count, rows.length);
  if (count < 5) return moonLinearKm(moon, jd, out);
  const f = (jd - moon.startJdTdb) / moon.stepDays;
  const last = count - 1;
  if (!(f > 0) || f >= last) {
    const row = rows[f >= last ? last : 0] ?? [0, 0, 0];
    out.x = row[0];
    out.y = row[1];
    out.z = row[2];
    return out;
  }
  const i = Math.floor(f);
  const s = f - i;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const p0 = rows[i] ?? [0, 0, 0];
  const p1 = rows[i + 1] ?? p0;
  const value = (axis: 0 | 1 | 2): number =>
    h00 * p0[axis] + h10 * moonTangent(rows, count, i, axis) + h01 * p1[axis] + h11 * moonTangent(rows, count, i + 1, axis);
  out.x = value(0);
  out.y = value(1);
  out.z = value(2);
  return out;
}

export interface Ephemeris {
  readonly bodies: readonly PlanetBody[];
  /** Index of the Earth row in bodies: the Earth-Moon barycentre. */
  readonly embIndex: number;
  readonly constants: EphemerisConstants;
  /** The dates the data covers; positions outside them are held at the edge. */
  validRange(): { planets: JdRange; moon: JdRange };
  elementsAt(index: number, jd: number, out?: Elements): Elements;
  /** Heliocentric position in au. For embIndex this is the barycentre, not the Earth. */
  planetAu<T extends Vec3>(index: number, jd: number, out: T): T;
  /** Heliocentric position in km. */
  planetKm<T extends Vec3>(index: number, jd: number, out: T): T;
  /** The Moon relative to the Earth's centre, in km (Hermite). */
  moonKm<T extends Vec3>(jd: number, out: T): T;
  /** The Earth's centre, heliocentric, in km: EMB - moonGeo / (1 + EMRAT). */
  earthKm<T extends Vec3>(jd: number, out: T): T;
  /** The Moon, heliocentric, in km. */
  moonHelioKm<T extends Vec3>(jd: number, out: T): T;
}

export function createEphemeris(planets: PlanetsFile, moon: MoonFile, constants: EphemerisConstants): Ephemeris {
  const embIndex = planets.bodies.findIndex((b) => b.name === 'Earth');
  if (embIndex < 0) throw new Error('planets.json has no Earth (Earth-Moon barycentre) row');
  const scratch: Elements = { a: 0, e: 0, I: 0, L: 0, varpi: 0, Omega: 0 };
  const moonScratch: Vec3 = { x: 0, y: 0, z: 0 };
  const moonShare = 1 / (1 + constants.emrat);

  const planetAu = <T extends Vec3>(index: number, jd: number, out: T): T => {
    const body = planets.bodies[index];
    if (!body) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      return out;
    }
    positionFromElements(elementsAt(body, jd, scratch), out);
    return out;
  };
  const planetKm = <T extends Vec3>(index: number, jd: number, out: T): T => {
    planetAu(index, jd, out);
    out.x *= constants.auKm;
    out.y *= constants.auKm;
    out.z *= constants.auKm;
    return out;
  };
  const moonKm = <T extends Vec3>(jd: number, out: T): T => {
    moonHermiteKm(moon, jd, out);
    return out;
  };
  // The barycentre sits on the Earth-Moon line, 1/(1 + EMRAT) of the way from the Earth.
  const earthKm = <T extends Vec3>(jd: number, out: T): T => {
    planetKm(embIndex, jd, out);
    moonHermiteKm(moon, jd, moonScratch);
    out.x -= moonScratch.x * moonShare;
    out.y -= moonScratch.y * moonShare;
    out.z -= moonScratch.z * moonShare;
    return out;
  };

  return {
    bodies: planets.bodies,
    embIndex,
    constants,
    validRange: () => validRange(moon),
    elementsAt(index, jd, out) {
      const body = planets.bodies[index];
      if (!body) throw new RangeError(`no planet at index ${index}`);
      return elementsAt(body, jd, out);
    },
    planetAu,
    planetKm,
    moonKm,
    earthKm,
    moonHelioKm(jd, out) {
      earthKm(jd, out);
      moonHermiteKm(moon, jd, moonScratch);
      out.x += moonScratch.x;
      out.y += moonScratch.y;
      out.z += moonScratch.z;
      return out;
    },
  };
}
