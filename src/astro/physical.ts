/**
 * public/assets/jpl/physical.json: rotation models, radii, EMRAT, the J2000 obliquity, the
 * Saturn ring span and the time-scale terms. scripts/jpl/build.py parses each one from its
 * source file (NAIF pck00011 and naif0012, the DE440 header, Horizons, Cassini RSS on PDS), and
 * the validator checks the file's shape and recorded hashes.
 */

import type { EphemerisConstants } from './ephemeris';
import { ARCSEC, type RotatingBody, type RotationModel } from './rotation';
import type { TimeConstants } from './time';

export interface PhysicalFile extends EphemerisConstants {
  obliquityJ2000Arcsec: number;
  /** GM, km^3 s^-2 (DE440): the Earth's and the Moon's split by EMRAT; Mars to Neptune each with its moons. */
  gmKm3S2: Record<RotatingBody, number>;
  bodies: Record<RotatingBody, RotationModel>;
  saturnRings: {
    innerKm: number;
    outerKm: number;
    /** The Cassini profile's mean normal transmission in `bins` equal bins from innerKm out: base64, one byte (0..255) each. */
    profile: { bins: number; transmission: string };
  };
  time: TimeConstants;
}

/** Decodes the rings' transmission profile to values from 0 (opaque) to 1 (empty). */
export function ringTransmission(rings: PhysicalFile['saturnRings']): number[] {
  const bytes = atob(rings.profile.transmission);
  if (bytes.length !== rings.profile.bins) throw new Error(`physical.json: the ring profile has ${bytes.length} bins, expected ${rings.profile.bins}`);
  return Array.from(bytes, (c) => c.charCodeAt(0) / 255);
}

export const PHYSICAL_URL = 'assets/jpl/physical.json';

/** The ecliptic of J2000's tilt from the ICRF equator, in radians. */
export const obliquityRad = (physical: Pick<PhysicalFile, 'obliquityJ2000Arcsec'>): number => physical.obliquityJ2000Arcsec * ARCSEC;
