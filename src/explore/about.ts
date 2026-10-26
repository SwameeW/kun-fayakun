import type { PlanetBody, PlanetsFile } from '../astro/ephemeris';
import type { PhysicalFile } from '../astro/physical';
import { orientationAt, type RotationModel } from '../astro/rotation';
import type { BodyId } from '../core/types';

/**
 * The explorer's object information for each world (SpaceEngine's wiki), from cited data only.
 *
 * The planets: their row of JPL's "Planetary Physical Parameters" as the table gives it (mean and
 * equatorial radius, mass, bulk density, sidereal rotation and orbital periods, equatorial gravity,
 * escape velocity), and their orbit from Standish and Williams's elements (planets.json).
 *
 * The Sun and the Moon, which that table does not list, from DE440's GM and NAIF's radii
 * (physical.json): mass in units of the Earth's (their GM over the Earth's, so G is never needed)
 * and so in kilograms by the table's mass of the Earth; surface gravity GM / R^2; escape speed
 * sqrt(2 GM / R); bulk density mass over volume. The Sun's rotation is NAIF's (its equator, Carrington's
 * rate), the Moon's too, and the Moon's sunrise-to-sunrise day follows from it and the Earth's year.
 *
 * Axial tilts, at J2000: the angle between the spin axis (NAIF's pole with its periodic terms;
 * for a world that turns backwards, the other pole) and the orbit's pole (the elements; for the
 * Sun and the Moon, the ecliptic's). The Earth's is the obliquity Horizons uses.
 */

export type WorldKind = 'star' | 'planet' | 'moon';

export interface WorldFacts {
  id: BodyId;
  kind: WorldKind;
  meanRadiusKm: number;
  equatorialRadiusKm: number;
  massKg: number;
  /** Mass in units of the Earth's. */
  massEarths: number;
  densityGcm3: number;
  /** Gravity, m s^-2, at the equator (the planets, as JPL gives it) or at the surface (GM / R^2), and in units of the Earth's. */
  gravityMs2: number;
  gravityAt: 'equator' | 'surface';
  gravityEarths: number;
  escapeKmS: number;
  /** Sidereal rotation, days (negative: retrograde), and sunrise to sunrise, days (null for the Sun). */
  rotationDays: number;
  solarDayDays: number | null;
  /** Degrees between the axis and the orbit's pole (the ecliptic's for the Sun); null where not given. */
  tiltDeg: number | null;
  /** Around the Sun (planets) or the Earth (the Moon, which keeps one face to it); null for the Sun. */
  orbit: { around: 'sun' | 'earth'; periodDays: number; semiMajorKm: number | null; eccentricity: number | null; inclinationDeg: number | null } | null;
  /** data/sources.json ids the numbers come from. */
  sources: readonly string[];
}

const PLANET_NAMES: Partial<Record<BodyId, string>> = {
  mercury: 'Mercury', venus: 'Venus', earth: 'Earth', mars: 'Mars', jupiter: 'Jupiter', saturn: 'Saturn', uranus: 'Uranus', neptune: 'Neptune',
};
const JULIAN_YEAR_DAYS = 365.25;
const DEG = Math.PI / 180;
/** 1 kg km^-3 is 10^-12 g cm^-3. */
const KG_KM3_TO_G_CM3 = 1e-12;

const meanOf = (r: readonly number[]): number => r.reduce((a, b) => a + b, 0) / Math.max(1, r.length);
const sidereal = (degPerDay: number): number => 360 / degPerDay;
/** Sunrise to sunrise from the sidereal rotation and the year (both days; a negative rotation is retrograde). */
export const solarDay = (rotationDays: number, yearDays: number): number => Math.abs(1 / (1 / rotationDays - 1 / yearDays));

const J2000_JD = 2_451_545.0;

/**
 * The angle (degrees) between a world's spin axis and an orbit's pole (ecliptic inclination and
 * node, degrees): NAIF's pole at J2000, turned over for a world whose rotation is retrograde.
 */
export function axialTilt(model: RotationModel, inclination: number, node: number, obliquityRad: number): number {
  const o0 = orientationAt(model, J2000_JD);
  const angle = tiltBetween(o0.ra, o0.dec, inclination, node, obliquityRad);
  return model.pm[1] < 0 ? 180 - angle : angle;
}

