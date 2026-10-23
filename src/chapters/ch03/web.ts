import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedBufferAttribute,
  PointsNodeMaterial,
  Sprite,
  type Data3DTexture,
  type Node,
} from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  floor,
  hash,
  instancedBufferAttribute,
  instanceIndex,
  length,
  max,
  mix,
  pow,
  select,
  smoothstep,
  texture3D,
  uniform,
  uv,
  varying,
  vec3,
} from 'three/tsl';

/**
 * The dark-matter web and the first stars, moved by the Zel'dovich displacement field:
 * every particle and every star is at x = q + D psi(q), computed in the vertex stage
 * from the same 3D texture, so stars sit exactly in the knots the web forms. Sized
 * sprites on both WebGPU and WebGL2 (instanced, as the Chapter 1 dust).
 */

function createQuad(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  return geometry;
}

/** Soft round sprite: bright core, gentle halo. */
function softDisc(sharpness: number): Node<'float'> {
  const c = uv().sub(0.5).mul(2);
  const r2 = dot(c, c);
  return exp(r2.mul(-sharpness)).mul(max(float(1).sub(r2), 0));
}

/** Displacement and linear density at Lagrangian position q (world units), from the field texture. */
function sampleField(field: Data3DTexture, q: Node<'vec3'>, box: number) {
  // Vertex-stage fetch: explicit level 0 (no derivatives in the vertex stage).
  return texture3D(field, q.div(box).add(0.5)).level(float(0));
}

export interface WebParticles {
  readonly object: Sprite;
  /** Growth factor and brightness; call each frame. */
  update(state: { growth: number; brightness: number }): void;
  setBudget(particles: number): void;
  dispose(): void;
}

/** Faint violet for the thinnest regions, rising to blue-white in the knots (false colour). */
const VOID_COLOR = new Color(0.22, 0.14, 0.72);
const KNOT_COLOR = new Color(0.66, 0.74, 1.0);
/** Sprite edge in CSS pixels on High; most of the light sits in the central ~2 px. */
const BASE_SIZE = 1.9;
/** Light per particle: a million of them add up, so each is faint (voids stay dark). */
const PARTICLE_LIGHT = 0.42;
const REFERENCE_COUNT = 1_000_000;

