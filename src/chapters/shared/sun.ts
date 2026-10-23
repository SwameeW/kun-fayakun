import {
  AdditiveBlending,
  FrontSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  SphereGeometry,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
  type Data3DTexture,
} from 'three/webgpu';
import { abs, dot, exp, float, max, mix, normalView, positionLocal, positionViewDirection, pow, texture3D, uniform, uv, vec3 } from 'three/tsl';
import { blackbodyRgb } from './blackbody';

/**
 * A living star: a sphere whose surface boils with granulation (convection cells that turn
 * over slowly), darker and redder toward the limb because there we see cooler, higher
 * layers, and a faint corona that the bloom carries. Its colour is the blackbody colour of
 * its temperature (the limb a cooler one), never picked by eye. Sized in world units.
 */

export interface StarState {
  time: number;
  /** Surface temperature, kelvin. */
  kelvin: number;
  /** Overall brightness multiplier (0 hides it). */
  light: number;
  /** With options.filter: the colour of a filter the star is seen through (linear RGB). Default white. */
  filter?: readonly [number, number, number];
}

export interface LivingStar {
  readonly object: Group;
  readonly radius: number;
  update(state: StarState): void;
  dispose(): void;
}

/** The limb's light comes from layers about this much cooler (a simple, physically motivated reddening). */
const LIMB_COOLING = 0.78;
/** Linear limb-darkening coefficient for visible light (I(mu) = 1 - u (1 - mu)). */
const LIMB_DARKENING = 0.6;

/** Optional extras for views other than the chapters' (left out, the star is the chapters' exactly). */
export interface LivingStarOptions {
  /**
   * Strength of a mottling much finer than the boiling cells (about a fortieth of the radius, the
   * scale of supergranules), for a star seen close enough to fill the view. Default 0 (none).
   */
  fine?: number;
  /** The star can be seen through a coloured filter (StarState.filter), as the Sun is photographed up close. */
  filter?: boolean;
}

export function createLivingStar(noise: Data3DTexture, radius: number, seed = 0.31, options?: LivingStarOptions): LivingStar {
  const object = new Group();
  object.name = 'living-star';
  const uTime = uniform(0);
  const uLight = uniform(1);
  const uCentre = uniform(new Vector3(1, 1, 1));
  const uLimb = uniform(new Vector3(1, 0.7, 0.4));

  const surface = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
  const p = positionLocal;
  const cells = texture3D(noise, p.mul(2.2).add(vec3(uTime.mul(0.012), seed, uTime.mul(-0.008)))).r;
  const fine = texture3D(noise, p.mul(7.5).add(vec3(seed, uTime.mul(0.03), 0))).r;
  const mu = abs(dot(normalView, positionViewDirection));
  const darkening = float(1).sub(float(1).sub(mu).mul(LIMB_DARKENING));
  let granulation = cells.mul(0.22).add(fine.mul(0.16)).add(0.8);
  if (options?.fine) {
    const super1 = texture3D(noise, p.mul(26).add(vec3(uTime.mul(0.004), seed + 0.5, 0))).r;
    const super2 = texture3D(noise, p.mul(61).add(vec3(0, uTime.mul(-0.006), seed))).r;
    granulation = granulation.mul(super1.mul(0.6).add(super2.mul(0.4)).sub(0.5).mul(options.fine).add(1));
  }
  const tint = mix(uLimb, uCentre, pow(mu, 0.5));
  const uFilter = options?.filter ? uniform(new Vector3(1, 1, 1)) : null;
  const disc = tint.mul(darkening).mul(granulation).mul(uLight).mul(1.15);
  surface.colorNode = uFilter ? disc.mul(uFilter) : disc;
  const geometry = new SphereGeometry(1, 96, 64);
  const body = new Mesh(geometry, surface);
  body.scale.setScalar(radius);
  body.name = 'living-star-surface';

  // Corona: a faint halo of scattered light, carried further by the bloom.
  const coronaMaterial = new SpriteNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, fog: false });
  const c = uv().sub(0.5).mul(2);
  const r = c.length();
  const halo = exp(r.mul(-5.5)).mul(0.55).add(exp(r.mul(-14)).mul(0.6)).mul(max(float(1).sub(r), 0));
  const glow = uCentre.mul(halo).mul(uLight);
  coronaMaterial.colorNode = uFilter ? glow.mul(uFilter) : glow;
  coronaMaterial.opacityNode = float(1);
  const corona = new Sprite(coronaMaterial);
  corona.scale.setScalar(radius * 7);
  corona.name = 'living-star-corona';

  object.add(corona, body);
  return {
    object,
    radius,
    update(state) {
      uTime.value = state.time;
      uLight.value = state.light;
      const centre = blackbodyRgb(state.kelvin);
      const limb = blackbodyRgb(state.kelvin * LIMB_COOLING);
      uCentre.value.set(centre[0], centre[1], centre[2]);
      uLimb.value.set(limb[0], limb[1], limb[2]);
      if (uFilter) uFilter.value.set(...(state.filter ?? ([1, 1, 1] as const)));
      object.visible = state.light > 1e-3;
    },
    dispose() {
      geometry.dispose();
      surface.dispose();
      coronaMaterial.dispose();
    },
  };
}
