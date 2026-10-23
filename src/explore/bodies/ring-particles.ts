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
 * that repeats, so the field never runs out.
 *
 * The field is a thin sheet, as the rings are: a slab a fraction of the particles' spacing thick in
 * the ring plane, so from above it the particles lie on the rings' own surface and crowd toward the
 * line where the plane meets the horizon, never in open sky; the camera is inside it only as it
 * passes through the plane, when they stream past on both sides. They are as dense as the ring is
 * opaque at their radius (the strip's measured opacity: none in the gaps or beyond the A ring), their
 * sizes follow a steep power law (n(r) ~ r^-3, as ring particles' do: many small, few large), and they
 * are lit as small spheres by the Sun in the ring's own colour, dimmer deep in an opaque ring where
 * their neighbours shade them and on the side away from the Sun. While the camera moves each is drawn
 * as the streak it sweeps across the screen in half a frame, its light spread along it, so a fast
 * pass reads as motion rather than as dots jumping.
 *
 * Illustrative: real ring particles are centimetres to a few metres across in a layer tens of metres
 * thick, and they orbit at about 17 km/s; these are drawn thousands of times larger (at the scale the
 * depth range can show), in a thicker layer, turning with the planet. One draw call.
 */

import { BufferAttribute, BufferGeometry, Matrix4, SpriteNodeMaterial, Sprite, Vector3, type Object3D, type Quaternion } from 'three/webgpu';
import {
  abs,
  atan,
  cos,
  dot,
  exp,
  float,
  fract,
  hash,
  instanceIndex,
  length,
  max,
  min,
  mix,
  modelViewMatrix,
  select,
  sin,
  smoothstep,
  sqrt,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { MapSlot } from '../assets/streaming';
import { blendPremultiplied } from '../render/blending';
import type { Vec2Node, Vec3Node } from '../render/sampling';
import type { RingSpan } from './rings';

/** Particles per scale. */
const PER_SCALE = 3000;
/**
 * Per scale, in units of its spacing S: the repeating box's half-width, the slab's half-thickness and
 * the particles' radius range (a power law between them). The spacing is about `perNear` near planes.
 */
const FIELD = { box: 12, layer: 0.14, radius: [0.003, 0.028], perNear: 2.5 } as const;
/**
 * The field shows while the camera is within these shares of its distance from Saturn's centre of the
 * ring plane (fading between them), over the rings.
 */
const SHOW = { from: 0.06, to: 0.03 } as const;
/** A fully lit particle's brightness against the ring strip's colour (the strip is the ring's own colour; the sheet's law peaks about here). */
const PARTICLE_GAIN = 4.2;
/** Streaks: the shutter (frames), and the longest streak drawn (px; a longer jump is a cut, not motion). */
const STREAK = { shutter: 0.5, maxPx: 90 } as const;

export interface RingParticleFrame {
  /** The camera in the rings' frame, km (doubles: the field is placed relative to it). */
  camera: { x: number; y: number; z: number };
  /** Ring frame to render frame (the planet's orientation), column-major 3 x 3. */
  basis: readonly number[];
  /** Unit direction to the Sun in the view (camera) frame, and in the rings' frame. */
  sunView: Vector3;
  sunRing: { x: number; y: number; z: number };
  /** The camera's orientation (render frame) this frame. */
  view: Quaternion;
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
  /** The Sun's height over the ring plane (sine of its elevation, signed: which face it lights). */
  const uSunRing = uniform(0.3);
  const uLight = uniform(1);
  const uPx = uniform(1000);
  const uNear = uniform(1);
  const uRadiusKm = uniform(60268);
  /** The camera's move since the last frame in the rings' frame (km), and the last frame's view rotation (render to view). */
  const uDelta = uniform(new Vector3());
  const uPrevView = uniform(new Matrix4());

  const material = blendPremultiplied(new SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, sizeAttenuation: false, fog: false }));
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
  const r6 = hash(seed.add(13.7));
  const box = spacing.mul(FIELD.box);
  const layer = spacing.mul(FIELD.layer);
  // Where the particle is relative to the camera, rings' frame, km: its place in the repeating box,
  // brought to the copy of the box around the camera; vertically, in the thin slab of the plane.
  const relX = fract(r1.sub(cam.x.div(box.mul(2))).add(0.5)).sub(0.5).mul(box.mul(2));
  const relZ = fract(r3.sub(cam.z.div(box.mul(2))).add(0.5)).sub(0.5).mul(box.mul(2));
  const depthInLayer = r2.sub(0.5).mul(2);
  const relY = depthInLayer.mul(layer).sub(cam.y);
  const rel = vec3(relX, relY, relZ);
  // Its radius from the planet's centre, and the ring's opacity and colour there.
  const radiusKm = length(vec2(uCamXZ.x.add(relX), uCamXZ.z.add(relZ)));
  const s = radiusKm.div(uRadiusKm).sub(span.inner).div(span.outer - span.inner);
  const texel = slot.node.sample(vec2(s, 0.5)).level(float(0));
  const inside = smoothstep(0, 0.002, s).mul(float(1).sub(smoothstep(0.998, 1, s)));
  const opacity = mix(slot.mean.w, texel.w, slot.arrive).mul(inside);
  const present = select(r4.lessThan(opacity.mul(0.9)), float(1), float(0));
  // A power law of sizes, n(r) ~ r^-3 between the range's ends: many small, few large.
  const [rMin, rMax] = FIELD.radius;
  const size = float(rMin).div(sqrt(float(1).sub(r5.mul(1 - (rMin / rMax) ** 2)))).mul(spacing);
  const distance = max(length(rel), 1e-6);
  // Angular diameter (tangent units) and in pixels.
  const angular = size.div(distance).mul(2);
  const px = angular.mul(uPx);
  const edge = max(relX.abs(), relZ.abs()).div(box);
  // Gone at the box's edges, under a pixel, and close in (the nearest would loom as boulders).
  const visible = float(1).sub(smoothstep(0.55, 1, edge)).mul(smoothstep(0.6, 1.4, px)).mul(smoothstep(spacing.mul(0.6), spacing.mul(1.5), distance)).mul(smoothstep(uNear, uNear.mul(1.6), distance));
  // The ring's optical depth here; a particle beyond the sheet's midplane is seen through the sheet
  // (the ring writes no depth, so this is what hides it behind a dense ring), as much as the sheet
  // lets through along this line of sight.
  const tau = min(opacity.oneMinus().max(1e-4).log().negate(), 5);
  const height = depthInLayer.mul(layer);
  const behind = smoothstep(0, layer.mul(0.5), height.mul(cam.y.sign()).negate());
  const slant = max(abs(relY).div(max(length(rel), 1e-6)), 0.05);
  const seen = mix(float(1), exp(tau.div(slant).negate()), behind);
  const fade = visible.mul(weight).mul(uStrength).mul(present).mul(seen);
  // The rings' frame turned into the render frame (camera-relative: the camera is at the origin).
  const turn = (v: Vec3Node): Vec3Node => uColumn0.mul(v.x).add(uColumn1.mul(v.y)).add(uColumn2.mul(v.z));
  const world = turn(rel);
  material.positionNode = world;
  // Its motion across the screen since the last frame (tangent units), from where the camera was then.
  const now = modelViewMatrix.mul(vec4(world, 1)).xyz;
  const before = uPrevView.mul(vec4(turn(rel.add(uDelta)), 0)).xyz;
  const onScreen = (v: Vec3Node): Vec2Node => v.xy.div(max(v.z.negate(), 1e-6));
  const motion = onScreen(now).sub(onScreen(before));
  const sweep = min(length(motion).mul(STREAK.shutter), float(STREAK.maxPx).div(uPx));
  const shown = select(fade.greaterThan(1e-3), float(1), float(0));
  // Never under about a pixel and a half across; streaked along its motion.
  const width = max(angular, float(1.5).div(uPx)).mul(shown);
  material.scaleNode = vec2(width.add(sweep.mul(shown)), width);
  const angle = atan(motion.y, motion.x);
  material.rotationNode = angle;
  const stretch = sweep.div(max(width, 1e-9));
  const vTurn = varying(vec2(cos(angle), sin(angle)), 'vRingParticleTurn');
  // Lit by the Sun, dimmer deep in an opaque ring (its neighbours shade it) on the side away from the Sun.
  const sunSide = depthInLayer.mul(uSunRing.sign());
  const shaded = exp(tau.mul(float(1).sub(sunSide)).mul(0.25).div(max(abs(uSunRing), 0.05)).negate()).mul(0.7).add(0.3);
  // Light spread along the streak: a streak k widths long is 1 / (1 + k) as bright.
  const vColour = varying(mix(slot.mean.xyz, texel.xyz, slot.arrive).mul(shaded).mul(r6.mul(0.4).add(0.8)), 'vRingParticleColour');
  const vFade = varying(fade.div(stretch.add(1)), 'vRingParticleFade');
  const vStretch = varying(stretch, 'vRingParticleStretch');
  // A lit sphere swept along x: the capsule's distance from its axis in radii, and its normal.
  const q = uv().sub(0.5).mul(vec2(vStretch.add(1).mul(2), 2));
  const along = max(abs(q.x).sub(vStretch), 0).mul(q.x.sign());
  const d2 = along.mul(along).add(q.y.mul(q.y));
  // The sprite is turned along its motion: its normal turned back into the view's frame.
  const normal = vec3(along.mul(vTurn.x).sub(q.y.mul(vTurn.y)), along.mul(vTurn.y).add(q.y.mul(vTurn.x)), sqrt(max(float(1).sub(d2), 0)));
  const lambert = max(dot(normal, uSunView), 0);
  const disc = float(1).sub(smoothstep(0.55, 1, d2));
  // A particle's lit face is a little brighter than the ring around it (which averages lit faces, shadows and gaps).
  const colour = vColour.mul(lambert.mul(0.92).add(0.08)).mul(uLight).mul(PARTICLE_GAIN);
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
  /** The camera last frame (rings' frame, km) and its view rotation, for the streaks. */
  const last = { x: 0, y: 0, z: 0, valid: false };
  const viewNow = new Matrix4();
  const viewBefore = new Matrix4();

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
      const from = Math.hypot(camera.x, camera.y, camera.z);
      const radial = Math.hypot(camera.x, camera.z) / frame.radiusKm;
      const over = smoothstepJs(span.inner - 0.02, span.inner, radial) * (1 - smoothstepJs(span.outer, span.outer + 0.02, radial));
      const strength = smoothstepJs(SHOW.from * from, SHOW.to * from, height) * over;
      sprite.visible = enabled && strength > 1e-3;
      viewNow.makeRotationFromQuaternion(frame.view).invert();
      if (!sprite.visible) {
        last.valid = false;
        return;
      }
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
      uSunRing.value = frame.sunRing.y;
      uLight.value = frame.light;
      uPx.value = frame.pxPerRadian;
      uNear.value = frame.nearKm;
      uRadiusKm.value = frame.radiusKm;
      // The streaks: the camera's move since the last frame, and the view it had then. A jump larger
      // than the field (a cut, a placed camera) draws no streak.
      const dx = camera.x - last.x;
      const dy = camera.y - last.y;
      const dz = camera.z - last.z;
      if (last.valid && Math.hypot(dx, dy, dz) < FIELD.box * s0) {
        uDelta.value.set(dx, dy, dz);
        uPrevView.value.copy(viewBefore);
      } else {
        uDelta.value.set(0, 0, 0);
        uPrevView.value.copy(viewNow);
      }
      viewBefore.copy(viewNow);
      last.x = camera.x;
      last.y = camera.y;
      last.z = camera.z;
      last.valid = true;
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
