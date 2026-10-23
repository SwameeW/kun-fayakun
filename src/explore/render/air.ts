/**
 * The Earth's air for the explorer: Bruneton's reference atmosphere (his 2017 implementation of
 * precomputed atmospheric scattering, whose constants data/constants.json cites), in planet radii.
 *
 * - Rayleigh scattering k / lambda^4 at the model's three wavelengths (680, 550 and 440 nm), falling
 *   off with an 8 km scale height; Mie (aerosol) extinction from its Angstrom beta over a 1.2 km scale
 *   height, 90% of it scattered, with a Cornette-Shanks phase of asymmetry 0.8; ozone absorbing in a
 *   tent from 10 to 40 km, 300 Dobson units of it. Ozone's Chappuis band is broad and peaks between
 *   the green and red sample wavelengths, so each channel takes the cross section averaged over its
 *   band (400-500, 500-600, 600-700 nm) from the same table, not its single wavelength's: three point
 *   samples would leave the long limb paths purple.
 * - A transmittance table (Hillaire 2020; Bruneton's parameterisation) baked once into a 256 x 64 half
 *   float render target by a full-screen quad, so WebGL2 needs no compute: transmittance from any
 *   height along any direction to the top of the air.
 * - Lookups into it, and the sunlight that reaches a point (the planet's own shadow included, its
 *   edge spread over the Sun's angular radius: the penumbra).
 *
 * Every number comes from data/constants.json (and the Sun's angular size from physical.json);
 * nothing here is tuned by eye.
 */

