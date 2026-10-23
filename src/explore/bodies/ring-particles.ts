/**
 * Saturn's ring particles up close ('particles' ring detail): near the ring plane, over the rings, a
 * sparse field of icy particles fades in around the camera, so a pass through the rings has things
 * streaming past instead of a flat sheet turning edge-on.
 *
 * The field is laid out at the scale the view can hold. Beside the rings the depth range starts a
 * fixed share of the way to Saturn's centre (../space/lens: hundreds of km out in the rings), so the
 * particles are spaced at a few times that near distance, at two neighbouring scales a factor of four
 * apart cross-faded in log scale, so nothing pops or swims as the camera moves in and out. Each
 * scale's particles sit still in the rings' frame (their parallax is real) in a box around the camera
 * that repeats, so the field never runs out, and fade at the box's edges and with their size on
 * screen. They are as dense as the ring is opaque at their radius (the strip's measured opacity), a
 * few of them much larger (a steep size distribution, as real ring particles have), and lit as small
 * spheres by the Sun in the ring's own colour.
 *
 * Illustrative: real ring particles are centimetres to a few metres across in a layer tens of metres
 * thick, and they orbit at about 17 km/s; these are drawn thousands of times larger (at the scale the
 * depth range can show), in a thicker layer, and still. One draw call.
 */

import { BufferAttribute, BufferGeometry, PointsNodeMaterial, Sprite, Vector3, type Object3D } from 'three/webgpu';
import { dot, float, fract, hash, instanceIndex, length, max, mix, select, smoothstep, sqrt, uniform, uv, varying, vec2, vec3 } from 'three/tsl';
import type { MapSlot } from '../assets/streaming';
import { blendPremultiplied } from '../render/blending';
import type { RingSpan } from './rings';

/** Particles per scale. */
const PER_SCALE = 3000;
/**
 * Per scale, in units of its spacing S: the repeating box's half-width, the layer's half-thickness and
 * the particles' radius range. The spacing is about `perNear` near planes; the field shows while the
 * camera is within `showLayers` layer half-thicknesses of the ring plane (fading over the last half).
 */
const FIELD = { box: 9, layer: 1.6, radius: [0.004, 0.032], perNear: 2.5, showLayers: 2.5 } as const;

export interface RingParticleFrame {
  /** The camera in the rings' frame, km (doubles: the field is placed relative to it). */
  camera: { x: number; y: number; z: number };
  /** Ring frame to render frame (the planet's orientation), column-major 3 x 3. */
  basis: readonly number[];
  /** Unit direction to the Sun in the view (camera) frame. */
  sunView: Vector3;
  /** Sunlight (1 at 1 au), the view's pixels per radian, the planet's radius and the depth range's near plane (km). */
  light: number;
  pxPerRadian: number;
  radiusKm: number;
  nearKm: number;
}

export interface RingParticles {
  readonly object: Sprite;
  readonly enabled: boolean;
  setEnabled(on: boolean): void;
  /** Places the field for this frame. */
  update(frame: RingParticleFrame): void;
  /** A sprite that compiles the field's material ahead of first use. */
  warmUp(): Object3D[];
  dispose(): void;
}

const smoothstepJs = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const wrap = (v: number, period: number): number => v - Math.floor(v / period) * period;

