/**
 * Reading the planet maps (assets/planets/planets.json) on the explorer's bodies.
 *
 * Coordinates come from each fragment's direction in the body's own frame, not from the mesh's
 * texture coordinates, so the poles never pinch and a flattened giant can be read at the latitude
 * of its ellipsoid's normal (planetographic, as OPAL's maps are). The body frame is the one
 * src/explore/system.ts turns the meshes by: local x the prime meridian, local y the north pole,
 * east longitude toward -z (as three's SphereGeometry lays out u). With east longitude lon,
 * u = uAtLon0 + lon / 360 and v = 0.5 + lat / 180, exactly as the manifest says.
 *
 * Every lookup passes its own gradients: longitude wraps at the map's seam, where a naive
 * derivative would jump and pick the smallest mip level along a line (src/chapters/ch02's CMB sky
 * does the same), and a slot's blur (./assets/streaming) is applied by scaling them.
 */

import type { Node } from 'three/webgpu';
import { abs, asin, atan, clamp, dFdx, dFdy, exp2, float, floor, fract, fwidth, int, mix, select, vec2, vec3 } from 'three/tsl';
import type { MapSlot } from '../assets/streaming';

export type FloatNode = Node<'float'>;
export type Vec2Node = Node<'vec2'>;
export type Vec3Node = Node<'vec3'>;
export type Vec4Node = Node<'vec4'>;

/** Map coordinates of a fragment and their screen-space gradients. */
export interface MapCoords {
  readonly uv: Vec2Node;
  readonly dx: Vec2Node;
  readonly dy: Vec2Node;
}

/**
 * Coordinates of a unit direction `d` in a body's frame, with `latitudeSine` the sine of the latitude
 * in the map's convention (d.y for a sphere; the ellipsoid normal's y for planetographic maps).
 * `uAtLon0` and `lonSign` come from the map's manifest entry.
 */
export function mapCoords(d: Vec3Node, latitudeSine: FloatNode, uAtLon0: number, lonSign: 1 | -1 = 1): MapCoords {
  const turns = atan(d.z.negate(), d.x).div(2 * Math.PI);
  // Two parameterisations of longitude, each continuous where the other wraps: the gradient comes
  // from whichever is continuous at this pixel.
  const uA = fract(turns);
  const uB = fract(turns.add(0.5)).sub(0.5);
  const useA = fwidth(uA).lessThan(fwidth(uB));
  const dudx = select(useA, dFdx(uA), dFdx(uB)).mul(lonSign);
  const dudy = select(useA, dFdy(uA), dFdy(uB)).mul(lonSign);
  const v = asin(clamp(latitudeSine, -1, 1)).div(Math.PI).add(0.5);
  const u = uA.mul(lonSign).add(uAtLon0);
  return { uv: vec2(u, v), dx: vec2(dudx, dFdx(v)), dy: vec2(dudy, dFdy(v)) };
}

/** The same coordinates moved by `du` and `dv` (texture units), with the same gradients. */
export function shiftCoords(c: MapCoords, du: FloatNode | number, dv: FloatNode | number = 0): MapCoords {
  return { uv: c.uv.add(vec2(du, dv)), dx: c.dx, dy: c.dy };
}

/**
 * A slot's value at `c`: its bound texture sampled with the slot's blur (and `extraBlur` more mip
 * levels, for fine detail that should fade), faded in from the placeholder's mean as its first file arrives.
 */
export function sampleSlot(slot: MapSlot, c: MapCoords, extraBlur: FloatNode | number = 0): Vec4Node {
  const scale = exp2(slot.blur.add(extraBlur));
  const value = slot.node.sample(c.uv).grad(c.dx.mul(scale), c.dy.mul(scale)) as unknown as Vec4Node;
  return mix(slot.mean, value, slot.arrive);
}

/**
 * A slot's value at an explicit mip level (for loops and branches, where a lookup may not take
 * screen-space derivatives).
 */
export function sampleSlotLevel(slot: MapSlot, uv: Vec2Node, level: FloatNode): Vec4Node {
  const value = slot.node.sample(uv).level(level.add(slot.blur)) as unknown as Vec4Node;
  return mix(slot.mean, value, slot.arrive);
}

