/**
 * Shadows of one body on another: the Moon's on the Earth in a solar eclipse, the Earth's on the Moon
 * in a lunar one, the moons' on their planets (Io's on Jupiter, Titan's on Saturn, Triton's on
 * Neptune, Phobos's on Mars). Saturn's on its rings is the rings' own (../bodies/rings).
 *
 * Each pixel of the receiver looks at the Sun and sees how much of its disc the occluder covers from
 * there: the overlap of two discs (../bodies/glare visibleShare, written again here for the GPU), so
 * the umbra and the penumbra come out of the geometry exactly, their edges as soft as the Sun's disc
 * makes them. The share darkens the body as drawn (its ground, clouds and air) through a shell just
 * above it whose colour multiplies what is behind it; on the night side it does nothing. The shell
 * is drawn only while an occluder's penumbra reaches its receiver, so it costs nothing otherwise.
 *
 * The Earth's shadow is cast by the Earth with its air, about 2% larger than the solid globe (Danjon's
 * rule, as eclipse predictions take it). Inside it the Moon still shows the sunlight the Earth's air
 * bends and reddens into the umbra: about a ten-thousandth of full moonlight, too faint for a view
 * exposed for the full Moon, so it is shown some hundred times brighter, a dim copper (the readout says
 * so: UniverseIllustration 'eclipse-red').
 */

import { AddEquation, CustomBlending, FrontSide, Mesh, MeshBasicNodeMaterial, OneFactor, SphereGeometry, SrcColorFactor, Vector3, Vector4, ZeroFactor } from 'three/webgpu';
import { acos, asin, clamp, dot, float, length, max, min, mix, normalize, positionLocal, select, smoothstep, sqrt, uniform, vec3 } from 'three/tsl';
import type { FocusId } from '../../core/types';
import { visibleShare } from '../bodies/glare';
import type { FloatNode } from '../render/sampling';

/** The Earth's shadow is cast by the Earth and its air: this much larger than the globe (Danjon's rule). */
export const EARTH_SHADOW_SCALE = 1.02;
/** The light left in the Earth's umbra on the Moon (display terms: shown about a hundred times brighter than it is), a dim copper. */
export const UMBRA_RED: readonly [number, number, number] = [0.024, 0.0085, 0.0035];
/** The shell's height above the receiver's radius (its share): above the Earth's clouds, under its air's top. */
const SHELL = 1.004;
const MAX_OCCLUDERS = 4;

export interface ShadowCaster {
  /** Centre, render frame, km (from the Sun). */
  position: { x: number; y: number; z: number };
  radiusKm: number;
}

export interface ShadowReceiver {
  id: FocusId;
  position: { x: number; y: number; z: number };
  radiusKm: number;
  /** As drawn: camera-relative place and scale (scaled space). */
  drawn: { x: number; y: number; z: number };
  k: number;
  /** Its disc on screen (px): no shell under a pixel. */
  radiusPx: number;
  visible: boolean;
}

export interface Eclipse {
  on: FocusId;
  by: FocusId;
  /** The share of the Sun's disc hidden from the receiver's point nearest the shadow's axis (1 total). */
  depth: number;
}

export interface Eclipses {
  /** A shell per receiver: add them to the scene. */
  readonly objects: readonly Mesh[];
  /** Places the shells and reports the eclipses under way (any depth). */
  update(pairs: ReadonlyArray<{ receiver: ShadowReceiver; casters: ReadonlyArray<{ id: FocusId; caster: ShadowCaster }>; red: boolean; scale: number }>, sunRadiusKm: number, out: Eclipse[]): void;
  dispose(): void;
}

/** visibleShare (../bodies/glare) on the GPU: the share of a disc of angular radius a left by a nearer disc b at separation d. */
function share(a: FloatNode, b: FloatNode, d: FloatNode): FloatNode {
  const a2 = a.mul(a);
  const b2 = b.mul(b);
  const dd = max(d, 1e-9);
  const alpha = acos(clamp(dd.mul(dd).add(a2).sub(b2).div(dd.mul(a).mul(2)), -1, 1));
  const beta = acos(clamp(dd.mul(dd).add(b2).sub(a2).div(dd.mul(b).mul(2)), -1, 1));
  const kite = sqrt(max(dd.negate().add(a).add(b).mul(dd.add(a).sub(b)).mul(dd.sub(a).add(b)).mul(dd.add(a).add(b)), 0));
  const overlap = a2.mul(alpha).add(b2.mul(beta)).sub(kite.mul(0.5));
  const partial = clamp(float(1).sub(overlap.div(a2.mul(Math.PI))), 0, 1);
  const inside = float(1).sub(b2.div(a2));
  return select(d.greaterThanEqual(a.add(b)), float(1), select(d.lessThanEqual(b.sub(a)), float(0), select(d.lessThanEqual(a.sub(b)), inside, partial)));
}

