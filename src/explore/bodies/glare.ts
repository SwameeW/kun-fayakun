/**
 * The Sun's glare: the light a lens and an eye scatter around a source far brighter than anything
 * else in view. Its disc is drawn by ./sun; this adds what surrounds it: a white-hot core over a
 * small disc, a halo that falls off steeply (as a real lens's point-spread function does, so it reads
 * as a blinding star and not as a hazy ball), faint diffraction spikes, and a wide, very faint veil
 * just warmer than the core. All of it is dimmed by the share of the disc another body covers (no
 * glare from a Sun hidden behind a planet), held in display terms like the other guides, capped, and
 * all but gone once the Sun is shown through its solar filter. One draw call.
 */

import { AdditiveBlending, BufferAttribute, BufferGeometry, PointsNodeMaterial, Sprite, Vector3 } from 'three/webgpu';
import { abs, exp, float, length, max, mix, pow, smoothstep as smoothstepNode, uniform, uv, vec3 } from 'three/tsl';
import type { Km } from '../space/origin';

export interface GlareFrame {
  /** Where the Sun is drawn (camera-relative, scaled space), km, and its drawn radius. */
  position: Km;
  drawnRadius: number;
  /** Its disc's radius on screen, and the view's height, CSS px. */
  radiusPx: number;
  viewportPx: number;
  /** Share of the disc not hidden by other bodies, 0 to 1. */
  visible: number;
  /** The exposure's adaptation (the glare keeps its brightness on screen). */
  compensation: number;
  /** How far the Sun is shown through its solar filter, 0 to 1. */
  filtered: number;
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

/** Glare strengths at their peak, display terms: the core over the disc, the halo, the spikes, the veil. */
const GLARE = { core: 2.4, halo: 0.6, spikes: 0.3, veil: 0.025 } as const;

export function createSunGlare(tint: readonly [number, number, number]): SunGlare {
  const uPosition = uniform(new Vector3());
  const uSize = uniform(100);
  const uStrength = uniform(0);
  /** The core only while the disc is small (a large disc carries its own light). */
  const uCore = uniform(1);
  /** The core's scale: half the disc's radius in the sprite's units (the core is a small hot centre). */
  const uDisc = uniform(0.02);
  /** Where the disc's edge falls in the sprite (0 at its centre, 1 at its edge). */
  const uEdge = uniform(0.04);
  /** The spikes belong to a blinding point; a filtered Sun has none. */
  const uSpikes = uniform(1);
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
  // Distance outside the disc, in sprite units: the halo starts at the disc's edge and adds nothing
  // over the disc itself (which carries its own light).
  const outside = max(r.sub(uEdge), 0);
  const offDisc = smoothstepNode(uEdge.mul(0.92), uEdge, r);
  const edge = max(float(1).sub(r.mul(r)), 0);
  const core = exp(r.mul(r).div(max(uDisc.mul(uDisc).mul(4), 1e-5)).negate()).mul(GLARE.core).mul(uCore);
  // A steep power-law halo (a lens's scattered light falls as about the cube of the angle).
  const halo = float(1).div(pow(float(1).add(outside.div(0.028)), 3)).mul(GLARE.halo).mul(offDisc);
  // Four spikes, as a reflector's vanes diffract: thin along two axes, fading with distance.
  const spikeX = exp(abs(c.y).mul(-420)).mul(exp(abs(c.x).mul(-4.5)));
  const spikeY = exp(abs(c.x).mul(-420)).mul(exp(abs(c.y).mul(-4.5)));
  const spikes = spikeX.add(spikeY).mul(GLARE.spikes);
  const veil = exp(r.mul(-3.2)).mul(GLARE.veil);
  // White at the core, only just warmer outward (scattered light reddens a little; it is not brown).
  const colour = mix(vec3(...tint), vec3(1, 0.9, 0.78), pow(r, 0.7).mul(0.5));
  material.colorNode = colour.mul(core.add(halo).add(spikes.mul(uSpikes)).add(veil).mul(edge)).mul(uStrength);
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
      // A small Sun gets a halo many times its size; a large one a rim of light around it.
      const reachPx = Math.max(140, Math.min(2.2 * frame.viewportPx, frame.radiusPx * (18 + (2.6 - 18) * smoothstep(10, 200, frame.radiusPx))));
      uSize.value = reachPx;
      uDisc.value = Math.min(0.9, frame.radiusPx / reachPx);
      // The sprite's coordinates run from -1 to 1 across its diameter (reachPx).
      uEdge.value = Math.min(0.95, (2 * frame.radiusPx) / reachPx);
      const grow = 0.7 + 0.5 * smoothstep(1, 40, frame.radiusPx);
      uStrength.value = (grow * frame.visible * (1 - 0.92 * frame.filtered)) / Math.max(frame.compensation, 1e-6);
      uCore.value = 1 - smoothstep(6, 40, frame.radiusPx);
      uSpikes.value = (1 - frame.filtered) ** 3;
      sprite.visible = frame.visible > 1e-3 && frame.filtered < 0.999;
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
