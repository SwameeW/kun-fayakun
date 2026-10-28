import { AdditiveBlending, Group, Sprite, SpriteNodeMaterial, type Data3DTexture } from 'three/webgpu';
import { exp, float, Fn, If, max, mix, smoothstep, sqrt, texture3D, uniform, uv, vec3 } from 'three/tsl';
import type { Rgb } from './layers';

/**
 * What a core-collapse supernova leaves besides its debris (whose structure is in ejecta.ts):
 * - the blast wave, running ahead of the debris into the gas around the star: a thin shell, so
 *   it shows as a faint rim, brightest at its edge (a shell seen through is thickest along its
 *   limb), broken into filaments. Neutral grey, outside the elements' colours, so it is never
 *   taken for one of them (iron's blue-white least of all);
 * - the neutron star at the centre: a small steady white point;
 * - round it, a faint glow of the kind a young pulsar's wind of particles lights in the Crab
 *   Nebula. It holds still: a real one's wisps change over days, far too slowly to show here, and
 *   a pulsar's flicker (thirty times a second in the Crab) would be a flash.
 *
 * A composite, after two real remnants: Cassiopeia A has the rim and a neutron star but no such
 * glow round it, and the Crab the glow but no rim seen. Remnants with both exist (G21.5-0.9 and
 * Kes 75 among them). The Discover card says so. Sizes are illustrative.
 */

export interface RemnantMarksState {
  /** Radius of the blast wave's rim, world units. */
  rimRadius: number;
  /** Light of the rim, the neutron star and its glow (0 hides each). */
  rim: number;
  star: number;
  glow: number;
}

export interface RemnantMarks {
  readonly object: Group;
  update(state: RemnantMarksState): void;
  dispose(): void;
}

/** Faint: the rim's brightest stretch is about as bright as a single faint knot of debris. */
const RIM: Rgb = [0.1, 0.1, 0.096];
const STAR: Rgb = [1, 0.98, 0.95];
const GLOW: Rgb = [0.7, 0.74, 0.84];
/** The rim's thickness as a fraction of its radius. */
const RIM_THICKNESS = 0.03;
/** The quad is a little larger than the rim, so its soft outer edge is not clipped. */
const RIM_MARGIN = 1.04;
/** World radius of the neutron star's sprite (its glow reaches about half of it). */
const STAR_SPRITE_RADIUS = 1.3;

export function createRemnantMarks(noise: Data3DTexture, centre: readonly [number, number, number]): RemnantMarks {
  const uRim = uniform(0);
  const uStar = uniform(0);
  const uGlow = uniform(0);

  // The rim: the column through a thin shell of outer radius 1 and inner 1 - w, over its peak (at the inner edge).
  const rimMaterial = new SpriteNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, fog: false });
  const rc = uv().sub(0.5).mul(2 * RIM_MARGIN);
  const rho2 = rc.dot(rc);
  const inner = 1 - RIM_THICKNESS;
  const column = sqrt(max(float(1).sub(rho2), 0)).sub(sqrt(max(float(inner * inner).sub(rho2), 0)));
  const shell = column.div(Math.sqrt(1 - inner * inner));
  // Filaments: brighter and fainter stretches round the rim, from the noise volume. Looked up only
  // near the rim (inside, the shell seen face-on is too faint to show them): there their mean.
  const filaments = Fn(() => {
    const f = float(0.67).toVar();
    If(rho2.greaterThan(0.6), () => {
      const strands = texture3D(noise, vec3(rc.mul(2.6).add(0.3), 0.17)).level(float(0)).r;
      f.assign(mix(float(0.67), smoothstep(0.3, 0.75, strands).mul(0.65).add(0.35), smoothstep(0.6, 0.75, rho2)));
    });
    return f;
  })();
  rimMaterial.colorNode = vec3(...RIM).mul(shell.mul(filaments).mul(uRim));
  rimMaterial.opacityNode = float(1);
  const rim = new Sprite(rimMaterial);
  rim.name = 'ch06-blast-wave';
  rim.position.set(...centre);
  rim.visible = false;

  // The neutron star: a small white core with a soft halo, inside the faint still glow.
  const starMaterial = new SpriteNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, fog: false });
  const sc = uv().sub(0.5).mul(2);
  const s2 = sc.dot(sc);
  const core = exp(s2.mul(-260)).mul(5).add(exp(s2.mul(-40)).mul(0.35));
  const wisps = texture3D(noise, vec3(sc.mul(1.6).add(0.55), 0.71)).r;
  const glow = exp(s2.mul(-3.2)).mul(smoothstep(0.25, 0.8, wisps).mul(0.7).add(0.3)).mul(max(float(1).sub(s2), 0));
  starMaterial.colorNode = vec3(...STAR).mul(core.mul(uStar)).add(vec3(...GLOW).mul(glow.mul(0.16).mul(uGlow)));
  starMaterial.opacityNode = float(1);
  const star = new Sprite(starMaterial);
  star.name = 'ch06-neutron-star';
  star.position.set(...centre);
  star.scale.setScalar(2 * STAR_SPRITE_RADIUS);
  star.visible = false;

  const object = new Group();
  object.name = 'ch06-remnant-marks';
  object.add(rim, star);

  return {
    object,
    update(state) {
      uRim.value = state.rim;
      uStar.value = state.star;
      uGlow.value = state.glow;
      rim.scale.setScalar(2 * state.rimRadius * RIM_MARGIN);
      rim.visible = state.rim > 1e-3;
      star.visible = state.star > 1e-3 || state.glow > 1e-3;
    },
    dispose() {
      rimMaterial.dispose();
      starMaterial.dispose();
    },
  };
}
