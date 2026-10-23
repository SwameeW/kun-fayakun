/**
 * Jupiter and Saturn for the explorer, from Hubble's OPAL global maps (Jupiter 2025-12-11, Saturn
 * 2025-08-29), on flattened globes read at planetographic latitude (the latitude of the ellipsoid's
 * normal, as OPAL's maps are navigated), and Saturn's rings (./rings).
 *
 * Jupiter's bands drift: each latitude is carried east or west at its own speed, so belts slide past
 * zones. The drift is two-phase (a flow map): two readings of the map, each carried for one period
 * and then reset, cross-fade so that neither is ever carried further than half a period's drift, so
 * the map is never smeared, sheared or torn however long one watches. The speeds are schematic (jets
 * alternating with latitude, sped up so the motion shows), not a measured wind profile: illustrative.
 *
 * Light: Minnaert's law with k = 1.25 (mu0^k mu^(k-1)), so the disc darkens toward its limb as cloud
 * decks under haze do; near the terminator sunlight crosses more of the upper haze and reddens, and a
 * faint warm twilight carries a little past it; the terminator is softened over a pixel. Saturn's
 * globe takes the rings' shadow from the ring strip's measured opacity.
 */

import { FrontSide, Group, Matrix4, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3, type Object3D } from 'three/webgpu';
import { abs, asin, cos, dot, float, fract, max, mix, normalize, positionLocal, pow, smoothstep, uniform, vec3 } from 'three/tsl';
import type { PlanetTextures } from '../assets/streaming';
import type { ExploreDetail } from '../detail';
import { mapCoords, sampleSlot, shiftCoords, type FloatNode, type Vec3Node } from '../render/sampling';
import { createRings, ringShadow, type ExploreRings, type RingSpan } from './rings';
import { litCosine, sunlit } from './shading';

/** Minnaert's exponent for the cloud decks' limb darkening (1 would be Lambert). */
const MINNAERT_K = 1.25;
/**
 * Jupiter's schematic zonal drift: the fastest jet's speed (turns of longitude per second, sped up
 * for the eye), the latitude spacing of its alternating jets (radians), and the flow map's period
 * (seconds): the furthest any reading is carried is half the fastest jet's drift over one period.
 */
const FLOW = { speed: 1 / 2400, jetSpacing: 0.42, period: 16 } as const;

export interface GiantFrame {
  /** Seconds (the bands' drift). */
  time: number;
  /** Unit direction to the Sun, render frame. */
  sun: { x: number; y: number; z: number };
  /** Sunlight on the planet (1 at 1 au). */
  light: number;
}

export interface ExploreGiant {
  readonly object: Group;
  readonly rings: ExploreRings | null;
  /** Set the object's position, scale and orientation first, and its world matrix current. */
  update(frame: GiantFrame, cameraWorld: Vector3): void;
  prepare(detail: ExploreDetail): Object3D[];
  apply(detail: ExploreDetail): void;
  dispose(): void;
}

export interface GiantOptions {
  name: string;
  body: 'jupiter' | 'saturn';
  /** Polar over equatorial radius. */
  polar: number;
  /** The map's u at east longitude 0 (planets.json). */
  uAtLon0: number;
  /** Bands drift (Jupiter). */
  flow: boolean;
  /** Saturn: the rings' radial span in planet radii, and the geometry the strip's colour was measured in. */
  rings?: RingSpan & { mosaic: { mu0: number; mu: number; phaseRad: number } };
}

/** Schematic zonal speed at planetographic latitude `lat` (radians), turns per second. */
function zonalSpeed(lat: FloatNode): FloatNode {
  // Alternating jets, strongest near the equator and weakening toward the poles.
  return cos(lat.mul(Math.PI / FLOW.jetSpacing)).mul(cos(lat).pow(2)).mul(FLOW.speed);
}

