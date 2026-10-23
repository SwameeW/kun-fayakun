/**
 * Saturn's rings at their measured structure: the Cassini radio-occultation optical-depth profile
 * (public/assets/jpl/physical.json, binned by scripts/jpl/build.py from the PDS product cited
 * there), sampled from a mipmapped strip so fine ringlets average out instead of shimmering when
 * they are smaller than a pixel. Only their colour is illustrative (it follows optical depth: the
 * thick B ring cream, the thin C ring and Cassini Division greyer).
 *
 * Light: a thin layer of icy particles, single scattering. The lit face reflects
 * w P / 4 * mu0 / (mu0 + mu) * (1 - exp(-tau (1/mu0 + 1/mu))); seen from the unlit side, light
 * scattered through the layer is w P / 4 * mu0 / (mu - mu0) * (exp(-tau/mu) - exp(-tau/mu0)), bright
 * where the ring is thin and black where it is opaque. With the Sun only a few degrees above the
 * rings (late 2026, just after the 2025 equinox) they are dim, as they should be. The particles
 * scatter light back toward the Sun more than sideways (P), and the globe's shadow falls on them.
 */

import { ClampToEdgeWrapping, DataTexture, DoubleSide, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshBasicNodeMaterial, NormalBlending, RedFormat, RingGeometry, UnsignedByteType, Vector3 } from 'three/webgpu';
import { abs, dot, exp, float, fwidth, length, log, max, min, mix, normalize, positionLocal, pow, select, smoothstep, texture, uniform, vec2, vec3 } from 'three/tsl';
import type { FloatNode, Tier, Vec3Node } from './shading';

const SEGMENTS: Readonly<Record<Tier, number>> = { high: 512, mid: 384, low: 256 };

/** The rings' radial profile: mean normal transmission exp(-tau) per bin from inner to outer edge. */
export interface RingProfileData {
  innerKm: number;
  outerKm: number;
  transmission: readonly number[];
}

/** The particles' single-scattering albedo (illustrative, a little under the measured ~0.5-0.6). */
const ALBEDO = 0.55;
/** Optical depth where the profile's signal was lost (the B ring's cores) reads as this. */
const MAX_TAU = 5;
/** How much brighter the rings look than single scattering alone gives (thick layers scatter many times). */
const MULTIPLE = 2.2;

export interface ProfileTexture {
  readonly texture: DataTexture;
  /** Normal optical depth at radial share s (0 inner edge, 1 outer edge), sampled with the strip's mipmaps. */
  tau(s: FloatNode): FloatNode;
  dispose(): void;
}

export function createProfileTexture(profile: RingProfileData): ProfileTexture {
  const count = profile.transmission.length;
  const data = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) data[i] = Math.round(Math.min(1, Math.max(0, profile.transmission[i] ?? 1)) * 255);
  const strip = new DataTexture(data, count, 1, RedFormat, UnsignedByteType);
  strip.wrapS = ClampToEdgeWrapping;
  strip.wrapT = ClampToEdgeWrapping;
  strip.magFilter = LinearFilter;
  strip.minFilter = LinearMipmapLinearFilter;
  strip.generateMipmaps = true;
  strip.needsUpdate = true;
  return {
    texture: strip,
    tau(s) {
      const t = texture(strip, vec2(s, 0.5)).r;
      // Outside the profile the rings are empty.
      const inside = smoothstep(-0.002, 0, s).mul(float(1).sub(smoothstep(1, 1.002, s)));
      return min(log(max(t, 1 / 512)).negate(), MAX_TAU).mul(inside);
    },
    dispose() {
      strip.dispose();
    },
  };
}

/**
 * The particles' phase function of the scattering angle (cos 1: light going on as it came, -1:
 * straight back toward the Sun): mostly back toward the Sun, as icy regolith scatters, with a little
 * forward scattering from dust; mean 1.
 */
function phase(cosScatter: FloatNode): FloatNode {
  const hg = (g: number): FloatNode => float(1 - g * g).div(pow(float(1 + g * g).sub(cosScatter.mul(2 * g)), 1.5));
  return hg(-0.35).mul(0.78).add(hg(0.55).mul(0.22));
}

export interface ExploreRings {
  readonly mesh: Mesh;
  /** Sun direction and the eye, in the rings' (the planet's) own frame. */
  update(sunLocal: Vector3, eyeLocal: Vector3, light: number): void;
  setTier(tier: Tier): void;
  dispose(): void;
}

/**
 * The rings as a disc in the planet's equator (local y up), radii in planet radii. `polar` is the
 * globe's polar radius (for its shadow on the rings).
 */
