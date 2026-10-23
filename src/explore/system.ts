/**
 * The bodies the explorer shows and where they are on a date: true radii, positions and spin, all
 * from NASA JPL data (public/assets/jpl, Stage 2's astro core). Pure (no three.js).
 *
 * Positions are km in the render frame (./space/origin): the Sun at the origin, the planets from
 * their elements, the Earth's centre from the Earth-Moon barycentre and the Moon (Hermite), the
 * Moon from Horizons. Orientations are the IAU rotation models: each body's pole and prime meridian
 * on the date, so the Earth's tilt, the Moon's near side toward the Earth, and Saturn's rings
 * opening toward the Sun are all as they are.
 */

import { createEphemeris, type Ephemeris, type MoonFile, type PlanetsFile } from '../astro/ephemeris';
import { obliquityRad, type PhysicalFile } from '../astro/physical';
import { bodyToEcliptic, orientationAt, type Orientation, type RotatingBody } from '../astro/rotation';
import type { BodyId } from '../core/types';
import { eclipticToRender, km, type Km } from './space/origin';

export interface BodySpec {
  readonly id: BodyId;
  /** HUD and list name (an existing ui.hud.* key). */
  readonly nameKey: string;
  /** Equatorial and polar radius, km (physical.json, IAU). */
  readonly radiusKm: number;
  readonly polarKm: number;
  /** Bounding radius for scaled space and framing, km: the rings for Saturn. */
  readonly boundKm: number;
  /** The camera never goes lower than this above the equatorial surface, km. */
  readonly minAltitudeKm: number;
  /** Default viewing distance from the centre, in bounding radii (the body fills about half the view's height). */
  readonly framing: number;
}

const ROTATING: Readonly<Record<BodyId, RotatingBody>> = {
  sun: 'Sun',
  earth: 'Earth',
  moon: 'Moon',
  jupiter: 'Jupiter',
  saturn: 'Saturn',
};

const NAME_KEYS: Readonly<Record<BodyId, string>> = {
  sun: 'ui.hud.sunName',
  earth: 'ui.hud.earth',
  moon: 'ui.hud.moon',
  jupiter: 'ui.hud.planet.jupiter',
  saturn: 'ui.hud.planet.saturn',
};

/**
 * The lowest the camera goes. The Earth: 150 km, above its drawn atmosphere (EARTH_AIR_SCALE, 127 km
 * up). The others: 2% of the radius (35 km over the Moon, about 1,400 km over the giants' cloud tops).
 */
export const EARTH_AIR_SCALE = 1.02;
const MIN_ALTITUDE_SHARE = 0.02;
const EARTH_MIN_ALTITUDE_KM = 150;

export function bodySpecs(physical: PhysicalFile): Readonly<Record<BodyId, BodySpec>> {
  const spec = (id: BodyId, framing: number, boundKm?: number): BodySpec => {
    const [a, , c] = physical.bodies[ROTATING[id]].radiiKm;
    return {
      id,
      nameKey: NAME_KEYS[id],
      radiusKm: a,
      polarKm: c,
      boundKm: boundKm ?? a,
      minAltitudeKm: id === 'earth' ? EARTH_MIN_ALTITUDE_KM : MIN_ALTITUDE_SHARE * a,
      framing,
    };
  };
  return {
    sun: spec('sun', 4.2),
    earth: spec('earth', 4),
    moon: spec('moon', 4),
    jupiter: spec('jupiter', 4),
    saturn: spec('saturn', 3.1, physical.saturnRings.outerKm),
  };
}

/** One body on the date: its centre (render frame, km) and its body-to-render rotation (3x3, column-major). */
export interface BodyState {
  readonly position: Km;
  /**
   * Columns: where the mesh's local x, y and z axes point. Local y is the north pole and local x the
   * prime meridian (three's spheres have their poles on y), so a mesh turned by this matrix stands
   * as the body does.
   */
  readonly basis: number[];
}

export interface SolarSystem {
  readonly ephemeris: Ephemeris;
  readonly specs: Readonly<Record<BodyId, BodySpec>>;
  readonly bodies: Readonly<Record<BodyId, BodyState>>;
  /** km per au (DE440). */
  readonly auKm: number;
  /** Moves every body to the date (TDB Julian date). */
  update(jdTdb: number): void;
}

export function createSolarSystem(planets: PlanetsFile, moon: MoonFile, physical: PhysicalFile): SolarSystem {
  const ephemeris = createEphemeris(planets, moon, physical);
  const specs = bodySpecs(physical);
  const obliquity = obliquityRad(physical);
  const index = (name: string): number => {
    const i = planets.bodies.findIndex((b) => b.name === name);
    if (i < 0) throw new Error(`planets.json has no ${name}`);
    return i;
  };
  const jupiter = index('Jupiter');
  const saturn = index('Saturn');
  const state = (): BodyState => ({ position: km(), basis: new Array<number>(9).fill(0) });
  const bodies: Record<BodyId, BodyState> = { sun: state(), earth: state(), moon: state(), jupiter: state(), saturn: state() };
  const ecl = km();
  const orientation: Orientation = { ra: 0, dec: 0, w: 0 };
  const toEcliptic = new Array<number>(9).fill(0);
  const axis = km();
  const turned = km();

  /** basis = W B P: W the ecliptic-to-render turn, B body-to-ecliptic, P the mesh's axes in the body frame. */
  const orient = (id: BodyId, jd: number): void => {
    bodyToEcliptic(orientationAt(physical.bodies[ROTATING[id]], jd, orientation), obliquity, toEcliptic);
    const out = bodies[id].basis;
    // Mesh x -> body x (prime meridian), mesh y -> body z (pole), mesh z -> -body y.
    const columns: ReadonlyArray<readonly [number, number]> = [
      [0, 1],
      [6, 1],
      [3, -1],
    ];
    columns.forEach(([from, sign], c) => {
      axis.x = sign * (toEcliptic[from] ?? 0);
      axis.y = sign * (toEcliptic[from + 1] ?? 0);
      axis.z = sign * (toEcliptic[from + 2] ?? 0);
      eclipticToRender(axis, turned);
      out[3 * c] = turned.x;
      out[3 * c + 1] = turned.y;
      out[3 * c + 2] = turned.z;
    });
  };

  return {
    ephemeris,
    specs,
    bodies,
    auKm: physical.auKm,
    update(jd) {
      const sun = bodies.sun.position;
      sun.x = 0;
      sun.y = 0;
      sun.z = 0;
      eclipticToRender(ephemeris.earthKm(jd, ecl), bodies.earth.position);
      eclipticToRender(ephemeris.moonHelioKm(jd, ecl), bodies.moon.position);
      eclipticToRender(ephemeris.planetKm(jupiter, jd, ecl), bodies.jupiter.position);
      eclipticToRender(ephemeris.planetKm(saturn, jd, ecl), bodies.saturn.position);
      for (const id of ['sun', 'earth', 'moon', 'jupiter', 'saturn'] as const) orient(id, jd);
    },
  };
}
