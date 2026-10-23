import {
  BackSide,
  CustomBlending,
  Mesh,
  MeshBasicNodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SphereGeometry,
  type Data3DTexture,
  type Node,
  type UniformNode,
} from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  clamp,
  exp,
  float,
  max,
  mix,
  normalize,
  positionWorld,
  pow,
  smoothstep,
  texture3D,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import type { QualityTier } from '../../core/types';

/**
 * The hot, glowing, opaque plasma of the early universe, shared by Chapter 1
 * (where it forms as the light fills space) and Chapter 2 (where it clears at
 * recombination). Both chapters drive the same shader, so the moment one hands
 * over to the other is seamless by construction.
 *
 * One back-facing sphere that travels with the camera covers the screen exactly
 * once (no stacked full-screen layers). Its fragment shader marches a handful of
 * samples outward along the view ray through a world-space noise volume and
 * composites them front to back, so near glow hides far glow and camera motion
 * shows real parallax.
 *
 * The pattern lives in comoving space: positions are divided by the scale factor
 * before the noise is sampled, so as space stretches every feature grows with it.
 * The real early plasma was smooth to a few parts in 100,000; the variation here
 * is a gentle, deliberately visible exaggeration of those seeds.
 */

/** Distances (world units) of the samples along each view ray, nearest first, per quality tier. */
const SAMPLE_DEPTHS: Readonly<Record<QualityTier, readonly number[]>> = {
  high: [0.4, 0.9, 1.5, 2.2, 3.1, 4.2, 5.7, 7.5],
  mid: [0.5, 1.2, 2.1, 3.3, 5.0, 7.5],
  low: [0.5, 1.4, 2.8, 4.8, 7.5],
};
/** World units → noise texture coordinates (the tile repeats every 1 / NOISE_SCALE units). */
const NOISE_SCALE = 0.075;
/** Absorption per world unit at full density: optical depth ≈ 3 across the march, so the medium is opaque. */
const ABSORPTION = 0.7;
/** Drift of the noise layers in texture units per second of flow time (slow; never a pulse). */
const DRIFT_A = [0.0035, 0.0018, -0.0052] as const;
const DRIFT_B = [-0.0041, 0.0029, 0.0023] as const;
const DRIFT_C = [0.0062, -0.0047, 0.0031] as const;
/** Overall emission. The hottest cores reach scene luminance ≈ 0.85 and bloom softly; the rest glows below the threshold. */
const EMISSION = 0.74;
/** Sphere radius: anything between the camera's near and far planes works; the shader only uses the view direction. */
const SHELL_RADIUS = 4;

/**
 * A glowing body's colour by "heat" 0..1, roughly like a cooling blackbody:
 * dark → deep red → orange → gold. Dimmer always means redder, so the medium
 * reads as glowing light at every brightness, never as brown haze; cooling the
 * plasma is just sliding down this ramp.
 */
const glowRamp = (heat: Node<'float'>) =>
  vec3(heat.mul(1.3), pow(heat, 2.6).mul(0.62), pow(heat, 5).mul(0.2));

export interface MediumState {
  /** Comoving scale factor (1 = as authored): the pattern grows as space stretches. */
  scale: number;
  /** Seconds of slow drift (ambient motion). */
  flow: number;
  /** 0 = transparent, 1 = the designed optical depth (opaque). */
  density: number;
  /** Radiance multiplier (1 = as designed). */
  emission: number;
  /** 0 = a perfectly uniform glow, 1 = the full (exaggerated) structure. */
  contrast: number;
  /** 0 = opaque plasma, 1 = cleared: near layers clear first and the densest, hottest cores last. */
  clear: number;
  /**
   * 0..1: how much of the medium has condensed. Below 1 only the densest regions exist, at
   * full brightness, so the plasma gathers as islands of light that spread (never as a dim haze).
   */
  coverage: number;
  /**
   * Added heat (usually 0): slides the whole medium along the incandescent ramp. Negative
   * values cool it, which is how a scene dims it: a dimmer glow must be a redder one.
   */
  heatBoost: number;
  /** Draw even when invisible, so its pipeline compiles on the chapter's first frame. */
  warmUp: boolean;
}

