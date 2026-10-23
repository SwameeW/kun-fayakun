/**
 * The Earth of today, for the explorer: seen whole from far away and from a few hundred km up.
 *
 * The continents come from the same few lookups of a 3D noise volume as the chapters' Earth
 * (src/chapters/shared/planet.ts, its "today" epoch), so the two worlds share their shapes; they are
 * illustrative, not the real geography, until the mission maps arrive (Stage 7). What the
 * explorer adds is what a true-scale view needs:
 *
 * - Land coloured by a rough climate (forest, grass, sand, rock, snow on the heights) and clouds
 *   gathered into weather systems drawn out east-west, thicker in the tropics' convergence and the
 *   mid-latitude storm tracks, thinner over the subtropical highs.
 * - Detail that switches on with closeness: finer octaves of the same noise roughen coastlines,
 *   relief tones, deserts and cloud edges as the camera comes down, each fading in only once its
 *   cells are several pixels across (so nothing shimmers), and clouds cast their shadows on the
 *   ground below them when the camera is low.
 * - Sunlight that reddens as it crosses more air: the ground near the terminator is lit warm.
 * - A sun glint on open water only (GGX, Fresnel), broad and below the bloom threshold, so it reads
 *   as sunlight on a rough sea, not a hole in the planet.
 * - An atmosphere shaded from the length of air along each line of sight: Rayleigh-blue haze over
 *   the disc, a bright blue rim over the lit limb fading upward with height, a narrow orange band
 *   where sunlight grazes the terminator, and the forward-scattered glow of a backlit limb. Its
 *   scale height is about three times the real one (25 km rather than 8), so the rim is visible from
 *   20,000 km; it is drawn as a shell that also dims what is behind it.
 * - Faint city lights on the night side's lowlands (illustrative, like the continents they are on).
 */

import { FrontSide, Group, Mesh, MeshBasicNodeMaterial, NormalBlending, Quaternion, SphereGeometry, Vector3, type Data3DTexture } from 'three/webgpu';
import {
  abs,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  fwidth,
  length,
  max,
  min,
  mix,
  modelPosition,
  normalize,
  normalWorld,
  positionLocal,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  texture3D,
  uniform,
  vec3,
} from 'three/tsl';
import { EARTH_AIR_SCALE } from '../system';
import { keepOnSphere, litCosine, noiseIfKept, sphereFootprint, sunlit, type FloatNode, type Tier, type Vec3Node } from './shading';

const SEGMENTS: Readonly<Record<Tier, readonly [number, number]>> = { high: [256, 160], mid: [192, 128], low: [128, 96] };
/** Detail octaves of the noise per tier (scale of the lookup, amplitude in height units). */
const DETAIL: Readonly<Record<Tier, ReadonlyArray<{ scale: number; height: number }>>> = {
  high: [
    { scale: 13, height: 0.034 },
    { scale: 41, height: 0.014 },
    { scale: 127, height: 0.006 },
  ],
  mid: [
    { scale: 13, height: 0.034 },
    { scale: 41, height: 0.014 },
  ],
  low: [{ scale: 13, height: 0.034 }],
};

/** Today's epoch, as the chapters' EARTH_TODAY with a little less cloud (seen whole and close, more surface shows). */
const SEA_LEVEL = 0.64 - 0.085;
const CLOUD_COVER = 0.6;

const ROCK = vec3(0.34, 0.27, 0.2);
const SAND = vec3(0.54, 0.43, 0.29);
const GRASS = vec3(0.21, 0.25, 0.11);
const FOREST = vec3(0.07, 0.15, 0.06);
const HIGHLAND = vec3(0.4, 0.36, 0.32);
const SEA = vec3(0.008, 0.045, 0.14);
const SHALLOW = vec3(0.04, 0.19, 0.24);
const ICE = vec3(0.85, 0.88, 0.92);
const CLOUD = vec3(0.93, 0.94, 0.95);

