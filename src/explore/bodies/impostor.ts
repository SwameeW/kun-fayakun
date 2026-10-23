/**
 * Points of light for bodies smaller than a couple of pixels. At true scale most of the solar
 * system is far below a pixel from most places (Jupiter from the Earth is about 45 arcseconds),
 * yet each body is plainly visible in the sky, as a point. So under about 2 px each body is also
 * drawn as a soft dot of constant size, its brightness from how much of its lit face is turned
 * toward the camera (the phase) and from how much light it reflects; the Sun as a brilliant point.
 * A thin ring around the dot marks where a body is in a wide view, so its name tag points at
 * something. The dots are held in display terms (divided by the exposure's adaptation), and they fade
 * in and out with the disc's size, so nothing pops. One draw call, the chapters' Sun marker generalised.
 */

import { AdditiveBlending, BufferAttribute, BufferGeometry, InstancedBufferAttribute, PointsNodeMaterial, Sprite, type Node } from 'three/webgpu';
import { exp, float, instancedDynamicBufferAttribute, length, max, uniform, uv, vec3 } from 'three/tsl';
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
  /** 0 to 1: how much of the ring marker shows. */
  marker: number;
}

export interface Impostors {
  readonly object: Sprite;
  update(dots: readonly ImpostorDot[], compensation: number): void;
  dispose(): void;
}

/** The ring marker: radius and line width, CSS px, and its colour (display terms, a soft gold). */
const MARKER = { radiusPx: 7.5, widthPx: 0.8, color: [0.5, 0.44, 0.32] } as const;

export function createImpostors(maxCount: number): Impostors {
  const positions = new InstancedBufferAttribute(new Float32Array(maxCount * 3), 3);
  const colors = new InstancedBufferAttribute(new Float32Array(maxCount * 3), 3);
  /** Per dot: the sprite's diameter, the glow's diameter (CSS px), the marker's strength. */
  const shapes = new InstancedBufferAttribute(new Float32Array(maxCount * 3), 3);
  const uCompensation = uniform(1);
  const material = new PointsNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    sizeAttenuation: false,
    fog: false,
  });
  const shape = instancedDynamicBufferAttribute(shapes) as unknown as Node<'vec3'>;
  material.positionNode = instancedDynamicBufferAttribute(positions);
  material.sizeNode = shape.x;
  // Distance from the dot's centre in CSS px.
  const d = length(uv().sub(0.5)).mul(shape.x);
  // A bright core and a soft halo, like a point of light seen through a lens.
  const g = d.div(max(shape.y.mul(0.5), 1e-3));
  const g2 = g.mul(g);
  const glow = exp(g2.mul(-28)).add(exp(g2.mul(-6)).mul(0.22)).mul(max(float(1).sub(g2), 0));
  const across = d.sub(MARKER.radiusPx).div(MARKER.widthPx);
  const ring = exp(across.mul(across).negate()).mul(shape.z);
  const tint = instancedDynamicBufferAttribute(colors) as unknown as Node<'vec3'>;
  material.colorNode = tint.mul(glow).add(vec3(...MARKER.color).mul(ring)).mul(uCompensation);
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
      for (const dot of dots) {
        if (n >= maxCount || (dot.opacity <= 1e-3 && dot.marker <= 1e-3)) continue;
        positions.array[3 * n] = dot.position.x;
        positions.array[3 * n + 1] = dot.position.y;
        positions.array[3 * n + 2] = dot.position.z;
        colors.array[3 * n] = dot.color[0] * dot.opacity;
        colors.array[3 * n + 1] = dot.color[1] * dot.opacity;
        colors.array[3 * n + 2] = dot.color[2] * dot.opacity;
        shapes.array[3 * n] = Math.max(dot.sizePx, dot.marker > 1e-3 ? 2 * (MARKER.radiusPx + 3 * MARKER.widthPx) : 0);
        shapes.array[3 * n + 1] = dot.sizePx;
        shapes.array[3 * n + 2] = dot.marker;
        n += 1;
      }
      sprite.count = Math.max(1, n);
      sprite.visible = n > 0;
      positions.needsUpdate = true;
      colors.needsUpdate = true;
      shapes.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