function shell(): { mesh: Mesh; occluders: Vector4[]; sun: Vector3; sunAngle: { value: number }; red: Vector3 } {
  const occluders = Array.from({ length: MAX_OCCLUDERS }, () => new Vector4(0, 0, 0, 0));
  const uOcc = occluders.map((v) => uniform(v));
  const uSun = uniform(new Vector3(1, 0, 0));
  const uSunAngle = uniform(0.00465);
  const uRed = uniform(new Vector3(0, 0, 0));
  // On the unit sphere (receiver radii): the point, and per occluder the Sun's disc it leaves.
  const p = normalize(positionLocal);
  let lit: FloatNode = float(1);
  for (const o of uOcc) {
    const v = o.xyz.sub(p);
    const d = max(length(v), 1e-6);
    const b = asin(min(o.w.div(d), 1));
    const sep = acos(clamp(dot(v.div(d), uSun), -1, 1));
    lit = lit.mul(select(o.w.greaterThan(0), share(uSunAngle, b, sep), float(1)));
  }
  // Only where the Sun is up: the night side is the receiver's own shadow already.
  const day = smoothstep(-0.02, 0.02, dot(p, uSun));
  const material = new MeshBasicNodeMaterial({ side: FrontSide, transparent: true, depthWrite: false, depthTest: true, fog: false });
  // result = what is behind times this colour.
  material.blending = CustomBlending;
  material.blendEquation = AddEquation;
  material.blendSrc = ZeroFactor;
  material.blendDst = SrcColorFactor;
  material.blendEquationAlpha = AddEquation;
  material.blendSrcAlpha = ZeroFactor;
  material.blendDstAlpha = OneFactor;
  material.premultipliedAlpha = false;
  material.colorNode = mix(vec3(1), mix(vec3(uRed), vec3(1), lit), day);
  material.opacityNode = float(1);
  const mesh = new Mesh(new SphereGeometry(SHELL, 96, 48), material);
  mesh.name = 'explore-eclipse-shell';
  mesh.frustumCulled = false;
  // After the body and its air.
  mesh.renderOrder = 4;
  mesh.visible = false;
  return { mesh, occluders, sun: uSun.value, sunAngle: uSunAngle, red: uRed.value };
}

export function createEclipses(receivers: number): Eclipses {
  const shells = Array.from({ length: receivers }, shell);
  return {
    objects: shells.map((s) => s.mesh),
    update(pairs, sunRadiusKm, out) {
      out.length = 0;
      pairs.forEach(({ receiver, casters, red, scale }, i) => {
        const s = shells[i];
        if (!s) return;
        const r = receiver.position;
        const rd = Math.hypot(r.x, r.y, r.z) || 1;
        let any = false;
        let slot = 0;
        for (const { id, caster } of casters) {
          const o = caster.position;
          const od = Math.hypot(o.x, o.y, o.z) || 1;
          const radius = caster.radiusKm * (id === 'earth' ? EARTH_SHADOW_SCALE : 1) * scale;
          // Along the shadow's axis (away from the Sun through the caster), and how far off it the receiver is.
          const ax = o.x / od;
          const ay = o.y / od;
          const az = o.z / od;
          const vx = r.x - o.x;
          const vy = r.y - o.y;
          const vz = r.z - o.z;
          const along = vx * ax + vy * ay + vz * az;
          if (along <= 0) continue;
          const off = Math.hypot(vx - along * ax, vy - along * ay, vz - along * az);
          const penumbra = radius + (along * (sunRadiusKm + radius)) / od;
          if (off > penumbra + receiver.radiusKm) continue;
          // The depth at the receiver's point nearest the axis: the share of the Sun's disc the caster hides there.
          const nearest = Math.max(0, off - receiver.radiusKm);
          const sunAngle = Math.asin(Math.min(1, sunRadiusKm / od));
          const casterAngle = Math.asin(Math.min(1, radius / Math.max(along, 1e-9)));
          const sep = Math.atan2(nearest, along);
          out.push({ on: receiver.id, by: id, depth: 1 - visibleShare(sunAngle, casterAngle, sep) });
          if (slot < MAX_OCCLUDERS) {
            s.occluders[slot]?.set(-vx / receiver.radiusKm, -vy / receiver.radiusKm, -vz / receiver.radiusKm, radius / receiver.radiusKm);
            slot += 1;
            any = true;
          }
        }
        for (let j = slot; j < MAX_OCCLUDERS; j += 1) s.occluders[j]?.set(0, 0, 0, 0);
        s.mesh.visible = any && receiver.visible && receiver.radiusPx > 1;
        if (!s.mesh.visible) return;
        s.sun.set(-r.x / rd, -r.y / rd, -r.z / rd);
        s.sunAngle.value = Math.asin(Math.min(1, sunRadiusKm / rd));
        s.red.set(...(red ? UMBRA_RED : ([0, 0, 0] as const)));
        s.mesh.position.set(receiver.drawn.x, receiver.drawn.y, receiver.drawn.z);
        s.mesh.scale.setScalar(receiver.radiusKm * receiver.k);
        s.mesh.updateMatrixWorld();
      });
    },
    dispose() {
      for (const s of shells) {
        s.mesh.geometry.dispose();
        (s.mesh.material as MeshBasicNodeMaterial).dispose();
      }
    },
  };
}
