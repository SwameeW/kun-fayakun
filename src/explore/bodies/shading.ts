/**
 * Small shader pieces the explorer's bodies share. The bodies are drawn at true scale from far
 * away to a few hundred km up, so everything here is written to stay clean at any size on screen:
 * hard edges in shading (a terminator, a ring's edge, a shadow's edge) are softened over exactly
 * the width of a pixel, and fine detail fades out before it would be smaller than one. That is
 * shading aliasing, which multisampling cannot fix: MSAA smooths a mesh's outline, not what is
 * painted inside it.
 */

import type { Data3DTexture, Node } from 'three/webgpu';
import { cross, dFdx, dFdy, dot, exp, float, floor, Fn, fwidth, hash, If, length, max, min, normalize, select, sin, smoothstep, texture3D, vec3 } from 'three/tsl';
import type { QualityTier } from '../../core/types';

export type FloatNode = Node<'float'>;
export type Vec3Node = Node<'vec3'>;

/** The explorer's detail levels follow the engine's quality tiers. */
export type Tier = QualityTier;

/** 1 between a and b, with soft edges at least `soft` wide, widened to a pixel where x changes faster. */
export function band(x: FloatNode, a: number, b: number, soft: number): FloatNode {
  const w = max(fwidth(x), soft);
  return smoothstep(float(a).sub(w), float(a).add(w), x).mul(float(1).sub(smoothstep(float(b).sub(w), float(b).add(w), x)));
}

/**
 * How much of a pattern of `cycles` per unit of x to keep: 1 while its period spans a few pixels,
 * fading to 0 as it nears one, so it never shimmers or breaks into moiré.
 */
function keep(x: FloatNode, cycles: number): FloatNode {
  return float(1).sub(smoothstep(0.22, 0.55, fwidth(x).mul(cycles)));
}

/** Like keep(), for a pattern on the unit sphere: `footprint` is the radians a pixel spans there. */
export function keepOnSphere(footprint: FloatNode, cycles: number): FloatNode {
  return float(1).sub(smoothstep(0.22, 0.55, footprint.mul(cycles)));
}

/**
 * A lookup of the noise volume that is skipped where `kept` is 0 (detail faded out for being finer
 * than a pixel): there it would only read texels scattered far apart, the costliest kind of fetch,
 * for nothing. Returns the volume's value, or its mean (0.5) where skipped. The lookup names its
 * level (the volume has one), so it may sit in a branch that differs from pixel to pixel.
 */
export function noiseIfKept(noise: Data3DTexture, p: Vec3Node, kept: FloatNode): FloatNode {
  return Fn(() => {
    const value = float(0.5).toVar();
    If(kept.greaterThan(1e-3), () => {
      value.assign(texture3D(noise, p).level(float(0)).r);
    });
    return value;
  })();
}

/** Radians of the unit sphere one pixel spans at this fragment (the screen-space footprint). */
export function sphereFootprint(direction: Vec3Node): FloatNode {
  return length(fwidth(direction));
}

/** A sine ripple of x that fades out as its period nears a pixel. */
export function ripple(x: FloatNode, frequency: number, phase: FloatNode | number = 0): FloatNode {
  return sin(x.mul(frequency).add(phase)).mul(keep(x, frequency / (2 * Math.PI)));
}

/**
 * The lit share of a pixel at a terminator: nDotL's sign, softened over one pixel plus `soft` (a
 * twilight width in nDotL units), so a thin crescent thins to a fading line instead of dashes.
 */
export function sunlit(nDotL: FloatNode, soft = 0): FloatNode {
  const w = max(fwidth(nDotL), 1e-4).add(soft);
  return smoothstep(w.negate(), w, nDotL);
}

/**
 * The Sun's cosine for shading next to a softened terminator: never below half the pixel's change of
 * nDotL, so the pixels the softening lights (just past the terminator, where the cosine itself is 0)
 * have light to show. Use it with sunlit(); far from the terminator it is the plain cosine.
 */
export function litCosine(nDotL: FloatNode): FloatNode {
  return max(nDotL, max(fwidth(nDotL), 1e-4).mul(0.5));
}

/** Five random numbers in [0, 1) per integer cell (cells folded into 0..63, so the seed stays exact in float32). */
function cellRandom(cell: Vec3Node, salt: number): readonly [FloatNode, FloatNode, FloatNode, FloatNode, FloatNode] {
  const wrap = (v: FloatNode): FloatNode => v.sub(floor(v.div(64)).mul(64));
  const seed = wrap(cell.x).add(wrap(cell.y).mul(64)).add(wrap(cell.z).mul(4096)).add((salt % 4) * 262_144);
  const step = 1_048_576;
  return [hash(seed), hash(seed.add(step)), hash(seed.add(2 * step)), hash(seed.add(3 * step)), hash(seed.add(4 * step))];
}

