import { Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3 } from 'three/webgpu';
import { cameraPosition, dot, float, normalWorld, normalize, positionWorld, uniform } from 'three/tsl';

/**
 * A star up close (docs/NEIGHBOURHOOD.md, "Stars up close"): the star in view drawn as a disc of its
 * size once it is wider than a pixel or two, the point of light fading as the disc grows.
 *
 * Its size: the NASA Exoplanet Archive's radius for a planet's star; otherwise estimated from its
 * light and temperature, R = sqrt(L) (5772 K / T)^2 (in the Sun's), with L from its absolute V and
 * the bolometric correction for its temperature (Torres 2010's fit to Flower 1996's table; the Sun's
 * absolute bolometric magnitude 4.74, IAU 2015 B2), and T from its B-V (Ballesteros 2012): marked as
 * estimated. The disc's colour is its temperature's; its darkening toward the edge (a linear law,
 * u = 0.6) is illustrative.
 */

/** The Sun's radius (pc; IAU 2015 B3's nominal 695,700 km) and its absolute bolometric magnitude (IAU 2015 B2). */
export const SUN = { radiusPc: 695_700 / ((648_000 / Math.PI) * 149_597_870.7), mbol: 4.74, teff: 5772 } as const;

/** Torres (2010), table 1: BC_V as a polynomial in log10(Teff), by range. */
const BC = {
  cool: [-0.190537291496456e5, 0.155144866764412e5, -0.421278819301717e4, 0.381476328422343e3],
  mid: [-0.370510203809015e5, 0.385672629965804e5, -0.150651486316025e5, 0.261724637119416e4, -0.170623810323864e3],
  hot: [-0.118115450538963e6, 0.137145973583929e6, -0.636233812100225e5, 0.147412923562646e5, -0.170587278406872e4, 0.78873172180499e2],
} as const;

/** The bolometric correction to V for a temperature (K), Torres (2010). */
export function bolometricCorrection(teff: number): number {
  const x = Math.log10(Math.max(2000, Math.min(50_000, teff)));
  const c = x < 3.7 ? BC.cool : x < 3.9 ? BC.mid : BC.hot;
  let sum = 0;
  for (let i = c.length - 1; i >= 0; i -= 1) sum = sum * x + (c[i] ?? 0);
  return sum;
}

/** A star's radius estimated from its absolute V and temperature, in the Sun's. */
export function estimatedRadius(absoluteV: number, teff: number): number {
  const luminosity = 10 ** (-0.4 * (absoluteV + bolometricCorrection(teff) - SUN.mbol));
  return Math.sqrt(luminosity) * (SUN.teff / teff) ** 2;
}

export interface Disc {
  readonly mesh: Mesh;
  /** Places the disc (camera-relative, pc) at its radius (pc) and colour, and how much of it shows. */
  set(at: readonly [number, number, number], radiusPc: number, colour: readonly number[], shown: number): void;
  dispose(): void;
}

export function createDisc(): Disc {
  const uColour = uniform(new Vector3(1, 1, 1));
  const uShown = uniform(0);
  const material = new MeshBasicNodeMaterial({ depthWrite: false, depthTest: false, fog: false, transparent: true });
  // Linear limb darkening, I(mu) = 1 - u (1 - mu), mu the cosine between the surface's normal and the line of sight (u = 0.6, illustrative).
  const mu = dot(normalWorld, normalize(cameraPosition.sub(positionWorld))).clamp(0, 1);
  material.colorNode = uColour.mul(float(1).sub(float(0.6).mul(float(1).sub(mu)))).mul(1.4);
  material.opacityNode = uShown;
  const mesh = new Mesh(new SphereGeometry(1, 64, 32), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.name = 'explore-neighbourhood-disc';
  mesh.visible = false;
  return {
    mesh,
    set(at, radiusPc, colour, shown) {
      mesh.visible = shown > 0.002;
      if (!mesh.visible) return;
      mesh.position.set(at[0], at[1], at[2]);
      mesh.scale.setScalar(radiusPc);
      uColour.value.set(colour[0] ?? 1, colour[1] ?? 1, colour[2] ?? 1);
      uShown.value = shown;
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