export function createWebParticles(field: Data3DTexture, box: number): WebParticles {
  const uGrowth = uniform(0);
  const uBrightness = uniform(0);
  const uSide = uniform(100);
  const uSize = uniform(BASE_SIZE);
  const uGain = uniform(1);

  // Lagrangian position: a jittered lattice cell from the instance index.
  const index = float(instanceIndex);
  const side2 = uSide.mul(uSide);
  const iz = floor(index.add(0.5).div(side2));
  const rest = index.sub(iz.mul(side2));
  const iy = floor(rest.add(0.5).div(uSide));
  const ix = rest.sub(iy.mul(uSide));
  const seed = instanceIndex.mul(4);
  const jitter = vec3(hash(seed), hash(seed.add(1)), hash(seed.add(2)));
  const q = vec3(ix, iy, iz).add(jitter).mul(float(box).div(uSide)).sub(box / 2);
  const sample = sampleField(field, q, box);
  const moved = q.add(sample.xyz.mul(uGrowth));
  // Periodic box, centred on the origin.
  const x = moved.sub(floor(moved.div(box).add(0.5)).mul(box));

  // Soft spherical edge: the web reads as a region of space, never as a cube.
  const radius = length(x).div(box / 2);
  const edge = float(1).sub(smoothstep(0.62, 0.98, radius));
  // Knots (high linear density) brighter and whiter, voids faint violet. Linear density in sigma.
  const density = clamp(sample.w.mul(0.35).add(0.5), 0, 1);
  const luck = hash(seed.add(3));
  const brightness = uBrightness
    .mul(uGain)
    .mul(edge)
    .mul(PARTICLE_LIGHT)
    .mul(mix(float(0.1), float(1.6), pow(density, 2.5)))
    .mul(luck.mul(0.6).add(0.7));
  const near = smoothstep(0.4, 2.5, length(x.sub(cameraPosition)));

  const material = new PointsNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    sizeAttenuation: false,
    fog: false,
  });
  material.positionNode = x;
  material.sizeNode = select(brightness.greaterThan(1e-4), uSize, float(0));
  material.colorNode = mix(vec3(VOID_COLOR.r, VOID_COLOR.g, VOID_COLOR.b), vec3(KNOT_COLOR.r, KNOT_COLOR.g, KNOT_COLOR.b), varying(density));
  material.opacityNode = varying(brightness.mul(near)).mul(softDisc(4));

  const geometry = createQuad();
  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.name = 'ch03-web';
  sprite.frustumCulled = false;

  return {
    object: sprite,
    update(state) {
      uGrowth.value = state.growth;
      uBrightness.value = state.brightness;
      sprite.visible = state.brightness > 1e-4;
    },
    setBudget(particles) {
      const count = Math.max(8, Math.min(REFERENCE_COUNT, particles));
      const side = Math.max(2, Math.round(Math.cbrt(count)));
      uSide.value = side;
      sprite.count = side ** 3;
      // Fewer particles on lower tiers: a little larger and brighter, so the web reads the same.
      const sparser = REFERENCE_COUNT / side ** 3;
      uSize.value = BASE_SIZE * sparser ** 0.18;
      uGain.value = sparser ** 0.55;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* First stars                                                          */
/* ------------------------------------------------------------------ */

export interface FirstStars {
  readonly object: Sprite;
  /** time = chapter time; ignitions start at `start` and spread over `spread` seconds. */
  update(state: { growth: number; time: number; start: number; spread: number; galaxies: number; reducedMotion: boolean }): void;
  dispose(): void;
}

/** Blue-white light of very hot, massive stars (blackbody near 30,000 K, normalised). */
const STAR_COLOR = new Color(0.66, 0.76, 1.0);
/** Warmer, softer glow of the first galaxies gathering around them. */
const GALAXY_COLOR = new Color(1.0, 0.82, 0.62);

export function createFirstStars(field: Data3DTexture, box: number, peaks: ReadonlyArray<{ q: readonly [number, number, number]; height: number }>): FirstStars {
  const count = Math.max(1, peaks.length);
  const lagrangian = new Float32Array(count * 3);
  const order = new Float32Array(count);
  const top = peaks[0]?.height ?? 1;
  const bottom = peaks[peaks.length - 1]?.height ?? 0;
  peaks.forEach((p, i) => {
    lagrangian.set(p.q, i * 3);
    // Highest peaks collapse (and light up) first: 0 = first, 1 = last.
    order[i] = top > bottom ? 1 - (p.height - bottom) / (top - bottom) : i / count;
  });
  const qAttr = instancedBufferAttribute(new InstancedBufferAttribute(lagrangian, 3));
  const orderAttr = instancedBufferAttribute(new InstancedBufferAttribute(order, 1));

  const uGrowth = uniform(0);
  const uTime = uniform(0);
  const uStart = uniform(0);
  const uSpread = uniform(18);
  const uGalaxies = uniform(0);
  const uRamp = uniform(2.5);

  const q = qAttr as unknown as Node<'vec3'>;
  const sample = sampleField(field, q, box);
  const moved = q.add(sample.xyz.mul(uGrowth));
  const x = moved.sub(floor(moved.div(box).add(0.5)).mul(box));
  const seed = instanceIndex.mul(7);
  const ignite = uStart.add(pow(orderAttr as unknown as Node<'float'>, 1.3).mul(uSpread)).add(hash(seed).mul(1.5));
  // Each star brightens over uRamp seconds (an eased swell, never a flash).
  const lit = smoothstep(ignite, ignite.add(uRamp), uTime);
  // Steady light: stars do not twinkle in space.
  // The same soft spherical edge as the web, so no star shines outside it.
  const edge = float(1).sub(smoothstep(0.55, 0.85, length(x).div(box / 2)));
  const strength = lit.mul(edge).mul(hash(seed.add(1)).mul(0.8).add(0.6));
  const glow = uGalaxies.mul(lit);

  const material = new PointsNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    sizeAttenuation: false,
    fog: false,
  });
  material.positionNode = x;
  // A crisp star with a soft galaxy-scale glow that grows around it later.
  material.sizeNode = select(strength.greaterThan(1e-4), float(9).add(glow.mul(30)), float(0));
  const c = uv().sub(0.5).mul(2);
  const r2 = dot(c, c);
  // A bright core (it reaches the bloom) with a faint stellar halo, and a warm galaxy glow later.
  const core = exp(r2.mul(-22)).mul(3.2).add(exp(r2.mul(-6)).mul(0.25));
  const halo = exp(r2.mul(-5)).mul(max(float(1).sub(r2), 0)).mul(glow.mul(0.3));
  const starRgb = vec3(STAR_COLOR.r, STAR_COLOR.g, STAR_COLOR.b);
  const galaxyRgb = vec3(GALAXY_COLOR.r, GALAXY_COLOR.g, GALAXY_COLOR.b);
  material.colorNode = starRgb.mul(core).add(galaxyRgb.mul(halo)).mul(varying(strength));
  material.opacityNode = float(1);

  const geometry = createQuad();
  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.count = count;
  sprite.name = 'ch03-first-stars';
  sprite.frustumCulled = false;

  return {
    object: sprite,
    update(state) {
      uGrowth.value = state.growth;
      uTime.value = state.time;
      uStart.value = state.start;
      uSpread.value = state.spread;
      uGalaxies.value = state.galaxies;
      // Reduced motion: slower swells.
      uRamp.value = state.reducedMotion ? 4 : 2.5;
      sprite.visible = state.time > state.start - 1;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
