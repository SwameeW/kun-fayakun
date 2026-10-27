import type { Material } from '../../sim/looks';

/**
 * The shape and size a laboratory body is drawn at (docs/LAB.md, "How experiments are drawn"): pure,
 * so the tests check it.
 *
 * - Size: exactly the engine's radius, at every distance (its disc on screen is pxPerTan tan(asin(R/d))).
 * - Shape: round above the "potato radius", the size above which a body's own gravity pulls it round
 *   (Lineweaver and Norman 2010: about 200 km for rock, 300 km for ice); below it lumpy, more so the
 *   smaller, and a fragment's axes 2 : sqrt 2 : 1 (Fujiwara and others' 1978 fragments of basalt). The
 *   lumps are illustrative; the mass and radius stay the engine's.
 * - A disc under a few pixels is a point of light: the mesh and the point cross over between a disc
 *   radius of 2.8 and 1.2 px, their weights always adding to 1, as the explorer's worlds do.
 */

/** Potato radii (km) by material: round above, lumpy below half of it. Metal is taken as rock. */
const POTATO_KM: Readonly<Record<Material, number>> = { rock: 200, metal: 200, ice: 300, gas: 0, star: 0 };
/** A fragment's axes, 2 : sqrt 2 : 1, scaled to keep the volume of a sphere of the same radius. */
const FRAGMENT_AXES = [2 / Math.SQRT2, 1, 1 / Math.SQRT2] as const;
/** The mesh and the point of light cross over between these disc sizes (CSS px). */
export const CROSSOVER_PX = { point: 1.2, mesh: 2.8 } as const;

const smoothstep = (a: number, b: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/** How lumpy a body of `radiusKm` is drawn (0: round, 1: as lumpy as drawn gets). */
export function irregularity(radiusKm: number, material: Material): number {
  const potato = POTATO_KM[material];
  if (!(potato > 0)) return 0;
  return 1 - smoothstep(potato / 2, potato, radiusKm);
}

/** Its axes (a share of its radius each, the volume kept), from round to a fragment's as it grows lumpy. */
export function axesFor(irregular: number, out: [number, number, number] = [1, 1, 1]): [number, number, number] {
  for (let k = 0; k < 3; k += 1) out[k] = 1 + ((FRAGMENT_AXES[k] ?? 1) - 1) * irregular;
  return out;
}

/** A disc's radius on screen (CSS px) for a body of `radiusKm` at `distanceKm`, `pxPerTan` pixels per unit tangent (as the explorer's worlds' radiusPx). */
export function discPx(radiusKm: number, distanceKm: number, pxPerTan: number): number {
  if (!(distanceKm > 0)) return Number.POSITIVE_INFINITY;
  return pxPerTan * Math.tan(Math.asin(Math.min(1, radiusKm / Math.max(distanceKm, radiusKm))));
}

/** The mesh's weight and the point's, adding to 1. */
export function crossover(px: number): { mesh: number; point: number } {
  const mesh = smoothstep(CROSSOVER_PX.point, CROSSOVER_PX.mesh, px);
  return { mesh, point: 1 - mesh };
}

/** A star's effective temperature (K) from its luminosity (W) and radius (km): (L / 4 pi R^2 sigma)^(1/4). */
export function effectiveTemperature(luminosityW: number, radiusKm: number): number {
  const r = radiusKm * 1000;
  return (luminosityW / (4 * Math.PI * r * r * 5.670374419e-8)) ** 0.25;
}

/** A body's own seed from its id (stable through a run and its replays). */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (let k = 0; k < id.length; k += 1) h = Math.imul(h ^ id.charCodeAt(k), 16777619);
  return h >>> 0;
}

/** The Sun's light at 1 au (W/m^2) from the IAU's nominal luminosity: lights are given as shares of it. */
const S_1AU = 3.828e26 / (4 * Math.PI * 1.495978707e11 ** 2);

/**
 * The light of every star on a point (scenario frame, km), the strongest `out.length` (four, the rocks'),
 * strongest first, each `out` entry the direction to it (render frame: x, z, -y of the scenario's, a unit
 * vector) and its strength (1: the Sun's at 1 au), nought behind an occluder: a point in the cylinder its
 * body casts away from that star, softened over the point's own radius (an eclipse). `self` is the body's
 * own id (its own light and shadow are not counted).
 */
export function starLights(lights: ReadonlyArray<{ id: string; pos: readonly number[]; watts: number }>, occluders: ReadonlyArray<{ id: string; pos: readonly number[]; radiusKm: number }>, at: readonly number[], self: string, radiusKm: number, out: readonly number[][]): void {
  for (const o of out) o[3] = 0;
  for (const light of lights) {
    if (light.id === self) continue;
    const dx = (light.pos[0] ?? 0) - (at[0] ?? 0);
    const dy = (light.pos[1] ?? 0) - (at[1] ?? 0);
    const dz = (light.pos[2] ?? 0) - (at[2] ?? 0);
    const d = Math.hypot(dx, dy, dz);
    if (!(d > 0)) continue;
    let strength = light.watts / (4 * Math.PI * (d * 1000) ** 2) / S_1AU;
    for (const o of occluders) {
      if (o.id === self || o.id === light.id || strength <= 0) continue;
      const sx = (at[0] ?? 0) - (o.pos[0] ?? 0);
      const sy = (at[1] ?? 0) - (o.pos[1] ?? 0);
      const sz = (at[2] ?? 0) - (o.pos[2] ?? 0);
      // Along the light's way (away from the star) past the occluder, and how far off its axis.
      const along = -(sx * dx + sy * dy + sz * dz) / d;
      if (along <= 0) continue;
      const off = Math.sqrt(Math.max(0, sx * sx + sy * sy + sz * sz - along * along));
      strength *= smoothstep(o.radiusKm - radiusKm, o.radiusKm + radiusKm + 1e-6, off);
    }
    // Into its place among the strongest (the weaker moved down, the weakest dropped).
    const k = out.findIndex((o) => strength > (o[3] ?? 0));
    if (k < 0) continue;
    for (let j = out.length - 1; j > k; j -= 1) for (let c = 0; c < 4; c += 1) (out[j] as number[])[c] = out[j - 1]?.[c] ?? 0;
    const target = out[k] as number[];
    target[0] = dx / d;
    target[1] = dz / d;
    target[2] = -dy / d;
    target[3] = strength;
  }
}
