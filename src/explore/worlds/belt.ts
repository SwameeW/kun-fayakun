/**
 * The asteroids as points of light, every one on its own orbit: hundreds of thousands of JPL's
 * Small-Body Database objects (./orbits, public/assets/smallbodies), placed on the GPU each frame.
 *
 * Each point carries its orbit's perifocal axes (P toward perihelion times a, Q a quarter turn on
 * times b), its eccentricity, mean anomaly at the files' epoch and mean motion, decoded once on the
 * CPU. The vertex stage solves Kepler's equation for the date (Danby's starter and four Halley steps,
 * as ./orbits eccentricAnomaly does on the CPU), puts the point relative to the camera, and through
 * the same scaled-space remap as the bodies (../space/scaled-space), so the planets hide what is
 * behind them. Nothing is computed per point on the CPU after loading: a frame sets uniforms only.
 *
 * The date is split into whole blocks of BLOCK_DAYS and the days left (a uniform each), and each
 * point carries its mean motion times a block, reduced to a turn in doubles: the mean anomaly stays
 * exact to about 1e-4 radians in float32 across the clock's 800 years, and moves smoothly.
 *
 * Brightness has two parts. As seen: each point's V magnitude from its H and the H, G phase law
 * (Bowell et al. 1989; G = 0.15, the standard value for asteroids without a measured one) at its
 * distances from the Sun and the camera, through the sky's own mapping of magnitude to light, so from
 * the Earth nearly all of them are as invisible as they really are. Marked: in wide views a constant
 * light for each (a little more for the larger), so the belt reads as the band it is; the readout says
 * the brightness is enhanced while it is (UniverseIllustration 'small-body-light'). Positions are
 * never enhanced: the Kirkwood gaps, the Hildas' triangle and the Trojans' two clouds are in the data.
 *
 * Each point is a small sprite whose light is spread over the pixels it covers as a Gaussian of 0.7
 * device pixels integrated over each pixel (erf, in a tanh form), so a point's light neither shimmers
 * as it moves across pixels nor changes with the display's pixel ratio.
 *
 * Arranged by orbit size (a diagram, labelled 'small-body-orbits'): each point is drawn in the
 * ecliptic at its orbit's semi-major axis from the Sun, at the longitude it really has. The places at
 * a moment hide the gaps Jupiter's resonances clear in the orbits (the Kirkwood gaps at 2.50, 2.82,
 * 2.95 and 3.27 au: an asteroid on an eccentric or inclined orbit crosses them, or is seen across
 * them), so this shows them as empty rings in the belt.
 */

import { AdditiveBlending, BufferAttribute, BufferGeometry, InstancedBufferAttribute, PointsNodeMaterial, Sprite, Vector3, type Node } from 'three/webgpu';
import { acos, clamp, cos, dot, exp, float, floor, instancedBufferAttribute, length, log, max, min, mix, pow, screenDPR, select, sign, sin, tan, tanh, uniform, uv, varying, vec3 } from 'three/tsl';
import { SCALED } from '../space/scaled-space';
import { BELT_GROUPS, decodeRecord, GAUSS_K, GROUP_OF, perifocal, type BeltClass, type BeltGroup, type BeltRecord } from './orbits';

type FloatNode = Node<'float'>;
type Vec3Node = Node<'vec3'>;

/** Days in a block of the split date (see above). */
export const BLOCK_DAYS = 1024;
/** The point's light spread: a Gaussian of this many device pixels, over a sprite this many device pixels across. */
const PSF = { sigma: 0.7, footprint: 4 } as const;
/** A point fainter than this on screen (display terms, its whole light) is not drawn at all: its sprite collapses to nothing. */
const UNSEEN = 2e-4;
/**
 * The sky's mapping of magnitude to light (../sky.ts: V 6.5 at 0.05 at a star's centre, rising as the
 * flux to the 0.45th power), as a point's whole light (its centre pixel holds 0.276 of it).
 */
