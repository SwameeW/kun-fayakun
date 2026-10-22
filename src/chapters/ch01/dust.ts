import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, PointsNodeMaterial, Sprite } from 'three/webgpu';
import {
  cameraPosition,
  dot,
  exp,
  float,
  floor,
  hash,
  instanceIndex,
  length,
  max,
  select,
  smoothstep,
  uniform,
  uv,
  varying,
  vec3,
} from 'three/tsl';

/**
 * The comoving dust: a jittered cubic lattice of faint points that fills space.
 *
 * Positions are computed in the vertex stage from the instance index (no
 * vertex buffers) as comoving position × scale factor a, so every point moves
 * away from every other. The lattice tile repeats around the camera's
 * comoving position, which makes the field endless: there is no centre and no
 * edge, the camera is always inside it, and the repeat happens beyond the last
 * drawn distance.
 *
 * Each point's light falls off as 1/d² beyond the resolved reach, so near
 * points stand out and far ones merge into the glow (their unresolved light).
 * Points past the cut-off get size 0 and cost no fragments; the rest are tiny
 * additive sprites (low overdraw).
 *
 * Instanced sprites with PointsNodeMaterial give sized points on both WebGPU
 * (whose native points are 1 px) and WebGL2.
 */

/** Edge of the repeating comoving tile, in world units at a = 1. */
const TILE = 20;
/** Points are drawn out to CUTOFF_REACHES × reach, never past this fraction of the tile (the wrap stays out of sight). */
const CUTOFF_REACHES = 3;
const MAX_CUTOFF_FRACTION = 0.45;
/** Lattice points per side on the High tier (125³ ≈ 1.95 M points). */
const REFERENCE_SIDE = 125;
/** Sprite edge in CSS pixels on High; most of the light sits in the central ~2 px. */
const BASE_SIZE = 2.8;
/** Points fade in from this distance to the camera (world units) so nothing pops at the lens. */
const NEAR_FADE = 1.6;

export interface DustState {
  a: number;
  /** Resolved reach in world units at High-tier density (see FrameState.dustReach). */
  reach: number;
  /** Overall brightness (0 hides the dust). */
  intensity: number;
  color: Color;
}

export interface Dust {
  readonly object: Sprite;
  /** Sets the particle budget (an upper bound, e.g. ctx.quality.particles); applies live. */
  setBudget(particles: number): void;
  update(state: DustState): void;
  dispose(): void;
}

/** Points per side of the lattice for a budget: the largest cube that fits (never more points than the budget). */
export function latticeSide(particles: number): number {
  // The epsilon keeps exact cubes from rounding down.
  return Math.max(1, Math.floor(Math.cbrt(Math.max(1, particles)) + 1e-6));
}

/** A private copy of three's sprite quad, so disposing it never touches the geometry other sprites share. */
function createQuad(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  return geometry;
}

export function createDust(): Dust {
  const uScale = uniform(1);
  const uSide = uniform(REFERENCE_SIDE);
  const uReach = uniform(5);
  const uCutoff = uniform(15);
  const uIntensity = uniform(0);
  const uSize = uniform(BASE_SIZE);
  const uColor = uniform(new Color(1, 1, 1));

  // Lattice cell from the instance index. Float maths is exact here (index < 2^24) and the +0.5
  // keeps floor() away from exact multiples.
  const index = float(instanceIndex);
  const side2 = uSide.mul(uSide);
  const iz = floor(index.add(0.5).div(side2));
  const rest = index.sub(iz.mul(side2));
  const iy = floor(rest.add(0.5).div(uSide));
  const ix = rest.sub(iy.mul(uSide));
  const seed = instanceIndex.mul(4);
  const jitter = vec3(hash(seed), hash(seed.add(1)), hash(seed.add(2)));
  const comoving = vec3(ix, iy, iz).add(jitter).mul(float(TILE).div(uSide)).sub(TILE / 2);

  // Wrap into the tile centred on the camera's comoving position, then stretch by a.
  const fromEye = comoving.sub(cameraPosition.div(uScale));
  const wrapped = fromEye.sub(floor(fromEye.div(TILE).add(0.5)).mul(TILE));
  const offset = wrapped.mul(uScale);
  const distance = length(offset);

  // Brightness spread: most points faint, a few bright (luck³).
  const luck = hash(seed.add(3));
  const share = luck.mul(luck).mul(luck).mul(0.85).add(0.15);
  const inReach = distance.div(uReach);
  const falloff = float(1).div(inReach.mul(inReach).add(1));
  const far = float(1).sub(smoothstep(uCutoff.mul(0.5), uCutoff, distance));
  const near = smoothstep(NEAR_FADE * 0.3, NEAR_FADE, distance);
  const brightness = falloff.mul(far).mul(near).mul(share).mul(uIntensity);
  // Close points are drawn a little larger, which reads as depth.
  const closeness = float(1).div(inReach.mul(2.5).pow(2).add(1));
  const size = uSize.mul(luck.mul(0.5).add(0.75)).mul(closeness.mul(0.8).add(1));

  const material = new PointsNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    sizeAttenuation: false,
    fog: false,
  });
  material.alphaToCoverage = false;
  material.positionNode = cameraPosition.add(offset);
  material.sizeNode = select(brightness.greaterThan(1e-4), size, float(0));
  const centred = uv().sub(0.5).mul(2);
  const r2 = dot(centred, centred);
  material.colorNode = uColor;
  material.opacityNode = varying(brightness).mul(exp(r2.mul(-4)).mul(max(float(1).sub(r2), 0)));

  const geometry = createQuad();
  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.name = 'ch01-dust';
  sprite.frustumCulled = false;

  let side = REFERENCE_SIDE;
  let active = false;
  let tierGain = 1;
  let tierReach = 1;

  const applyCount = (): void => {
    // While the dust is dark, draw a single (invisible) instance: the pipeline stays compiled
    // and the GPU skips ~8 M vertex invocations.
    sprite.count = active ? side ** 3 : 1;
  };

  return {
    object: sprite,
    setBudget(particles) {
      side = latticeSide(particles);
      uSide.value = side;
      // Fewer points on lower tiers: resolve them further out and draw them a little larger and
      // brighter, so about as many stand out and the field reads the same.
      const sparser = REFERENCE_SIDE / side;
      uSize.value = BASE_SIZE * sparser ** 0.15;
      tierGain = sparser ** 0.25;
      tierReach = sparser ** 0.5;
      applyCount();
    },
    update(state) {
      active = state.intensity > 0;
      applyCount();
      uScale.value = state.a;
      const reach = state.reach * tierReach;
      uReach.value = reach;
      uCutoff.value = Math.min(CUTOFF_REACHES * reach, MAX_CUTOFF_FRACTION * TILE * state.a);
      uIntensity.value = state.intensity * tierGain;
      uColor.value.copy(state.color);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
