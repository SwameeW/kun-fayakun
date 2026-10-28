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
  min,
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
 *
 * Once the stars light, the same particles also carry the gas they ionise
 * (reionisation.ts): a soft rose skin where a bubble's front is passing, a fainter rose
 * inside it. That is the gas's (its own tag says so, apart from the dark matter's false
 * colour): light added in the thin gas, and where the dark matter is bright a lean of its
 * colour toward rose at the same luminance, never more light there.
 */

/** The web's soft spherical edge (fractions of the half box): it fades out between these. */
export const WEB_EDGE = [0.62, 0.98] as const;
/** The same for the first stars, a little inside it, so no star shines where the web has faded. */
export const STAR_EDGE = [0.55, 0.85] as const;

function createQuad(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  return geometry;
}

/** Soft round sprite: bright core, gentle halo (softer as `sharpness` falls). */
function softDisc(sharpness: Node<'float'>): Node<'float'> {
  const c = uv().sub(0.5).mul(2);
  const r2 = dot(c, c);
  return exp(r2.mul(sharpness).negate()).mul(max(float(1).sub(r2), 0));
}

/** Displacement and linear density at Lagrangian position q (world units), from the field texture. */
function sampleField(field: Data3DTexture, q: Node<'vec3'>, box: number) {
  // Vertex-stage fetch: explicit level 0 (no derivatives in the vertex stage).
  return texture3D(field, q.div(box).add(0.5)).level(float(0));
}

export interface WebParticles {
  readonly object: Sprite;
  /**
   * Call each frame. growth and brightness are the web's; the rest are the ionised gas's: clock is
   * seconds after `stars` at the film's normal pace (the gas field's own time), gas its light (0 to
   * 1), veil how much the still-neutral gas dims the dark matter's light there (0 to VEIL_MAX).
   */
  update(state: { growth: number; brightness: number; clock: number; gas: number; veil: number }): void;
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

/**
 * Ionised gas (an illustration): the pink of hydrogen's recombination light, as H II regions are
 * photographed, on the passing front; paler inside the bubble. Clear of the dark matter's violet to
 * blue-white and of the galaxies' warm glow.
 */
const FRONT_COLOR = new Color(1.0, 0.44, 0.64);
const INSIDE_COLOR = new Color(0.92, 0.58, 0.78);
/**
 * The gas's light: per particle on the front, and inside a bubble as a share of the dark matter's light
 * there (counted only up to INSIDE_CAP), both softened where particles crowd. Where the dark matter is
 * bright, the ionised gas shows as a shift of its colour toward rose (INSIDE_TINT, at the same
 * luminance) rather than as more light, so the knots never brighten. Front particles in thin gas grow
 * by up to FRONT_GLOW of their size, their light spread wider rather than raised.
 */
const FRONT_LIGHT = 0.1;
const INSIDE_LIGHT = 0.9;
const INSIDE_CAP = 0.06;
const INSIDE_TINT = 0.16;
const FRONT_GLOW = 0.8;
/** Luminance weights of linear sRGB (Rec. 709), and the rose's own luminance. */
const LUMA = vec3(0.2126, 0.7152, 0.0722);
const INSIDE_LUMINANCE = 0.2126 * INSIDE_COLOR.r + 0.7152 * INSIDE_COLOR.g + 0.0722 * INSIDE_COLOR.b;
/** The most the neutral gas may dim the dark matter's light where it still lies (15%). */
export const VEIL_MAX = 0.15;
/**
 * Thickness of the front's bright skin, world units (about three particles' spacing on High), wider on
 * sparser tiers so it still reads as a surface.
 */
const SKIN_UNITS = 1.4;
const SKIN_PER_SPARSENESS = 0.35;
const FRONT_GAIN_PER_SPARSENESS = 0.32;

export function createWebParticles(field: Data3DTexture, box: number, ionisation: { texture: Data3DTexture }): WebParticles {
  const uGrowth = uniform(0);
  const uBrightness = uniform(0);
  const uSide = uniform(100);
  const uSize = uniform(BASE_SIZE);
  const uGain = uniform(1);
  const uClock = uniform(-1000);
  const uGas = uniform(0);
  const uVeil = uniform(0);
  const uSkin = uniform(SKIN_UNITS);
  const uFrontGain = uniform(1);
  const uGlow = uniform(FRONT_GLOW);

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
  const edge = float(1).sub(smoothstep(WEB_EDGE[0], WEB_EDGE[1], radius));
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

  // The gas at this particle's own q: when the front reaches it (R), how fast it is going then (G),
  // and its light there (B). How far behind the front the particle is, in world units, keeps the skin
  // one thickness as a bubble slows; its leading edge is sharper than its wake.
  const gasField = texture3D(ionisation.texture, q.div(box).add(0.5)).level(float(0));
  const behind = uClock.sub(gasField.x).mul(gasField.y);
  const across = behind.div(select(behind.lessThan(0), uSkin.mul(0.3), uSkin));
  const front = exp(across.mul(across).negate());
  const ionised = smoothstep(uSkin.mul(-0.5), uSkin.mul(0.5), behind);
  // The front's light: strongest per particle where they are sparse (it shows the bubble's shape across
  // the voids), soft where they crowd. Inside, the ionised gas glows faintly in the thin gas, and where
  // the dark matter is bright it shows as rose in its colour, at the same luminance.
  const thin = min(gasField.z, 1);
  const frontLight = uGas.mul(uFrontGain).mul(edge).mul(gasField.z.mul(thin)).mul(luck.mul(0.6).add(0.7)).mul(front).mul(FRONT_LIGHT);
  // The neutral gas's veil over the dark matter, lifted where the gas is ionised.
  const darkLight = brightness.mul(float(1).sub(uVeil.mul(float(1).sub(ionised))));
  const insideLight = min(darkLight, INSIDE_CAP).mul(thin.mul(thin)).mul(uGas).mul(ionised).mul(INSIDE_LIGHT);
  const total = darkLight.add(frontLight).add(insideLight);
  const falseColour = mix(vec3(VOID_COLOR.r, VOID_COLOR.g, VOID_COLOR.b), vec3(KNOT_COLOR.r, KNOT_COLOR.g, KNOT_COLOR.b), density);
  const insideRgb = vec3(INSIDE_COLOR.r, INSIDE_COLOR.g, INSIDE_COLOR.b);
  const roseAlike = insideRgb.mul(dot(falseColour, LUMA).div(INSIDE_LUMINANCE));
  const darkRgb = mix(falseColour, roseAlike, ionised.mul(uGas).mul(INSIDE_TINT));
  const rgb = darkRgb
    .mul(darkLight)
    .add(vec3(FRONT_COLOR.r, FRONT_COLOR.g, FRONT_COLOR.b).mul(frontLight))
    .add(insideRgb.mul(insideLight))
    .div(max(total, 1e-6));

  const material = new PointsNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    sizeAttenuation: false,
    fog: false,
  });
  material.positionNode = x;
  // On the front, a particle in thin gas is drawn larger and softer, so the skin glows as one surface
  // rather than as grains.
  const glow = front.mul(uGas).mul(thin);
  material.sizeNode = select(total.greaterThan(1e-4), uSize.mul(glow.mul(uGlow).add(1)), float(0));
  material.colorNode = varying(rgb);
  material.opacityNode = varying(total.mul(near)).mul(softDisc(varying(mix(float(4), float(3), glow))));

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
      uClock.value = state.clock;
      uGas.value = state.gas;
      uVeil.value = Math.min(VEIL_MAX, Math.max(0, state.veil));
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
      uSkin.value = SKIN_UNITS * sparser ** SKIN_PER_SPARSENESS;
      // The front: about as much light per area as on High (a wider skin holds more of the sparser
      // particles), its glow about as wide on screen.
      uFrontGain.value = sparser ** FRONT_GAIN_PER_SPARSENESS;
      uGlow.value = FRONT_GLOW / sparser ** 0.18;
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
  /** time = chapter time; each star lights its own delay (times `pace`) after `start`. */
  update(state: { growth: number; time: number; start: number; pace: number; galaxies: number; reducedMotion: boolean }): void;
  dispose(): void;
}

