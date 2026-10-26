import type { UniverseBulletin, UniverseNearPlace, UniverseSatellite } from '../../core/types';
import { nearestPlace, type Place } from './places';

/**
 * "Today on Earth", the first of the field notes: a few live facts about the planet at the
 * explorer's instant, each with a place to fly to. Where the Sun is overhead (from the ephemeris and
 * the Earth's rotation model), where dawn is breaking and where the day is ending (the largest places
 * with the Sun on their horizon, rising or setting), where the space station is and whether it is in
 * sunlight (from its orbital elements), how many satellites are in sunlight, and the day's strongest
 * earthquake (from USGS). Composed here from numbers the explorer already has; the interface words it.
 *
 * The ground is treated as a sphere and the Sun's elevation is geometric (no refraction): "on the
 * horizon" means within DAWN_BAND_DEG of it, a band wide enough that a large place is nearly always
 * in it.
 */

/** The Sun within this many degrees of the horizon counts as dawn or dusk; wider if no place is that close. */
export const DAWN_BAND_DEG = [3, 8] as const;

const DEG = Math.PI / 180;

export interface GroundPoint {
  lat: number;
  lon: number;
}

export interface BulletinInput {
  /** Where the Sun is overhead, degrees. */
  sun: GroundPoint;
  radiusKm: number;
  places: readonly Place[];
  station: UniverseSatellite | null;
  satellites: { count: number; sunlit: number } | null;
  /** The day's events, strongest first. */
  quakes: ReadonlyArray<NonNullable<NonNullable<UniverseBulletin['quakes']>['strongest']>> | null;
}

/** The Sun's elevation at a place (radians), given where it is overhead. */
export function solarElevation(place: GroundPoint, sun: GroundPoint): number {
  const h = (place.lon - sun.lon) * DEG;
  const s = Math.sin(place.lat * DEG) * Math.sin(sun.lat * DEG) + Math.cos(place.lat * DEG) * Math.cos(sun.lat * DEG) * Math.cos(h);
  return Math.asin(Math.max(-1, Math.min(1, s)));
}

/** Morning at a place: the Sun is to its east (the place lies west of the meridian under the Sun). */
const morning = (place: GroundPoint, sun: GroundPoint): boolean => Math.sin((place.lon - sun.lon) * DEG) < 0;

/** The largest place with the Sun on its horizon, rising (dawn) or setting (dusk); null if there is none. */
export function terminatorPlace(places: readonly Place[], sun: GroundPoint, rising: boolean): Place | null {
  for (const band of DAWN_BAND_DEG) {
    const limit = band * DEG;
    // Largest first (as places.json is sorted), so the first match is the one to name.
    const found = places.find((p) => Math.abs(solarElevation(p, sun)) <= limit && morning(p, sun) === rising);
    if (found) return found;
  }
  return null;
}

const near = (places: readonly Place[], at: GroundPoint, radiusKm: number): UniverseNearPlace | null => {
  const n = nearestPlace(places, at.lat, at.lon, radiusKm);
  return n ? { name: n.place.name, lat: n.place.lat, lon: n.place.lon, km: n.km } : null;
};

export function composeBulletin(input: BulletinInput): UniverseBulletin {
  const { places, radiusKm } = input;
  const dawn = terminatorPlace(places, input.sun, true);
  const dusk = terminatorPlace(places, input.sun, false);
  const strongest = input.quakes?.[0] ?? null;
  return {
    sun: { ...input.sun, near: near(places, input.sun, radiusKm) },
    dawn: dawn ? { name: dawn.name, lat: dawn.lat, lon: dawn.lon } : null,
    dusk: dusk ? { name: dusk.name, lat: dusk.lat, lon: dusk.lon } : null,
    station: input.station ? { ...input.station, near: near(places, input.station, radiusKm) } : null,
    satellites: input.satellites,
    quakes: input.quakes ? { count: input.quakes.length, strongest } : null,
  };
}

/** Latitude and longitude (degrees) of an Earth-fixed position (x Greenwich, y 90 E, z north): the point beneath it, on a sphere. */
export function subPoint(x: number, y: number, z: number): GroundPoint {
  return { lat: Math.atan2(z, Math.hypot(x, y)) / DEG, lon: Math.atan2(y, x) / DEG };
}
