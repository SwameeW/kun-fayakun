import { InstancedBufferAttribute, Vector3, type Node, type Sprite } from 'three/webgpu';
import { abs, cameraPosition, float, instanceIndex, instancedBufferAttribute, length, log2, max, normalize, uniform, vec3 } from 'three/tsl';
import { starMaterial, starSprites } from '../starlight';

/**
 * The stars on the GPU (docs/NEIGHBOURHOOD.md, "More stars"), through the explorer's star light
 * (../starlight), one draw call a layer, every star's brightness worked out in the vertex stage:
 * - placed: stars at their places in space (parsecs from the Sun, render frame, in single precision)
 *   with their absolute magnitude; each drawn relative to the camera as (place - camera's high part)
 *   - camera's low part (the camera split into two single-precision numbers), so a star stays exact
 *   kilometres from the camera however far it is from the Sun, and as bright as its distance makes it;
 * - far: stars as directions (ICRS, octahedrally packed in two 16-bit numbers) with their magnitude
 *   as seen from the Sun (Tycho-2's, and Hipparcos's not placed), on a sphere round the camera.
 */

/** The camera's place (pc from the Sun) as two single-precision parts, for every placed layer. */
export const cameraParts = { high: uniform(new Vector3()), low: uniform(new Vector3()) };

export function setCameraParts(camera: readonly [number, number, number]): void {
  const hx = Math.fround(camera[0]);
  const hy = Math.fround(camera[1]);
  const hz = Math.fround(camera[2]);
  cameraParts.high.value.set(hx, hy, hz);
  cameraParts.low.value.set(camera[0] - hx, camera[1] - hy, camera[2] - hz);
}

/** log10(2), for magnitudes from log2. */
const LOG10_2 = 0.30102999566;

export interface PlacedLayer {
  readonly sprite: Sprite;
  /** A light multiple for the whole layer (the stars' fade beyond the galaxy), and for one star (the one drawn up close as a disc). */
  readonly light: { value: number };
  readonly focus: { value: number };
  readonly focusLight: { value: number };
  dispose(): void;
}

/** Placed stars: `stars` holds x, y, z (pc from the Sun) and absolute V for each; `colours` its tint (r, g, b, 0-255). */
export function placedLayer(stars: Float32Array, colours: Uint8Array, name: string): PlacedLayer {
  const count = stars.length / 4;
  const star = instancedBufferAttribute(new InstancedBufferAttribute(stars, 4)) as unknown as Node<'vec4'>;
  const tint = instancedBufferAttribute(new InstancedBufferAttribute(colours, 4, true)) as unknown as Node<'vec4'>;
  const light = uniform(1);
  const focus = uniform(-1, 'int');
  const focusLight = uniform(1);
  // Exact differences of single-precision numbers, then the camera's remainder.
  const rel = star.xyz.sub(cameraParts.high).sub(cameraParts.low);
  const r = max(length(rel), float(1e-14));
  const magnitude = star.w.add(log2(r).mul(5 * LOG10_2)).sub(5);
  const mine = instanceIndex.toInt().equal(focus).select(focusLight, float(1));
  const material = starMaterial(rel, magnitude, tint.xyz, light.mul(mine), false);
  const sprite = starSprites(material, count, name);
  sprite.renderOrder = 1;
  return {
    sprite,
    light,
    focus: focus,
    focusLight,
    dispose() {
      sprite.geometry.dispose();
      material.dispose();
    },
  };
}

export interface FarLayer {
  readonly sprite: Sprite;
  readonly light: { value: number };
  /** The sphere's radius round the camera (render units). */
  readonly radius: { value: number };
  dispose(): void;
}

/**
 * Stars as directions: `directions` two 16-bit numbers each (ICRS, octahedral), `colours` its tint
 * and its V magnitude's byte ((V + 1.5) * 16) in the fourth; turned into the render frame by the
 * obliquity (the explorer's ecliptic frame: x to the equinox, y to the ecliptic's north).
 */
export function farLayer(directions: Uint16Array, colours: Uint8Array, obliquity: number, name: string, depthTest = false): FarLayer {
  const count = directions.length / 2;
  const packed = instancedBufferAttribute(new InstancedBufferAttribute(directions, 2, true)) as unknown as Node<'vec2'>;
  const tint = instancedBufferAttribute(new InstancedBufferAttribute(colours, 4, true)) as unknown as Node<'vec4'>;
  const light = uniform(1);
  const radius = uniform(1e9);
  // The octahedron unfolded: z = 1 - |x| - |y|, the lower half folded back over the upper.
  const e = packed.mul(2).sub(1);
  const z = float(1).sub(abs(e.x)).sub(abs(e.y));
  const t = max(z.negate(), 0);
  const x = e.x.add(e.x.greaterThanEqual(0).select(t.negate(), t));
  const y = e.y.add(e.y.greaterThanEqual(0).select(t.negate(), t));
  const icrs = normalize(vec3(x, y, z));
  // ICRS to the ecliptic of J2000 (about x by the obliquity), then (x, y, z) to the render frame's (x, z, -y).
  const s = Math.sin(obliquity);
  const c = Math.cos(obliquity);
  const dir = vec3(icrs.x, icrs.y.mul(-s).add(icrs.z.mul(c)), icrs.y.mul(-c).sub(icrs.z.mul(s)));
  const magnitude = tint.w.mul(255 / 16).sub(1.5);
  const material = starMaterial(cameraPosition.add(dir.mul(radius)), magnitude, tint.xyz, light, depthTest);
  const sprite = starSprites(material, count, name);
  sprite.renderOrder = 0;
  return {
    sprite,
    light,
    radius,
    dispose() {
      sprite.geometry.dispose();
      material.dispose();
    },
  };
}
