/**
 * How the Sun, all eight planets and the Moon are turned on a date: the IAU WGCCRE rotation
 * models (pole right ascension and declination, prime meridian W) as NAIF's pck00011.tpc gives
 * them, read from public/assets/jpl/physical.json. Pure, like ./ephemeris.
 *
 *   RA  = ra0 + ra1 T + ra2 T^2 + sum ra_i sin(theta_i)
 *   Dec = dec0 + dec1 T + dec2 T^2 + sum dec_i cos(theta_i)
 *   W   = w0 + w1 d + w2 d^2 + sum pm_i sin(theta_i)
 *   theta_i = angle_i0 + angle_i1 T + angle_i2 T^2 (quadratic coefficient optional)
 *
 * d is in TDB days and T in Julian centuries from J2000, and all angles are in degrees. The
 * pole is given in the ICRF. The positions in ./ephemeris use the ecliptic of J2000, which is the
 * ICRF turned about its x axis by the obliquity (physical.json obliquityJ2000Arcsec, the value
 * Horizons uses).
 */

import { DAYS_PER_CENTURY, J2000, type Vec3 } from './ephemeris';

export interface NutationPrecession {
  ra: number[];
  dec: number[];
  pm: number[];
  /** Polynomial in Julian centuries: degrees, degrees/century, optional degrees/century squared. */
  angles: Array<[number, number, number?]>;
}

/** One body of physical.json "bodies". */
export interface RotationModel {
  naifId: number;
  /** Triaxial radii a, b, c in km (c along the pole). */
  radiiKm: [number, number, number];
  poleRa: [number, number, number];
  poleDec: [number, number, number];
  pm: [number, number, number];
  nutPrec: NutationPrecession | null;
}

export type RotatingBody = 'Sun' | 'Mercury' | 'Venus' | 'Earth' | 'Moon' | 'Mars' | 'Jupiter' | 'Saturn' | 'Uranus' | 'Neptune';

/** In radians; w is reduced to [0, 2 pi). */
export interface Orientation {
  ra: number;
  dec: number;
  w: number;
}

const DEG = Math.PI / 180;
const TURN = 2 * Math.PI;
export const ARCSEC = DEG / 3600;

export function orientationAt(model: RotationModel, jdTdb: number, out: Orientation = { ra: 0, dec: 0, w: 0 }): Orientation {
  const d = jdTdb - J2000;
  const T = d / DAYS_PER_CENTURY;
  let ra = model.poleRa[0] + model.poleRa[1] * T + model.poleRa[2] * T * T;
  let dec = model.poleDec[0] + model.poleDec[1] * T + model.poleDec[2] * T * T;
  let w = model.pm[0] + model.pm[1] * d + model.pm[2] * d * d;
  const np = model.nutPrec;
  if (np) {
    np.angles.forEach(([a0, a1, a2 = 0], i) => {
      const theta = (a0 + a1 * T + a2 * T * T) * DEG;
      const s = Math.sin(theta);
      ra += (np.ra[i] ?? 0) * s;
      dec += (np.dec[i] ?? 0) * Math.cos(theta);
      w += (np.pm[i] ?? 0) * s;
    });
  }
  out.ra = ra * DEG;
  out.dec = dec * DEG;
  out.w = ((((w * DEG) % TURN) + TURN) % TURN);
  return out;
}

/** The body's north pole as a unit vector in the ICRF. */
export function poleIcrf(o: Orientation, out: Vec3): Vec3 {
  const cd = Math.cos(o.dec);
  out.x = cd * Math.cos(o.ra);
  out.y = cd * Math.sin(o.ra);
  out.z = Math.sin(o.dec);
  return out;
}

/**
 * The rotation from body-fixed axes to the ICRF: Rz(90 deg + RA) Rx(90 deg - Dec) Rz(W), the
 * transpose of the matrix NAIF documents. The result is 9 numbers in column-major order (the
 * columns are the body's x, y and z axes in the ICRF), so Matrix3.fromArray reads it directly.
 * Body x points at the prime meridian on the equator, and body z points at the north pole.
 */
export function bodyToIcrf(o: Orientation, out: number[] = new Array<number>(9).fill(0)): number[] {
  const ca = Math.cos(o.ra);
  const sa = Math.sin(o.ra);
  const cd = Math.cos(o.dec);
  const sd = Math.sin(o.dec);
  const cw = Math.cos(o.w);
  const sw = Math.sin(o.w);
  // The node of the body's equator on the ICRF equator is (-sin RA, cos RA, 0). W is measured from it.
  const nx = -sa;
  const ny = ca;
  // The direction 90 deg further along the body's equator: pole x node.
  const qx = -sd * ca;
  const qy = -sd * sa;
  const qz = cd;
  out[0] = cw * nx + sw * qx;
  out[1] = cw * ny + sw * qy;
  out[2] = sw * qz;
  out[3] = -sw * nx + cw * qx;
  out[4] = -sw * ny + cw * qy;
  out[5] = cw * qz;
  out[6] = cd * ca;
  out[7] = cd * sa;
  out[8] = sd;
  return out;
}

/** An ICRF vector in the ecliptic of J2000. */
export function icrfToEcliptic(v: Vec3, obliquityRad: number, out: Vec3): Vec3 {
  const c = Math.cos(obliquityRad);
  const s = Math.sin(obliquityRad);
  const { x, y, z } = v;
  out.x = x;
  out.y = c * y + s * z;
  out.z = -s * y + c * z;
  return out;
}

/** bodyToIcrf followed by icrfToEcliptic: body-fixed axes to the frame of ./ephemeris (column-major). */
export function bodyToEcliptic(o: Orientation, obliquityRad: number, out: number[] = new Array<number>(9).fill(0)): number[] {
  bodyToIcrf(o, out);
  const column: Vec3 = { x: 0, y: 0, z: 0 };
  for (let c = 0; c < 9; c += 3) {
    column.x = out[c] ?? 0;
    column.y = out[c + 1] ?? 0;
    column.z = out[c + 2] ?? 0;
    icrfToEcliptic(column, obliquityRad, column);
    out[c] = column.x;
    out[c + 1] = column.y;
    out[c + 2] = column.z;
  }
  return out;
}
