/**
 * Jupiter and Saturn for the explorer: flattened globes of cloud bands, and Saturn's rings.
 *
 * Belts, zones and storms are drawn after the planets' general look, not measured (illustrative,
 * as the interface says, until the mission maps arrive in Stage 7): turbulence stretched east-west
 * by the zonal winds, fading out toward the poles, which turn a smooth muted colour.
 *
 * Light: Minnaert's law with k = 1.25 (mu0^k mu^(k-1)), so the disc darkens toward its limb as cloud
 * decks under haze do; near the terminator sunlight crosses more of the upper haze and reddens, and a
 * faint warm twilight carries a little past it; the terminator is softened over a pixel. Saturn's
 * globe takes the rings' shadow from their measured optical depth.
 */

import { FrontSide, Group, Matrix4, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3, type Data3DTexture } from 'three/webgpu';
import { abs, dot, float, max, mix, normalize, positionLocal, pow, smoothstep, texture3D, uniform, vec3 } from 'three/tsl';
import { band, keepOnSphere, litCosine, noiseIfKept, ripple, sphereFootprint, sunlit, type FloatNode, type Tier, type Vec3Node } from './shading';
import { createRings, ringShadow, type ExploreRings, type ProfileTexture } from './rings';

const SEGMENTS: Readonly<Record<Tier, readonly [number, number]>> = { high: [192, 128], mid: [160, 112], low: [112, 80] };
/** Minnaert's exponent for the cloud decks' limb darkening (1 would be Lambert). */
const MINNAERT_K = 1.25;

type Surface = (n: Vec3Node, footprint: FloatNode, level: Tier) => Vec3Node;

/** 0 at the equator to 1 near the poles: the zonal patterns give way to a smooth polar colour. */
const polarCap = (y: FloatNode, from: number, to: number): FloatNode => smoothstep(from, to, abs(y));

/**
 * Jupiter: cream zones and rust-brown belts, a pale equatorial zone, east-west streaks within them,
 * and an oval storm in the southern tropics after the Great Red Spot's look.
 */
