/**
 * Points of light for bodies smaller than a couple of pixels. At true scale most of the solar
 * system is far below a pixel from most places (Jupiter from the Earth is about 45 arcseconds),
 * yet each body is plainly visible in the sky, as a point. So under about 2 px each body is also
 * drawn as a soft dot of constant size, its brightness from how much of its lit face is turned
 * toward the camera (the phase) and from how much light it reflects; the Sun as a brilliant point.
 * The dots are held in display terms (divided by the exposure's adaptation), and they fade in and
 * out with the disc's size, so nothing pops. One draw call, the chapters' Sun marker generalised.
 */

import { AdditiveBlending, BufferAttribute, BufferGeometry, InstancedBufferAttribute, PointsNodeMaterial, Sprite, type Node } from 'three/webgpu';
import { dot, exp, float, instancedDynamicBufferAttribute, max, uniform, uv } from 'three/tsl';
import type { Km } from '../space/origin';

export interface ImpostorDot {
  /** Where to draw it (camera-relative render position, already in scaled space), km. */
  position: Km;
  /** Linear colour at full strength (display terms, before the fade). */
  color: readonly [number, number, number];
  /** 0 to 1: how much of the dot shows (the disc's own size takes over above about 2 px). */
  opacity: number;
  /** Diameter of the glow, CSS px. */
  sizePx: number;
}

export interface Impostors {
  readonly object: Sprite;
  update(dots: readonly ImpostorDot[], compensation: number): void;
  dispose(): void;
}

export function createImpostors(maxCount: number): Impostors {
  const positions = new InstancedBufferAttribute(new Float32Array(maxCount * 3), 3);
  const colors = new InstancedBufferAttribute(new Float32Array(maxCount * 3), 3);
  const sizes = new InstancedBufferAttribute(new Float32Array(maxCount), 1);
  const uCompensation = uniform(1);
  const material = new PointsNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    sizeAttenuation: false,
    fog: false,
  });
  material.positionNode = instancedDynamicBufferAttribute(positions);
  material.sizeNode = instancedDynamicBufferAttribute(sizes);
  // A bright core and a soft halo, like a point of light seen through a lens.
  const c = uv().sub(0.5).mul(2);
  const r2 = dot(c, c);
  const profile = exp(r2.mul(-28)).add(exp(r2.mul(-6)).mul(0.22)).mul(max(float(1).sub(r2), 0));
  material.colorNode = (instancedDynamicBufferAttribute(colors) as unknown as Node<'vec3'>).mul(profile).mul(uCompensation);
  material.opacityNode = float(1);
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.frustumCulled = false;
  sprite.name = 'explore-impostors';
  sprite.renderOrder = -2;

  return {
    object: sprite,
    update(dots, compensation) {
      uCompensation.value = 1 / Math.max(compensation, 1e-6);
      let n = 0;
      for (const d of dots) {
        if (n >= maxCount || d.opacity <= 1e-3) continue;
        positions.array[3 * n] = d.position.x;
        positions.array[3 * n + 1] = d.position.y;
        positions.array[3 * n + 2] = d.position.z;
        colors.array[3 * n] = d.color[0] * d.opacity;
        colors.array[3 * n + 1] = d.color[1] * d.opacity;
        colors.array[3 * n + 2] = d.color[2] * d.opacity;
        sizes.array[n] = d.sizePx;
        n += 1;
      }
      sprite.count = Math.max(1, n);
      sprite.visible = n > 0;
      positions.needsUpdate = true;
      colors.needsUpdate = true;
      sizes.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
