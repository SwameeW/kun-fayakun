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
 * - Beside it, the light scattered more than once (Hillaire 2020, his multiple-scattering table): for
 *   every height and Sun elevation, what a point of air receives from the sunlit air all round it and
 *   the sunlit ground below, summed over all the orders of scattering. It is what makes a thick column
 *   of air pale rather than deep blue: the haze over the far land and along the limb.
 * - Lookups into it, and the sunlight that reaches a point (the planet's own shadow included, its
 *   edge spread over the Sun's angular radius: the penumbra).
 *
 * Every number comes from data/constants.json (and the Sun's angular size from physical.json), but
 * the ground's albedo the light scattered more than once sees (MULTIPLE_GROUND_ALBEDO, a typical
 * land's); nothing here is tuned by eye. The explorer draws it on a clear day (clearDayAir: more
 * aerosols than the reference's).
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
import { abs, cos, dot, exp, float, Fn, length, Loop, max, min, normalize, select, sin, smoothstep, sqrt, texture, uv, vec2, vec3, vec4 } from 'three/tsl';
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
  /** Radius (1 is the ground) of the night airglow's layer: atomic oxygen's green line at its brightest. */
  readonly airglow: number;
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
    airglow: 1 + c('earth.airglow.greenLine.height') * km,
  };
}

/**
 * A clear day's air: the reference's (whose aerosols are those of an exceptionally clean day, optical
 * depth 0.005 at 550 nm) with eight times its aerosols, about 0.04 (the factor is a choice: still a
 * clean day, the global mean being about 0.12). The globe from orbit and the ground on foot are both
 * drawn with it, so the way down from one to the other meets no change of air. The aerosols are what
 * pale the horizon and the limb, light the haze round the Sun and the glint, and whiten the far land
 * rather than redden it.
 */
export const CLEAR_DAY_AEROSOLS = 8;
export function clearDayAir(air: AirModel): AirModel {
  const k = CLEAR_DAY_AEROSOLS;
  const extra = air.mieExtinction * air.mieScale * (k - 1);
  return { ...air, mieExtinction: air.mieExtinction * k, mieScattering: air.mieScattering * k, verticalDepth: air.verticalDepth.map((t) => t + extra) as [number, number, number] };
}

/**
 * Sunlight that reaches the eye along a line grazing the planet `heightRadii` above its ground (the
 * Sun seen through the limb, setting or rising behind the planet): Chapman's grazing column of the
 * whole air, thinning with the height as the Rayleigh scale height does. (r, g, b), 1 above the air.
 */
export function limbTransmittance(air: AirModel, heightRadii: number): [number, number, number] {
  const H = air.rayleighScale;
  const grazing = Math.sqrt((2 * Math.PI) / H) * Math.exp(-Math.max(0, heightRadii) / H);
  const [r, g, b] = air.verticalDepth;
  return [Math.exp(-r * grazing), Math.exp(-g * grazing), Math.exp(-b * grazing)];
}

export const LUT = { width: 256, height: 64, steps: 40 } as const;
/**
 * The multiple-scattering table: Sun elevation (cosine, -1 to 1) by height (ground to top), the
 * directions about each point (a square of them, spread evenly over the sphere) and the steps along each.
 */
export const MULTIPLE_LUT = { width: 32, height: 32, directions: 8, steps: 20 } as const;
/**
 * The ground's albedo the light scattered more than once sees below (typical land, illustrative: the
 * walk's own, ../walk/light GROUND_ALBEDO; Hillaire's and Bruneton's demonstrations take 0.1 to 0.3).
 */
const MULTIPLE_GROUND_ALBEDO = 0.15;

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

/**
 * The transmittance table: bake once (needs a renderer), then sample it with transmittanceToTop. The
 * multiple-scattering table is baked with it (it reads the transmittance) and found from the
 * transmittance table's texture (multipleScattering), so whatever is handed the one has the other.
 */
export interface TransmittanceTable {
  readonly texture: Texture;
  readonly baked: boolean;
  bake(renderer: WebGPURenderer): void;
  dispose(): void;
}

/** Each transmittance table's multiple-scattering table, by the transmittance table's texture. */
const multipleTables = new WeakMap<Texture, Texture>();

/** Table coordinates of (r, muSun) in the multiple-scattering table: the Sun's cosine across, the height up. */
function multipleUv(air: AirModel, r: FloatNode, muSun: FloatNode): Node<'vec2'> {
  const centre = (x: FloatNode, n: number): FloatNode => x.clamp(0, 1).mul(1 - 1 / n).add(0.5 / n);
  return vec2(centre(muSun.mul(0.5).add(0.5), MULTIPLE_LUT.width), centre(r.sub(1).div(air.top - 1), MULTIPLE_LUT.height));
}

/**
 * The multiple-scattering table's light for one point (Hillaire 2020, section 5.5): the second order,
 * the mean over the sphere of the light each direction brings (the sunlit air along it, scattered
 * isotropically, and the sunlit ground it may end on), and the higher orders as the geometric series of
 * f, the share of light the air about the point scatters back toward it: L2 / (1 - f).
 */