export function jupiterSurface(noise: Data3DTexture): Surface {
  return (n, footprint, level) => {
    const T = (p: Vec3Node): FloatNode => texture3D(noise, p).r;
    const cap = polarCap(n.y, 0.72, 0.9);
    const zonal = float(1).sub(cap);
    // Turbulence stretched east-west, as the zonal winds draw it out (long and thin), at four scales,
    // each kept only while its streaks span a few pixels.
    const big = T(vec3(n.x.mul(1.6), n.y.mul(6), n.z.mul(1.6)).add(0.37)).sub(0.5);
    const mid = T(vec3(n.x.mul(3), n.y.mul(24), n.z.mul(3)).add(0.11)).sub(0.5).mul(keepOnSphere(footprint, 80));
    const fineKept = keepOnSphere(footprint, 220);
    const finerKept = keepOnSphere(footprint, 520);
    const fine = level === 'low' ? float(0) : noiseIfKept(noise, vec3(n.x.mul(7), n.y.mul(64), n.z.mul(7)).add(0.71), fineKept).sub(0.5).mul(fineKept);
    const finer = level === 'high' ? noiseIfKept(noise, vec3(n.x.mul(16), n.y.mul(150), n.z.mul(16)).add(0.29), finerKept).sub(0.5).mul(finerKept) : float(0);
    const swirl = big.mul(0.05).add(mid.mul(0.03)).add(fine.mul(0.012)).add(finer.mul(0.005));
    const y = n.y.add(swirl.mul(zonal));
    const zone = vec3(0.78, 0.73, 0.62);
    const equator = vec3(0.8, 0.7, 0.55);
    const belt = vec3(0.58, 0.39, 0.25);
    const darkBelt = vec3(0.48, 0.31, 0.19);
    const temperate = vec3(0.6, 0.5, 0.39);
    const pole = vec3(0.5, 0.47, 0.43);
    let c: Vec3Node = zone;
    c = mix(c, equator, band(y, -0.122, 0.122, 0.015));
    const north = band(y, 0.122, 0.292, 0.018);
    const south = band(y, -0.342, -0.122, 0.02);
    // Within the belts, the colour streaks along the flow rather than breaking into blotches.
    const streaks = mid.mul(0.55).add(fine.mul(0.4)).add(finer.mul(0.3));
    c = mix(c, belt.mul(streaks.add(1)), north.mul(big.mul(0.4).add(0.95)));
    c = mix(c, darkBelt.mul(streaks.add(1)), south.mul(big.mul(0.4).add(0.95)));
    // Dark filaments drawn out by the winds (ridges of the finer turbulence).
    const filaments = float(1).sub(abs(fine.add(finer.mul(0.7)).mul(3.2))).max(0).mul(north.add(south)).mul(zonal);
    c = c.mul(float(1).sub(filaments.mul(0.18)));
    c = mix(c, temperate, band(y, 0.407, 0.515, 0.014).mul(0.85));
    c = mix(c, temperate, band(y, -0.53, -0.438, 0.014).mul(0.8));
    c = mix(c, temperate, band(y, 0.574, 0.629, 0.012).mul(0.55));
    c = mix(c, temperate, band(y, -0.656, -0.602, 0.012).mul(0.5));
    // Thin streaks within the bands, drawn out by the winds.
    c = c.mul(ripple(y, 240, big.mul(6)).mul(0.06).mul(zonal).add(1));
    // The oval storm in the southern tropics.
    const lat = -22.5 * (Math.PI / 180);
    const centre = vec3(0, Math.sin(lat), Math.cos(lat));
    const ex = dot(n, vec3(1, 0, 0)).div(0.125);
    const ny = dot(n, vec3(0, Math.cos(lat), -Math.sin(lat))).div(0.078);
    const r2 = ex.mul(ex).add(ny.mul(ny)).add(mid.mul(0.3));
    const facing = smoothstep(0.5, 0.7, dot(n, centre));
    const spot = float(1).sub(smoothstep(0.35, 1.05, r2)).mul(facing);
    const collar = smoothstep(0.85, 1.25, r2).mul(float(1).sub(smoothstep(1.35, 2.4, r2))).mul(facing);
    c = mix(c, zone, collar.mul(0.6));
    c = mix(c, vec3(0.74, 0.4, 0.27).mul(fine.mul(0.3).add(1)), spot);
    c = c.mul(fine.mul(0.08).add(finer.mul(0.06)).add(mid.mul(0.05)).mul(zonal).add(1));
    // The poles: one smooth muted colour, no streaks.
    return mix(c, pole.mul(big.mul(0.08).add(1)), cap);
  };
}

/** Saturn: pale butterscotch, softly banded, a brighter equatorial zone, a muted hexagon-free pole. */
export function saturnSurface(noise: Data3DTexture): Surface {
  return (n, footprint, level) => {
    const T = (p: Vec3Node): FloatNode => texture3D(noise, p).r;
    const cap = polarCap(n.y, 0.78, 0.93);
    const zonal = float(1).sub(cap);
    const big = T(vec3(n.x.mul(1.2), n.y.mul(7), n.z.mul(1.2)).add(0.13)).sub(0.5);
    const fineKept = keepOnSphere(footprint, 150);
    const fine = level === 'low' ? float(0) : noiseIfKept(noise, vec3(n.x.mul(4), n.y.mul(40), n.z.mul(4)).add(0.52), fineKept).sub(0.5).mul(fineKept);
    const y = n.y.add(big.mul(0.025).mul(zonal));
    const ay = abs(y);
    const base = vec3(0.86, 0.77, 0.58);
    const belt = vec3(0.74, 0.61, 0.42);
    let c: Vec3Node = base;
    c = mix(c, vec3(0.9, 0.83, 0.65), band(y, -0.14, 0.14, 0.035));
    c = mix(c, belt, band(ay, 0.2, 0.34, 0.035).mul(0.75));
    c = mix(c, belt, band(ay, 0.44, 0.54, 0.025).mul(0.5));
    c = mix(c, belt, band(ay, 0.62, 0.68, 0.02).mul(0.4));
    c = c.mul(ripple(y, 160, fine.mul(4)).mul(0.03).mul(zonal).add(1));
    c = c.mul(fine.mul(0.07).mul(zonal).add(1));
    return mix(c, vec3(0.62, 0.62, 0.58), cap);
  };
}