export function createMediumState(): MediumState {
  return { scale: 1, flow: 0, density: 1, emission: 1, contrast: 1, clear: 0, coverage: 1, heatBoost: 0, warmUp: false };
}

export interface PlasmaMedium {
  readonly mesh: Mesh;
  /** Updates the shader inputs; call after the camera has moved this frame. */
  update(state: MediumState, cameraPositionWorld: { x: number; y: number; z: number }): void;
  /** Number of samples along each ray follows the quality tier. */
  setTier(tier: QualityTier): void;
  dispose(): void;
}

const v3 = (c: readonly [number, number, number]) => vec3(c[0], c[1], c[2]);

type FloatUniform = UniformNode<'float', number>;

interface Uniforms {
  scale: FloatUniform;
  flow: FloatUniform;
  density: FloatUniform;
  emission: FloatUniform;
  contrast: FloatUniform;
  clear: FloatUniform;
  heatBoost: FloatUniform;
  coverage: FloatUniform;
}

function buildMaterial(noise: Data3DTexture, depths: readonly number[], u: Uniforms): MeshBasicNodeMaterial {
  const colour = Fn(() => {
    const dir = normalize(positionWorld.sub(cameraPosition));
    const driftA = v3(DRIFT_A).mul(u.flow);
    const driftB = v3(DRIFT_B).mul(u.flow);
    const driftC = v3(DRIFT_C).mul(u.flow);
    // Comoving coordinates: divide by the scale factor, so features grow as space stretches.
    const toNoise = float(NOISE_SCALE).div(u.scale);
    const radiance = vec3(0).toVar();
    const transmittance = float(1).toVar();
    const last = depths.length - 1;
    depths.forEach((depth, i) => {
      const previous = i === 0 ? 0 : (depths[i - 1] ?? 0);
      // Fixed depths: the medium varies smoothly, so the march shows no slices, and per-pixel
      // jitter (tried) turns steep density edges into sand.
      const d = float(depth);
      const along = i / last;
      const p = cameraPosition.add(dir.mul(d)).mul(toNoise);
      const broad = texture3D(noise, p.add(driftA)).r;
      const fine = texture3D(noise, p.mul(2.9).add(vec3(0.37, 0.11, 0.73)).add(driftB)).r;
      const grain = texture3D(noise, p.mul(7.3).add(vec3(0.71, 0.53, 0.19)).add(driftC)).r;
      // Ridged fine noise draws thin bright filaments through the broad billows.
      const ridge = float(1).sub(fine.mul(2).sub(1).abs());
      const raw = broad.mul(0.62).add(ridge.mul(0.22)).add(grain.mul(0.16));
      const n = mix(float(0.5), smoothstep(0.24, 0.8, raw), u.contrast);
      // Near samples clear first, so the glow recedes from the viewer as it fades.
      const clear = clamp(u.clear.mul(1.25).sub(0.25 * along), 0, 1);
      const remaining = float(1).sub(clear);
      // Thin gaps let deeper glow show through and nearer layers are thinner, so
      // structure at several depths shows at once. As it clears, thin regions go
      // first and the densest, hottest cores last.
      // Partial coverage raises the threshold: only the densest regions exist, at full brightness.
      const low = clear.mul(0.7).add(mix(float(1.02), float(0.15), u.coverage));
      const high = max(low.add(0.3), clear.mul(0.35).add(0.85));
      const density = smoothstep(low, high, n)
        .mul(remaining)
        .mul(0.5 + 0.5 * along)
        .mul(u.density);
      // Hot cores run up to gold-white and just reach the bloom; cool lanes sink to deep red.
      // Kept in [0, 1.32]: the ramp raises heat to fractional powers (undefined below 0), and
      // above ~1.32 its blue catches up and the light turns neutral grey.
      // Thin, partly condensed plasma is cooler: dimmer must always mean redder, never brown.
      const condensed = mix(float(0.55), float(1), u.coverage);
      const heat = clamp(
        pow(n, 1.7).mul(1.0).add(0.34).mul(clear.mul(-0.7).add(1)).mul(1 - 0.1 * along).mul(condensed).add(u.heatBoost),
        0,
        1.32,
      );
      const glow = glowRamp(heat).mul(EMISSION).mul(u.emission);
      const alpha = float(1).sub(exp(density.mul(-ABSORPTION * Math.max(0.05, depth - previous))));
      radiance.addAssign(glow.mul(alpha).mul(transmittance));
      transmittance.mulAssign(float(1).sub(alpha));
    });
    // The plasma beyond the last sample: the farthest glow, last to fade and reddest.
    const farClear = clamp(u.clear.mul(1.25).sub(0.25), 0, 1);
    const farAlpha = pow(float(1).sub(farClear), 2).mul(clamp(u.density, 0, 1)).mul(u.coverage.mul(u.coverage));
    const farGlow = glowRamp(clamp(farClear.mul(-0.7).add(1).mul(0.5).add(u.heatBoost), 0, 1.32)).mul(EMISSION).mul(u.emission);
    radiance.addAssign(farGlow.mul(farAlpha).mul(transmittance));
    transmittance.mulAssign(float(1).sub(farAlpha));
    // Premultiplied: radiance already carries each layer's coverage.
    return vec4(radiance, float(1).sub(transmittance));
  });

  const material = new MeshBasicNodeMaterial();
  material.colorNode = colour();
  material.side = BackSide;
  material.transparent = true;
  // The shader outputs premultiplied colour, so blend it as such (three would premultiply again).
  material.blending = CustomBlending;
  material.blendSrc = OneFactor;
  material.blendDst = OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = OneFactor;
  material.blendDstAlpha = OneMinusSrcAlphaFactor;
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  return material;
}