function bakeMultiple(air: AirModel, table: Texture): Vec3Node {
  const n = MULTIPLE_LUT.directions;
  const p = uv();
  const muSun = p.x.sub(0.5 / MULTIPLE_LUT.width).div(1 - 1 / MULTIPLE_LUT.width).clamp(0, 1).mul(2).sub(1);
  const r = p.y.sub(0.5 / MULTIPLE_LUT.height).div(1 - 1 / MULTIPLE_LUT.height).clamp(0, 1).mul(air.top - 1).add(1);
  const x = vec3(0, r, 0);
  const sun = vec3(sqrt(max(float(1).sub(muSun.mul(muSun)), 0)), muSun, 0);
  const [rr, rg, rb] = air.rayleigh;
  const rayleigh = vec3(rr, rg, rb);
  const second = vec3(0, 0, 0).toVar();
  const back = vec3(0, 0, 0).toVar();
  Loop(n * n, ({ i }) => {
    // Evenly over the sphere: cos(zenith) and azimuth each in n even bands. (Held in variables before
    // the steps' loop, whose own index takes the same name.)
    const k = float(i);
    const row = k.div(n).floor();
    const cosZenith = float(1).sub(row.add(0.5).mul(2 / n));
    const azimuth = k.sub(row.mul(n)).add(0.5).mul((2 * Math.PI) / n);
    const sinZenith = sqrt(max(float(1).sub(cosZenith.mul(cosZenith)), 0));
    const ray = vec3(sinZenith.mul(cos(azimuth)), cosZenith, sinZenith.mul(sin(azimuth))).toVar();
    const b = r.mul(cosZenith);
    const c = r.mul(r);
    const discGround = b.mul(b).sub(c).add(1);
    const tGround = b.negate().sub(sqrt(max(discGround, 0)));
    const hits = discGround.greaterThan(0).and(tGround.greaterThan(0)).toVar();
    const tTop = b.negate().add(sqrt(max(b.mul(b).sub(c).add(air.top * air.top), 0)));
    const dt = select(hits, tGround, tTop).div(MULTIPLE_LUT.steps).toVar();
    const through = vec3(1, 1, 1).toVar();
    Loop(MULTIPLE_LUT.steps, ({ i: step }) => {
      const q = x.add(ray.mul(float(step).add(0.5).mul(dt)));
      const rq = length(q);
      const density = densities(air, rq.sub(1));
      const scattering = rayleigh.mul(density.x).add(density.y.mul(air.mieScattering));
      const extinct = max(extinction(air, density), 1e-9);
      const kept = exp(extinct.mul(dt).negate());
      // Each step's light integrated exactly across it for its own extinction (Hillaire's energy-conserving form).
      const across = float(1).sub(kept).div(extinct);
      // Sunlight (1/4: the isotropic phase times pi) scattered at q, and the share of all light scattered there.
      second.addAssign(through.mul(scattering).mul(across).mul(sunTransmittance(air, table, rq, dot(q, sun).div(rq))).mul(0.25));
      back.addAssign(through.mul(scattering).mul(across));
      through.mulAssign(kept);
    });
    // The ground the direction ends on, sunlit, reflecting as a Lambert surface.
    const normal = normalize(x.add(ray.mul(tGround)));
    const muGround = dot(normal, sun);
    const ground = sunTransmittance(air, table, float(1), muGround).mul(max(muGround, 0)).mul(MULTIPLE_GROUND_ALBEDO);
    second.addAssign(select(hits, through.mul(ground), vec3(0, 0, 0)));
  });
  const count = n * n;
  return second.div(count).div(max(float(1).sub(back.div(count)), 1e-3));
}

/**
 * The light scattered more than once that reaches a point at radius r whose zenith makes cosine muSun
 * with the Sun, per unit of its scattering coefficient (isotropic): from the transmittance table's own
 * multiple-scattering table. Black for a table that has none.
 */
export function multipleScattering(air: AirModel, table: Texture, r: FloatNode, muSun: FloatNode): Vec3Node {
  const multiple = multipleTables.get(table);
  return multiple ? texture(multiple, multipleUv(air, min(r, air.top), muSun)).level(float(0)).rgb : vec3(0, 0, 0);
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
  const multipleTarget = new RenderTarget(MULTIPLE_LUT.width, MULTIPLE_LUT.height, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, generateMipmaps: false });
  multipleTarget.texture.minFilter = LinearFilter;
  multipleTarget.texture.magFilter = LinearFilter;
  multipleTarget.texture.wrapS = ClampToEdgeWrapping;
  multipleTarget.texture.wrapT = ClampToEdgeWrapping;
  multipleTarget.texture.name = 'explore-air-multiple-scattering';
  const multipleMaterial = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
  multipleMaterial.colorNode = Fn(() => vec4(bakeMultiple(air, target.texture), 1))();
  const multipleQuad = new QuadMesh(multipleMaterial);
  multipleTables.set(target.texture, multipleTarget.texture);
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
      // Then the light scattered more than once, which reads the transmittance just baked.
      renderer.setRenderTarget(multipleTarget);
      multipleQuad.render(renderer);
      renderer.setRenderTarget(previous);
      baked = true;
    },
    dispose() {
      target.dispose();
      material.dispose();
      multipleTarget.dispose();
      multipleMaterial.dispose();
      multipleTables.delete(target.texture);
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