export function createRings(profile: ProfileTexture, inner: number, outer: number, polar: number, tier: Tier): ExploreRings {
  const uSun = uniform(new Vector3(0, 1, 0));
  const uEye = uniform(new Vector3(0, 1, 3));
  const uLight = uniform(1);
  const radius = length(positionLocal.xz);
  const s = radius.sub(inner).div(outer - inner);
  const tau = profile.tau(s);
  const view = normalize(uEye.sub(positionLocal));
  const mu = max(abs(view.y), 1e-3);
  const mu0 = max(abs(uSun.y), 1e-3);
  // Sunlight travels along -sun and leaves toward the eye along view.
  const p = phase(dot(view, uSun).negate()).mul(ALBEDO / 4).mul(MULTIPLE);
  const reflected = p.mul(mu0.div(mu0.add(mu))).mul(float(1).sub(exp(tau.mul(float(1).div(mu0).add(float(1).div(mu))).negate())));
  const near = abs(mu.sub(mu0)).lessThan(1e-3);
  const throughFar = mu0.div(mu.sub(mu0)).mul(exp(tau.div(mu).negate()).sub(exp(tau.div(mu0).negate())));
  const throughNear = tau.mul(mu0).div(mu.mul(mu)).mul(exp(tau.div(mu).negate()));
  const transmitted = p.mul(select(near, throughNear, throughFar));
  // The lit face is the one on the Sun's side of the ring plane, softened over a pixel at a crossing.
  const sameSide = view.y.mul(uSun.y);
  const lit = smoothstep(max(fwidth(sameSide), 1e-6).negate(), max(fwidth(sameSide), 1e-6), sameSide);
  let light: FloatNode = mix(transmitted, reflected, lit);
  // The globe's shadow: does the ray from here toward the Sun meet the (flattened) globe?
  const q = vec3(positionLocal.x, positionLocal.y.div(polar), positionLocal.z);
  const l = normalize(vec3(uSun.x, uSun.y.div(polar), uSun.z));
  const b = dot(q, l);
  const miss = dot(q, q).sub(b.mul(b));
  const edge = max(fwidth(miss), 1e-4);
  const shadow = float(1).sub(smoothstep(float(1).sub(edge), float(1).add(edge), miss)).mul(smoothstep(0, 0.02, b.negate()));
  light = light.mul(float(1).sub(shadow.mul(0.97)));
  // Colour follows optical depth: the thick B ring cream, thin ringlets greyer.
  const thickness = smoothstep(0.15, 1.6, tau);
  const colour: Vec3Node = mix(vec3(0.72, 0.68, 0.62), vec3(1, 0.9, 0.74), thickness);
  const material = new MeshBasicNodeMaterial({ side: DoubleSide, transparent: true, depthWrite: false, fog: false, blending: NormalBlending, premultipliedAlpha: true });
  material.colorNode = colour.mul(light).mul(uLight);
  // What the rings let through of what is behind them, along this line of sight.
  material.opacityNode = float(1).sub(exp(tau.div(mu).negate()));
  let geometry = ringGeometry(inner, outer, SEGMENTS[tier]);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'explore-saturn-rings';
  let current = tier;
  return {
    mesh,
    update(sunLocal, eyeLocal, light) {
      uSun.value.copy(sunLocal);
      uEye.value.copy(eyeLocal);
      uLight.value = light;
    },
    setTier(next) {
      if (next === current) return;
      current = next;
      const old = geometry;
      geometry = ringGeometry(inner, outer, SEGMENTS[next]);
      mesh.geometry = geometry;
      old.dispose();
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

function ringGeometry(inner: number, outer: number, segments: number): RingGeometry {
  const geometry = new RingGeometry(inner, outer, segments, 1);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/** The rings' transmission of sunlight onto a point of the globe (1 where no ring is in the way). */
export function ringShadow(profile: ProfileTexture, point: Vec3Node, sun: Vec3Node, inner: number, outer: number): FloatNode {
  const sy = select(sun.y.greaterThanEqual(0), max(sun.y, 1e-4), min(sun.y, -1e-4));
  const along = point.y.negate().div(sy);
  const hit = point.add(sun.mul(along));
  const s = length(hit.xz).sub(inner).div(outer - inner);
  const tau = profile.tau(s);
  const through = exp(tau.div(max(abs(sun.y), 1e-3)).negate());
  const ahead = smoothstep(0, max(fwidth(along), 1e-5), along);
  return mix(float(1), through, ahead);
}