import {
  ClampToEdgeWrapping,
  HalfFloatType,
  LinearFilter,
  MeshBasicNodeMaterial,
  QuadMesh,
  RenderTarget,
  RGBAFormat,
  type Node,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';
import { abs, exp, float, Fn, Loop, max, min, select, smoothstep, sqrt, texture, uv, vec2, vec3, vec4 } from 'three/tsl';
import type { DataStore } from '../../core/types';
import type { FloatNode, Vec3Node } from './sampling';

/** The model's wavelengths for red, green and blue, micrometres (Bruneton, model.h kLambdaR/G/B). */
const WAVELENGTH_IDS = ['earth.air.wavelength.red', 'earth.air.wavelength.green', 'earth.air.wavelength.blue'] as const;
const OZONE_IDS = ['earth.air.ozone.crossSection.red', 'earth.air.ozone.crossSection.green', 'earth.air.ozone.crossSection.blue'] as const;

/** The air in planet radii: coefficients per radius, heights in radii above the ground. */
export interface AirModel {
  /** Top of the air (1 is the ground). */
  readonly top: number;
  readonly rayleigh: readonly [number, number, number];
  readonly rayleighScale: number;
  readonly mieScattering: number;
  readonly mieExtinction: number;
  readonly mieScale: number;
  readonly mieG: number;
  /** Ozone absorption at its peak density, per radius. */
  readonly ozone: readonly [number, number, number];
  readonly ozonePeak: number;
  readonly ozoneHalfWidth: number;
  /** The Sun's angular radius as seen from the planet, radians (the shadow's penumbra). */
  readonly sunAngularRadius: number;
  /** Vertical optical depth of the whole air at the three wavelengths (for the analytic 'chord' model). */
  readonly verticalDepth: readonly [number, number, number];
}

/** The air of a planet of `radiusKm` from the cited constants (data/constants.json). */
export function earthAir(data: DataStore, radiusKm: number, sunAngularRadius: number): AirModel {
  const c = (id: string): number => data.constant(id).value;
  const metres = radiusKm * 1000;
  const km = 1000 / metres;
  const lambdas = WAVELENGTH_IDS.map((id) => c(id) / 1000) as [number, number, number];
  // Rayleigh: k * lambda^-4 per metre, lambda in micrometres (demo.cc: kRayleigh * pow(lambda, -4)).
  // (constants.json stores a few values in scaled units: their `unit` says which.)
  const rayleigh = lambdas.map((l) => c('earth.air.rayleigh.coefficient') * 1e-6 * l ** -4 * metres) as [number, number, number];
  const rayleighScale = c('earth.air.rayleigh.scaleHeight') * km;
  // Mie: Angstrom beta over the scale height (alpha 0: the same at every wavelength), per metre.
  const mieScaleM = c('earth.air.mie.scaleHeight') * 1000;
  const mieExtinction = ((c('earth.air.mie.angstromBeta') * 1e-3) / mieScaleM) * metres;
  const mieScattering = mieExtinction * c('earth.air.mie.singleScatteringAlbedo');
  // Ozone: 300 Dobson units spread over the tent's 15 km integral (demo.cc kMaxOzoneNumberDensity).
  const halfWidthKm = c('earth.air.ozone.halfWidth');
  const maxDensity = (c('earth.air.ozone.column') * c('earth.air.ozone.dobsonUnit') * 1e20) / (halfWidthKm * 1000);
  const ozone = OZONE_IDS.map((id) => maxDensity * c(id) * 1e-25 * metres) as [number, number, number];
  const ozonePeak = c('earth.air.ozone.peak') * km;
  const ozoneHalfWidth = halfWidthKm * km;
  const verticalDepth = [0, 1, 2].map((i) => (rayleigh[i] ?? 0) * rayleighScale + mieExtinction * (mieScaleM / metres) + (ozone[i] ?? 0) * ozoneHalfWidth) as [
    number,
    number,
    number,
  ];
  return {
    top: 1 + c('earth.air.height') * km,
    rayleigh,
    rayleighScale,
    mieScattering,
    mieExtinction,
    mieScale: mieScaleM / metres,
    mieG: c('earth.air.mie.g'),
    ozone,
    ozonePeak,
    ozoneHalfWidth,
    sunAngularRadius,
    verticalDepth,
  };
}

export const LUT = { width: 256, height: 64, steps: 40 } as const;

/** Air density at height h (radii) for Rayleigh, Mie and ozone, as (x, y, z). */
export function densities(air: AirModel, h: FloatNode): Vec3Node {
  const ozone = max(float(1).sub(abs(h.sub(air.ozonePeak)).div(air.ozoneHalfWidth)), 0);
  return vec3(exp(h.div(-air.rayleighScale)), exp(h.div(-air.mieScale)), ozone);
}

/** Extinction (r, g, b) of a column of the three densities (x Rayleigh, y Mie, z ozone). */
export function extinction(air: AirModel, column: Vec3Node): Vec3Node {
  const [rr, rg, rb] = air.rayleigh;
  const [or, og, ob] = air.ozone;
  return vec3(rr, rg, rb).mul(column.x).add(column.y.mul(air.mieExtinction)).add(vec3(or, og, ob).mul(column.z));
}

/** Distance from radius r along direction cosine mu to the top of the air (rays from inside it). */
function distanceToTop(air: AirModel, r: FloatNode, mu: FloatNode): FloatNode {
  const disc = r.mul(r).mul(mu.mul(mu).sub(1)).add(air.top * air.top);
  return max(r.negate().mul(mu).add(sqrt(max(disc, 0))), 0);
}

/** Table coordinates of (r, mu) (Bruneton 2017, GetTransmittanceTextureUvFromRMu). */
function lutUv(air: AirModel, r: FloatNode, mu: FloatNode): Node<'vec2'> {
  const H = Math.sqrt(air.top * air.top - 1);
  const rho = sqrt(max(r.mul(r).sub(1), 0));
  const d = distanceToTop(air, r, mu);
  const dMin = float(air.top).sub(r);
  const dMax = rho.add(H);
  const xMu = d.sub(dMin).div(max(dMax.sub(dMin), 1e-6));
  const xR = rho.div(H);
  const centre = (x: FloatNode, n: number): FloatNode => x.mul(1 - 1 / n).add(0.5 / n);
  return vec2(centre(xMu, LUT.width), centre(xR, LUT.height));
}

/** The transmittance table: bake once (needs a renderer), then sample it with transmittanceToTop. */
export interface TransmittanceTable {
  readonly texture: Texture;
  readonly baked: boolean;
  bake(renderer: WebGPURenderer): void;
  dispose(): void;
}

export function createTransmittanceTable(air: AirModel): TransmittanceTable {
  const target = new RenderTarget(LUT.width, LUT.height, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, generateMipmaps: false });
  target.texture.minFilter = LinearFilter;
  target.texture.magFilter = LinearFilter;
  target.texture.wrapS = ClampToEdgeWrapping;
  target.texture.wrapT = ClampToEdgeWrapping;
  target.texture.name = 'explore-air-transmittance';
  const material = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
  material.colorNode = Fn(() => {
    // (u, v) -> (r, mu): the inverse of lutUv.
    const H = Math.sqrt(air.top * air.top - 1);
    const p = uv();
    const xMu = p.x.sub(0.5 / LUT.width).div(1 - 1 / LUT.width).clamp(0, 1);
    const xR = p.y.sub(0.5 / LUT.height).div(1 - 1 / LUT.height).clamp(0, 1);
    const rho = xR.mul(H);
    const r = sqrt(rho.mul(rho).add(1));
    const dMin = float(air.top).sub(r);
    const dMax = rho.add(H);
    const d = dMin.add(xMu.mul(dMax.sub(dMin)));
    const mu = select(d.lessThan(1e-7), float(1), float(H * H).sub(rho.mul(rho)).sub(d.mul(d)).div(r.mul(d).mul(2).max(1e-9))).clamp(-1, 1);
    // Optical depth along the ray to the top (midpoint rule).
    const length = distanceToTop(air, r, mu);
    const dt = length.div(LUT.steps);
    const column = vec3(0, 0, 0).toVar();
    Loop(LUT.steps, ({ i }) => {
      const t = float(i).add(0.5).mul(dt);
      const radius = sqrt(t.mul(t).add(r.mul(mu).mul(t).mul(2)).add(r.mul(r)));
      column.addAssign(densities(air, radius.sub(1)).mul(dt));
    });
    return vec4(exp(extinction(air, column).negate()), 1);
  })();
  const quad = new QuadMesh(material);
  let baked = false;
  return {
    texture: target.texture,
    get baked() {
      return baked;
    },
    bake(renderer) {
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      quad.render(renderer);
      renderer.setRenderTarget(previous);
      baked = true;
    },
    dispose() {
      target.dispose();
      material.dispose();
    },
  };
}

