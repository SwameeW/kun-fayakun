import type { Ephemeris } from '../astro/ephemeris';
import { obliquityRad, type PhysicalFile } from '../astro/physical';
import { icrfToEcliptic, orientationAt, poleIcrf } from '../astro/rotation';
import type { ClimateSpec } from './climate';
import { DEFAULT_INTEGRATOR, ENGINE_VERSION, SCHEMA_VERSION, type BodySpec, type Scenario } from './engine';

/**
 * Starting states for the orbital laboratory.
 *
 * The solar system at an epoch: the explorer's own ephemeris (JPL's approximate elements, Standish
 * and Williams, and the Horizons Moon table) gives every body's heliocentric position; velocities
 * are central differences over +/- VELOCITY_STEP_DAYS (so the epoch is kept that far inside the Moon
 * table, never differencing across its clamped ends). GM from DE440 (physical.json gmKm3S2: the
 * Earth's and the Moon's split by EMRAT; Mars to Neptune each with its moons, which the laboratory
 * does not add separately), radii NAIF's means. Then everything is moved to the barycentre of the
 * ten bodies, at rest: the Sun moves too. Frame: ecliptic and equinox of J2000, km and km/s.
 *
 * The approximate elements are not an N-body solution, so the integrated orbits slowly leave the
 * real ones: the laboratory says so (seedNote) and never calls its positions JPL's.
 *
 * Each world turns as the IAU models have it at the epoch (NAIF's pck00011: its pole, and its
 * sidereal period from the prime meridian's rate; Venus and Uranus turn backwards about the IAU
 * north pole), with its J2 and moment of inertia factor where the caller gives them (`shapes`: the
 * NASA fact sheets' values, data/constants.json), so oblateness pulls and turns as it should.
 */

/** A world's flattening and the spread of its mass: its J2 and moment of inertia factor (either unknown). */
export type Shapes = Readonly<Record<string, { j2?: number | null; inertia?: number | null; climate?: ClimateSpec | null; luminosityW?: number | null } | undefined>>;

export const VELOCITY_STEP_DAYS = 1 / 24;
export const SOLAR_FRAME = 'barycentre of the ten bodies, at rest; ecliptic and equinox of J2000; km, km/s';

const NAMES: ReadonlyArray<readonly [string, keyof PhysicalFile['bodies'], string]> = [
  ['sun', 'Sun', 'Sun'],
  ['mercury', 'Mercury', 'Mercury'],
  ['venus', 'Venus', 'Venus'],
  ['earth', 'Earth', 'Earth'],
  ['moon', 'Moon', 'Moon'],
  ['mars', 'Mars', 'Mars'],
  ['jupiter', 'Jupiter', 'Jupiter'],
  ['saturn', 'Saturn', 'Saturn'],
  ['uranus', 'Uranus', 'Uranus'],
  ['neptune', 'Neptune', 'Neptune'],
];

type V = { x: number; y: number; z: number };

/** The epoch the solar system can be seeded at nearest `jdTdb`: inside the Moon table by the velocity step. */
export function seedEpoch(ephemeris: Ephemeris, jdTdb: number): number {
  const r = ephemeris.validRange();
  const lo = Math.max(r.planets.startJd, r.moon.startJd) + VELOCITY_STEP_DAYS;
  const hi = Math.min(r.planets.endJd, r.moon.endJd) - VELOCITY_STEP_DAYS;
  return Math.min(hi, Math.max(lo, jdTdb));
}

/** A world's rotation at an epoch from its IAU model: its sidereal period and its pole (prograde about it) in the ecliptic of J2000. */
export function rotationAt(physical: PhysicalFile, key: keyof PhysicalFile['bodies'], jdTdb: number): { periodS: number; pole: [number, number, number] } {
  const model = physical.bodies[key];
  const o = orientationAt(model, jdTdb);
  const icrf = poleIcrf(o, { x: 0, y: 0, z: 0 });
  const ecl = icrfToEcliptic(icrf, obliquityRad(physical), { x: 0, y: 0, z: 0 });
  const rate = model.pm[1];
  const sense = rate < 0 ? -1 : 1;
  return { periodS: (360 / Math.abs(rate)) * 86_400, pole: [sense * ecl.x, sense * ecl.y, sense * ecl.z] };
}

