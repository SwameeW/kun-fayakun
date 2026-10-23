/**
 * The explorer's depth range, set every frame from the camera's height above the nearest surface.
 * Pure, like ./origin.
 *
 * The renderer keeps standard 24-bit depth (no logarithmic or reversed depth: both are renderer-wide
 * switches that would change every chapter). 24 bits resolve a scene about 2e4 times deeper than
 * its near plane with depth to spare, so the range follows the camera: the near plane sits at 40%
 * of the altitude (the nearest surface is always 2.5 near planes away, never clipped), the far plane
 * 2e4 times further. Anything beyond half of that is drawn in scaled space (./scaled-space), and the
 * starfield sits just inside the far plane.
 */

import type { Km } from './origin';

export const LENS = {
  /** The near plane as a share of the altitude above the nearest surface. */
  nearShare: 0.4,
  /** 1 m: closer than any surface the camera may approach. */
  minNearKm: 1e-3,
  /** 1e5 km: beyond this the far plane (2e9 km, 13 au) already holds the planets out to Saturn. */
  maxNearKm: 1e5,
  /** far / near. */
  ratio: 2e4,
  /** The starfield's sphere, as a share of the far plane (inside it, behind everything else). */
  starShare: 0.98,
} as const;

export interface Lens {
  near: number;
  far: number;
}

/** The depth range for a camera this many km above the nearest surface. */
export function lensFor(altitudeKm: number, out: Lens = { near: 0, far: 0 }): Lens {
  const altitude = Number.isFinite(altitudeKm) ? Math.max(0, altitudeKm) : Infinity;
  const near = Math.min(LENS.maxNearKm, Math.max(LENS.minNearKm, LENS.nearShare * altitude));
  out.near = near;
  out.far = near * LENS.ratio;
  return out;
}

export interface Sphere {
  /** Centre relative to the camera, km. */
  centre: Km;
  /** Radius, km (the equatorial radius: never more than the true height above an oblate body). */
  radius: number;
}

/** The camera's height above the nearest surface, km (negative inside a body; Infinity with none). */
export function nearestAltitude(spheres: Iterable<Sphere>): number {
  let lowest = Infinity;
  for (const s of spheres) {
    const altitude = Math.hypot(s.centre.x, s.centre.y, s.centre.z) - s.radius;
    if (altitude < lowest) lowest = altitude;
  }
  return lowest;
}
