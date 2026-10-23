/**
 * The floating origin. Pure (no three.js), so the unit tests run it without a browser.
 *
 * Every position the explorer keeps is a JavaScript double in kilometres from the solar-system
 * barycentre, in the render frame (below). The GPU only ever sees float32, which at 1 au
 * steps by 16 km and at Neptune by 512 km: a planet parked there would shiver, and shading that
 * subtracts large world positions would break up. So each frame the camera is put at the origin
 * and every object at (its position - the camera's), still in doubles; only those small,
 * camera-relative numbers become float32. Near the camera they are exact to well under a metre.
 *
 * Frame: the ecliptic and equinox of J2000 (the JPL data's frame), turned a quarter turn about x
 * so that ecliptic north is +y, three.js's up. A right-handed rotation, so the handedness of
 * everything (orbits, spins) is kept.
 *
 * Origin: the barycentre. The slice's ephemeris is heliocentric and the Sun's own offset from the
 * barycentre (about one solar radius, mostly from Jupiter) is not modelled yet, so the Sun sits
 * at the origin; every relative position, and so everything drawn, is unaffected.
 */

/** A position or direction in km, float64. */
export interface Km {
  x: number;
  y: number;
  z: number;
}

export const km = (x = 0, y = 0, z = 0): Km => ({ x, y, z });

/** Ecliptic J2000 (z to ecliptic north) to the render frame (y to ecliptic north). */
export function eclipticToRender<T extends Km>(v: Km, out: T): T {
  const { x, y, z } = v;
  out.x = x;
  out.y = z;
  out.z = -y;
  return out;
}

/** The render frame back to ecliptic J2000. */
export function renderToEcliptic<T extends Km>(v: Km, out: T): T {
  const { x, y, z } = v;
  out.x = x;
  out.y = -z;
  out.z = y;
  return out;
}

export const length = (v: Km): number => Math.hypot(v.x, v.y, v.z);

export const distance = (a: Km, b: Km): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The camera's position (km from the barycentre); every object is drawn relative to it. */
export class FloatingOrigin {
  readonly camera: Km = km();

  setCamera(position: Km): void {
    this.camera.x = position.x;
    this.camera.y = position.y;
    this.camera.z = position.z;
  }

  /** world - camera, in doubles: what the GPU gets for an object at `world`. */
  relative<T extends Km>(world: Km, out: T): T {
    out.x = world.x - this.camera.x;
    out.y = world.y - this.camera.y;
    out.z = world.z - this.camera.z;
    return out;
  }
}