export function seedSolarSystem(ephemeris: Ephemeris, physical: PhysicalFile, jdTdb: number, names: Readonly<Record<string, string>> = {}, shapes: Shapes = {}): Scenario {
  const epoch = seedEpoch(ephemeris, jdTdb);
  const at = (id: string, jd: number): V => {
    const out = { x: 0, y: 0, z: 0 };
    if (id === 'sun') return out;
    if (id === 'earth') return ephemeris.earthKm(jd, out);
    if (id === 'moon') return ephemeris.moonHelioKm(jd, out);
    const index = ephemeris.bodies.findIndex((b) => b.name.toLowerCase() === id);
    return ephemeris.planetKm(index, jd, out);
  };
  const h = VELOCITY_STEP_DAYS;
  const bodies: BodySpec[] = NAMES.map(([id, key, name]) => {
    const p = at(id, epoch);
    const a = at(id, epoch - h);
    const b = at(id, epoch + h);
    const s = (2 * h * 86_400);
    const radii = physical.bodies[key].radiiKm;
    const shape = shapes[id];
    return {
      id,
      name: names[id] ?? name,
      gm: physical.gmKm3S2[key],
      radiusKm: (radii[0] + radii[1] + radii[2]) / 3,
      pos: [p.x, p.y, p.z],
      vel: [(b.x - a.x) / s, (b.y - a.y) / s, (b.z - a.z) / s],
      origin: 'modelled',
      sourceIds: id === 'moon' ? ['jpl-horizons', 'jpl-de440', 'naif-pck00011'] : ['jpl-approx-pos', 'jpl-de440', 'naif-pck00011'],
      spin: rotationAt(physical, key, epoch),
      ...(shape?.j2 ? { j2: shape.j2 } : {}),
      ...(shape?.inertia ? { inertia: shape.inertia } : {}),
      ...(shape?.climate ? { climate: { ...shape.climate } } : {}),
      ...(shape?.luminosityW ? { luminosityW: shape.luminosityW } : {}),
    };
  });
  // To the barycentre, at rest.
  const total = bodies.reduce((sum, b) => sum + b.gm, 0);
  const c = [0, 1, 2].map((k) => bodies.reduce((sum, b) => sum + b.gm * (b.pos[k] ?? 0), 0) / total);
  const u = [0, 1, 2].map((k) => bodies.reduce((sum, b) => sum + b.gm * (b.vel[k] ?? 0), 0) / total);
  for (const b of bodies) {
    b.pos = [b.pos[0] - (c[0] ?? 0), b.pos[1] - (c[1] ?? 0), b.pos[2] - (c[2] ?? 0)];
    b.vel = [b.vel[0] - (u[0] ?? 0), b.vel[1] - (u[1] ?? 0), b.vel[2] - (u[2] ?? 0)];
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    name: 'solar-system',
    epochJdTdb: epoch,
    frame: SOLAR_FRAME,
    seedNote: 'Positions from JPL’s approximate planetary elements (Standish and Williams) and the Horizons Moon table; velocities by central differences over ±1 hour; GM from DE440; each world’s rotation from the IAU models, its J2 and moment of inertia from NASA’s fact sheets. The approximate elements are not an N-body solution, so the integrated orbits drift from the real ones.',
    integrator: { ...DEFAULT_INTEGRATOR },
    bodies,
    log: [],
    // The Sun lights the scene: it keeps its identity in any merger and is not removed.
    persistentIds: ['sun'],
  };
}

/**
 * A clean laboratory: a Sun-like star and an Earth-like planet on a circular orbit of 1 au (the
 * planet's speed from GM and radius, about the pair's barycentre), and an optional third body on a
 * wider circular orbit; the bodies' GM and radii are the Sun's and the Earth's (and Jupiter's for the
 * third) from physical.json, labelled as a laboratory, not the solar system.
 */
export function seedLaboratory(physical: PhysicalFile, third: boolean, shapes: Shapes = {}): Scenario {
  const au = physical.auKm;
  const mean = (r: readonly number[]): number => ((r[0] ?? 0) + (r[1] ?? 0) + (r[2] ?? 0)) / 3;
  const star = physical.gmKm3S2.Sun;
  const planet = physical.gmKm3S2.Earth;
  const giant = physical.gmKm3S2.Jupiter;
  const bodies: BodySpec[] = [];
  const orbit = (id: string, name: string, gm: number, radiusKm: number, r: number): void => {
    // About the star: v^2 = G(M + m) / r for the pair; the star's recoil added below (barycentre at rest).
    const v = Math.sqrt((star + gm) / r);
    bodies.push({ id, name, gm, radiusKm, pos: [r, 0, 0], vel: [0, v, 0], origin: 'user-edited', sourceIds: ['jpl-de440', 'naif-pck00011'] });
  };
  bodies.push({ id: 'star', name: 'Star', gm: star, radiusKm: mean(physical.bodies.Sun.radiiKm), pos: [0, 0, 0], vel: [0, 0, 0], origin: 'user-edited', sourceIds: ['jpl-de440', 'naif-pck00011'], ...(shapes.sun?.luminosityW ? { luminosityW: shapes.sun.luminosityW } : {}) });
  orbit('planet', 'Planet', planet, mean(physical.bodies.Earth.radiiKm), au);
  // The planet has the Earth's mass, size and climate (no tilt: no seasons).
  const planetClimate = shapes.earth?.climate;
  const made = bodies[bodies.length - 1];
  if (planetClimate && made) made.climate = { ...planetClimate };
  if (third) orbit('giant', 'Giant', giant, mean(physical.bodies.Jupiter.radiiKm), 2.5 * au);
  const total = bodies.reduce((s, b) => s + b.gm, 0);
  const c = [0, 1, 2].map((k) => bodies.reduce((s, b) => s + b.gm * (b.pos[k] ?? 0), 0) / total);
  const u = [0, 1, 2].map((k) => bodies.reduce((s, b) => s + b.gm * (b.vel[k] ?? 0), 0) / total);
  for (const b of bodies) {
    b.pos = [b.pos[0] - (c[0] ?? 0), b.pos[1] - (c[1] ?? 0), b.pos[2] - (c[2] ?? 0)];
    b.vel = [b.vel[0] - (u[0] ?? 0), b.vel[1] - (u[1] ?? 0), b.vel[2] - (u[2] ?? 0)];
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    name: third ? 'three-body-laboratory' : 'two-body-laboratory',
    epochJdTdb: 2_451_545.0,
    frame: 'barycentre of the laboratory, at rest; km, km/s',
    seedNote: 'A laboratory, not the solar system: a star with the Sun’s GM and radius, a planet with the Earth’s on a circular orbit of 1 au' + (third ? ', and a giant with Jupiter’s on a circular orbit of 2.5 au.' : '.'),
    integrator: { ...DEFAULT_INTEGRATOR },
    bodies,
    log: [],
  };
}
