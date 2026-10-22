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
} from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  clamp,
  exp,
  float,
  normalize,
  positionWorld,
  pow,
  smoothstep,
  texture3D,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';

/**
 * The glowing, opaque plasma before recombination.
 *
 * One back-facing sphere that travels with the camera covers the screen exactly
 * once (no stacked full-screen layers). Its fragment shader marches a few
 * samples outward along the view ray through a world-space noise volume and
 * composites them front to back, so near glow hides far glow and camera motion
 * shows real parallax. The early plasma was extraordinarily smooth, so the
 * variation is kept gentle: a luminous medium, never grey wisps.
 */

/** Distances (world units) of the samples along each view ray, nearest first. */
const SAMPLE_DEPTHS = [0.5, 1.2, 2.1, 3.3, 5.0, 7.5] as const;
/** World units → noise texture coordinates (the tile repeats every 1 / NOISE_SCALE units). */
const NOISE_SCALE = 0.075;
/** Absorption per world unit at full density: optical depth ≈ 3 across the march, so the medium is opaque. */
const ABSORPTION = 0.7;
/** Drift of the two noise layers in texture units per second of flow time (slow; never a pulse). */
const DRIFT_A = [0.0035, 0.0018, -0.0052] as const;
const DRIFT_B = [-0.0041, 0.0029, 0.0023] as const;
/** Overall emission. The hottest glow reaches scene luminance ≈ 0.5, under the bloom threshold, so the frame never blooms over. */
const EMISSION = 0.6;
/** Sphere radius: any size between the camera's near and far planes works; the shader only uses the view direction. */
const SHELL_RADIUS = 4;

/**
 * A glowing body's colour by "heat" 0..1, roughly like a cooling blackbody:
 * dark → deep red → orange → gold. Dimmer always means redder, so the medium
 * reads as glowing light at every brightness, never as brown haze; cooling the
 * plasma is just sliding down this ramp.
 */
const glowRamp = (heat: Node<'float'>) =>
  vec3(heat.mul(1.3), pow(heat, 3.2).mul(0.58), pow(heat, 6).mul(0.2));

export interface PlasmaState {
  /** 0 = opaque glowing plasma, 1 = transparent. */
  clear: number;
  /** Seconds of slow drift for the noise (ambient motion). */
  flow: number;
  /** Draw even when fully clear (it is then invisible), so its pipeline compiles on the chapter's first frame. */
  warmUp: boolean;
}

export interface Plasma {
  readonly mesh: Mesh;
  /** Updates the shader inputs; call after the camera has moved this frame. */
  update(state: PlasmaState, cameraPositionWorld: { x: number; y: number; z: number }): void;
  dispose(): void;
}

const v3 = (c: readonly [number, number, number]) => vec3(c[0], c[1], c[2]);

export function createPlasma(noise: Data3DTexture): Plasma {
  const uClear = uniform(0);
  const uFlow = uniform(0);

  const colour = Fn(() => {
    const dir = normalize(positionWorld.sub(cameraPosition));
    const driftA = v3(DRIFT_A).mul(uFlow);
    const driftB = v3(DRIFT_B).mul(uFlow);

    const radiance = vec3(0).toVar();
    const transmittance = float(1).toVar();
    let previousDepth = 0;
    SAMPLE_DEPTHS.forEach((depth, i) => {
      const along = i / (SAMPLE_DEPTHS.length - 1);
      const p = cameraPosition.add(dir.mul(depth)).mul(NOISE_SCALE);
      const broad = texture3D(noise, p.add(driftA)).r;
      const fine = texture3D(noise, p.mul(2.9).add(vec3(0.37, 0.11, 0.73)).add(driftB)).r;
      const n = smoothstep(0.22, 0.78, broad.mul(0.78).add(fine.mul(0.22)));

      // Near samples clear first, so the glow recedes from the viewer as it fades.
      const clear = clamp(uClear.mul(1.25).sub(0.25 * along), 0, 1);
      const remaining = float(1).sub(clear);
      // Thin gaps let deeper glow show through, and nearer layers are thinner, so
      // structure at several depths shows at once. As it clears, thin regions go
      // first and the densest, hottest cores last.
      const density = smoothstep(clear.mul(0.7).add(0.15), clear.mul(0.35).add(0.85), n)
        .mul(remaining)
        .mul(0.5 + 0.5 * along);
      const heat = pow(n, 1.6).mul(0.7).add(0.38).mul(clear.mul(-0.7).add(1)).mul(1 - 0.1 * along);
      const glow = glowRamp(heat).mul(EMISSION);

      const alpha = float(1).sub(exp(density.mul(-ABSORPTION * (depth - previousDepth))));
      radiance.addAssign(glow.mul(alpha).mul(transmittance));
      transmittance.mulAssign(float(1).sub(alpha));
      previousDepth = depth;
    });

    // The plasma beyond the last sample: the farthest glow, last to fade and reddest.
    const farClear = clamp(uClear.mul(1.25).sub(0.25), 0, 1);
    const farAlpha = pow(float(1).sub(farClear), 2);
    const farGlow = glowRamp(farClear.mul(-0.7).add(1).mul(0.5)).mul(EMISSION);
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

  const geometry = new SphereGeometry(SHELL_RADIUS, 32, 16);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'ch02-plasma';
  mesh.frustumCulled = false;
  // No depth test: it is the medium the camera sits in, so it lies over anything behind it.
  mesh.renderOrder = -10;

  return {
    mesh,
    update(state, cameraPositionWorld) {
      uClear.value = state.clear;
      uFlow.value = state.flow;
      mesh.position.set(cameraPositionWorld.x, cameraPositionWorld.y, cameraPositionWorld.z);
      mesh.visible = state.warmUp || state.clear < 1;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