/** The mip level a lookup with these gradients picks on a map `width` texels wide (isotropic estimate). */
export function mipLevel(c: MapCoords, width: FloatNode): FloatNode {
  const texels = vec2(c.dx.x.mul(width), c.dx.y.mul(width).mul(0.5)).length().max(vec2(c.dy.x.mul(width), c.dy.y.mul(width).mul(0.5)).length());
  return texels.max(1e-6).log2().max(0);
}

/** The bound texture's size in texels (it changes as files stream in; the lookup follows). */
function slotSize(slot: MapSlot): Vec2Node {
  const size = slot.node.size(int(0)) as unknown as Node<'ivec2'>;
  return vec2(float(size.x), float(size.y));
}

/** Pixels one texel of the slot's bound map spans here (above 1: magnified), from the lookup's gradients. */
export function magnification(c: MapCoords, slot: MapSlot): FloatNode {
  const size = slotSize(slot);
  const texels = c.dx.mul(size).length().max(c.dy.mul(size).length());
  return float(1).div(texels.max(1e-6));
}

/**
 * A slot's value through a cubic B-spline instead of bilinear filtering (four bilinear taps, Sigg and
 * Hadwiger 2005): a magnified low-resolution map then shades smoothly instead of showing its texels
 * and its block-compression edges. Same gradients (and so the same mip level) as sampleSlot.
 */
export function sampleSlotSmooth(slot: MapSlot, c: MapCoords, extraBlur: FloatNode | number = 0): Vec4Node {
  const size = slotSize(slot);
  const scale = exp2(slot.blur.add(extraBlur));
  const dx = c.dx.mul(scale);
  const dy = c.dy.mul(scale);
  const p = c.uv.mul(size).sub(0.5);
  const i = floor(p);
  const f = p.sub(i);
  const f2 = f.mul(f);
  const f3 = f2.mul(f);
  const w0 = float(1).sub(f).pow(3).div(6);
  const w1 = f3.mul(3).sub(f2.mul(6)).add(4).div(6);
  const w2 = f3.mul(-3).add(f2.mul(3)).add(f.mul(3)).add(1).div(6);
  const w3 = f3.div(6);
  const g0 = w0.add(w1);
  const g1 = w2.add(w3);
  const h0 = i.sub(0.5).add(w1.div(g0.max(1e-6))).div(size);
  const h1 = i.add(1.5).add(w3.div(g1.max(1e-6))).div(size);
  const tap = (u: FloatNode, v: FloatNode): Vec4Node => slot.node.sample(vec2(u, v)).grad(dx, dy);
  const value = tap(h0.x, h0.y).mul(g0.x).add(tap(h1.x, h0.y).mul(g1.x)).mul(g0.y).add(tap(h0.x, h1.y).mul(g0.x).add(tap(h1.x, h1.y).mul(g1.x)).mul(g1.y));
  return mix(slot.mean, value, slot.arrive);
}

/**
 * Local east and north at a point of a sphere (unit direction `n`, body frame): the tangent frame of
 * the planets' normal maps (x toward increasing u, y toward north, z out).
 */
export function tangentFrame(n: Vec3Node): { east: Vec3Node; north: Vec3Node } {
  const rho = n.x.mul(n.x).add(n.z.mul(n.z)).sqrt().max(1e-5);
  const east = vec3(n.z.div(rho), float(0), n.x.negate().div(rho));
  const north = vec3(n.y.negate().mul(n.x).div(rho), rho, n.y.negate().mul(n.z).div(rho));
  return { east, north };
}

/**
 * A normal map's texel (UASTC normal mode: x in green, y in alpha, both stored as 0..1) as a tangent
 * normal, with its slope scaled by `strength` (1 as published, which already exaggerates the relief).
 */
export function decodeNormal(texel: Vec4Node, strength: FloatNode | number = 1): Vec3Node {
  const xy = vec2(texel.y, texel.w).mul(2).sub(1).mul(strength);
  const z = float(1).sub(xy.dot(xy)).max(0.04).sqrt();
  return vec3(xy.x, xy.y, z).normalize();
}

/** |x| softened near 0 over `soft` (keeps derivatives continuous where a ridge would alias). */
export function softAbs(x: FloatNode, soft: number): FloatNode {
  return abs(x).mul(abs(x)).add(soft * soft).sqrt();
}
