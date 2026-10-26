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
import { BODY_IDS, type BodyId } from '../core/types';
import type { ViewPreference } from './navigation';
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
  /** Share of the narrower clear side of the view its bounding sphere spans when framed. */
  readonly fill: number;
  /** How it is first seen (see ViewPreference in ./navigation). */
  readonly view: ViewPreference;
}

const ROTATING: Readonly<Record<BodyId, RotatingBody>> = {
  sun: 'Sun',
  earth: 'Earth',
  moon: 'Moon',
  jupiter: 'Jupiter',
  mercury: 'Mercury',
  venus: 'Venus',
  mars: 'Mars',
  uranus: 'Uranus',
  neptune: 'Neptune',
  saturn: 'Saturn',
};

const NAME_KEYS: Readonly<Record<BodyId, string>> = {
  sun: 'ui.hud.sunName',
  earth: 'ui.hud.earth',
  moon: 'ui.hud.moon',
  jupiter: 'ui.hud.planet.jupiter',
  mercury: 'ui.hud.planet.mercury',
  venus: 'ui.hud.planet.venus',
  mars: 'ui.hud.planet.mars',
  uranus: 'ui.hud.planet.uranus',
  neptune: 'ui.hud.planet.neptune',
  saturn: 'ui.hud.planet.saturn',
};

/**
 * The lowest the camera goes. The Earth: 150 km, above its drawn atmosphere (EARTH_AIR_SCALE, 127 km
 * up). The others: 2% of the radius (35 km over the Moon, about 1,400 km over the giants' cloud tops).
 */
export const EARTH_AIR_SCALE = 1.02;
const MIN_ALTITUDE_SHARE = 0.02;
const EARTH_MIN_ALTITUDE_KM = 150;

/**
 * How each body is framed and first seen. Visual choices, not measurements: the sunlit face turned
 * about 50 degrees away so the terminator shows; the Earth and the Moon from a little above, Jupiter
 * from near its equator (its belts run straight across), Saturn from 17 degrees off its ring plane on
 * the side the Sun lights; the Sun from the Earth's side. Saturn's bounding sphere is its rings.
 */
const FRAMING: Readonly<Record<BodyId, { fill: number; view: ViewPreference }>> = {
  sun: { fill: 0.5, view: { azimuth: 0.35, latitude: 0.16, litFace: false } },
  earth: { fill: 0.6, view: { azimuth: 0.9, latitude: 0.2, litFace: false } },
  moon: { fill: 0.6, view: { azimuth: 0.85, latitude: 0.12, litFace: false } },
  jupiter: { fill: 0.62, view: { azimuth: 0.78, latitude: 0.06, litFace: false } },
  mercury: { fill: 0.62, view: { azimuth: 0.85, latitude: 0.12, litFace: false } },
  venus: { fill: 0.62, view: { azimuth: 0.85, latitude: 0.12, litFace: false } },
  mars: { fill: 0.62, view: { azimuth: 0.85, latitude: 0.12, litFace: false } },
  uranus: { fill: 0.62, view: { azimuth: 0.85, latitude: 0.12, litFace: false } },
  neptune: { fill: 0.62, view: { azimuth: 0.85, latitude: 0.12, litFace: false } },
  saturn: { fill: 0.78, view: { azimuth: 0.7, latitude: 0.3, litFace: true } },
};

export function bodySpecs(physical: PhysicalFile): Readonly<Record<BodyId, BodySpec>> {
  const spec = (id: BodyId, boundKm?: number): BodySpec => {
    const [a, , c] = physical.bodies[ROTATING[id]].radiiKm;
    return {
      id,
      nameKey: NAME_KEYS[id],
      radiusKm: a,
      polarKm: c,
      boundKm: boundKm ?? a,
      minAltitudeKm: id === 'earth' ? EARTH_MIN_ALTITUDE_KM : MIN_ALTITUDE_SHARE * a,
      ...FRAMING[id],
    };
  };
  return {
    mercury: spec('mercury'),
    venus: spec('venus'),
    mars: spec('mars'),
    uranus: spec('uranus'),
    neptune: spec('neptune'),
    sun: spec('sun'),
    earth: spec('earth'),
    moon: spec('moon'),
    jupiter: spec('jupiter'),
    saturn: spec('saturn', physical.saturnRings.outerKm),
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
  /** A body's basis (as BodyState's) on another date, into `out`, leaving the bodies where they are. */
  basisAt(id: BodyId, jdTdb: number, out: number[]): number[];
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
  const mercury = index('Mercury');
  const venus = index('Venus');
  const mars = index('Mars');
  const uranus = index('Uranus');
  const neptune = index('Neptune');
  const jupiter = index('Jupiter');
  const saturn = index('Saturn');
  const state = (): BodyState => ({ position: km(), basis: new Array<number>(9).fill(0) });
  const bodies: Record<BodyId, BodyState> = { mercury: state(), venus: state(), mars: state(), uranus: state(), neptune: state(), sun: state(), earth: state(), moon: state(), jupiter: state(), saturn: state() };
  const ecl = km();
  const orientation: Orientation = { ra: 0, dec: 0, w: 0 };
  const toEcliptic = new Array<number>(9).fill(0);
  const axis = km();
  const turned = km();

  /** basis = W B P: W the ecliptic-to-render turn, B body-to-ecliptic, P the mesh's axes in the body frame. */
  const orient = (id: BodyId, jd: number, out: number[] = bodies[id].basis): number[] => {
    bodyToEcliptic(orientationAt(physical.bodies[ROTATING[id]], jd, orientation), obliquity, toEcliptic);
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
    return out;
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
      eclipticToRender(ephemeris.planetKm(mercury, jd, ecl), bodies.mercury.position);
      eclipticToRender(ephemeris.planetKm(venus, jd, ecl), bodies.venus.position);
      eclipticToRender(ephemeris.planetKm(mars, jd, ecl), bodies.mars.position);
      eclipticToRender(ephemeris.planetKm(uranus, jd, ecl), bodies.uranus.position);
      eclipticToRender(ephemeris.planetKm(neptune, jd, ecl), bodies.neptune.position);
      eclipticToRender(ephemeris.planetKm(jupiter, jd, ecl), bodies.jupiter.position);
      eclipticToRender(ephemeris.planetKm(saturn, jd, ecl), bodies.saturn.position);
      for (const id of BODY_IDS) orient(id, jd);
    },
    basisAt(id, jd, out) {
      return orient(id, jd, out);
    },
  };
}
