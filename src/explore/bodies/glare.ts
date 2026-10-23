/**
 * The Sun's glare: the soft light a lens and an eye scatter around a source far brighter than
 * anything else in view. Its disc is drawn by the chapters' living star; this adds the halo around
 * it, larger as the disc grows, warm toward its rim, and dimmed by the share of the disc another
 * body covers (no glare from a Sun hidden behind a planet). Held in display terms like the other
 * guides, and capped, so it never becomes a flash. One draw call.
 */

import { AdditiveBlending, BufferAttribute, BufferGeometry, PointsNodeMaterial, Sprite, Vector3 } from 'three/webgpu';
import { atan, exp, float, length, max, mix, pow, sin, uniform, uv, vec3 } from 'three/tsl';
import type { Km } from '../space/origin';

export interface GlareFrame {
  /** Where the Sun is drawn (camera-relative, scaled space), km, and its drawn radius. */
  position: Km;
  drawnRadius: number;
  /** Its disc's radius on screen, CSS px. */
  radiusPx: number;
  viewportPx: number;
  /** Share of the disc not hidden by other bodies, 0 to 1. */
  visible: number;
  /** The exposure's adaptation (the glare keeps its brightness on screen). */
  compensation: number;
  /** The solar filter the Sun is seen through, if any (white for none). */
  filter: readonly [number, number, number];
}

export interface SunGlare {
  readonly object: Sprite;
  update(frame: GlareFrame): void;
  dispose(): void;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createSunGlare(tint: readonly [number, number, number]): SunGlare {
  const uPosition = uniform(new Vector3());
  const uSize = uniform(100);
  const uStrength = uniform(0);
  /** The bright core over the disc: only while the disc is small (a large disc carries its own light). */
  const uCore = uniform(1);
  const uFilter = uniform(new Vector3(1, 1, 1));
  const material = new PointsNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    sizeAttenuation: false,
    fog: false,
  });
  material.positionNode = uPosition;
  material.sizeNode = uSize;
  const c = uv().sub(0.5).mul(2);
  const r = length(c);
  // A tight bright core over the disc, a halo, and a wide faint veil, all fading to nothing at the edge.
  const edge = max(float(1).sub(r.mul(r)), 0);
  const core = exp(r.mul(r).mul(-60)).mul(0.5).mul(uCore);
  const halo = exp(r.mul(-7.5)).mul(0.32);
  // The veil is faintly uneven around the disc, as streamers of the corona make it.
  const angle = atan(c.y, c.x);
  const streamers = sin(angle.mul(5).add(0.7)).mul(0.5).add(sin(angle.mul(9).add(2.1)).mul(0.3)).add(sin(angle.mul(14).add(4.4)).mul(0.2)).mul(0.22).add(1);
  const veil = exp(r.mul(-2.6)).mul(0.09).mul(streamers);
  // White at the disc, warming to gold outward, as light scattered by dust and the eye reddens.
  const warm = mix(vec3(...tint), vec3(1, 0.7, 0.36), pow(r, 0.55).mul(0.85));
  material.colorNode = warm.mul(uFilter).mul(core.add(halo).add(veil).mul(edge)).mul(uStrength);
  material.opacityNode = float(1);
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.frustumCulled = false;
  sprite.name = 'explore-sun-glare';
  sprite.renderOrder = -1;

  return {
    object: sprite,
    update(frame) {
      const d = Math.hypot(frame.position.x, frame.position.y, frame.position.z);
      // In front of the disc (by at least 1% of the distance, several depth steps even near the far
      // plane), so the glare lies over it and planets in front still hide it.
      const toward = d > 0 ? Math.max(0, Math.min(0.99, 1 - (1.02 * frame.drawnRadius) / d)) : 0;
      uPosition.value.set(frame.position.x * toward, frame.position.y * toward, frame.position.z * toward);
      // A small Sun gets a halo many times its size; a Sun filling the view, only a rim of light around it.
      const reach = 24 + (3.2 - 24) * smoothstep(8, 160, frame.radiusPx);
      uSize.value = Math.min(2.4 * frame.viewportPx, Math.max(80, frame.radiusPx * reach));
      // Brighter as the disc grows (a nearer Sun floods more of the lens), then gentler once the disc
      // itself carries the light; always within a fixed ceiling.
      const grow = (0.55 + 0.6 * smoothstep(1, 60, frame.radiusPx)) * (1 - 0.55 * smoothstep(60, 320, frame.radiusPx));
      uStrength.value = (grow * frame.visible) / Math.max(frame.compensation, 1e-6);
      uCore.value = 1 - smoothstep(20, 120, frame.radiusPx);
      uFilter.value.set(frame.filter[0], frame.filter[1], frame.filter[2]);
      sprite.visible = frame.visible > 1e-3;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * The share of a disc of angular radius `a` left visible by a nearer disc of angular radius `b`
 * whose centre is `separation` away (radians): one minus their overlap over the first disc's area.
 */
export function visibleShare(a: number, b: number, separation: number): number {
  if (a <= 0) return 0;
  if (separation >= a + b) return 1;
  if (separation <= b - a) return 0;
  if (separation <= a - b) return 1 - (b * b) / (a * a);
  const a2 = a * a;
  const b2 = b * b;
  const d = separation;
  const alpha = Math.acos(Math.min(1, Math.max(-1, (d * d + a2 - b2) / (2 * d * a))));
  const beta = Math.acos(Math.min(1, Math.max(-1, (d * d + b2 - a2) / (2 * d * b))));
  const overlap = a2 * alpha + b2 * beta - 0.5 * Math.sqrt(Math.max(0, (-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b)));
  return Math.min(1, Math.max(0, 1 - overlap / (Math.PI * a2)));
}