/** The angle (degrees) between a pole (right ascension and declination, radians, ICRF) and an orbit's pole (ecliptic inclination and node, degrees). */
export function tiltBetween(poleRa: number, poleDec: number, inclination: number, node: number, obliquityRad: number): number {
  const pole = [Math.cos(poleDec) * Math.cos(poleRa), Math.cos(poleDec) * Math.sin(poleRa), Math.sin(poleDec)];
  const i = inclination * DEG;
  const o = node * DEG;
  // The orbit's pole in the ecliptic, then turned into the ICRF about the x axis by the obliquity.
  const ex = Math.sin(i) * Math.sin(o);
  const ey = -Math.sin(i) * Math.cos(o);
  const ez = Math.cos(i);
  const n = [ex, ey * Math.cos(obliquityRad) - ez * Math.sin(obliquityRad), ey * Math.sin(obliquityRad) + ez * Math.cos(obliquityRad)];
  const c = (pole[0] ?? 0) * (n[0] ?? 0) + (pole[1] ?? 0) * (n[1] ?? 0) + (pole[2] ?? 0) * (n[2] ?? 1);
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

function planet(planets: PlanetsFile, name: string): PlanetBody {
  const body = planets.bodies.find((b) => b.name === name);
  if (!body) throw new Error(`planets.json has no ${name}`);
  return body;
}

export function worldFacts(id: BodyId, physical: PhysicalFile, planets: PlanetsFile): WorldFacts {
  const earth = planet(planets, 'Earth');
  const earthMassKg = earth.physical.massE24Kg * 1e24;
  const earthGravity = earth.physical.equatorialGravityMs2;
  const obliquity = (physical.obliquityJ2000Arcsec / 3600) * DEG;
  const name = PLANET_NAMES[id];
  if (name) {
    const body = planet(planets, name);
    const p = body.physical;
    const year = p.orbitYears * JULIAN_YEAR_DAYS;
    const pole = physical.bodies[name as keyof PhysicalFile['bodies']];
    return {
      id,
      kind: 'planet',
      meanRadiusKm: body.meanRadiusKm,
      equatorialRadiusKm: p.equatorialRadiusKm,
      massKg: p.massE24Kg * 1e24,
      massEarths: p.massE24Kg / earth.physical.massE24Kg,
      densityGcm3: p.densityGcm3,
      gravityMs2: p.equatorialGravityMs2,
      gravityAt: 'equator',
      gravityEarths: p.equatorialGravityMs2 / earthGravity,
      escapeKmS: p.escapeVelocityKmS,
      rotationDays: p.rotationDays,
      solarDayDays: solarDay(p.rotationDays, year),
      tiltDeg: id === 'earth' ? physical.obliquityJ2000Arcsec / 3600 : axialTilt(pole, body.elements.I, body.elements.Omega, obliquity),
      orbit: { around: 'sun', periodDays: year, semiMajorKm: body.elements.a * physical.auKm, eccentricity: body.elements.e, inclinationDeg: body.elements.I },
      sources: ['jpl-phys-par', 'jpl-approx-pos', 'naif-pck00011'],
    };
  }
  // The Sun and the Moon: from GM (DE440) and NAIF's radii and rotation.
  const key = id === 'sun' ? 'Sun' : 'Moon';
  const model = physical.bodies[key];
  const gm = physical.gmKm3S2[key];
  const radius = meanOf(model.radiiKm);
  const massEarths = gm / physical.gmKm3S2.Earth;
  const massKg = massEarths * earthMassKg;
  const gravity = (gm / radius ** 2) * 1000;
  const rotation = sidereal(model.pm[1]);
  const year = earth.physical.orbitYears * JULIAN_YEAR_DAYS;
  return {
    id,
    kind: id === 'sun' ? 'star' : 'moon',
    meanRadiusKm: radius,
    equatorialRadiusKm: model.radiiKm[0],
    massKg,
    massEarths,
    densityGcm3: (massKg / ((4 / 3) * Math.PI * radius ** 3)) * KG_KM3_TO_G_CM3,
    gravityMs2: gravity,
    gravityAt: 'surface',
    gravityEarths: gravity / earthGravity,
    escapeKmS: Math.sqrt((2 * gm) / radius),
    rotationDays: rotation,
    solarDayDays: id === 'moon' ? solarDay(rotation, year) : null,
    // The Sun's equator and the Moon's, each to the ecliptic.
    tiltDeg: axialTilt(model, 0, 0, obliquity),
    orbit: id === 'moon' ? { around: 'earth', periodDays: rotation, semiMajorKm: null, eccentricity: null, inclinationDeg: null } : null,
    sources: id === 'sun' ? ['jpl-de440', 'naif-pck00011', 'jpl-phys-par'] : ['jpl-de440', 'naif-pck00011', 'jpl-phys-par', 'jpl-horizons'],
  };
}
