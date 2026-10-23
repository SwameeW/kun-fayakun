/**
 * Jupiter and Saturn for the explorer, from Hubble's OPAL global maps (Jupiter 2025-12-11, Saturn
 * 2025-08-29), on flattened globes read at planetographic latitude (the latitude of the ellipsoid's
 * normal, as OPAL's maps are navigated), and Saturn's rings (./rings).
 *
 * Jupiter's bands drift: each latitude is carried east or west at its own speed, so belts slide past
 * zones. The drift is two-phase (a flow map): two readings of the map, each carried for one period
 * and then reset, cross-fade so that neither is ever carried far. The speeds are schematic (jets
 * alternating with latitude, sped up so the motion shows), not a measured wind profile: illustrative.
 * Two things keep the map from ever ghosting or smearing: the drift's speed on screen is capped (a
 * band never moves more than FLOW.pxPerSecond however far one zooms in, so the motion stays gentle up
 * close), and the period is short enough that the two readings are never more than FLOW.maxPx apart
 * when they are blended half and half; those moments come at different times at different latitudes
 * (the phase varies smoothly with latitude), never across the whole disc at once.
 *
 * Light: Minnaert's law with k = 1.25 (mu0^k mu^(k-1)), so the disc darkens toward its limb as cloud
 * decks under haze do; near the terminator sunlight crosses more of the upper haze and reddens, and a
 * faint warm twilight carries a little past it; the terminator is softened over a pixel. Saturn's
 * globe takes the rings' shadow from the ring strip's measured opacity (the thin C ring and Cassini
 * Division let light through as bright stripes across it), and a little light still reaches the
 * shadowed band (from the rings and the sky), so it never merges with space.
 *
 * Seen against the Sun, the upper haze above each globe lights up by forward scattering: a thin
 * bright rim around the night side (its own shell; illustrative height and strength).
 *
 * At Low the 1024 maps are read through a cubic B-spline, so a magnified globe shades smoothly
 * instead of showing its texels and its compression blocks.
 */