/** Vertical optical depth of the air for red, green and blue light (Rayleigh, about 680, 550 and 440 nm). */
const TAU = vec3(0.041, 0.097, 0.237);
const TAU_GREEN = 0.097;
/** The drawn atmosphere's scale height, in Earth radii (25 km: three times the real one, so it shows from afar). */
const SCALE_HEIGHT = 0.0039;
/** Slant column through the limb at tangent height 0, in vertical columns (Chapman: sqrt(2 pi R / H)). */
const LIMB_COLUMN = Math.sqrt((2 * Math.PI) / SCALE_HEIGHT);
/** Cloud tops, in Earth radii (about 7.5 km), for the shadows they cast. */
const CLOUD_HEIGHT = 0.0012;
/** The glint's roughness (GGX alpha): wind-roughened open sea. Its peak stays below the bloom threshold. */
const GLINT = { alpha: 0.2, scale: 4, peak: 0.5 } as const;

export interface EarthFrame {
  time: number;
  /** Unit direction to the Sun, render frame. */
  sun: { x: number; y: number; z: number };
  /** Sunlight on the Earth (1 at 1 au). */
  light: number;
  /** The Earth's equatorial radius as drawn (km times the scaled-space factor). */
  radius: number;
}

export interface ExploreEarth {
  readonly object: Group;
  /** Set the object's position, scale and orientation first. */
  update(frame: EarthFrame): void;
  setTier(tier: Tier): void;
  dispose(): void;
}

const rotateY = (v: Vec3Node, angle: FloatNode): Vec3Node =>
  vec3(v.x.mul(cos(angle)).sub(v.z.mul(sin(angle))), v.y, v.x.mul(sin(angle)).add(v.z.mul(cos(angle))));

/** Sunlight's colour after crossing the air at cosine mu, relative to overhead (white at noon, reddening low). */
function sunColour(mu: FloatNode): Vec3Node {
  const airmass = float(1).div(max(mu.add(0.12), 0.035));
  return exp(TAU.mul(float(1).sub(airmass)));
}