const SEEN = { mag: 6.5, light: 0.05 / 0.276, power: 0.45 } as const;
/** Marked: each point's light in wide views (display terms, whole light), and how it grows with size (per magnitude of H below 12), within bounds. */
const MARKED = { light: 0.16, perMag: 0.06, floor: 0.35, ceiling: 2.5 } as const;
/** No point shows brighter than this (display terms, whole light): a near pass does not flare. */
const CEILING = 3;
/** The points' colour (linear, display terms): sunlit rock, a little warm; and each group's when coloured by group (illustrative). */
const ROCK: readonly [number, number, number] = [1, 0.92, 0.82];
export const GROUP_COLOURS: Readonly<Record<BeltGroup, readonly [number, number, number]>> = {
  main: [0.95, 0.88, 0.76],
  near: [1, 0.42, 0.3],
  trojans: [0.42, 0.95, 0.5],
  hildas: [0.45, 0.72, 1],
  centaurs: [1, 0.78, 0.3],
  kuiper: [0.72, 0.58, 1],
  other: [0.8, 0.8, 0.8],
};

export interface BeltFrame {
  /** Days since the files' epoch (TDB). */
  days: number;
  /** The camera from the Sun, render frame, km. */
  cameraKm: { x: number; y: number; z: number };
  auKm: number;
  far: number;
  /** The exposure's adaptation (points are held in display terms). */
  compensation: number;
  /** How far the marked light is in (0 as seen only, 1 marked), times how much of it a point gets at this zoom. */
  marked: number;
  /** Colour by group (0 natural, 1 grouped), drawn at their orbits' sizes (0 where they are, 1 arranged), and the whole layer's fade. */
  grouped: number;
  arranged: number;
  fade: number;
}

export interface Belt {
  readonly object: Sprite;
  /** Points loaded so far. */
  readonly loaded: number;
  /** Points drawn. */
  readonly count: number;
  /** Appends a file's records (brightest first). */
  append(view: DataView, count: number): void;
  /** How many of the loaded points to draw (the detail level's count). */
  setCount(count: number): void;
  update(frame: BeltFrame): void;
  /**
   * For the GPU's own check (./probe): the points' shape, and each point's place from the Sun as the
   * vertex stage works it out (au, render frame): on its orbit, and as drawn (arranged by orbit size or not).
   */
  readonly geometry: BufferGeometry;
  readonly heliocentric: Vec3Node;
  readonly drawn: Vec3Node;
  dispose(): void;
}

/** erf(x) in a tanh form (error under 4e-4). */
const erf = (x: FloatNode): FloatNode => tanh(x.mul(1.1283791).add(x.mul(x).mul(x).mul(0.1009)));

/** Kepler's equation as ./orbits eccentricAnomaly solves it: M reduced to [-pi, pi), Danby's starter, four Halley steps. */
function keplerE(meanAnomaly: FloatNode, e: FloatNode): FloatNode {
  const m = meanAnomaly.sub(floor(meanAnomaly.div(2 * Math.PI).add(0.5)).mul(2 * Math.PI));
  let E: FloatNode = m.add(e.mul(0.85).mul(sign(sin(m))));
  for (let k = 0; k < 4; k += 1) {
    const s = e.mul(sin(E));
    const c = e.mul(cos(E));
    const f = E.sub(s).sub(m);
    const f1 = float(1).sub(c);
    E = E.sub(f.mul(f1).mul(2).div(f1.mul(f1).mul(2).sub(f.mul(s))));
  }
  return E;
}

/** A group's colour by its index in BELT_GROUPS (a chain of selects: seven groups). */
function groupColour(index: FloatNode): Vec3Node {
  let out: Vec3Node = vec3(...GROUP_COLOURS.other);
  for (let g = BELT_GROUPS.length - 2; g >= 0; g -= 1) out = select(index.lessThan(g + 0.5), vec3(...GROUP_COLOURS[BELT_GROUPS[g] ?? 'other']), out);
  return out;
}