export function createRingParticles(slot: MapSlot, span: RingSpan): RingParticles {
  /** The two scales' spacings, km. */
  const uScale = uniform(new Vector3(1, 4, 0));
  /** The camera's position modulo each scale's box (x, z) and its height above the plane (y), km. */
  const uCam0 = uniform(new Vector3());
  const uCam1 = uniform(new Vector3());
  /** The camera in the ring plane (km from Saturn's axis), for each particle's radius. */
  const uCamXZ = uniform(new Vector3());
  const uWeight = uniform(0);
  const uStrength = uniform(0);
  const uColumn0 = uniform(new Vector3(1, 0, 0));
  const uColumn1 = uniform(new Vector3(0, 1, 0));
  const uColumn2 = uniform(new Vector3(0, 0, 1));
  const uSunView = uniform(new Vector3(0, 0, 1));
  const uLight = uniform(1);
  const uPx = uniform(1000);
  const uNear = uniform(1);
  const uRadiusKm = uniform(60268);

  const material = blendPremultiplied(new PointsNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, sizeAttenuation: false, fog: false }));
  const i = float(instanceIndex);
  const second = i.greaterThanEqual(PER_SCALE);
  const spacing = select(second, uScale.y, uScale.x);
  const cam = select(second, uCam1, uCam0);
  const weight = select(second, uWeight, float(1).sub(uWeight));
  const seed = i.mul(7.31);
  const r1 = hash(seed);
  const r2 = hash(seed.add(1.7));
  const r3 = hash(seed.add(3.1));
  const r4 = hash(seed.add(5.3));
  const r5 = hash(seed.add(9.9));
  const box = spacing.mul(FIELD.box);
  const layer = spacing.mul(FIELD.layer);
  // Where the particle is relative to the camera, rings' frame, km: its place in the repeating box,
  // brought to the copy of the box around the camera; vertically, in the layer around the plane.
  const relX = fract(r1.sub(cam.x.div(box.mul(2))).add(0.5)).sub(0.5).mul(box.mul(2));
  const relZ = fract(r3.sub(cam.z.div(box.mul(2))).add(0.5)).sub(0.5).mul(box.mul(2));
  const relY = r2.sub(0.5).mul(layer.mul(2)).sub(cam.y);
  const rel = vec3(relX, relY, relZ);
  // Its radius from the planet's centre, and the ring's opacity and colour there.
  const radiusKm = length(vec2(uCamXZ.x.add(relX), uCamXZ.z.add(relZ)));
  const s = radiusKm.div(uRadiusKm).sub(span.inner).div(span.outer - span.inner);
  const texel = slot.node.sample(vec2(s, 0.5)).level(float(0));
  const inside = smoothstep(0, 0.002, s).mul(float(1).sub(smoothstep(0.998, 1, s)));
  const opacity = mix(slot.mean.w, texel.w, slot.arrive).mul(inside);
  const present = select(r4.lessThan(opacity.mul(0.9)), float(1), float(0));
  // Mostly small, a few large: the steep size distribution of real ring particles.
  const size = mix(float(FIELD.radius[0]), float(FIELD.radius[1]), r5.mul(r5).mul(r5).mul(r5)).mul(spacing);
  const distance = max(length(rel), 1e-6);
  const px = size.div(distance).mul(uPx).mul(2);
  const edge = max(relX.abs(), relZ.abs()).div(box);
  const visible = float(1).sub(smoothstep(0.6, 1, edge)).mul(smoothstep(0.5, 1.4, px)).mul(smoothstep(uNear, uNear.mul(1.6), distance));
  const fade = visible.mul(weight).mul(uStrength).mul(present);
  // The rings' frame turned into the render frame (camera-relative: the camera is at the origin).
  material.positionNode = uColumn0.mul(rel.x).add(uColumn1.mul(rel.y)).add(uColumn2.mul(rel.z));
  material.sizeNode = select(fade.greaterThan(1e-3), px.min(30).max(1.5), float(0));
  const vColour = varying(mix(slot.mean.xyz, texel.xyz, slot.arrive), 'vRingParticleColour');
  const vFade = varying(fade, 'vRingParticleFade');
  // A lit sphere: its normal from the sprite's coordinates, facing the camera.
  const d = uv().sub(0.5).mul(2);
  const r2d = dot(d, d);
  const normal = vec3(d.x, d.y, sqrt(max(float(1).sub(r2d), 0)));
  const lambert = max(dot(normal, uSunView), 0);
  const disc = float(1).sub(smoothstep(0.6, 1, r2d));
  const colour = vColour.mul(lambert.mul(0.92).add(0.08)).mul(uLight).mul(1.6);
  material.colorNode = colour.mul(disc).mul(vFade);
  material.opacityNode = disc.mul(vFade);

  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.count = 2 * PER_SCALE;
  sprite.frustumCulled = false;
  sprite.name = 'explore-saturn-ring-particles';
  sprite.renderOrder = 4;
  sprite.visible = false;
  let enabled = false;

  return {
    object: sprite,
    get enabled() {
      return enabled;
    },
    setEnabled(on) {
      enabled = on;
      if (!on) sprite.visible = false;
    },
    update(frame) {
      const { camera } = frame;
      // Two scales bracketing a few near planes, cross-faded in log scale.
      const x = Math.log(Math.max(frame.nearKm, 1e-3) * FIELD.perNear) / Math.log(4);
      const k = Math.floor(x);
      const s0 = 4 ** k;
      const s1 = 4 * s0;
      const height = Math.abs(camera.y);
      const radial = Math.hypot(camera.x, camera.z) / frame.radiusKm;
      const over = smoothstepJs(span.inner - 0.02, span.inner, radial) * (1 - smoothstepJs(span.outer, span.outer + 0.02, radial));
      const reach = FIELD.showLayers * FIELD.layer * s1;
      const strength = (1 - smoothstepJs(reach * 0.5, reach, height)) * over;
      sprite.visible = enabled && strength > 1e-3;
      if (!sprite.visible) return;
      uStrength.value = strength;
      uScale.value.set(s0, s1, 0);
      uWeight.value = x - k;
      const place = (u: Vector3, spacingKm: number): void => {
        const period = 2 * FIELD.box * spacingKm;
        u.set(wrap(camera.x, period), camera.y, wrap(camera.z, period));
      };
      place(uCam0.value, s0);
      place(uCam1.value, s1);
      uCamXZ.value.set(camera.x, 0, camera.z);
      const b = frame.basis;
      uColumn0.value.set(b[0] ?? 1, b[1] ?? 0, b[2] ?? 0);
      uColumn1.value.set(b[3] ?? 0, b[4] ?? 1, b[5] ?? 0);
      uColumn2.value.set(b[6] ?? 0, b[7] ?? 0, b[8] ?? 1);
      uSunView.value.copy(frame.sunView);
      uLight.value = frame.light;
      uPx.value = frame.pxPerRadian;
      uNear.value = frame.nearKm;
      uRadiusKm.value = frame.radiusKm;
    },
    warmUp() {
      const warm = new Sprite(material);
      warm.geometry = geometry;
      warm.count = 1;
      warm.frustumCulled = false;
      return [warm];
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
