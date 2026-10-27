import { DataTexture, FloatType, InstancedBufferAttribute, NearestFilter, RedFormat, Vector3, type Node, type Sprite } from 'three/webgpu';
import { abs, atan, cameraPosition, cos, cross, dot, float, Fn, If, instanceIndex, instancedBufferAttribute, length, log2, max, min, mix, normalize, sin, smoothstep, textureLoad, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { starMaterial, starSprites } from '../starlight';
import { IMAGES } from './lens';

/**
 * The stars on the GPU (docs/NEIGHBOURHOOD.md, "More stars"), through the explorer's star light
 * (../starlight), one draw call a layer, every star's brightness worked out in the vertex stage:
 * - placed: stars at their places in space (parsecs from the Sun, render frame, in single precision)
 *   with their absolute magnitude; each drawn relative to the camera as (place - camera's high part)
 *   - camera's low part (the camera split into two single-precision numbers), so a star stays exact
 *   kilometres from the camera however far it is from the Sun, and as bright as its distance makes it;
 * - far: stars as directions (ICRS, octahedrally packed in two 16-bit numbers) with their magnitude
 *   as seen from the Sun (Tycho-2's, and Hipparcos's not placed), on a sphere round the camera.
 *
 * Near a black hole every star is drawn where its bent light is seen (docs/NEIGHBOURHOOD.md, "Black
 * holes"), in the vertex stage, so it stays a sharp point at the screen's own resolution: its primary
 * image, pushed out from the hole, and a second draw of the same stars for each one's secondary image
 * on the hole's far side, just outside the shadow; each brightened or dimmed by its magnification
 * (held to LENSED.maxGain, so a star crossing the ring brightens, never flashes). The angle of a
 * source's images comes from ./lens's table for the camera's distance from the hole.
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

/**
 * The most a star is brightened by the lens (its magnification is unbounded on an Einstein ring); the
 * magnitudes past the faintest drawn whose stars are drawn too near a hole (brightened four times,
 * they are seen: as many stars show on a patch of sky bent as unbent, each brighter, as the eye
 * would see them); and the source's distance from the hole, over the camera's, past which it is taken
 * as at infinity (nearer, it is drawn less bent, and not at all as near as the camera: a star in
 * front of the hole).
 */
export const LENSED = { maxGain: 12, reach: 1.5, farFrom: 1.5, farTo: 4 } as const;

/** A black hole's bending of the stars' light: on or off, the hole's place from the camera (pc, render frame), and the angles of a source's images (./lens imageTable, for the camera's distance). */
export const lensing = { on: uniform(0), hole: uniform(new Vector3()), table: imageTexture() };

function imageTexture(): DataTexture {
  const t = new DataTexture(new Float32Array(IMAGES.size), IMAGES.size, 1, RedFormat, FloatType);
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.needsUpdate = true;
  return t;
}

/** A new table of images (./lens imageTable) for the stars to be bent by. */
export function setImages(table: Float32Array): void {
  (lensing.table.image.data as Float32Array).set(table);
  lensing.table.needsUpdate = true;
}

/** The table at a source's angle (rad, 0 to IMAGES.span): its bending, its image's angle (the source's less that), and how fast it turns with the source's. */
function image(x: Node<'float'>): { bent: Node<'float'>; theta: Node<'float'>; slope: Node<'float'> } {
  const per = (IMAGES.size - 1) / IMAGES.span;
  const at = x.mul(per).clamp(0, IMAGES.size - 1.001);
  const i = at.floor();
  const a = textureLoad(lensing.table, vec2(i, 0).toIVec2()).r;
  const b = textureLoad(lensing.table, vec2(i.add(1), 0).toIVec2()).r;
  const bent = mix(a, b, at.sub(i));
  return { bent, theta: x.sub(bent), slope: float(1).sub(b.sub(a).mul(per)) };
}

/**
 * A star's light seen past a black hole, from its place relative to the camera (pc): where it is seen
 * (camera-relative) and a multiple of its light. The primary image (`secondary` false) is the star
 * itself when there is no lens; the secondary is nothing then. (../beyond's points too.)
 */
export function lensed(rel: Node<'vec3'>, secondary: boolean): Node<'vec4'> {
  return Fn(() => {
    const out = vec4(rel, secondary ? 0 : 1).toVar();
    If(lensing.on.greaterThan(0.5), () => {
      const h = lensing.hole;
      const dH = max(length(h), 1e-30);
      // The axis from the hole to the camera; the source's direction from the hole and its angle from that axis.
      const er = h.div(dH).negate();
      const toStar = rel.sub(h);
      const s = normalize(toStar);
      // Its angle from the axis by both its sine and cosine (exact near 0 and pi, where single precision's arccosine is not).
      const turn = cross(er, s);
      const sine = length(turn);
      const phi = atan(sine, dot(er, s));
      const n = sine.greaterThan(1e-9).select(turn.div(sine), normalize(cross(er, abs(er.y).lessThan(0.9).select(vec3(0, 1, 0), vec3(1, 0, 0)))));
      const far = smoothstep(LENSED.farFrom, LENSED.farTo, length(toStar).div(dH));
      const at = image(secondary ? float(2 * Math.PI).sub(phi) : phi);
      // Turned about n (from the axis toward the source) by the angle between its image and itself (back by its bending), the image on the far side the other way round.
      const angle = secondary ? at.theta.add(phi).negate() : at.bent.mul(far).negate();
      const d = rel.div(max(length(rel), 1e-30));
      const turned = d.mul(cos(angle)).add(cross(n, d).mul(sin(angle))).add(n.mul(dot(n, d)).mul(float(1).sub(cos(angle))));
      // Its magnification: the solid angle of the image over the source's.
      const gain = min(sin(at.theta).add(1e-7).div(sine.add(1e-7)).mul(abs(at.slope)), LENSED.maxGain);
      out.assign(vec4(turned.mul(length(rel)), secondary ? gain.mul(far) : mix(float(1), gain, far)));
    });
    return out;
  })();
}

/** log10(2), for magnitudes from log2. */
const LOG10_2 = 0.30102999566;

/** A magnitude brightened by a lens's gain (none: not seen), so the faintest drawn is the faintest seen. */
const brightened = (magnitude: Node<'float'>, gain: Node<'float'>): Node<'float'> => magnitude.sub(log2(max(gain, 1e-30)).mul(2.5 * LOG10_2));

export interface PlacedLayer {
  readonly sprite: Sprite;
  /** The stars' secondary images past a black hole (drawn only near one). */
  readonly image: Sprite;
  /** A light multiple for the whole layer (the stars' fade beyond the galaxy), and for one star (the one drawn up close as a disc). */
  readonly light: { value: number };
  /** 1: the stars drawn as seen from the Sun (a stellar black hole's stand-in sky), 0: from the camera. */
  readonly sunView: { value: number };
  readonly focus: { value: number };
  readonly focusLight: { value: number };
  dispose(): void;
}

/** Drawn after a black hole's lens (./lens-view, renderOrder 20), which leaves them its picture of the sky's glow to bend; hidden by its disc of gas (it writes the depth there). */
const STARS_ORDER = 24;

/** Placed stars: `stars` holds x, y, z (pc from the Sun) and absolute V for each; `colours` its tint (r, g, b, 0-255). */
export function placedLayer(stars: Float32Array, colours: Uint8Array, name: string): PlacedLayer {
  const count = stars.length / 4;
  const star = instancedBufferAttribute(new InstancedBufferAttribute(stars, 4)) as unknown as Node<'vec4'>;
  const tint = instancedBufferAttribute(new InstancedBufferAttribute(colours, 4, true)) as unknown as Node<'vec4'>;
  const light = uniform(1);
  const focus = uniform(-1, 'int');
  const focusLight = uniform(1);
  const sunView = uniform(0);
  // Exact differences of single-precision numbers, then the camera's remainder (none of it as seen from the Sun).
  const from = float(1).sub(sunView);
  const rel = star.xyz.sub(cameraParts.high.mul(from)).sub(cameraParts.low.mul(from));
  const r = max(length(rel), float(1e-14));
  const magnitude = star.w.add(log2(r).mul(5 * LOG10_2)).sub(5);
  const mine = instanceIndex.toInt().equal(focus).select(focusLight, float(1));
  const [sprite, image] = [false, true].map((secondary) => {
    const seen = lensed(rel, secondary);
    const s = starSprites(starMaterial(seen.xyz, brightened(magnitude, seen.w), tint.xyz, light.mul(mine), true), count, secondary ? `${name}-images` : name);
    s.renderOrder = STARS_ORDER;
    return s;
  }) as [Sprite, Sprite];
  image.visible = false;
  return {
    sprite,
    image,
    light,
    sunView,
    focus: focus,
    focusLight,
    dispose() {
      for (const s of [sprite, image]) {
        s.geometry.dispose();
        s.material.dispose();
      }
    },
  };
}

export interface FarLayer {
  readonly sprite: Sprite;
  readonly image: Sprite;
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
export function farLayer(directions: Uint16Array, colours: Uint8Array, obliquity: number, name: string): FarLayer {
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
  const [sprite, image] = [false, true].map((secondary) => {
    const seen = lensed(dir.mul(radius), secondary);
    const sp = starSprites(starMaterial(cameraPosition.add(seen.xyz), brightened(magnitude, seen.w), tint.xyz, light, true), count, secondary ? `${name}-images` : name);
    sp.renderOrder = STARS_ORDER - 1;
    return sp;
  }) as [Sprite, Sprite];
  image.visible = false;
  return {
    sprite,
    image,
    light,
    radius,
    dispose() {
      for (const sp of [sprite, image]) {
        sp.geometry.dispose();
        sp.material.dispose();
      }
    },
  };
}
