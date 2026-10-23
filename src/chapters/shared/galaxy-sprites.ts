import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  InstancedBufferAttribute,
  PointsNodeMaterial,
  Sprite,
  Vector3,
  type Node,
} from 'three/webgpu';
import {
  abs,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  hash,
  instancedBufferAttribute,
  instanceIndex,
  length,
  max,
  mix,
  pow,
  select,
  sin,
  smoothstep,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
} from 'three/tsl';

/**
 * Galaxies as tiny sprites: each a soft elliptical disc at its own orientation and axis
 * ratio (a disc seen at some angle), spirals blue-white and ellipticals golden. Light is
 * redshifted by distance from the viewer: as space stretches, farther galaxies are
 * stretched redder (and dimmer), whichever galaxy the camera stands near, so there is no
 * special centre. Positions are comoving; `scale` is the scale factor that stretches them.
 * One draw call; per-galaxy variety comes from hashes of the instance index.
 */

export interface GalaxySpritesOptions {
  name: string;
  /** Comoving positions, xyz per galaxy. Any prefix must be a fair sample (lower tiers draw one). */
  positions: Float32Array;
  /** Optional per-galaxy brightness weight (one float each), e.g. from survey depth. */
  weights?: Float32Array;
  /** Optional measured redshift of each galaxy (as seen from Earth), shown in proportion to `measuredRedshift`. */
  redshifts?: Float32Array;
}

export interface GalaxySpritesState {
  /** Scale factor: physical position = comoving position × scale. */
  scale: number;
  brightness: number;
  /** Redshift added per world unit of distance from the viewer (0 = no reddening). */
  redshiftPerUnit: number;
  /** Sprite size at REFERENCE_DISTANCE, CSS pixels. */
  sizePx: number;
  /** Distance (world units) at which sprites have sizePx; nearer ones grow, up to `maxGrowth` times (default 6). */
  referenceDistance: number;
  maxGrowth?: number;
  /** How much of each galaxy's measured redshift (option `redshifts`) colours its light, 0 to 1. */
  measuredRedshift?: number;
  /**
   * Light of galaxies whose measured redshift is below and above `limit` (two parts of a survey
   * sampled differently). `belowKeep` draws only that share of the lower band (a fixed random
   * choice), each brighter in proportion: the same light from far fewer sprites when they are faint.
   */
  bands?: { limit: number; below: number; above: number; belowKeep?: number };
  /**
   * Emphasis of one slice of the field: galaxies farther than `halfThickness` (position units) from the
   * plane through the origin with unit normal `normal` are dimmed to `outside`, by `amount` (0 to 1).
   */
  slab?: { normal: readonly [number, number, number]; halfThickness: number; outside: number; amount: number };
  /** Colour multiplier for the whole field (e.g. bluer light in a collapsing universe). */
  tint?: readonly [number, number, number];
  /**
   * An artistic fold (Chapter 10, labelled as art): the field rolls about the horizontal axis
   * through the origin, more the farther a galaxy is above or below it. 0 = none.
   */
  fold?: number;
}

export interface GalaxySprites {
  readonly object: Sprite;
  update(state: GalaxySpritesState): void;
  /** Draw only the first `count` galaxies (a fair subsample). */
  setCount(count: number): void;
  readonly total: number;
  dispose(): void;
}

const SPIRAL = vec3(0.72, 0.82, 1.0);
const ELLIPTICAL = vec3(1.0, 0.84, 0.62);
/** Light stretched far into the red keeps its brightness profile but loses its blue. */
const STRETCHED = vec3(1.0, 0.3, 0.12);
const LUMA = vec3(0.2126, 0.7152, 0.0722);

function createQuad(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  return geometry;
}