/** Transmittance from radius r (radii) along direction cosine mu to the top of the air, as (r, g, b). */
export function transmittanceToTop(air: AirModel, table: Texture, r: FloatNode, mu: FloatNode): Vec3Node {
  return texture(table, lutUv(air, min(r, air.top), mu)).level(float(0)).rgb;
}

/**
 * Sunlight reaching a point at radius r whose zenith makes cosine muSun with the Sun: the air's
 * transmittance, and none in the planet's shadow (its edge spread over the Sun's disc).
 */
export function sunTransmittance(air: AirModel, table: Texture, r: FloatNode, muSun: FloatNode): Vec3Node {
  const horizon = sqrt(max(float(1).sub(float(1).div(r.mul(r))), 0)).negate();
  const visible = smoothstep(horizon.sub(air.sunAngularRadius), horizon.add(air.sunAngularRadius), muSun);
  return transmittanceToTop(air, table, r, max(muSun, horizon)).mul(visible);
}

/** Phase functions times pi (the explorer's light convention): Rayleigh, and Cornette-Shanks for Mie. */
export function rayleighPhase(cosTheta: FloatNode): FloatNode {
  return cosTheta.mul(cosTheta).add(1).mul(3 / 16);
}
export function miePhase(air: AirModel, cosTheta: FloatNode): FloatNode {
  const g = air.mieG;
  const k = (3 / 8) * ((1 - g * g) / (2 + g * g));
  return cosTheta.mul(cosTheta).add(1).mul(k).div(float(1 + g * g).sub(cosTheta.mul(2 * g)).max(1e-4).pow(1.5));
}