export function createPlasmaMedium(noise: Data3DTexture, tier: QualityTier): PlasmaMedium {
  const u: Uniforms = {
    scale: uniform(1),
    flow: uniform(0),
    density: uniform(1),
    emission: uniform(1),
    contrast: uniform(1),
    clear: uniform(0),
    heatBoost: uniform(0),
    coverage: uniform(1),
  };
  const materials = new Map<QualityTier, MeshBasicNodeMaterial>();
  const materialFor = (t: QualityTier): MeshBasicNodeMaterial => {
    let m = materials.get(t);
    if (!m) {
      m = buildMaterial(noise, SAMPLE_DEPTHS[t], u);
      materials.set(t, m);
    }
    return m;
  };

  const geometry = new SphereGeometry(SHELL_RADIUS, 32, 16);
  const mesh = new Mesh(geometry, materialFor(tier));
  mesh.name = 'plasma-medium';
  mesh.frustumCulled = false;
  // No depth test: it is the medium the camera sits in, so it lies over anything behind it.
  mesh.renderOrder = -10;

  return {
    mesh,
    update(state, cameraPositionWorld) {
      u.scale.value = Math.max(1e-3, state.scale);
      u.flow.value = state.flow;
      u.density.value = state.density;
      u.emission.value = state.emission;
      u.contrast.value = state.contrast;
      u.clear.value = state.clear;
      u.heatBoost.value = state.heatBoost;
      u.coverage.value = state.coverage;
      mesh.position.set(cameraPositionWorld.x, cameraPositionWorld.y, cameraPositionWorld.z);
      mesh.visible = state.warmUp || (state.clear < 1 && state.density > 0 && state.emission > 0 && state.coverage > 0);
    },
    setTier(t) {
      mesh.material = materialFor(t);
    },
    dispose() {
      geometry.dispose();
      for (const m of materials.values()) m.dispose();
      materials.clear();
    },
  };
}
