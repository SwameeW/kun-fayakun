import { AdditiveBlending, BackSide, Color, Mesh, MeshBasicNodeMaterial, SphereGeometry } from 'three/webgpu';
import {
  cameraPosition,
  cross,
  dot,
  exp,
  float,
  hash,
  max,
  normalize,
  positionWorld,
  pow,
  screenCoordinate,
  sign,
  smoothstep,
  sqrt,
  uniform,
} from 'three/tsl';
import type { Node } from 'three/webgpu';

/**
 * The light: a 3D Gaussian of emission centred on the origin, rendered
 * analytically. Each pixel integrates the Gaussian along its view ray, so the
 * same shader shows a soft point while the light is small and far away, and a
 * uniform glow in every direction once its width exceeds the camera's
 * distance (a gentle gradient remains toward where the light was densest).
 *
 * One back-facing sphere around the whole scene covers the screen exactly once
 * (a single cheap full-screen layer); only the view direction is used.
 */

/** Any radius between the camera's near and far planes works; the camera always stays well inside. */
const SHELL_RADIUS = 1000;
/** Angular scale (radians) of the point's halo. */
export const HALO_WIDTH = 0.012;
/** Static per-pixel dither (±2.5 %) so the dim, smooth gradient never shows 8-bit banding. */
const DITHER = 0.05;
/** Abramowitz–Stegun-style constant for the closed-form erf approximation (max error ~1e-4). */
const ERF_A = 0.147;

export interface GlowState {
  sigma: number;
  peak: number;
  halo: number;
  /** Linear-sRGB hue; multiplied by the radiance terms. */
  color: Color;
}

export interface Glow {
  readonly mesh: Mesh;
  update(state: GlowState): void;
  dispose(): void;
}

function erfc(x: Node<'float'>): Node<'float'> {
  const x2 = x.mul(x);
  const ax2 = x2.mul(ERF_A);
  const erfAbs = sqrt(float(1).sub(exp(x2.negate().mul(ax2.add(4 / Math.PI)).div(ax2.add(1)))));
  return float(1).sub(sign(x).mul(erfAbs));
}

export function createGlow(): Glow {
  const uInvSigma = uniform(1);
  const uPeak = uniform(0);
  const uHalo = uniform(0);
  const uColor = uniform(new Color(0, 0, 0));

  // The light is centred on the origin, so the camera's offset from it is cameraPosition.
  const dir = normalize(positionWorld.sub(cameraPosition));
  const along: Node<'float'> = dot(cameraPosition, dir);
  const across = cross(cameraPosition, dir);
  const miss2: Node<'float'> = dot(across, across);
  const toCentre2: Node<'float'> = max(dot(cameraPosition, cameraPosition), 1e-4);

  // ∫ exp(-|o + s·d|² / σ²) ds over s ≥ 0, normalised so a point seen from outside peaks at uPeak.
  const body: Node<'float'> = uPeak
    .mul(0.5)
    .mul(exp(miss2.mul(uInvSigma).mul(uInvSigma).negate()))
    .mul(erfc(along.mul(uInvSigma)));
  const facing: Node<'float'> = smoothstep(0, 0.3, along.negate().div(sqrt(toCentre2)));
  const halo: Node<'float'> = uHalo.mul(pow(miss2.div(toCentre2).div(HALO_WIDTH * HALO_WIDTH).add(1), -1.5)).mul(facing);
  const dither: Node<'float'> = hash(screenCoordinate.x.add(screenCoordinate.y.mul(8192))).sub(0.5).mul(DITHER).add(1);

  const material = new MeshBasicNodeMaterial({
    side: BackSide,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  material.colorNode = uColor.mul(body.add(halo).mul(dither));

  const geometry = new SphereGeometry(SHELL_RADIUS, 32, 16);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'ch01-glow';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;

  return {
    mesh,
    update(state) {
      uInvSigma.value = 1 / Math.max(state.sigma, 1e-4);
      uPeak.value = state.peak;
      uHalo.value = state.halo;
      uColor.value.copy(state.color);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
