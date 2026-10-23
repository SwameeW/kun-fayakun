/**
 * The Earth of today, for the explorer, from the mission maps (assets/planets: a composite of
 * several epochs, as the interface says).
 *
 * - Ground: Blue Marble Next Generation's July 2004 colour, lit by sunlight that has crossed the air
 *   (white at noon, reddening toward the terminator; the transmittance table in 'scatter' detail,
 *   its analytic form in 'chord') plus the sky's own blue fill, with ETOPO 2022's relief as a normal
 *   map (Medium and up), so mountain ranges catch the low sun.
 * - Water (Natural Earth's mask): a sun glint on open water only, GGX on a wind-roughened sea with
 *   Fresnel, bright toward the limb but held below the bloom threshold: sunlight on a rough sea, not
 *   a hole in the planet.
 * - City lights (Black Marble 2016) on the night side only, fading in through twilight and dimmed by
 *   cloud: today's Earth only (the chapters' early Earths never load them).
 * - Clouds (Blue Marble's 2001 cloud map) on their own shell 10 km up, drifting slowly eastward (an
 *   illustrative drift: real weather moves every way), lit like the ground, a little darker where
 *   thicker cloud lies toward the Sun (low sun: their tops gain relief), and casting their shadows on
 *   the ground beside them as the Sun gets low (cloudShadows).
 * - The air over all of it (./atmosphere).
 *
 * Every map is streamed (../assets/streaming): the first frames show each map's mean, the 1024 maps
 * follow at once and the focus's larger ones after; all of it sharpens in over about a second.
 */

import { FrontSide, Group, Matrix4, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3, type Data3DTexture, type Object3D, type Texture } from 'three/webgpu';
import { clamp, dot, exp, float, max, min, mix, normalize, positionLocal, pow, smoothstep, sqrt, uniform, vec3 } from 'three/tsl';
import type { PlanetTextures } from '../assets/streaming';
import type { ExploreDetail } from '../detail';
import { sunTransmittance, transmittanceToTop, type AirModel } from '../render/air';
import { blendPremultiplied } from '../render/blending';
import { decodeNormal, mapCoords, sampleSlot, shiftCoords, tangentFrame, type FloatNode, type MapCoords, type Vec3Node } from '../render/sampling';
import { createAir, type AirUniforms, type ExploreAir } from './atmosphere';
import { bumpGradient, keepOnSphere, litCosine, noiseIfKept, sphereFootprint, sunlit, tiltNormal } from './shading';

/** Blue Marble and the other Earth maps put Greenwich at u = 0.5 (planets.json bodies.earth.uAtLon0). */
const U_AT_LON0 = 0.5;
/** The cloud shell's height, planet radii (about 10 km: the tops of most weather clouds). */
const CLOUD_HEIGHT = 0.0016;
/** The clouds' illustrative eastward drift, turns of longitude per second (a full turn in two hours). */
const CLOUD_DRIFT = 1 / 7200;
/** Cloud tops' reflectance (bright, slightly short of fresh snow), and how dark a cloud's shadow is on the ground. */
const CLOUD_ALBEDO = 0.86;
const CLOUD_SHADOW = 0.62;
/**
 * The glint: GGX roughness of a wind-roughened sea, and the ceiling of its radiance (display terms at
 * the Earth's exposure), below the bloom threshold so it never blooms into a blob.
 */
const GLINT = { alpha: 0.2, ceiling: 0.62 } as const;
/**
 * City lights as shown: a warm sodium-and-LED tint for Black Marble's grey (illustrative) and their
 * strength on the night side. Real city light is about 10^-4 of daylight, far below what an exposure
 * set for the day side records; it is shown as the eye sees it at night, like the Moon's earthshine.
 */
const CITY = { tint: [1, 0.72, 0.42], strength: 0.9 } as const;