export function createGiant(textures: PlanetTextures, options: GiantOptions, initial: ExploreDetail): ExploreGiant {
  const object = new Group();
  object.name = options.name;
  const uTime = uniform(0);
  const uLight = uniform(1);
  const uSun = uniform(new Vector3(1, 0, 0));
  const uEye = uniform(new Vector3(0, 0, 3));
  const polar = options.polar;
  const colourSlot = textures.slot(options.body, 'colour');
  const ringSlot = options.rings ? textures.slot('saturn', 'rings') : null;

  const build = (): MeshBasicNodeMaterial => {
    // The flattened globe: its points and outward normals in the body's frame.
    const point = vec3(positionLocal.x, positionLocal.y.mul(polar), positionLocal.z);
    const normal = normalize(vec3(positionLocal.x, positionLocal.y.div(polar), positionLocal.z));
    const c = mapCoords(normal, normal.y, options.uAtLon0);
    let albedo: Vec3Node;
    if (options.flow) {
      const lat = asin(normal.y.clamp(-1, 1));
      const speed = zonalSpeed(lat);
      const phase = fract(uTime.div(FLOW.period));
      const phaseB = fract(phase.add(0.5));
      // Each reading is carried by (phase - 0.5) periods of drift: from -half to +half, then reset.
      const a = sampleSlot(colourSlot, shiftCoords(c, speed.mul(phase.sub(0.5)).mul(FLOW.period).negate())).rgb;
      const b = sampleSlot(colourSlot, shiftCoords(c, speed.mul(phaseB.sub(0.5)).mul(FLOW.period).negate())).rgb;
      // Each reading's weight is greatest when it is carried least.
      const weightA = float(1).sub(abs(phase.mul(2).sub(1)));
      albedo = mix(b, a, weightA);
    } else {
      albedo = sampleSlot(colourSlot, c).rgb;
    }
    const view = normalize(uEye.sub(point));
    const nDotL = dot(normal, uSun);
    const mu0 = litCosine(nDotL);
    const mu = max(dot(normal, view), 0.02);
    const minnaert = pow(mu0, MINNAERT_K).mul(pow(mu, MINNAERT_K - 1));
    // Low sunlight crosses more haze: warmer toward the terminator, and a faint twilight past it.
    const warm = mix(vec3(1, 0.6, 0.36), vec3(1, 1, 1), smoothstep(0, 0.3, mu0));
    const twilight = smoothstep(-0.07, 0.01, nDotL).mul(float(1).sub(smoothstep(0, 0.12, nDotL))).mul(0.018);
    let light: Vec3Node = warm.mul(minnaert.mul(sunlit(nDotL, 0.01))).add(vec3(1, 0.55, 0.3).mul(twilight));
    if (options.rings && ringSlot) light = light.mul(ringShadow(ringSlot, point, uSun, options.rings));
    const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
    material.colorNode = albedo.mul(light).mul(uLight);
    return material;
  };

  const material = build();
  const geometries = new Map<number, SphereGeometry>();
  const sphere = (segments: number): SphereGeometry => {
    let g = geometries.get(segments);
    if (!g) {
      g = new SphereGeometry(1, segments, Math.max(16, Math.round(segments / 2)));
      geometries.set(segments, g);
    }
    return g;
  };
  const globe = new Mesh(sphere(initial.sphereSegments), material);
  globe.scale.y = polar;
  globe.name = `${options.name}-globe`;
  object.add(globe);
  const rings: ExploreRings | null = options.rings && ringSlot ? createRings(ringSlot, options.rings, polar, options.rings.mosaic, initial) : null;
  if (rings) object.add(rings.object);
  const inverse = new Matrix4();
  const eye = new Vector3();

  return {
    object,
    rings,
    update(frame, cameraWorld) {
      uTime.value = frame.time;
      uLight.value = frame.light;
      inverse.copy(object.matrixWorld).invert();
      uSun.value.set(frame.sun.x, frame.sun.y, frame.sun.z).transformDirection(inverse);
      eye.copy(cameraWorld).applyMatrix4(inverse);
      uEye.value.copy(eye);
      rings?.update(uSun.value, eye, frame.light, frame.time);
      object.visible = frame.light > 1e-3;
    },
    prepare(detail) {
      return rings ? rings.prepare(detail) : [];
    },
    apply(detail) {
      globe.geometry = sphere(detail.sphereSegments);
      rings?.apply(detail);
    },
    dispose() {
      for (const g of geometries.values()) g.dispose();
      material.dispose();
      rings?.dispose();
    },
  };
}
