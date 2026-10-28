import { createEphemeris, type Ephemeris, type MoonFile, type PlanetsFile } from '../../astro/ephemeris';
import { obliquityRad, PHYSICAL_URL, type PhysicalFile } from '../../astro/physical';
import { julianDateUtc, utcToTdb } from '../../astro/time';
import type { App, BodyId } from '../../core/types';
import type { SkyFrame } from '../../explore/islamic/astronomy';

/**
 * The explorer's own data for the calculators, loaded through the app's asset loader once per app
 * (public/assets/jpl: DE440's GM, NAIF's radii and rotation, JPL's planetary elements and physical
 * parameters, the Horizons Moon table, NAIF's time constants), so every number a tool gives comes
 * from the same files the explorer draws from.
 */

export interface JplData {
  physical: PhysicalFile;
  planets: PlanetsFile;
  moon: MoonFile;
  ephemeris: Ephemeris;
  sky: SkyFrame;
  /** One G for kilograms, as the laboratory uses it: the Earth's GM over JPL's mass of the Earth (km^3 s^-2 per kg). */
  gPerKg: number;
}

/** physical.json's names for the ten worlds. */
export const PHYSICAL_KEY: Readonly<Record<BodyId, keyof PhysicalFile['bodies']>> = {
  sun: 'Sun',
  mercury: 'Mercury',
  venus: 'Venus',
  earth: 'Earth',
  moon: 'Moon',
  mars: 'Mars',
  jupiter: 'Jupiter',
  saturn: 'Saturn',
  uranus: 'Uranus',
  neptune: 'Neptune',
};

/** Where each number about a world comes from (data/sources.json ids). */
export const GM_SOURCE = 'jpl-de440';
export const RADIUS_SOURCE = 'naif-pck00011';
export const ELEMENTS_SOURCE = 'jpl-approx-pos';

export function buildJplData(physical: PhysicalFile, planets: PlanetsFile, moon: MoonFile): JplData {
  const ephemeris = createEphemeris(planets, moon, physical);
  const earthMassKg = (planets.bodies.find((b) => b.name === 'Earth')?.physical.massE24Kg ?? Number.NaN) * 1e24;
  return { physical, planets, moon, ephemeris, sky: { ephemeris, time: physical.time, obliquityRad: obliquityRad(physical) }, gPerKg: physical.gmKm3S2.Earth / earthMassKg };
}

const cache = new WeakMap<App, Promise<JplData>>();

/** The data, fetched once per app (a failed fetch is tried again next time). */
export function jplData(app: App): Promise<JplData> {
  let p = cache.get(app);
  if (!p) {
    p = Promise.all([app.assets.json<PhysicalFile>(PHYSICAL_URL), app.assets.json<PlanetsFile>('assets/jpl/planets.json'), app.assets.json<MoonFile>('assets/jpl/moon.json')]).then(([physical, planets, moon]) => buildJplData(physical, planets, moon));
    p.catch(() => cache.delete(app));
    cache.set(app, p);
  }
  return p;
}

/**
 * The span (UTC Unix ms) a calculation can use, kept `marginDays` inside the data: the Moon's table
 * (2026 to 2035) for anything with the Moon, JPL's planetary elements (1800 to 2050) for the Sun.
 * Outside it the ephemeris holds positions at its edge, which would give wrong answers silently.
 */
export function dataSpanMs(data: JplData, which: 'moon' | 'planets', marginDays = 0): { startMs: number; endMs: number } {
  const r = data.ephemeris.validRange()[which];
  const ms = (jd: number): number => (jd - 2440587.5) * 86_400_000;
  return { startMs: ms(r.startJd + marginDays), endMs: ms(r.endJd - marginDays) };
}

/** A world's GM (km^3 s^-2, DE440; Mars to Neptune with their moons) and mean radius (km, NAIF). */
export function bodyGm(data: JplData, id: BodyId): number {
  return data.physical.gmKm3S2[PHYSICAL_KEY[id]];
}

export function meanRadiusKm(data: JplData, id: BodyId): number {
  const r = data.physical.bodies[PHYSICAL_KEY[id]].radiiKm;
  return (r[0] + r[1] + r[2]) / 3;
}

/** A planet's mean semi-major axis about the Sun (km) from JPL's approximate elements at J2000; null for the Sun and the Moon. */
export function planetSemiMajorKm(data: JplData, id: BodyId): number | null {
  if (id === 'sun' || id === 'moon') return null;
  const body = data.planets.bodies.find((b) => b.name.toLowerCase() === id);
  return body ? body.elements.a * data.physical.auKm : null;
}

/** The TDB Julian date of the explorer's date if it is on screen, else of now. */
export function dateJdTdb(app: App, data: JplData, nowMs: number): number {
  const v = app.universe();
  return v ? v.jdTdb : utcToTdb(julianDateUtc(nowMs), data.physical.time);
}

/** Heliocentric ecliptic position of a world (km) at a TDB Julian date. */
export function heliocentricKm(data: JplData, id: BodyId, jdTdb: number): { x: number; y: number; z: number } {
  const out = { x: 0, y: 0, z: 0 };
  if (id === 'sun') return out;
  if (id === 'earth') return data.ephemeris.earthKm(jdTdb, out);
  if (id === 'moon') return data.ephemeris.moonHelioKm(jdTdb, out);
  const index = data.ephemeris.bodies.findIndex((b) => b.name.toLowerCase() === id);
  return data.ephemeris.planetKm(index, jdTdb, out);
}