export interface EarthFrame {
  /** Seconds (the clouds' drift). */
  time: number;
  /** Unit direction to the Sun, render frame. */
  sun: { x: number; y: number; z: number };
  /** Sunlight on the Earth (1 at 1 au). */
  light: number;
}

export interface ExploreEarth {
  readonly object: Group;
  /** Set the object's position, scale and orientation first, and its world matrix current. */
  update(frame: EarthFrame, cameraWorld: Vector3): void;
  /** Builds what a detail level needs; returns the meshes whose materials should compile before apply(). */
  prepare(detail: ExploreDetail): Object3D[];
  apply(detail: ExploreDetail): void;
  dispose(): void;
}

const srgbToLinear = (x: FloatNode): FloatNode => pow(max(x, 0), 2.2);

export function createEarth(textures: PlanetTextures, noise: Data3DTexture, air: AirModel, table: { texture: Texture } | null, initial: ExploreDetail): ExploreEarth {
  const object = new Group();
  object.name = 'explore-earth';
  const uTime = uniform(0);
  const uLight = uniform(1);
  const uSun = uniform(new Vector3(1, 0, 0));
  const uEye = uniform(new Vector3(0, 0, 3));
  const airUniforms: AirUniforms = { eye: uEye, sun: uSun, light: uLight };
  const slot = {
    day: textures.slot('earth', 'day'),
    water: textures.slot('earth', 'water'),
    clouds: textures.slot('earth', 'clouds'),
    normal: textures.slot('earth', 'normal'),
    night: textures.slot('earth', 'night'),
  };
  const [tr, tg, tb] = air.verticalDepth;
  const tau = vec3(tr, tg, tb);

  /** Sunlight reaching height `r` (radii) at sun cosine mu: the table's, or the analytic slant column. */
  const sunAt = (scatter: boolean, r: number, mu: FloatNode): Vec3Node => {
    if (scatter && table) return sunTransmittance(air, table.texture, float(r), mu);
    const airmass = float(1).div(max(mu.add(0.12), 0.035));
    return exp(tau.mul(airmass).negate()).mul(smoothstep(-0.02, 0.02, mu));
  };
  /** The sky's diffuse light on a surface (half the air's scattered sunlight comes down), bluish. */
  const skyFill = (mu: FloatNode): Vec3Node => float(1).sub(exp(tau.negate())).mul(0.5).mul(clamp(mu.add(0.1), 0, 1));

  const cloudCoords = (c: MapCoords): MapCoords => shiftCoords(c, uTime.mul(CLOUD_DRIFT));

  /**
   * Illustrative detail below the maps' texels, for low orbit: octaves of the noise volume (about 64
   * features per unit of its coordinates) at `frequencies`, each fading in only once its features
   * span a few pixels, so it is never seen from afar and never shimmers. Returns their sum in -0.5..0.5
   * units and how much of the first octave is shown (how magnified the maps are).
   */
  const fine = (p: Vec3Node, frequencies: readonly number[], salt: number): { value: FloatNode; shown: FloatNode } => {
    const footprint = sphereFootprint(p);
    let value: FloatNode = float(0);
    let shown: FloatNode = float(0);
    frequencies.forEach((f, i) => {
      // Kept down to features of about two pixels (the noise is smooth within a feature).
      const kept = keepOnSphere(footprint, 64 * f * 0.55);
      if (i === 0) shown = kept;
      value = value.add(noiseIfKept(noise, p.mul(f).add(salt + 0.37 * i), kept).sub(0.5).mul(kept).mul(0.6 ** i));
    });
    return { value, shown };
  };

  /** Coordinates moved along the ground toward the Sun by `distance` radii. */
  const towardSun = (c: MapCoords, n: Vec3Node, distance: FloatNode): MapCoords => {
    const { east, north } = tangentFrame(n);
    const se = dot(uSun, east);
    const sn = dot(uSun, north);
    const flat = max(sqrt(se.mul(se).add(sn.mul(sn))), 1e-4);
    const cosLat = max(sqrt(n.x.mul(n.x).add(n.z.mul(n.z))), 0.05);
    return shiftCoords(c, se.div(flat).mul(distance).div(cosLat.mul(2 * Math.PI)), sn.div(flat).mul(distance).div(Math.PI));
  };

  const buildSurface = (detail: ExploreDetail): MeshBasicNodeMaterial => {
    const scatter = detail.atmosphere === 'scatter';
    const n = normalize(positionLocal);
    const c = mapCoords(n, n.y, U_AT_LON0);
    const albedo = sampleSlot(slot.day, c).rgb;
    const water = sampleSlot(slot.water, c).r;
    let normal: Vec3Node = n;
    if (detail.normalMaps) {
      const t = decodeNormal(sampleSlot(slot.normal, c));
      const { east, north } = tangentFrame(n);
      normal = normalize(east.mul(t.x).add(north.mul(t.y)).add(n.mul(t.z)));
    }
    // Low over the ground, illustrative detail finer than the maps: mottled land and rough relief.
    const land = float(1).sub(smoothstep(0.3, 0.7, water));
    const ground = fine(n, detail.tier === 'low' ? [60] : [60, 190], 0.11);
    const albedoDetailed = albedo.mul(ground.value.mul(0.7).mul(land).add(1));
    if (detail.normalMaps && detail.tier !== 'medium') {
      normal = tiltNormal(normal, bumpGradient(positionLocal, n, ground.value.mul(land).mul(0.00005)), 1);
    }
    const nDotL = dot(n, uSun);
    const sunColour = sunAt(scatter, 1, nDotL).mul(sunlit(nDotL, 0.004));
    const lambert = max(dot(normal, uSun), 0).mul(0.85).add(litCosine(nDotL).mul(0.15));

    // Cloud shadows: the cloud the sunlight crossed on its way down, CLOUD_HEIGHT up.
    let shade: FloatNode = float(1);
    const cc = detail.clouds ? cloudCoords(c) : null;
    if (detail.cloudShadows && cc) {
      const slant = float(CLOUD_HEIGHT).mul(sqrt(max(float(1).sub(nDotL.mul(nDotL)), 0)).div(max(nDotL, 0.08)));
      const shadowCloud = sampleSlot(slot.clouds, towardSun(cc, n, slant)).r;
      shade = float(1).sub(shadowCloud.mul(CLOUD_SHADOW));
    }
    let colour: Vec3Node = albedoDetailed.mul(sunColour.mul(lambert).mul(shade).add(skyFill(nDotL)));

    // The glint: GGX on open water (the sea is flat: the sphere's normal), Fresnel toward the limb.
    const view = normalize(uEye.sub(n));
    const half = normalize(view.add(uSun));
    const nh = max(dot(n, half), 0);
    const nv = max(dot(n, view), 1e-3);
    const nl = max(nDotL, 0);
    const a2 = GLINT.alpha * GLINT.alpha;
    const denom = nh.mul(nh).mul(a2 - 1).add(1);
    const distribution = float(a2).div(denom.mul(denom).mul(Math.PI));
    const fresnel = float(0.02).add(pow(float(1).sub(max(dot(view, half), 0)), 5).mul(0.98));
    const k = GLINT.alpha / 2;
    const geometry = nv.div(nv.mul(1 - k).add(k)).mul(nl.div(nl.mul(1 - k).add(k)));
    const specular = distribution.mul(fresnel).mul(geometry).div(nv.mul(4)).mul(nl).mul(Math.PI);
    const glint = min(specular, GLINT.ceiling).mul(smoothstep(0.5, 0.95, water)).mul(shade);
    colour = colour.add(sunColour.mul(glint));

    // City lights: the night side only, fading in through twilight, dimmed where cloud covers them.
    if (detail.nightLights) {
      const lights = srgbToLinear(sampleSlot(slot.night, c).r);
      const dark = smoothstep(0.06, -0.12, nDotL);
      const cover = cc ? sampleSlot(slot.clouds, cc).r : float(0);
      colour = colour.add(vec3(...CITY.tint).mul(lights.mul(dark).mul(float(1).sub(cover.mul(0.85))).mul(CITY.strength)));
    }
    const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
    material.colorNode = colour.mul(uLight);
    return material;
  };

  const buildClouds = (detail: ExploreDetail): MeshBasicNodeMaterial => {
    const scatter = detail.atmosphere === 'scatter';
    const n = normalize(positionLocal);
    const c = cloudCoords(mapCoords(n, n.y, U_AT_LON0));
    const base = sampleSlot(slot.clouds, c).r;
    // Low over them, illustrative detail breaks the map's soft edges into cloud-like ones (strongest
    // at the edges, none in clear sky or under solid cloud) and the edges sharpen as the map magnifies.
    const edges = fine(n.add(vec3(uTime.mul(CLOUD_DRIFT * 0.6), 0, 0)), detail.tier === 'low' ? [40] : detail.tier === 'ultra' ? [40, 130, 420] : [40, 130], 0.53);
    const cover = base.add(edges.value.mul(base.mul(float(1).sub(base)).mul(3.2)));
    // The map's thinnest haze is left out; the rest keeps its own opacity.
    const opacity = smoothstep(mix(float(0.06), float(0.22), edges.shown), mix(float(0.92), float(0.62), edges.shown), cover).mul(0.97);
    const nDotL = dot(n, uSun);
    // Relief of the cloud tops at low sun: thicker cloud toward the Sun shades this one.
    const ahead = sampleSlot(slot.clouds, towardSun(c, n, float(0.004))).r;
    const lowSun = float(1).sub(smoothstep(0.15, 0.6, nDotL));
    const relief = clamp(float(1).sub(ahead.sub(cover).mul(2.2).mul(lowSun)), 0.45, 1.15);
    const wrap = clamp(nDotL.add(0.08).div(1.08), 0, 1);
    const sunColour = sunAt(scatter, 1 + CLOUD_HEIGHT, nDotL).mul(sunlit(nDotL.add(0.02), 0.006));
    const light = sunColour.mul(wrap).mul(relief).add(skyFill(nDotL).mul(0.6));
    let colour: Vec3Node = light.mul(CLOUD_ALBEDO).mul(uLight);
    if (scatter && table) {
      // The air's shell dims everything behind it by the whole column down to the ground; a cloud top
      // sits above most of that air, so it is brightened back by what lies below it along the view.
      const toEye = normalize(uEye.sub(n.mul(1 + CLOUD_HEIGHT)));
      const up = max(dot(n, toEye), 0.02);
      const aboveCloud = transmittanceToTop(air, table.texture, float(1 + CLOUD_HEIGHT), up);
      const fromGround = transmittanceToTop(air, table.texture, float(1), up);
      colour = colour.mul(min(aboveCloud.div(max(fromGround, 1e-3)), 3));
    }
    const material = blendPremultiplied(new MeshBasicNodeMaterial({ side: FrontSide, transparent: true, depthWrite: false, fog: false }));
    material.colorNode = colour.mul(opacity);
    material.opacityNode = opacity;
    return material;
  };

  // Materials, geometries and airs by what they depend on, built once each.
  const surfaces = new Map<string, MeshBasicNodeMaterial>();
  const cloudMaterials = new Map<string, MeshBasicNodeMaterial>();
  const geometries = new Map<string, SphereGeometry>();
  const airs = new Map<string, ExploreAir>();
  const surfaceKey = (d: ExploreDetail): string => `${d.atmosphere}|${d.normalMaps}|${d.nightLights}|${d.cloudShadows}|${d.clouds}`;
  const airKey = (d: ExploreDetail): string => `${d.atmosphere}|${d.atmosphere === 'scatter' ? d.atmosphereSteps : 0}`;
  const surfaceFor = (d: ExploreDetail): MeshBasicNodeMaterial => {
    const key = surfaceKey(d);
    let m = surfaces.get(key);
    if (!m) {
      m = buildSurface(d);
      surfaces.set(key, m);
    }
    return m;
  };
  const cloudsFor = (d: ExploreDetail): MeshBasicNodeMaterial => {
    let m = cloudMaterials.get(d.atmosphere);
    if (!m) {
      m = buildClouds(d);
      cloudMaterials.set(d.atmosphere, m);
    }
    return m;
  };
  const sphere = (radius: number, segments: number): SphereGeometry => {
    const key = `${radius}|${segments}`;
    let g = geometries.get(key);
    if (!g) {
      g = new SphereGeometry(radius, segments, Math.max(16, Math.round(segments / 2)));
      geometries.set(key, g);
    }
    return g;
  };
  const airFor = (d: ExploreDetail): ExploreAir => {
    const key = airKey(d);
    let a = airs.get(key);
    if (!a) {
      const model = d.atmosphere === 'scatter' && table ? 'scatter' : 'chord';
      a = createAir(air, model, d.atmosphereSteps, table?.texture ?? null, airUniforms, Math.min(d.sphereSegments, 128));
      airs.set(key, a);
    }
    return a;
  };

  const surface = new Mesh(sphere(1, initial.sphereSegments), surfaceFor(initial));
  surface.name = 'explore-earth-surface';
  const clouds = new Mesh(sphere(1 + CLOUD_HEIGHT, initial.sphereSegments), cloudsFor(initial));
  clouds.name = 'explore-earth-clouds';
  clouds.renderOrder = 1;
  clouds.visible = initial.clouds;
  let currentAir = airFor(initial);
  object.add(surface, clouds, ...currentAir.meshes);
  const inverse = new Matrix4();

  return {
    object,
    update(frame, cameraWorld) {
      uTime.value = frame.time;
      uLight.value = frame.light;
      inverse.copy(object.matrixWorld).invert();
      uSun.value.set(frame.sun.x, frame.sun.y, frame.sun.z).transformDirection(inverse);
      uEye.value.copy(cameraWorld).applyMatrix4(inverse);
      object.visible = frame.light > 1e-3;
    },
    prepare(detail) {
      const out: Object3D[] = [];
      const warm = (m: MeshBasicNodeMaterial, g: SphereGeometry): void => {
        const mesh = new Mesh(g, m);
        mesh.frustumCulled = false;
        out.push(mesh);
      };
      if (surface.material !== surfaceFor(detail)) warm(surfaceFor(detail), sphere(1, detail.sphereSegments));
      if (detail.clouds && clouds.material !== cloudsFor(detail)) warm(cloudsFor(detail), sphere(1 + CLOUD_HEIGHT, detail.sphereSegments));
      const nextAir = airFor(detail);
      if (nextAir !== currentAir) {
        for (const m of nextAir.meshes) {
          const mesh = new Mesh(m.geometry, m.material);
          mesh.frustumCulled = false;
          out.push(mesh);
        }
      }
      return out;
    },
    apply(detail) {
      surface.material = surfaceFor(detail);
      surface.geometry = sphere(1, detail.sphereSegments);
      clouds.material = cloudsFor(detail);
      clouds.geometry = sphere(1 + CLOUD_HEIGHT, detail.sphereSegments);
      clouds.visible = detail.clouds;
      const nextAir = airFor(detail);
      if (nextAir !== currentAir) {
        object.remove(...currentAir.meshes);
        object.add(...nextAir.meshes);
        currentAir = nextAir;
      }
    },
    dispose() {
      for (const m of surfaces.values()) m.dispose();
      for (const m of cloudMaterials.values()) m.dispose();
      for (const g of geometries.values()) g.dispose();
      for (const a of airs.values()) a.dispose();
    },
  };
}
