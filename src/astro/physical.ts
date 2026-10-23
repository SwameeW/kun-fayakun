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
  bodies: Record<RotatingBody, RotationModel>;
  saturnRings: { innerKm: number; outerKm: number };
  time: TimeConstants;
}

export const PHYSICAL_URL = 'assets/jpl/physical.json';

/** The ecliptic of J2000's tilt from the ICRF equator, in radians. */
export const obliquityRad = (physical: Pick<PhysicalFile, 'obliquityJ2000Arcsec'>): number => physical.obliquityJ2000Arcsec * ARCSEC;