import { FrontSide, Group, Matrix4, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3, type Object3D } from 'three/webgpu';
import { abs, asin, cos, dot, exp, float, fract, length, max, min, mix, normalize, positionLocal, pow, sin, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import type { PlanetTextures } from '../assets/streaming';
import type { ExploreDetail } from '../detail';
import { blendAdditive } from '../render/blending';
import { mapCoords, sampleSlot, sampleSlotSmooth, shiftCoords, type FloatNode, type Vec3Node } from '../render/sampling';
import { createRings, ringShadow, type ExploreRings, type RingSpan } from './rings';
import { litCosine, sunlit } from './shading';

/** Minnaert's exponent for the cloud decks' limb darkening (1 would be Lambert). */
const MINNAERT_K = 1.25;
/**
 * Jupiter's schematic zonal drift: the fastest jet's speed (turns of longitude per second, sped up for
 * the eye), the latitude spacing of its alternating jets (radians), the fastest a band may move on
 * screen (px per second), and the most the flow map's two readings may differ when blended half and
 * half (px).
 */
const FLOW = { speed: 1 / 2400, jetSpacing: 0.42, pxPerSecond: 1.6, maxPx: 1.5 } as const;
/**
 * The ring-shadowed band's floor: light reaching it from the rings' unlit face and the sky, as a
 * share of direct sunlight (illustrative), so the globe's edge always separates from space.
 */
const SHADOWED_FLOOR = 0.08;
/**
 * The backlit haze: its shell's height and scale height (planet radii), its forward-scattering
 * asymmetry, and its brightness (all illustrative: drawn so the rim reads, not measured).
 */
const HAZE = { shell: 0.012, scale: 0.0035, g: 0.72, strength: 0.015 } as const;

export interface GiantFrame {
  /** Seconds (the bands' drift): an illustrative clock that stops with reduced motion. */
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

  const build = (detail: ExploreDetail): MeshBasicNodeMaterial => {
    const read = detail.tier === 'low' ? sampleSlotSmooth : sampleSlot;
    // The flattened globe: its points and outward normals in the body's frame.
    const point = vec3(positionLocal.x, positionLocal.y.mul(polar), positionLocal.z);
    const normal = normalize(vec3(positionLocal.x, positionLocal.y.div(polar), positionLocal.z));
    const c = mapCoords(normal, normal.y, options.uAtLon0);
    let albedo: Vec3Node;
    if (options.flow) {
      const lat = asin(normal.y.clamp(-1, 1));
      // Turns of longitude per pixel here: the drift is capped so a band never moves faster than
      // FLOW.pxPerSecond on screen (up close the motion stays gentle and the readings stay close).
      const turnsPerPx = length(vec2(c.dx.x, c.dy.x));
      const raw = zonalSpeed(lat);
      const speed = raw.sign().mul(min(raw.abs(), turnsPerPx.mul(FLOW.pxPerSecond)));
      // With the speed so capped, this period keeps the two readings within FLOW.maxPx when blended
      // half and half; the phase varies smoothly with latitude, so those moments never line up across the disc.
      const period = (2 * FLOW.maxPx) / FLOW.pxPerSecond;
      const phase = fract(uTime.div(period).add(sin(lat.mul(7.3)).mul(0.37)));
      const phaseB = fract(phase.add(0.5));
      // Each reading is carried by (phase - 0.5) periods of drift: from -half to +half, then reset.
      const a = read(colourSlot, shiftCoords(c, speed.mul(phase.sub(0.5)).mul(period).negate())).rgb;
      const b = read(colourSlot, shiftCoords(c, speed.mul(phaseB.sub(0.5)).mul(period).negate())).rgb;
      // Each reading's weight is greatest when it is carried least.
      const weightA = float(1).sub(abs(phase.mul(2).sub(1)));
      albedo = mix(b, a, weightA);
    } else {
      albedo = read(colourSlot, c).rgb;
    }
    const view = normalize(uEye.sub(point));
    const nDotL = dot(normal, uSun);
    const mu0 = litCosine(nDotL);
    const mu = max(dot(normal, view), 0.02);
    const minnaert = pow(mu0, MINNAERT_K).mul(pow(mu, MINNAERT_K - 1));
    // Low sunlight crosses more haze: warmer toward the terminator, and a faint twilight past it.
    const warm = mix(vec3(1, 0.6, 0.36), vec3(1, 1, 1), smoothstep(0, 0.3, mu0));
    const twilight = smoothstep(-0.07, 0.01, nDotL).mul(float(1).sub(smoothstep(0, 0.12, nDotL))).mul(0.018);
    const day = sunlit(nDotL, 0.01);
    let direct: Vec3Node = warm.mul(minnaert.mul(day));
    if (options.rings && ringSlot) {
      // The rings' shadow, and the little light that still reaches the band they shade.
      const through = ringShadow(ringSlot, point, uSun, options.rings);
      direct = direct.mul(through).add(warm.mul(minnaert.mul(day)).mul(float(1).sub(through)).mul(SHADOWED_FLOOR));
    }
    const light: Vec3Node = direct.add(vec3(1, 0.55, 0.3).mul(twilight));
    const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
    material.colorNode = albedo.mul(light).mul(uLight);
    return material;
  };

  /**
   * The haze above the globe, lit from behind: along each ray the column of a thin exponential haze
   * over the (flattened) globe, sunlit where it stands over the day side or the terminator, scattered
   * toward the eye by a forward lobe. Bright only when the Sun is nearly behind the planet.
   */
  const buildHaze = (): MeshBasicNodeMaterial => {
    // In the sphere the flattened globe is a unit sphere of (rays are straightened there too).
    const toUnit = (v: Vec3Node): Vec3Node => vec3(v.x, v.y.div(polar), v.z);
    const eye = toUnit(uEye);
    const ray = normalize(toUnit(positionLocal.mul(vec3(1, polar, 1))).sub(eye));
    const b = dot(eye, ray);
    const closest = eye.sub(ray.mul(b));
    const tangent = length(closest);
    const h = tangent.sub(1);
    const ahead = smoothstep(0, 0.02, b.negate());
    // The haze column along the ray (Chapman's grazing column over the limb; capped over the disc).
    const grazing = Math.sqrt((2 * Math.PI) / HAZE.scale);
    const column = exp(max(h, 0).div(-HAZE.scale)).mul(grazing).mul(smoothstep(-0.01, 0, h));
    const up = closest.div(max(tangent, 1e-6));
    const lit = smoothstep(-0.12, 0.05, dot(up, uSun));
    const g = HAZE.g;
    const cosTheta = dot(ray, uSun);
    const phase = float(1 - g * g).div(pow(float(1 + g * g).sub(cosTheta.mul(2 * g)), 1.5)).div(4 * Math.PI);
    const material = blendAdditive(new MeshBasicNodeMaterial({ side: FrontSide, transparent: true, depthWrite: false, fog: false }));
    material.colorNode = vec3(1, 0.93, 0.82).mul(column.mul(lit).mul(phase).mul(ahead).mul(HAZE.strength)).mul(uLight);
    material.opacityNode = float(1);
    return material;
  };

  const materials = new Map<string, MeshBasicNodeMaterial>();
  const keyOf = (d: ExploreDetail): string => (d.tier === 'low' ? 'smooth' : 'linear');
  const materialFor = (d: ExploreDetail): MeshBasicNodeMaterial => {
    const key = keyOf(d);
    let m = materials.get(key);
    if (!m) {
      m = build(d);
      materials.set(key, m);
    }
    return m;
  };
  const geometries = new Map<number, SphereGeometry>();
  const sphere = (segments: number): SphereGeometry => {
    let g = geometries.get(segments);
    if (!g) {
      g = new SphereGeometry(1, segments, Math.max(16, Math.round(segments / 2)));
      geometries.set(segments, g);
    }
    return g;
  };
  const globe = new Mesh(sphere(initial.sphereSegments), materialFor(initial));
  globe.scale.y = polar;
  globe.name = `${options.name}-globe`;
  object.add(globe);
  const hazeGeometry = new SphereGeometry(1 + HAZE.shell, 96, 48);
  const hazeMaterial = buildHaze();
  const haze = new Mesh(hazeGeometry, hazeMaterial);
  haze.scale.y = polar;
  haze.renderOrder = 2;
  haze.name = `${options.name}-haze`;
  object.add(haze);
  const rings: ExploreRings | null = options.rings && ringSlot ? createRings(ringSlot, options.rings, polar, options.rings.mosaic, initial) : null;
  if (rings) object.add(rings.object);
  const inverse = new Matrix4();
  const eye = new Vector3();
  const toEye = new Vector3();

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
      // The haze only shows with the Sun behind the planet (forward scattering): skipped otherwise.
      haze.visible = uSun.value.dot(toEye.copy(eye).normalize()) < 0.2;
      object.visible = frame.light > 1e-3;
    },
    prepare(detail) {
      const out: Object3D[] = [];
      const m = materialFor(detail);
      if (globe.material !== m) {
        const warm = new Mesh(sphere(detail.sphereSegments), m);
        warm.frustumCulled = false;
        out.push(warm);
      }
      if (rings) out.push(...rings.prepare(detail));
      return out;
    },
    apply(detail) {
      globe.material = materialFor(detail);
      globe.geometry = sphere(detail.sphereSegments);
      for (const [key, m] of materials) {
        if (key === keyOf(detail)) continue;
        m.dispose();
        materials.delete(key);
      }
      for (const [segments, g] of geometries) {
        if (segments === detail.sphereSegments) continue;
        g.dispose();
        geometries.delete(segments);
      }
      rings?.apply(detail);
    },
    dispose() {
      for (const g of geometries.values()) g.dispose();
      for (const m of materials.values()) m.dispose();
      hazeGeometry.dispose();
      hazeMaterial.dispose();
      rings?.dispose();
    },
  };
}
