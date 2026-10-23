import { Vector3 } from 'three/webgpu';
import {
  elementsAt,
  moonLinearKm,
  positionFromElements,
  type Elements,
  type MoonFile,
  type PlanetBody,
  type PlanetsFile,
  type Vec3,
} from '../../astro/ephemeris';
import { julianDateUtc } from '../../astro/time';
import type { ChapterContext } from '../../core/types';

/**
 * Where the planets and the Moon are on a given date, from NASA JPL data
 * (public/assets/jpl, built by scripts/jpl/build.py), in this chapter's scene axes.
 *
 * A thin wrapper over src/astro/ephemeris that keeps Chapter 7's numbers bit for bit as they were
 * (tests/unit/ephemeris.spec.ts). The planets are held at the edges of Table 1's 1800 to 2050 fit,
 * the Earth is the Earth-Moon barycentre, and the Moon is interpolated linearly. The chapter
 * shows only the Moon's direction, so the linear sag between daily rows does not show. Outside
 * the Moon table, its phase falls back to the mean synodic month.
 *
 * Scene axes: x = ecliptic x (toward the vernal equinox), y = ecliptic north, z = -ecliptic y.
 */

export type { Elements };
export type Body = PlanetBody;

export interface Ephemeris {
  readonly bodies: readonly Body[];
  /** Heliocentric position in au (scene axes). */
  planetAu(index: number, jd: number, out: Vector3): Vector3;
  /** Geocentric Moon position in km (scene axes). */
  moonKm(jd: number, out: Vector3): Vector3;
  /** Elongation of the Moon from the Sun seen from the Earth (radians, 0 = new), signed: positive waxing. */
  moonElongation(jd: number): number;
}

/** Mean synodic month, days (for dates outside the Horizons table). */
const SYNODIC_MONTH = 29.530589;

/** The visitor's clock as a Julian date. It is UTC, which the chapter takes as TDB (69 s apart, which does not show here). */
export const julianDateNow = (): number => julianDateUtc(Date.now());

/** The chapter's ephemeris from the two JPL files (separate from loading so tests can build it from disk). */
export function chapterEphemeris(planets: PlanetsFile, moon: MoonFile): Ephemeris {
  const earthIndex = planets.bodies.findIndex((b) => b.name === 'Earth');
  const sun = new Vector3();
  const moonScratch = new Vector3();
  const elements: Elements = { a: 0, e: 0, I: 0, L: 0, varpi: 0, Omega: 0 };
  const ecliptic: Vec3 = { x: 0, y: 0, z: 0 };
  // Ecliptic to scene axes.
  const toScene = (out: Vector3): Vector3 => out.set(ecliptic.x, ecliptic.z, -ecliptic.y);

  const planetAu = (index: number, jd: number, out: Vector3): Vector3 => {
    const body = planets.bodies[index];
    if (!body) return out.set(0, 0, 0);
    positionFromElements(elementsAt(body, jd, elements), ecliptic);
    return toScene(out);
  };

  const moonKm = (jd: number, out: Vector3): Vector3 => {
    moonLinearKm(moon, jd, ecliptic);
    return toScene(out);
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

export async function loadEphemeris(ctx: ChapterContext): Promise<Ephemeris> {
  const [planets, moon] = await Promise.all([
    ctx.assets.json<PlanetsFile>('assets/jpl/planets.json'),
    ctx.assets.json<MoonFile>('assets/jpl/moon.json'),
  ]);
  return chapterEphemeris(planets, moon);
}

/** Compressed distance for display: the square root of the distance in au, so every orbit fits (not to scale). */
export const DISTANCE_SCALE = 1.25;
export function compress(au: Vector3, out: Vector3): Vector3 {
  const r = au.length();
  return r > 0 ? out.copy(au).multiplyScalar((DISTANCE_SCALE * Math.sqrt(r)) / r) : out.set(0, 0, 0);
}