export function createEarth(noise: Data3DTexture, tier: Tier): ExploreEarth {
  const object = new Group();
  object.name = 'explore-earth';
  const uTime = uniform(0);
  const uLight = uniform(1);
  const uSun = uniform(new Vector3(1, 0, 0));
  /** The Sun's direction in the Earth's own frame (for where cloud shadows fall). */
  const uSunLocal = uniform(new Vector3(1, 0, 0));
  const uRadius = uniform(1);

  const T = (p: Vec3Node): FloatNode => texture3D(noise, p).r;

  const buildSurface = (level: Tier): MeshBasicNodeMaterial => {
    const raw = normalize(positionLocal);
    const footprint = sphereFootprint(raw);
    // Domain warp: coastlines and cloud bands bend instead of forming round blobs (as the chapters').
    const warp = vec3(T(raw.mul(1.1).add(0.61)), T(raw.mul(1.1).add(0.27)), T(raw.mul(1.1).add(0.93))).sub(0.5);
    const n = normalize(raw.add(warp.mul(0.45)));
    const c1 = T(n.mul(0.55).add(0.17));
    const c2 = T(n.mul(1.3).add(0.41));
    const c3 = T(n.mul(3.4).add(0.73));
    let h: FloatNode = c1.mul(0.6).add(c2.mul(0.3)).add(c3.mul(0.1));
    // Finer octaves, each kept only while its cells span a few pixels.
    const octaves = DETAIL[level].map((o, i) => {
      const kept = keepOnSphere(footprint, o.scale * 8);
      const value = noiseIfKept(noise, raw.mul(o.scale).add(0.29 + 0.24 * i), kept).sub(0.5);
      h = h.add(value.mul(o.height).mul(kept));
      return value.mul(kept);
    });
    const d1 = octaves[0] ?? float(0);
    const d2 = octaves[1] ?? float(0);
    const d3 = octaves[2] ?? float(0);
    const elevation = h.sub(SEA_LEVEL);
    // The shore: soft from afar, crisp (a pixel and a half) up close.
    const shore = max(fwidth(h).mul(1.5), 0.0015);
    const land = smoothstep(shore.mul(-0.5), shore, elevation);

    const latitude = abs(raw.y);
    // Climate, roughly: wet tropics and mid-latitudes, dry belts either side of the tropics, cold
    // toward the poles. Forests where it is wet, grass between, sand and bare rock where it is dry.
    const wet = smoothstep(0.22, 0.62, c2.add(d1.mul(0.35)));
    const tropics = float(1).sub(smoothstep(0.08, 0.28, latitude));
    const dryBelt = smoothstep(0.18, 0.32, latitude).mul(float(1).sub(smoothstep(0.5, 0.62, latitude)));
    const cold = smoothstep(0.62, 0.82, latitude);
    const moisture = clamp(wet.mul(float(1).sub(dryBelt.mul(0.5))).add(tropics.mul(0.25)), 0, 1);
    const bare = mix(SAND.mul(d2.mul(0.5).add(c3.mul(0.3)).add(0.92)), ROCK.mul(c3.mul(0.5).add(0.8)), clamp(cold.add(smoothstep(0.04, 0.1, elevation)), 0, 1));
    const vegetation = mix(GRASS.mul(d1.mul(0.6).add(1)), FOREST.mul(d2.mul(0.5).add(1)), smoothstep(0.55, 0.85, moisture));
    let ground: Vec3Node = mix(bare, vegetation, smoothstep(0.25, 0.55, moisture).mul(float(1).sub(cold.mul(0.6))));
    // Mountains: bare and grey on the heights, snow on the highest and in the cold.
    ground = mix(ground, HIGHLAND.mul(d2.mul(0.4).add(1)), smoothstep(0.1, 0.19, elevation));
    ground = mix(ground, ICE, smoothstep(0.17, 0.23, elevation.add(cold.mul(0.08))).mul(0.85));
    ground = ground.mul(d2.mul(0.35).add(d3.mul(0.3)).add(1));
    const ice = smoothstep(0.86, 0.93, latitude.add(d1.mul(0.05)));
    const sea = mix(SEA.mul(d1.mul(0.2).add(1)), SHALLOW, smoothstep(-0.05, 0, elevation).mul(0.6));
    const water = float(1).sub(land);
    let surface: Vec3Node = mix(sea, ground, land);
    surface = mix(surface, ICE, ice);

    // Clouds: large weather systems where the air rises (the tropics' convergence, the mid-latitude
    // storm tracks), fewer over the subtropical highs; finer octaves erode their edges up close.
    const cloudAt = (p: Vec3Node, fine: boolean, wanted?: FloatNode): { cover: FloatNode; thick: FloatNode } => {
      const swirl = rotateY(p.add(warp.mul(0.5)), uTime.mul(0.012));
      // Drawn out east-west, as the winds stretch weather systems. (Lookups only where wanted.)
      const look = (q: Vec3Node): FloatNode => (wanted ? noiseIfKept(noise, q, wanted) : T(q));
      const systems = look(swirl.mul(vec3(1.4, 2.6, 1.4)).add(0.9));
      const cells = look(swirl.mul(vec3(4.2, 6, 4.2)).add(0.4));
      let density: FloatNode = systems.mul(0.7).add(cells.mul(0.3));
      if (fine) {
        const octave = (scale: number, offset: number, cycles: number, amount: number): FloatNode => {
          const kept = keepOnSphere(footprint, cycles);
          return noiseIfKept(noise, swirl.mul(scale).add(offset), kept).sub(0.5).mul(amount).mul(kept);
        };
        density = density.add(octave(17, 0.17, 136, 0.15));
        if (level !== 'low') density = density.add(octave(53, 0.66, 424, 0.08));
        if (level === 'high') density = density.add(octave(160, 0.31, 1280, 0.045));
      }
      const lat = abs(p.y);
      const equatorial = lat.div(0.11);
      const climate = exp(equatorial.mul(equatorial).negate())
        .mul(0.11)
        .add(smoothstep(0.55, 0.72, lat).mul(float(1).sub(smoothstep(0.88, 0.97, lat))).mul(0.11))
        .sub(smoothstep(0.18, 0.3, lat).mul(float(1).sub(smoothstep(0.42, 0.55, lat))).mul(0.13));
      const amount = density.add(climate).sub(0.04 * (1 - CLOUD_COVER));
      return { cover: smoothstep(0.54, 0.69, amount).mul(0.92), thick: smoothstep(0.57, 0.85, amount) };
    };
    const clouds = cloudAt(raw, true);
    const cloud = clouds.cover;
    const nDotL = dot(normalWorld, uSun);
    const mu0 = litCosine(nDotL);
    // Shadows of the clouds, cast toward the ground along the sunlight (only once they are a few pixels long).
    let shade: FloatNode = float(1);
    if (level !== 'low') {
      const towardSun = uSunLocal.sub(raw.mul(dot(raw, uSunLocal)));
      const reach = float(CLOUD_HEIGHT).div(max(dot(raw, uSunLocal), 0.12));
      const visible = smoothstep(1.5, 4, reach.div(max(footprint, 1e-6))).mul(sunlit(nDotL, 0.02));
      const shadowCloud = cloudAt(normalize(raw.add(towardSun.mul(reach))), false, visible).cover;
      shade = float(1).sub(shadowCloud.mul(0.55).mul(visible).mul(float(1).sub(cloud)));
    }
    // Thick cloud tops are the brightest; thin cloud lets the ground through.
    surface = mix(surface.mul(shade), CLOUD.mul(clouds.thick.mul(0.16).add(0.84)), cloud);

    // Sunlight: Lambert, reddened by the air it crossed, softened over a pixel at the terminator.
    const sunlight = sunColour(mu0).mul(sunlit(nDotL, 0.015));
    let colour: Vec3Node = surface.mul(mu0).mul(sunlight);

    // The glint: GGX on open water, brighter toward the limb (Fresnel), capped below the bloom threshold.
    const view = normalize(cameraPosition.sub(positionWorld));
    const half = normalize(view.add(uSun));
    const nh = max(dot(normalWorld, half), 0);
    const nv = max(dot(normalWorld, view), 1e-3);
    const a2 = GLINT.alpha * GLINT.alpha;
    const denom = nh.mul(nh).mul(a2 - 1).add(1);
    const distribution = float(a2).div(denom.mul(denom).mul(Math.PI));
    const fresnel = float(0.02).add(pow(float(1).sub(max(dot(view, half), 0)), 5).mul(0.98));
    const k = GLINT.alpha / 2;
    const geometry = nv.div(nv.mul(1 - k).add(k)).mul(mu0.div(mu0.mul(1 - k).add(k)));
    const specular = distribution.mul(fresnel).mul(geometry).div(nv.mul(4));
    const glint = min(specular.mul(GLINT.scale), GLINT.peak).mul(water).mul(float(1).sub(cloud)).mul(float(1).sub(ice)).mul(shade);
    colour = colour.add(sunlight.mul(glint));

    // City lights on the night side's lowlands near the coast: faint, warm, illustrative.
    if (level === 'high') {
      const night = float(1).sub(smoothstep(-0.08, 0.06, nDotL));
      const lowland = land.mul(float(1).sub(smoothstep(0.03, 0.09, elevation))).mul(float(1).sub(ice)).mul(moisture.mul(0.7).add(0.3));
      // Clusters at the scale of the coast's own detail; up close the finer octaves break them into towns.
      const clusters = smoothstep(0.6, 0.76, c3.add(d1.mul(0.4)));
      const towns = max(d2.mul(1.4).add(d3.mul(1.8)).add(1), 0);
      const cities = lowland.mul(clusters).mul(towns).mul(night).mul(float(1).sub(cloud.mul(0.8)));
      colour = colour.add(vec3(1, 0.62, 0.3).mul(cities.mul(0.018)));
    }

    const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
    material.colorNode = colour.mul(uLight);
    return material;
  };

  /**
   * The air, from the column of it along each line of sight (in units of the vertical column): for
   * a ray that reaches the ground, 1 / cos of its angle there; for one passing over the limb, the
   * Chapman grazing column at its lowest height. Light scattered into the ray is the sunlight that
   * reaches the air there (reddened by its own slant path, nothing in the planet's shadow) times
   * the share of the ray's light the air scatters, with Rayleigh's phase and a little forward haze.
   */
  const buildAir = (): MeshBasicNodeMaterial => {
    const ray = normalize(positionWorld.sub(cameraPosition));
    const toCentre = modelPosition.sub(cameraPosition);
    const along = dot(toCentre, ray);
    const closest = cameraPosition.add(ray.mul(along)).sub(modelPosition);
    const b = length(closest).div(uRadius);
    const hits = b.lessThan(1);
    // Where the ray meets the ground (rays that do), and the cosine of its angle there.
    const surfaceCos = sqrt(max(float(1).sub(b.mul(b)), 0));
    const ground = cameraPosition.add(ray.mul(along.sub(surfaceCos.mul(uRadius)))).sub(modelPosition).div(uRadius);
    const lowest = select(hits, ground, closest.div(max(length(closest), 1e-6)));
    const height = max(b.sub(1), 0);
    const column = select(hits, min(float(1).div(max(surfaceCos, 1e-3)), LIMB_COLUMN), exp(height.div(-SCALE_HEIGHT)).mul(LIMB_COLUMN));
    const sunCos = dot(normalize(lowest), uSun);
    // Air a little above the ground stays lit a little past the terminator.
    const lit = smoothstep(-0.1, 0.02, sunCos);
    const reaching = sunColour(sunCos).mul(lit);
    const scattered = float(1).sub(exp(TAU.mul(column).negate()));
    const cosTheta = dot(ray, uSun);
    const rayleigh = float(1).add(cosTheta.mul(cosTheta)).mul(0.75);
    // Forward-scattering haze: the bright rim of a backlit Earth.
    const g = 0.72;
    const hg = float(1 - g * g).div(pow(float(1 + g * g).sub(cosTheta.mul(2 * g)), 1.5));
    const haze = float(1).sub(exp(column.mul(-0.012))).mul(hg).mul(0.5);
    const radiance = reaching.mul(scattered.mul(rayleigh).add(haze)).mul(0.62);
    const air = new MeshBasicNodeMaterial({ side: FrontSide, transparent: true, depthWrite: false, fog: false, blending: NormalBlending, premultipliedAlpha: true });
    air.colorNode = radiance.mul(uLight);
    // What the air lets through of the ground and stars behind it (green light's share).
    air.opacityNode = float(1).sub(exp(column.mul(-TAU_GREEN)));
    return air;
  };

  const materials = new Map<Tier, MeshBasicNodeMaterial>();
  const surfaceFor = (level: Tier): MeshBasicNodeMaterial => {
    let m = materials.get(level);
    if (!m) {
      m = buildSurface(level);
      materials.set(level, m);
    }
    return m;
  };
  let geometry = new SphereGeometry(1, ...SEGMENTS[tier]);
  const body = new Mesh(geometry, surfaceFor(tier));
  body.name = 'explore-earth-surface';
  const airMaterial = buildAir();
  const air = new Mesh(geometry, airMaterial);
  air.scale.setScalar(EARTH_AIR_SCALE);
  air.name = 'explore-earth-air';
  object.add(body, air);
  let current = tier;
  const inverse = new Quaternion();

  return {
    object,
    update(frame) {
      uTime.value = frame.time;
      uLight.value = frame.light;
      uSun.value.set(frame.sun.x, frame.sun.y, frame.sun.z).normalize();
      inverse.copy(object.quaternion).invert();
      uSunLocal.value.copy(uSun.value).applyQuaternion(inverse);
      uRadius.value = frame.radius;
      object.visible = frame.light > 1e-3;
    },
    setTier(next) {
      if (next === current) return;
      current = next;
      const old = geometry;
      geometry = new SphereGeometry(1, ...SEGMENTS[next]);
      body.geometry = geometry;
      air.geometry = geometry;
      old.dispose();
      body.material = surfaceFor(next);
    },
    dispose() {
      geometry.dispose();
      for (const m of materials.values()) m.dispose();
      airMaterial.dispose();
    },
  };
}