export interface GiantFrame {
  /** Unit direction to the Sun, render frame. */
  sun: { x: number; y: number; z: number };
  /** Sunlight on the planet (1 at 1 au). */
  light: number;
}

export interface ExploreGiant {
  readonly object: Group;
  /** Set the object's position, scale and orientation first, and its world matrix current. */
  update(frame: GiantFrame, cameraWorld: Vector3): void;
  setTier(tier: Tier): void;
  dispose(): void;
}

export interface GiantOptions {
  name: string;
  /** Polar over equatorial radius. */
  polar: number;
  surface: Surface;
  /** Saturn: the rings' profile and their inner and outer radius in planet radii. */
  rings?: { profile: ProfileTexture; inner: number; outer: number };
}

export function createGiant(options: GiantOptions, tier: Tier): ExploreGiant {
  const object = new Group();
  object.name = options.name;
  const uLight = uniform(1);
  const uSun = uniform(new Vector3(1, 0, 0));
  const uEye = uniform(new Vector3(0, 0, 3));
  const polar = options.polar;

  const build = (level: Tier): MeshBasicNodeMaterial => {
    const n = normalize(positionLocal);
    const footprint = sphereFootprint(n);
    const albedo = options.surface(n, footprint, level);
    // The flattened globe: its points and normals in the body's frame.
    const point = vec3(positionLocal.x, positionLocal.y.mul(polar), positionLocal.z);
    const normal = normalize(vec3(positionLocal.x, positionLocal.y.div(polar), positionLocal.z));
    const view = normalize(uEye.sub(point));
    const nDotL = dot(normal, uSun);
    const mu0 = litCosine(nDotL);
    const mu = max(dot(normal, view), 0.02);
    const minnaert = pow(mu0, MINNAERT_K).mul(pow(mu, MINNAERT_K - 1));
    // Low sunlight crosses more haze: warmer toward the terminator, and a faint twilight past it.
    const warm = mix(vec3(1, 0.6, 0.36), vec3(1, 1, 1), smoothstep(0, 0.3, mu0));
    const twilight = smoothstep(-0.07, 0.01, nDotL).mul(float(1).sub(smoothstep(0, 0.12, nDotL))).mul(0.018);
    let light: Vec3Node = warm.mul(minnaert.mul(sunlit(nDotL, 0.01))).add(vec3(1, 0.55, 0.3).mul(twilight));
    if (options.rings) light = light.mul(ringShadow(options.rings.profile, point, uSun, options.rings.inner, options.rings.outer));
    const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
    material.colorNode = albedo.mul(light).mul(uLight);
    return material;
  };

  const materials = new Map<Tier, MeshBasicNodeMaterial>();
  const materialFor = (level: Tier): MeshBasicNodeMaterial => {
    let m = materials.get(level);
    if (!m) {
      m = build(level);
      materials.set(level, m);
    }
    return m;
  };
  let geometry = new SphereGeometry(1, ...SEGMENTS[tier]);
  const globe = new Mesh(geometry, materialFor(tier));
  globe.scale.y = polar;
  globe.name = `${options.name}-globe`;
  object.add(globe);
  const rings: ExploreRings | null = options.rings ? createRings(options.rings.profile, options.rings.inner, options.rings.outer, polar, tier) : null;
  if (rings) object.add(rings.mesh);
  let current = tier;
  const inverse = new Matrix4();
  const eye = new Vector3();

  return {
    object,
    update(frame, cameraWorld) {
      uLight.value = frame.light;
      inverse.copy(object.matrixWorld).invert();
      uSun.value.set(frame.sun.x, frame.sun.y, frame.sun.z).transformDirection(inverse);
      eye.copy(cameraWorld).applyMatrix4(inverse);
      uEye.value.copy(eye);
      rings?.update(uSun.value, eye, frame.light);
      object.visible = frame.light > 1e-3;
    },
    setTier(next) {
      if (next === current) return;
      current = next;
      const old = geometry;
      geometry = new SphereGeometry(1, ...SEGMENTS[next]);
      globe.geometry = geometry;
      old.dispose();
      globe.material = materialFor(next);
      rings?.setTier(next);
    },
    dispose() {
      geometry.dispose();
      for (const m of materials.values()) m.dispose();
      rings?.dispose();
    },
  };
}