export interface CraterLayer {
  /** Height in units of the craters' depth (bowls negative, rims a little positive). */
  height: FloatNode;
  /** Gradient of that height on the unit sphere (per radian), for tilting the normal. */
  gradient: Vec3Node;
  /** 1 on a crater's floor and walls, 0 outside (albedo: fresh rims, darker floors). */
  inside: FloatNode;
  /** 1 on the raised rim. */
  rim: FloatNode;
  /** The bright blanket around a young crater (about a third of them), 0 to 1. */
  ejecta: FloatNode;
}

/**
 * One scale of impact craters: at most one per cell of a 3D grid laid over the unit sphere
 * (`cells` per unit length), jittered and sized at random, a parabolic bowl inside a raised rim,
 * `ratio` deep for its diameter (so every scale has the same slopes, as real craters roughly do).
 * The gradient is analytic, so near the terminator walls facing away from the Sun go dark and rims
 * facing it catch the light. Illustrative: no real crater is placed.
 */
export function craters(direction: Vec3Node, cells: number, salt: number, density: number, ratio: number): CraterLayer {
  const p = direction.mul(cells);
  const cell = floor(p);
  const local = p.sub(cell);
  const [ra, rb, rc, rd, re] = cellRandom(cell, salt);
  // The crater stays inside its cell: centre within the middle 42%, radius at most 0.24 of the cell.
  const centre = vec3(ra, rb, rc).sub(0.5).mul(0.42).add(0.5);
  const radius = rd.mul(rd).mul(0.17).add(0.07);
  const present = select(re.lessThan(density), float(1), float(0));
  const offset = local.sub(centre);
  const dist = max(length(offset), 1e-5);
  const d = dist.div(radius);
  const bowl = min(d.mul(d), 1).sub(1);
  const ring = d.sub(1).mul(3.2);
  const rimShape = exp(ring.mul(ring).negate());
  const height = bowl.add(rimShape.mul(0.32)).mul(present);
  // d(height)/d(d): 2d inside the bowl, the rim's Gaussian slope everywhere.
  const slope = select(d.lessThan(1), d.mul(2), float(0)).add(rimShape.mul(ring).mul(-2 * 3.2 * 0.32));
  // Height in radii is height * ratio * diameter (2 radius / cells); its gradient on the sphere is
  // d(height)/d(d) * d(d)/dp * dp/d(direction) = slope / radius * cells, so the scale cancels.
  const gradient = offset.div(dist).mul(slope.mul(present).mul(2 * ratio));
  const inside = float(1).sub(smoothstep(0.85, 1.05, d)).mul(present);
  // Ejecta reach out to about two radii, never past the cell (the centre is at least 0.29 from its edge).
  const reach = min(float(2.2), float(0.28).div(radius));
  const young = select(re.lessThan(density / 3), float(1), float(0));
  const ejecta = float(1).sub(smoothstep(float(0.9), reach, d)).mul(young).mul(present);
  return { height, gradient, inside, rim: rimShape.mul(present), ejecta };
}

/** Tilts a unit normal by a height gradient (both on the unit sphere): a relief map's bump. */
export function tiltNormal(normal: Vec3Node, gradient: Vec3Node, strength: FloatNode | number): Vec3Node {
  const tangential = gradient.sub(normal.mul(dot(gradient, normal)));
  return normalize(normal.sub(tangential.mul(strength)));
}

/**
 * The gradient of a height field over a surface (per unit of `position`), from how the height and
 * the position change across the pixel (Mikkelsen's surface gradient): bump mapping for a procedural
 * height with no texture coordinates. Feed it to tiltNormal.
 */
export function bumpGradient(position: Vec3Node, normal: Vec3Node, height: FloatNode): Vec3Node {
  const dpdx = dFdx(position);
  const dpdy = dFdy(position);
  const r1 = cross(dpdy, normal);
  const r2 = cross(normal, dpdx);
  const det = dot(dpdx, r1);
  const safe = select(det.greaterThanEqual(0), max(det, 1e-20), min(det, -1e-20));
  return r1.mul(dFdx(height)).add(r2.mul(dFdy(height))).div(safe);
}
