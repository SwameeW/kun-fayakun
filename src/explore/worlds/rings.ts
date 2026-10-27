/**
 * The rings of Uranus and Neptune, from NSSDCA's ring fact sheets (worlds.json `rings`: each ring's
 * radius, width, normal optical depth and particle albedo). They are narrow (Uranus's are a few km
 * wide, its epsilon ring up to 96 km, at about 50,000 km) and dark (their particles reflect a few
 * percent of the light, darker than coal), so they are faint, as they are.
 *
 * Every ring is far narrower than a pixel from most places, so each pixel takes the share of its own
 * width each ring covers (the ring's radial span against the pixel's, from the radius's screen
 * derivative): a ring sub-pixel wide adds its equivalent width, never shimmering or breaking up.
 * Light: single scattering by a thin layer, w P / 4 * mu0 / (mu0 + mu) * (1 - exp(-tau (1/mu0 + 1/mu))),
 * with the particles' albedo and a backscattering phase (P = 6 at low phase, illustrative); the
 * planet's shadow falls across them. Neptune's Adams ring is drawn whole at its mean depth (its arcs,
 * whose longitudes drift, are not placed).
 */

import { DoubleSide, Mesh, MeshBasicNodeMaterial, RingGeometry, Vector3 } from 'three/webgpu';
import { abs, clamp, dot, exp, float, fwidth, length, max, min, normalize, positionLocal, smoothstep, uniform, vec3 } from 'three/tsl';
import { blendPremultiplied } from '../render/blending';
import type { FloatNode } from '../render/sampling';

export interface RingRow {
  name: string;
  radiusKm: number;
  widthKm: number;
  tau: number;
  albedo: number;
}

/** Reflected light per unit of albedo (w P / 4 with a backscattering P of about 6 at low phase angles: illustrative). */
const BACKSCATTER = 1.5;
/**
 * The rings are shown this many times brighter than they are: at their true brightness, a fiftieth of
 * their planet's and narrower than a pixel, a view exposed for the planet would not show them at all
 * (the readout says so: UniverseIllustration 'ring-light').
 */
const SHOWN_BRIGHTER = 10;
/** The rings' colour: neutral grey (they are spectrally flat and dark). */
const GREY: readonly [number, number, number] = [0.92, 0.92, 0.95];

export interface IceRings {
  readonly object: Mesh;
  /** Sun direction and the eye in the planet's own frame (planet radii), and its sunlight. */
  update(sunLocal: Vector3, eyeLocal: Vector3, light: number): void;
  dispose(): void;
}

export function createIceRings(name: string, rings: readonly RingRow[], planetRadiusKm: number): IceRings {
  const uSun = uniform(new Vector3(1, 0, 0));
  const uEye = uniform(new Vector3(0, 1, 3));
  const uLight = uniform(1);
  const rho = length(positionLocal.xz).mul(planetRadiusKm);
  const span = max(fwidth(rho), 1e-3);
  const view = normalize(uEye.sub(positionLocal));
  const mu = max(abs(view.y), 1e-3);
  const mu0 = max(abs(uSun.y), 1e-3);
  let cover: FloatNode = float(0);
  let reflected: FloatNode = float(0);
  for (const ring of rings) {
    // The share of this pixel's radial span the ring covers.
    const lo = max(rho.sub(span.mul(0.5)), ring.radiusKm - ring.widthKm / 2);
    const hi = min(rho.add(span.mul(0.5)), ring.radiusKm + ring.widthKm / 2);
    const share = clamp(hi.sub(lo).div(span), 0, 1);
    cover = cover.add(share.mul(float(1).sub(exp(float(-ring.tau).div(mu)))));
    reflected = reflected.add(share.mul(ring.albedo * BACKSCATTER).mul(float(1).sub(exp(float(-ring.tau).mul(float(1).div(mu0).add(float(1).div(mu)))))));
  }
  reflected = reflected.mul(mu0.div(mu0.add(mu)));
  // The planet's shadow (a sphere of radius 1 here): does the ray toward the Sun meet it?
  const b = dot(positionLocal, uSun);
  const miss = dot(positionLocal, positionLocal).sub(b.mul(b));
  const edge = max(fwidth(miss), 1e-4);
  const shadow = float(1).sub(smoothstep(float(1).sub(edge), float(1).add(edge), miss)).mul(smoothstep(0, 0.02, b.negate()));
  const material = blendPremultiplied(new MeshBasicNodeMaterial({ side: DoubleSide, transparent: true, depthWrite: false, fog: false }));
  material.colorNode = vec3(...GREY).mul(reflected).mul(float(1).sub(shadow)).mul(uLight).mul(SHOWN_BRIGHTER);
  material.opacityNode = min(cover, 1);
  const inner = Math.max(1.05, (Math.min(...rings.map((r) => r.radiusKm - r.widthKm / 2)) / planetRadiusKm) * 0.98);
  const outer = (Math.max(...rings.map((r) => r.radiusKm + r.widthKm / 2)) / planetRadiusKm) * 1.02;
  const geometry = new RingGeometry(inner, outer, 512, 1);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  return {
    object: mesh,
    update(sunLocal, eyeLocal, light) {
      uSun.value.copy(sunLocal);
      uEye.value.copy(eyeLocal);
      uLight.value = light;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