export function createBelt(capacity: number, classes: readonly BeltClass[]): Belt {
  /** Per point: (P xyz in au, render frame; e), (Q xyz; M0), (n rad/day; n x BLOCK_DAYS reduced to a turn; H; group). */
  const a0 = new Float32Array(capacity * 4);
  const a1 = new Float32Array(capacity * 4);
  const a2 = new Float32Array(capacity * 4);
  const attrP = new InstancedBufferAttribute(a0, 4);
  const attrQ = new InstancedBufferAttribute(a1, 4);
  const attrN = new InstancedBufferAttribute(a2, 4);
  const groupIndex = classes.map((c) => BELT_GROUPS.indexOf(GROUP_OF[c]));
  const uBlocks = uniform(0);
  const uDays = uniform(0);
  const uCamera = uniform(new Vector3());
  const uAuKm = uniform(1.495978707e8);
  const uFar = uniform(1e9);
  const uCompensation = uniform(1);
  const uMarked = uniform(0);
  const uGrouped = uniform(0);
  const uArranged = uniform(0);
  const uFade = uniform(1);

  const pAttr = instancedBufferAttribute(attrP) as unknown as Node<'vec4'>;
  const qAttr = instancedBufferAttribute(attrQ) as unknown as Node<'vec4'>;
  const nAttr = instancedBufferAttribute(attrN) as unknown as Node<'vec4'>;
  const e = pAttr.w;
  const E = keplerE(qAttr.w.add(nAttr.y.mul(uBlocks)).add(nAttr.x.mul(uDays)), e);
  const heliocentric = pAttr.xyz.mul(cos(E).sub(e)).add(qAttr.xyz.mul(sin(E)));
  // Arranged: in the ecliptic (the render frame's xz plane) at its longitude, at its orbit's semi-major axis (P's length).
  const flat = vec3(heliocentric.x, 0, heliocentric.z);
  const position = mix(heliocentric, flat.mul(length(pAttr.xyz).div(max(length(flat), 1e-6))), uArranged);
  const relAu = position.sub(uCamera);
  const deltaAu = max(length(relAu), 1e-9);
  const rAu = max(length(position), 1e-6);
  // Scaled space, as ../space/scaled-space scaledFactor with a zero radius.
  const d = deltaAu.mul(uAuKm);
  const start = uFar.mul(SCALED.start);
  const s = clamp(log(d.div(start)).div(log(max(float(SCALED.maxDistanceKm).div(start), Math.E))), 0, 1);
  const placed = min(uFar.mul(float(SCALED.start).add(s.mul(SCALED.span))), uFar.mul(SCALED.cap));
  const k = select(d.greaterThan(start), placed.div(d), float(1));

  const material = new PointsNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: true, sizeAttenuation: false, fog: false });
  material.positionNode = relAu.mul(uAuKm).mul(k);

  // As seen: V from H with G = 0.15 at r and delta, and the phase angle between the Sun and the camera seen from the point.
  const cosAlpha = clamp(dot(position, relAu).div(rAu.mul(deltaAu)), -1, 1);
  const half = tan(min(acos(cosAlpha), Math.PI - 1e-3).mul(0.5));
  const phi = float(0.85).mul(exp(pow(half, 0.63).mul(-3.33))).add(float(0.15).mul(exp(pow(half, 1.22).mul(-1.87))));
  const v = nAttr.z.add(log(rAu.mul(deltaAu)).mul(5 / Math.LN10)).sub(log(max(phi, 1e-9)).mul(2.5 / Math.LN10));
  const seen = exp(v.sub(SEEN.mag).mul(-0.4 * SEEN.power * Math.LN10)).mul(SEEN.light);
  const size = clamp(exp(float(12).sub(nAttr.z).mul(MARKED.perMag * Math.LN10)), MARKED.floor, MARKED.ceiling);
  // Worked out once a point, in the vertex stage, and handed to its pixels (not solved again for each).
  const light = varying(min(max(seen, size.mul(MARKED.light).mul(uMarked)), CEILING).mul(uFade).div(uCompensation));
  const tint = varying(mix(vec3(...ROCK), groupColour(nAttr.w), uGrouped));
  // A point too faint to see costs no pixels: its sprite has no size.
  material.sizeNode = select(light.greaterThan(UNSEEN), float(PSF.footprint), float(0)).div(screenDPR);

  // The pixel-integrated Gaussian about the point's true place (uv 0.5).
  const offset = uv().sub(0.5).mul(PSF.footprint);
  const w = 1 / (Math.SQRT2 * PSF.sigma);
  const ix = erf(offset.x.add(0.5).mul(w)).sub(erf(offset.x.sub(0.5).mul(w))).mul(0.5);
  const iy = erf(offset.y.add(0.5).mul(w)).sub(erf(offset.y.sub(0.5).mul(w))).mul(0.5);
  material.colorNode = tint.mul(light.mul(ix).mul(iy));
  material.opacityNode = float(1);

  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.frustumCulled = false;
  sprite.name = 'explore-small-bodies';
  sprite.count = 0;
  sprite.visible = false;

  let loaded = 0;
  let wanted = 0;
  const record: BeltRecord = { a: 0, e: 0, i: 0, node: 0, peri: 0, m0: 0, h: 0, cls: 0 };
  const p = [0, 0, 0];
  const q = [0, 0, 0];

  return {
    object: sprite,
    geometry,
    heliocentric,
    drawn: position,
    get loaded() {
      return loaded;
    },
    get count() {
      return sprite.count;
    },
    append(view, count) {
      const added = Math.min(count, capacity - loaded);
      for (let j = 0; j < added; j += 1) {
        decodeRecord(view, j, record);
        perifocal(record.a, record.e, record.i, record.node, record.peri, p, q);
        const o = (loaded + j) * 4;
        // Ecliptic (x, y, z) to the render frame (x, z, -y), as ../space/origin eclipticToRender.
        a0[o] = p[0] ?? 0;
        a0[o + 1] = p[2] ?? 0;
        a0[o + 2] = -(p[1] ?? 0);
        a0[o + 3] = record.e;
        a1[o] = q[0] ?? 0;
        a1[o + 1] = q[2] ?? 0;
        a1[o + 2] = -(q[1] ?? 0);
        a1[o + 3] = record.m0;
        const n = GAUSS_K / record.a ** 1.5;
        a2[o] = n;
        a2[o + 1] = (n * BLOCK_DAYS) % (2 * Math.PI);
        a2[o + 2] = record.h;
        a2[o + 3] = groupIndex[record.cls] ?? BELT_GROUPS.length - 1;
      }
      // Only the new range goes to the GPU.
      for (const attr of [attrP, attrQ, attrN]) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(loaded * 4, added * 4);
        attr.needsUpdate = true;
      }
      loaded += added;
      sprite.count = Math.min(loaded, wanted);
    },
    setCount(count) {
      wanted = count;
      sprite.count = Math.min(loaded, wanted);
    },
    update(frame) {
      const blocks = Math.floor(frame.days / BLOCK_DAYS);
      uBlocks.value = blocks;
      uDays.value = frame.days - blocks * BLOCK_DAYS;
      uCamera.value.set(frame.cameraKm.x / frame.auKm, frame.cameraKm.y / frame.auKm, frame.cameraKm.z / frame.auKm);
      uAuKm.value = frame.auKm;
      uFar.value = frame.far;
      uCompensation.value = Math.max(frame.compensation, 1e-6);
      uMarked.value = frame.marked;
      uGrouped.value = frame.grouped;
      uArranged.value = frame.arranged;
      uFade.value = frame.fade;
      sprite.visible = sprite.count > 0 && frame.fade > 1e-3;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