/** Blue-white light of very hot, massive stars (blackbody near 30,000 K, normalised). */
const STAR_COLOR = new Color(0.66, 0.76, 1.0);
/** Warmer, softer glow of the first galaxies gathering around them. */
const GALAXY_COLOR = new Color(1.0, 0.82, 0.62);

/**
 * `delays`: each star's ignition, seconds after `stars` at the film's normal pace (reionisation.ts,
 * ignitionDelays), worked out once on the CPU so its bubble starts from the same instant.
 */
export function createFirstStars(field: Data3DTexture, box: number, peaks: ReadonlyArray<{ q: readonly [number, number, number]; height: number }>, delays: Float32Array): FirstStars {
  const count = Math.max(1, peaks.length);
  const lagrangian = new Float32Array(count * 3);
  peaks.forEach((p, i) => {
    lagrangian.set(p.q, i * 3);
  });
  const delay = new Float32Array(count);
  delay.set(delays.subarray(0, count));
  const qAttr = instancedBufferAttribute(new InstancedBufferAttribute(lagrangian, 3));
  const delayAttr = instancedBufferAttribute(new InstancedBufferAttribute(delay, 1));

  const uGrowth = uniform(0);
  const uTime = uniform(0);
  const uStart = uniform(0);
  const uPace = uniform(1);
  const uGalaxies = uniform(0);
  const uRamp = uniform(2.5);

  const q = qAttr as unknown as Node<'vec3'>;
  const sample = sampleField(field, q, box);
  const moved = q.add(sample.xyz.mul(uGrowth));
  const x = moved.sub(floor(moved.div(box).add(0.5)).mul(box));
  const seed = instanceIndex.mul(7);
  const ignite = uStart.add((delayAttr as unknown as Node<'float'>).mul(uPace));
  // Each star brightens over uRamp seconds (an eased swell, never a flash).
  const lit = smoothstep(ignite, ignite.add(uRamp), uTime);
  // Steady light: stars do not twinkle in space.
  // The same soft spherical edge as the web, so no star shines outside it.
  const edge = float(1).sub(smoothstep(STAR_EDGE[0], STAR_EDGE[1], length(x).div(box / 2)));
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
      uPace.value = state.pace;
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