export function createGalaxySprites(options: GalaxySpritesOptions): GalaxySprites {
  const total = Math.floor(options.positions.length / 3);
  const weights = options.weights ?? new Float32Array(total).fill(1);
  const position = instancedBufferAttribute(new InstancedBufferAttribute(options.positions, 3)) as unknown as Node<'vec3'>;
  const weight = instancedBufferAttribute(new InstancedBufferAttribute(weights, 1)) as unknown as Node<'float'>;

  const uScale = uniform(1);
  const uBrightness = uniform(1);
  const uRedshift = uniform(0);
  const uSize = uniform(3);
  const uReference = uniform(20);
  const uMaxGrowth = uniform(6);
  const uMeasured = uniform(0);
  const measured = options.redshifts
    ? (instancedBufferAttribute(new InstancedBufferAttribute(options.redshifts, 1)) as unknown as Node<'float'>)
    : float(0);

  const seed = instanceIndex.mul(5);
  const kind = hash(seed);
  const angle = hash(seed.add(1)).mul(Math.PI);
  const flatness = mix(float(0.25), float(1), hash(seed.add(2)));
  const luck = hash(seed.add(3));

  const uFold = uniform(0);
  const uTint = uniform(new Vector3(1, 1, 1));
  const flat = position.mul(uScale);
  const foldAngle = flat.y.mul(uFold).mul(0.11);
  const world = vec3(
    flat.x,
    flat.y.mul(cos(foldAngle)).sub(flat.z.mul(sin(foldAngle))).mul(float(1).sub(uFold.mul(0.35))),
    flat.y.mul(sin(foldAngle)).add(flat.z.mul(cos(foldAngle))),
  );
  const distance = max(length(world.sub(cameraPosition)), 1e-3);
  const redshift = distance.mul(uRedshift).add(measured.mul(uMeasured));
  const uBandLimit = uniform(0);
  const uBelow = uniform(1);
  const uAbove = uniform(1);
  const uBelowKeep = uniform(1);
  const kept = select(hash(seed.add(4)).lessThan(uBelowKeep), uBelow.div(max(uBelowKeep, 1e-3)), float(0));
  const band = select(measured.lessThan(uBandLimit), kept, uAbove);
  const uSlabNormal = uniform(new Vector3(0, 1, 0));
  const uSlabHalf = uniform(1);
  const uSlabOutside = uniform(1);
  const uSlabAmount = uniform(0);
  const inSlab = float(1).sub(smoothstep(uSlabHalf, uSlabHalf.mul(1.5), abs(dot(position, uSlabNormal))));
  const slab = mix(float(1), mix(uSlabOutside, float(1), inSlab), uSlabAmount);
  const intrinsic = mix(SPIRAL, ELLIPTICAL, smoothstep(0.55, 0.75, kind));
  const reddened = mix(intrinsic, STRETCHED.mul(dot(intrinsic, LUMA).mul(1.6)), smoothstep(0, 1.4, redshift));
  // Stretched light arrives fainter (fewer photons per second, each of lower energy).
  const dimming = pow(float(1).add(redshift), -1);
  const near = smoothstep(0.3, 1.5, distance);
  const brightness = uBrightness.mul(weight).mul(luck.mul(0.7).add(0.5)).mul(dimming).mul(near).mul(band).mul(slab);
  const size = uSize.mul(luck.mul(0.9).add(0.6)).mul(clamp(uReference.div(distance), 0.5, uMaxGrowth));

  const material = new PointsNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    sizeAttenuation: false,
    fog: false,
  });
  material.positionNode = world;
  material.sizeNode = select(brightness.greaterThan(1e-4), size, float(0));
  // Elliptical disc: rotate the sprite's uv by the galaxy's angle and squash one axis.
  const c = uv().sub(0.5).mul(2);
  const a = varying(angle);
  const rotated = vec2(c.x.mul(cos(a)).sub(c.y.mul(sin(a))), c.x.mul(sin(a)).add(c.y.mul(cos(a))));
  const squashed = vec2(rotated.x, rotated.y.div(varying(flatness)));
  const r2 = dot(squashed, squashed);
  const profile = exp(r2.mul(-9)).mul(1.2).add(exp(r2.mul(-2.5)).mul(0.25)).mul(max(float(1).sub(dot(c, c)), 0));
  material.colorNode = varying(reddened.mul(uTint)).mul(profile).mul(varying(brightness));
  material.opacityNode = float(1);

  const geometry = createQuad();
  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.count = total;
  sprite.name = options.name;
  sprite.frustumCulled = false;

  return {
    object: sprite,
    total,
    update(state) {
      uScale.value = state.scale;
      uBrightness.value = state.brightness;
      uRedshift.value = state.redshiftPerUnit;
      uSize.value = state.sizePx;
      uReference.value = state.referenceDistance;
      uMaxGrowth.value = state.maxGrowth ?? 6;
      uMeasured.value = state.measuredRedshift ?? 0;
      uFold.value = state.fold ?? 0;
      uTint.value.set(...(state.tint ?? [1, 1, 1]));
      uBandLimit.value = state.bands?.limit ?? 0;
      uBelow.value = state.bands?.below ?? 1;
      uAbove.value = state.bands?.above ?? 1;
      uBelowKeep.value = state.bands?.belowKeep ?? 1;
      const slabState = state.slab;
      uSlabAmount.value = slabState?.amount ?? 0;
      if (slabState) {
        uSlabNormal.value.set(...slabState.normal);
        uSlabHalf.value = slabState.halfThickness;
        uSlabOutside.value = slabState.outside;
      }
      sprite.visible = state.brightness > 1e-4;
    },
    setCount(count) {
      sprite.count = Math.max(1, Math.min(total, Math.floor(count)));
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/** Comoving positions for a cosmic-scale field of galaxies: clustered groups plus a scattered field. */
export function clusteredField(count: number, radius: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const random = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const inBall = (r: number, out: Vector3): Vector3 => {
    for (;;) {
      out.set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1);
      if (out.lengthSq() <= 1) return out.multiplyScalar(r);
    }
  };
  const centres = Array.from({ length: Math.max(8, Math.round(count / 120)) }, () => inBall(radius * 0.92, new Vector3()));
  const out = new Float32Array(count * 3);
  const p = new Vector3();
  for (let i = 0; i < count; i += 1) {
    if (random() < 0.62) {
      // A member of a group: Gaussian scatter about its centre.
      const centre = centres[Math.floor(random() * centres.length)] ?? p;
      const g = (): number => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random());
      p.set(centre.x + g() * radius * 0.035, centre.y + g() * radius * 0.035, centre.z + g() * radius * 0.035);
    } else {
      inBall(radius, p);
    }
    out[i * 3] = p.x;
    out[i * 3 + 1] = p.y;
    out[i * 3 + 2] = p.z;
  }
  // Shuffle so any prefix is a fair sample.
  for (let i = count - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    for (let k = 0; k < 3; k += 1) {
      const a = out[i * 3 + k] ?? 0;
      out[i * 3 + k] = out[j * 3 + k] ?? 0;
      out[j * 3 + k] = a;
    }
  }
  return out;
}
