// A frozen copy of src/chapters/ch07/ephemeris.ts as it was before src/astro was extracted
// (commit e0be273). The only change is this import path. tests/unit/ephemeris.spec.ts checks
// that today's wrapper gives the same numbers, bit for bit. Do not edit the code below.
import { Vector3 } from 'three/webgpu';
import type { ChapterContext } from '../../../src/core/types';

/**
 * Where the planets and the Moon are on a given date, from NASA JPL data
 * (public/assets/jpl, built by scripts/jpl/build.py).
 *
 * Planets: Keplerian elements and their rates (Standish and Williams, Table 1, valid 1800 to
 * 2050 AD), solved for the date with Kepler's equation, in the ecliptic of J2000. Moon: its
 * geocentric position from Horizons, one row a day for 2026 to 2035, interpolated; outside
 * that range its phase falls back to the mean synodic month.
 *
 * Scene axes: x = ecliptic x (toward the vernal equinox), y = ecliptic north, z = -ecliptic y.
 */

export interface Elements {
  a: number;
  e: number;
  I: number;
  L: number;
  varpi: number;
  Omega: number;
}

export interface Body {
  name: string;
  elements: Elements;
  ratesPerCentury: Elements;
  meanRadiusKm: number;
}

interface PlanetsFile {
  epochJd: number;
  bodies: Body[];
}

interface MoonFile {
  startJdTdb: number;
  stepDays: number;
  count: number;
  positionsKm: Array<[number, number, number]>;
}

export interface Ephemeris {
  readonly bodies: readonly Body[];
  /** Heliocentric position in au (scene axes). */
  planetAu(index: number, jd: number, out: Vector3): Vector3;
  /** Geocentric Moon position in km (scene axes). */
  moonKm(jd: number, out: Vector3): Vector3;
  /** Elongation of the Moon from the Sun seen from the Earth (radians, 0 = new), signed: positive waxing. */
  moonElongation(jd: number): number;
}

const DEG = Math.PI / 180;
const J2000 = 2451545.0;
/** Mean synodic month, days (for dates outside the Horizons table). */
const SYNODIC_MONTH = 29.530589;
/** Unix epoch as a Julian date. */
const UNIX_EPOCH_JD = 2440587.5;

export const julianDateNow = (): number => Date.now() / 86_400_000 + UNIX_EPOCH_JD;

function solveKepler(meanAnomaly: number, e: number): number {
  let E = meanAnomaly + e * Math.sin(meanAnomaly);
  for (let i = 0; i < 8; i += 1) E -= (E - e * Math.sin(E) - meanAnomaly) / (1 - e * Math.cos(E));
  return E;
}

export async function loadEphemeris(ctx: ChapterContext): Promise<Ephemeris> {
  const [planets, moon] = await Promise.all([
    ctx.assets.json<PlanetsFile>('assets/jpl/planets.json'),
    ctx.assets.json<MoonFile>('assets/jpl/moon.json'),
  ]);
  const earthIndex = planets.bodies.findIndex((b) => b.name === 'Earth');
  const sun = new Vector3();
  const moonScratch = new Vector3();

  const planetAu = (index: number, jd: number, out: Vector3): Vector3 => {
    const body = planets.bodies[index];
    if (!body) return out.set(0, 0, 0);
    // Table 1 is valid for 1800 to 2050 AD; dates beyond are held at its edge.
    const T = Math.min(0.5, Math.max(-2, (jd - J2000) / 36525));
    const el = body.elements;
    const rate = body.ratesPerCentury;
    const a = el.a + rate.a * T;
    const e = el.e + rate.e * T;
    const I = (el.I + rate.I * T) * DEG;
    const L = el.L + rate.L * T;
    const varpi = el.varpi + rate.varpi * T;
    const Omega = (el.Omega + rate.Omega * T) * DEG;
    const omega = varpi * DEG - Omega;
    let M = (L - varpi) % 360;
    if (M > 180) M -= 360;
    if (M < -180) M += 360;
    const E = solveKepler(M * DEG, e);
    const xp = a * (Math.cos(E) - e);
    const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const cw = Math.cos(omega);
    const sw = Math.sin(omega);
    const cO = Math.cos(Omega);
    const sO = Math.sin(Omega);
    const cI = Math.cos(I);
    const sI = Math.sin(I);
    const x = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
    const y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
    const z = sw * sI * xp + cw * sI * yp;
    return out.set(x, z, -y);
  };

  const moonKm = (jd: number, out: Vector3): Vector3 => {
    const f = (jd - moon.startJdTdb) / moon.stepDays;
    const i = Math.floor(f);
    const a = moon.positionsKm[Math.min(moon.count - 1, Math.max(0, i))];
    const b = moon.positionsKm[Math.min(moon.count - 1, Math.max(0, i + 1))];
    if (!a || !b) return out.set(384_400, 0, 0);
    const t = Math.min(1, Math.max(0, f - i));
    // Ecliptic km to scene axes.
    return out.set(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t, -(a[1] + (b[1] - a[1]) * t));
  };

  const inTable = (jd: number): boolean => jd >= moon.startJdTdb && jd <= moon.startJdTdb + (moon.count - 1) * moon.stepDays;
  const firstNew = (() => {
    // A reference new moon from the table, for the fallback outside it.
    let best = { jd: moon.startJdTdb, e: Infinity };
    for (let d = 0; d < 30; d += 0.25) {
      const jd = moon.startJdTdb + d;
      planetAu(earthIndex, jd, sun).negate();
      moonKm(jd, moonScratch);
      const e = sun.angleTo(moonScratch);
      if (e < best.e) best = { jd, e };
    }
    return best.jd;
  })();

  return {
    bodies: planets.bodies,
    planetAu,
    moonKm,
    moonElongation(jd) {
      if (!inTable(jd)) {
        const phase = ((((jd - firstNew) / SYNODIC_MONTH) % 1) + 1) % 1;
        return phase <= 0.5 ? phase * 2 * Math.PI : (phase - 1) * 2 * Math.PI;
      }
      planetAu(earthIndex, jd, sun).negate(); // Earth to Sun
      moonKm(jd, moonScratch);
      const angle = sun.angleTo(moonScratch);
      // Waxing when the Moon is east of the Sun: counter-clockwise seen from ecliptic north (+y).
      const cross = sun.x * moonScratch.z - sun.z * moonScratch.x;
      return cross < 0 ? angle : -angle;
    },
  };
}

/** Compressed distance for display: the square root of the distance in au, so every orbit fits (not to scale). */
export const DISTANCE_SCALE = 1.25;
export function compress(au: Vector3, out: Vector3): Vector3 {
  const r = au.length();
  return r > 0 ? out.copy(au).multiplyScalar((DISTANCE_SCALE * Math.sqrt(r)) / r) : out.set(0, 0, 0);
}
