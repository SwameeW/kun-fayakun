/**
 * The Earth of today, for the explorer, from the mission maps (assets/planets: a composite of
 * several epochs, as the interface says).
 *
 * - Ground: Blue Marble Next Generation's July 2004 colour, lit by sunlight that has crossed the air
 *   (white at noon, reddening toward the terminator; the transmittance table in 'scatter' detail,
 *   its analytic form in 'chord') plus the sky's own blue fill, with ETOPO 2022's relief as a normal
 *   map, so mountain ranges catch the low sun.
 * - Water (Natural Earth's mask): a sun glint on open water only, GGX on a wind-roughened sea with
 *   Fresnel, bright toward the limb but held below the bloom threshold: sunlight on a rough sea, not
 *   a hole in the planet.
 * - City lights (Black Marble 2016) on the night side only, fading in through twilight and dimmed by
 *   cloud: today's Earth only (the chapters' early Earths never load them).
 * - Clouds (Blue Marble's 2001 cloud map) on their own shell 10 km up, drifting slowly (an
 *   illustrative drift: real weather moves every way). Their tops are shaded as relief (thicker cloud
 *   stands higher), thicker toward the limb where the eye looks through more of them, and they cast
 *   their shadows on the ground beside them, offset away from the Sun by their height (cloudShadows).
 * - The night side: lit faintly by the Moon from where it stands, as much as its phase gives, and by
 *   a faint glow of the night sky, both shown far brighter than they are (as the eye adapted to the
 *   dark sees a moonlit landscape) so the dark disc always reads against the stars.
 * - Close up, below the maps' texels: illustrative fine detail. Land and cloud edges take octaves
 *   of noise scaled to the bound map's texel, each fading in only once its features span a few
 *   pixels (never seen from afar, never shimmering), and the maps' own texel-scale contrast is
 *   sharpened as they magnify. The interface says this detail is illustrative.
 * - Close in, the streamed imagery (../earth-tiles): Sentinel-2 cloudless or the day's NASA VIIRS
 *   mosaic replaces the day map wherever the view needs more detail than it holds, read at the exact
 *   point of the sphere under each pixel; the illustrative fine detail gives way to it, and the cloud
 *   shell fades so the ground shows.
 * - The air over all of it (./atmosphere).
 *
 * Every map is streamed (../assets/streaming): the first frames show each map's mean, the 1024 maps
 * follow at once and the focus's larger ones after; all of it sharpens in over about a second.
 */

import { FrontSide, Group, Matrix4, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3, type Data3DTexture, type Object3D, type Texture } from 'three/webgpu';
import { clamp, dot, exp, float, max, min, mix, normalize, positionLocal, pow, smoothstep, sqrt, uniform, vec3 } from 'three/tsl';
import type { PlanetTextures } from '../assets/streaming';
import { exactSurface, type EarthTiles } from '../earth-tiles';
import { textureTier, type ExploreDetail } from '../detail';
import { sunTransmittance, transmittanceToTop, type AirModel } from '../render/air';
import { blendPremultiplied } from '../render/blending';
import { decodeNormal, magnification, mapCoords, sampleSlot, shiftCoords, tangentFrame, type FloatNode, type MapCoords, type Vec3Node } from '../render/sampling';
import { createAir, type AirUniforms, type ExploreAir } from './atmosphere';
import { createClimateView } from './climate-view';
import { createMarks, type SurfaceMark } from './marks';
import { bumpGradient, keepOnSphere, litCosine, noiseIfKept, sphereFootprint, sunlit, tiltNormal } from './shading';

/** Blue Marble and the other Earth maps put Greenwich at u = 0.5 (planets.json bodies.earth.uAtLon0). */
const U_AT_LON0 = 0.5;
/** The cloud shell's height, planet radii (about 10 km: the tops of most weather clouds). */
const CLOUD_HEIGHT = 0.0016;
/** The clouds' illustrative drift, turns of longitude per second (a full turn in two hours). */
const CLOUD_DRIFT = 1 / 7200;
/** Cloud tops' reflectance (bright, slightly short of fresh snow), and how dark a cloud's shadow is on the ground. */
const CLOUD_ALBEDO = 0.86;
const CLOUD_SHADOW = 0.7;
/** How high thick cloud stands above thin (radii, about 3 km): the cloud tops' shading relief. */
const CLOUD_RELIEF = 0.00045;
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
/**
 * The night side's light, shown as a dark-adapted eye sees it (real moonlight is about 2 millionths
 * of sunlight): full moonlight as this share of sunlight, its colour (bluish: night vision), and the
 * night sky's own faint glow on everything, moon or not.
 */
const NIGHT = { moonlight: 0.03, glow: 0.006, tint: [0.72, 0.82, 1] } as const;
/**
 * Fine detail: amplitudes of the land's octaves (albedo, as a share), of the relief they add (radii),
 * of the cloud edges' erosion (cover units), the sharpening of the maps' texel-scale contrast, and how
 * far (texels) the maps' lookups are warped so their soft edges break into crisp, irregular ones.
 */
const FINE = { land: [0.85, 0.55], relief: 0.0001, erosion: 1.1, sharpen: 0.85, warp: 0.85 } as const;

export interface EarthFrame {
  /** Seconds (the clouds' drift): an illustrative clock that stops with reduced motion. */
  time: number;
  /** Unit direction to the Sun, render frame. */
  sun: { x: number; y: number; z: number };
  /** Sunlight on the Earth (1 at 1 au). */
  light: number;
  /** Unit direction to the Moon, render frame, and how much of its face toward the Earth is lit (0 to 1). */
  moon: { x: number; y: number; z: number };
  moonLit: number;
}

export interface ExploreEarth {
  readonly object: Group;
  /**
   * The ground's colour (linear) at a direction in the Earth's own frame, as the globe shows it: the
   * day map, with streamed imagery where it has loaded (for the ground a walker stands on).
   */
  groundColour(direction: Vec3Node): Vec3Node;
  /** Sunlight's colour after the air, for the cosine of the Sun's elevation: the globe's own. */
  sunlight(mu: FloatNode): Vec3Node;
  /** Set the object's position, scale and orientation first, and its world matrix current. */
  update(frame: EarthFrame, cameraWorld: Vector3): void;
  /** Builds what a detail level needs; returns the meshes whose materials should compile before apply(). */
  prepare(detail: ExploreDetail): Object3D[];
  apply(detail: ExploreDetail): void;
  /** The laboratory's craters on it (none outside the laboratory). */
  setMarks(marks: readonly SurfaceMark[]): void;
  /** The laboratory's climate on it (./climate-view): its bands' temperatures (its ice drawn from them), the temperature view on or off (null: none). */
  setClimate(bandsK: readonly number[] | null, temperature: boolean): void;
  dispose(): void;
}

const srgbToLinear = (x: FloatNode): FloatNode => pow(max(x, 0), 2.2);

/** Width of the files streamed at a detail level (the detail octaves are scaled to their texels). */
const mapWidth = (detail: ExploreDetail): number => ({ low: 1024, medium: 2048, high: 4096, ultra: 8192 })[textureTier(detail)];

/**
 * Noise frequencies (cycles of the noise volume per radian) for octaves starting at the map's texel:
 * the volume's coarsest features are a quarter of a unit, so frequency W / (8 pi) puts them at one
 * texel of a map W wide; each further octave is four times finer (the volume spans a factor of four).
 */
const octavesFor = (detail: ExploreDetail, count: number): number[] => {
  const base = mapWidth(detail) / (8 * Math.PI);
  return Array.from({ length: count }, (_, i) => base * 4 ** i);
};

/** Fine-detail octaves per tier: Ultra adds a third, Low has one. */
const OCTAVES: Readonly<Record<ExploreDetail['tier'], number>> = { ultra: 3, high: 2, medium: 2, low: 1 };

/**
 * True while the illustrative fine detail shows: its first octave is kept straight below a camera
 * `altitudeRadii` up, with `pxPerRadian` device pixels per radian (the readout then says so).
 */
export function fineDetailShown(detail: ExploreDetail, altitudeRadii: number, pxPerRadian: number): boolean {
  const f = octavesFor(detail, 1)[0] ?? 0;
  return (Math.max(0, altitudeRadii) / Math.max(pxPerRadian, 1)) * 16 * f < 0.55;
}

export function createEarth(textures: PlanetTextures, noise: Data3DTexture, air: AirModel, table: { texture: Texture } | null, initial: ExploreDetail, tiles: EarthTiles | null = null): ExploreEarth {
  const object = new Group();
  object.name = 'explore-earth';
  const uTime = uniform(0);
  const uLight = uniform(1);
  const climate = createClimateView();
  // Fresh rock and ash on land: a grey brown (illustrative); relief as the ETOPO map's is drawn.
  const marks = createMarks(() => vec3(0.2, 0.17, 0.14), { exaggeration: textures.manifest.files.find((f) => f.body === 'earth' && f.map === 'normal')?.reliefExaggeration ?? 1 });
  const uSun = uniform(new Vector3(1, 0, 0));
  const uEye = uniform(new Vector3(0, 0, 3));
  const uMoon = uniform(new Vector3(0, 0, 1));
  const uMoonLight = uniform(0);
  /** The clouds' drift as a turn of the noise's frame about the pole (cos, sin), so their detail moves with them. */
  const uDriftCos = uniform(1);
  const uDriftSin = uniform(0);
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
  /** The night side's light on a surface of normal `normal`: moonlight from the Moon's direction and the sky's glow. */
  const nightLight = (normal: Vec3Node, nDotL: FloatNode, wrap: number): Vec3Node => {
    const dark = smoothstep(0.04, -0.14, nDotL);
    const moon = clamp(dot(normal, uMoon).add(wrap).div(1 + wrap), 0, 1).mul(uMoonLight);
    return vec3(...NIGHT.tint).mul(moon.add(NIGHT.glow).mul(dark));
  };

  const cloudCoords = (c: MapCoords): MapCoords => shiftCoords(c, uTime.mul(CLOUD_DRIFT));
  /** A direction turned with the clouds' drift (the frame their fine detail is anchored in). */
  const withClouds = (d: Vec3Node): Vec3Node => vec3(d.x.mul(uDriftCos).add(d.z.mul(uDriftSin)), d.y, d.z.mul(uDriftCos).sub(d.x.mul(uDriftSin)));

  /**
   * Illustrative fine detail: octaves of the noise volume at `frequencies` (radian frequencies, see
   * octavesFor), each kept only while its finest features span about two pixels or more. Returns their
   * weighted sum (about -0.5..0.5) and how much of the first octave shows.
   */
  const fine = (p: Vec3Node, footprint: FloatNode, frequencies: readonly number[], weights: readonly number[], salt: number): { value: FloatNode; shown: FloatNode } => {
    let value: FloatNode = float(0);
    let shown: FloatNode = float(0);
    frequencies.forEach((f, i) => {
      // The volume's finest lattice is a sixteenth of a unit.
      const kept = keepOnSphere(footprint, 16 * f);
      if (i === 0) shown = kept;
      // Each octave's lattice turned and offset from the last, so no grid lines up across octaves.
      const q = i % 2 === 0 ? p : vec3(p.z, p.x, p.y);
      value = value.add(noiseIfKept(noise, q.mul(f).add(salt + 0.37 * i), kept).sub(0.5).mul(kept).mul(weights[i] ?? weights[weights.length - 1] ?? 0.5));
    });
    return { value, shown };
  };

  /** Coordinates moved along the ground toward the Sun by `distance` radii, and the direction there. */
  const towardSun = (c: MapCoords, n: Vec3Node, distance: FloatNode): { coords: MapCoords; direction: Vec3Node } => {
    const { east, north } = tangentFrame(n);
    const se = dot(uSun, east);
    const sn = dot(uSun, north);
    const flat = max(sqrt(se.mul(se).add(sn.mul(sn))), 1e-4);
    const cosLat = max(sqrt(n.x.mul(n.x).add(n.z.mul(n.z))), 0.05);
    const coords = shiftCoords(c, se.div(flat).mul(distance).div(cosLat.mul(2 * Math.PI)), sn.div(flat).mul(distance).div(Math.PI));
    const direction = normalize(n.add(east.mul(se.div(flat)).add(north.mul(sn.div(flat))).mul(distance)));
    return { coords, direction };
  };

  /**
   * Cloud cover at map coordinates `c` (already drifted) and direction `d` (the fragment's): the
   * map's cover with its edges broken up by fine detail where the map is magnified (strongest at half
   * cover, none in clear sky or under solid cloud). Returns the cover and how much detail shows.
   */
  const cloudCover = (c: MapCoords, d: Vec3Node, footprint: FloatNode, frequencies: readonly number[]): { cover: FloatNode; shown: FloatNode } => {
    const base = sampleSlot(slot.clouds, c).r;
    const edges = fine(withClouds(d).add(vec3(0, uTime.mul(0.00002), 0)), footprint, frequencies, [1, 0.6, 0.4], 0.53);
    const edge = base.mul(float(1).sub(base)).mul(4);
    const cover = clamp(base.add(edges.value.mul(edge).mul(FINE.erosion)), 0, 1);
    return { cover, shown: edges.shown };
  };
  /** Opacity from eroded cover: thin haze left out, edges crisper as the detail shows. */
  const coverOpacity = (cover: FloatNode, shown: FloatNode): FloatNode =>
    smoothstep(mix(float(0.08), float(0.3), shown), mix(float(0.9), float(0.58), shown), cover).mul(0.97);

  /**
   * The maps' lookup warped, where they are magnified, by a fraction of a texel of smooth noise: the
   * texels' soft blends become crisp, irregular edges (coasts, ridges, field boundaries), as finer
   * imagery would show them. Illustrative; the warp is typically about FINE.warp texels, never many.
   */
  const warped = (c: MapCoords, n: Vec3Node, footprint: FloatNode, detail: ExploreDetail): { coords: MapCoords; magnified: FloatNode } => {
    const magnified = smoothstep(1.2, 4, magnification(c, slot.day));
    const [f0 = 1, f1 = 4] = octavesFor(detail, 2);
    const keep0 = keepOnSphere(footprint, 16 * f0).mul(magnified);
    const keep1 = keepOnSphere(footprint, 16 * f1).mul(magnified);
    const axis = (salt: number): FloatNode =>
      noiseIfKept(noise, n.mul(f0).add(salt), keep0).sub(0.5).mul(keep0).add(noiseIfKept(noise, vec3(n.z, n.x, n.y).mul(f1).add(salt + 0.29), keep1).sub(0.5).mul(keep1).mul(0.5));
    const width = mapWidth(detail);
    return { coords: shiftCoords(c, axis(0.71).mul(FINE.warp * 2.5 / width), axis(0.13).mul((FINE.warp * 2.5 * 2) / width)), magnified };
  };

  const buildSurface = (detail: ExploreDetail): MeshBasicNodeMaterial => {
    const scatter = detail.atmosphere === 'scatter';
    const n = normalize(positionLocal);
    const footprint = sphereFootprint(n);
    // The ground's maps are read warped; the clouds above (and so their shadows) are not.
    const plain = mapCoords(n, n.y, U_AT_LON0);
    const { coords: c, magnified } = warped(plain, n, footprint, detail);
    const water = sampleSlot(slot.water, c).r;
    const land = float(1).sub(smoothstep(0.3, 0.7, water));
    // The day map, its texel-scale contrast sharpened where it is magnified (land only: the sea is smooth).
    const albedoMap = sampleSlot(slot.day, c).rgb;
    const blurred = sampleSlot(slot.day, c, 1.6).rgb;
    const sharpenedMap = max(albedoMap.add(albedoMap.sub(blurred).mul(magnified.mul(land).mul(FINE.sharpen))), 0);
    // Streamed imagery where the view needs it, read at the exact point of the sphere under the pixel
    // (the mesh is flat between its vertices); the illustrative fine detail gives way to real detail.
    const streamed = tiles ? tiles.imagery(exactSurface(uEye, positionLocal), footprint, sharpenedMap) : null;
    const real: FloatNode = streamed ? streamed.weight : float(0);
    const sharpened: Vec3Node = streamed ? streamed.colour : sharpenedMap;
    const frequencies = octavesFor(detail, OCTAVES[detail.tier]);
    const groundFine = fine(n, footprint, frequencies, FINE.land, 0.11);
    const ground = { value: groundFine.value.mul(float(1).sub(real)), shown: groundFine.shown };
    let normal: Vec3Node = n;
    let rough: FloatNode = float(0.35);
    if (detail.normalMaps) {
      const t = decodeNormal(sampleSlot(slot.normal, c));
      const { east, north } = tangentFrame(n);
      normal = normalize(east.mul(t.x).add(north.mul(t.y)).add(n.mul(t.z)));
      // Mountains (steep relief) take more fine relief than plains.
      rough = smoothstep(0.02, 0.35, sqrt(t.x.mul(t.x).add(t.y.mul(t.y)))).mul(0.8).add(0.2);
    }
    // The grain is strongest on rough ground and where the map itself varies (deserts, mountains, fields).
    const variation = clamp(dot(albedoMap.sub(blurred).abs(), vec3(3)).add(rough.mul(0.6)), 0.25, 1);
    let albedo: Vec3Node = sharpened.mul(ground.value.mul(land).mul(variation).add(1));
    normal = tiltNormal(normal, bumpGradient(positionLocal, n, ground.value.mul(land).mul(rough).mul(FINE.relief)), 1);
    // The laboratory's craters (./marks), on land only: the sea closes over an ocean impact's.
    const marked = marks.apply(n, normal, albedo, footprint);
    albedo = mix(albedo, marked.albedo, land);
    normal = normalize(mix(normal, marked.normal, land));
    // The climate's ice, over land and sea alike.
    const climateNow = climate.apply(n.y, albedo);
    albedo = climateNow.albedo;
    const nDotL = dot(n, uSun);
    const sunColour = sunAt(scatter, 1, nDotL).mul(sunlit(nDotL, 0.004));
    const lambert = max(dot(normal, uSun), 0).mul(0.85).add(litCosine(nDotL).mul(0.15));

    // Cloud shadows: the cloud the sunlight crossed on its way down, CLOUD_HEIGHT up, with the same eroded edges.
    let shade: FloatNode = float(1);
    const cloudsShown: FloatNode = tiles ? tiles.clouds : float(1);
    const cc = detail.clouds ? cloudCoords(plain) : null;
    if (detail.cloudShadows && cc) {
      const slant = float(CLOUD_HEIGHT).mul(sqrt(max(float(1).sub(nDotL.mul(nDotL)), 0)).div(max(nDotL, 0.08)));
      const under = towardSun(cc, n, slant);
      const shadow = cloudCover(under.coords, under.direction, footprint, frequencies.slice(0, 1));
      shade = float(1).sub(coverOpacity(shadow.cover, shadow.shown).mul(CLOUD_SHADOW).mul(cloudsShown));
    }
    let colour: Vec3Node = albedo.mul(sunColour.mul(lambert).mul(shade).add(skyFill(nDotL)));

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
    // Close in, the global water mask is far coarser than the imagery: the glint keeps off the shore it blurs.
    const glint = min(specular, GLINT.ceiling).mul(smoothstep(0.5, 0.95, water)).mul(shade).mul(float(1).sub(real.mul(0.6)));
    colour = colour.add(sunColour.mul(glint));

    // The night side: moonlight and the sky's glow on the ground, and the city lights, dimmed where cloud covers them.
    const cover = cc ? sampleSlot(slot.clouds, cc).r.mul(cloudsShown) : float(0);
    colour = colour.add(albedo.mul(nightLight(normal, nDotL, 0)).mul(float(1).sub(cover.mul(0.7))));
    if (detail.nightLights) {
      const lights = srgbToLinear(sampleSlot(slot.night, c).r);
      const dark = smoothstep(0.06, -0.12, nDotL);
      colour = colour.add(vec3(...CITY.tint).mul(lights.mul(dark).mul(float(1).sub(cover.mul(0.85))).mul(CITY.strength)));
    }
    colour = colour.add(marked.glow.mul(land));
    // The temperature view: the map's colour lit as the ground is, a fifth of it showing at night.
    colour = mix(colour, climateNow.map.mul(sunColour.mul(lambert).add(0.2)), climateNow.mapShare);
    const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
    material.colorNode = colour.mul(uLight);
    return material;
  };

  const buildClouds = (detail: ExploreDetail): MeshBasicNodeMaterial => {
    const scatter = detail.atmosphere === 'scatter';
    const n = normalize(positionLocal);
    const footprint = sphereFootprint(n);
    const c = cloudCoords(mapCoords(n, n.y, U_AT_LON0));
    const frequencies = octavesFor(detail, OCTAVES[detail.tier]);
    const { cover, shown } = cloudCover(c, n, footprint, frequencies);
    const toEye = normalize(uEye.sub(n.mul(1 + CLOUD_HEIGHT)));
    const up = max(dot(n, toEye), 0.02);
    // A thin layer is more opaque seen slanting (the eye's path through it is 1 / mu longer).
    const flat = coverOpacity(cover, shown);
    const opacity = float(1).sub(pow(float(1).sub(min(flat, 0.999)), min(float(1).div(up), 3))).mul(0.98);
    const nDotL = dot(n, uSun);
    // Cloud tops as relief: thicker cloud stands higher, so its sunward slopes are bright and the far ones shaded.
    const top = tiltNormal(n, bumpGradient(positionLocal, n, cover.mul(CLOUD_RELIEF)), 1);
    const lit = clamp(dot(top, uSun).add(0.12).div(1.12), 0, 1);
    // At low sun thicker cloud toward the Sun also shades this one.
    const ahead = sampleSlot(slot.clouds, towardSun(c, n, float(0.004)).coords).r;
    const lowSun = float(1).sub(smoothstep(0.15, 0.6, nDotL));
    const relief = clamp(float(1).sub(ahead.sub(cover).mul(2.2).mul(lowSun)), 0.45, 1.15);
    const sunColour = sunAt(scatter, 1 + CLOUD_HEIGHT, nDotL).mul(sunlit(nDotL.add(0.02), 0.006));
    const light = sunColour.mul(lit).mul(relief).add(skyFill(nDotL).mul(0.6)).add(nightLight(top, nDotL, 0.2));
    let colour: Vec3Node = light.mul(CLOUD_ALBEDO).mul(uLight);
    if (scatter && table) {
      // The air's shell dims everything behind it by the whole column down to the ground; a cloud top
      // sits above most of that air, so it is brightened back by what lies below it along the view.
      const aboveCloud = transmittanceToTop(air, table.texture, float(1 + CLOUD_HEIGHT), up);
      const fromGround = transmittanceToTop(air, table.texture, float(1), up);
      colour = colour.mul(min(aboveCloud.div(max(fromGround, 1e-3)), 3));
    }
    const material = blendPremultiplied(new MeshBasicNodeMaterial({ side: FrontSide, transparent: true, depthWrite: false, fog: false }));
    // Close in the shell fades, so the ground the view zoomed to shows; with the day's mosaic its clouds are the real ones.
    // The clouds step aside while the climate's temperature view shows the ground.
    const kept = (tiles ? opacity.mul(tiles.clouds) : opacity).mul(float(1).sub(climate.mapShare));
    material.colorNode = colour.mul(kept);
    material.opacityNode = kept;
    return material;
  };

  // Materials, geometries and airs by what they depend on, built once each; a detail change keeps
  // only what the new level uses.
  const surfaces = new Map<string, MeshBasicNodeMaterial>();
  const cloudMaterials = new Map<string, MeshBasicNodeMaterial>();
  const geometries = new Map<string, SphereGeometry>();
  const airs = new Map<string, ExploreAir>();
  const surfaceKey = (d: ExploreDetail): string =>
    `${d.atmosphere}|${d.normalMaps}|${d.nightLights}|${d.cloudShadows}|${d.clouds}|${OCTAVES[d.tier]}|${mapWidth(d)}`;
  const cloudKey = (d: ExploreDetail): string => `${d.atmosphere}|${OCTAVES[d.tier]}|${mapWidth(d)}`;
  const airKey = (d: ExploreDetail): string => `${d.atmosphere}|${d.atmosphere === 'scatter' ? d.atmosphereSteps : 0}|${Math.min(d.sphereSegments, 128)}`;
  const cached = <T>(map: Map<string, T>, key: string, build: () => T): T => {
    let value = map.get(key);
    if (!value) {
      value = build();
      map.set(key, value);
    }
    return value;
  };
  const surfaceFor = (d: ExploreDetail): MeshBasicNodeMaterial => cached(surfaces, surfaceKey(d), () => buildSurface(d));
  const cloudsFor = (d: ExploreDetail): MeshBasicNodeMaterial => cached(cloudMaterials, cloudKey(d), () => buildClouds(d));
  const sphere = (radius: number, segments: number): SphereGeometry =>
    cached(geometries, `${radius}|${segments}`, () => new SphereGeometry(radius, segments, Math.max(16, Math.round(segments / 2))));
  const airFor = (d: ExploreDetail): ExploreAir =>
    cached(airs, airKey(d), () => {
      const model = d.atmosphere === 'scatter' && table ? 'scatter' : 'chord';
      return createAir(air, model, d.atmosphereSteps, table?.texture ?? null, airUniforms, Math.min(d.sphereSegments, 128));
    });
  /** Disposes what a detail level does not use (kept: its own materials, geometries and air). */
  const evict = (d: ExploreDetail): void => {
    const keep = <T>(map: Map<string, T>, key: string, free: (value: T) => void): void => {
      for (const [k, v] of map) {
        if (k === key) continue;
        free(v);
        map.delete(k);
      }
    };
    keep(surfaces, surfaceKey(d), (m) => {
      m.dispose();
    });
    keep(cloudMaterials, cloudKey(d), (m) => {
      m.dispose();
    });
    keep(airs, airKey(d), (a) => {
      a.dispose();
    });
    const used = new Set([`1|${d.sphereSegments}`, `${1 + CLOUD_HEIGHT}|${d.sphereSegments}`]);
    for (const [k, g] of geometries) {
      if (used.has(k)) continue;
      g.dispose();
      geometries.delete(k);
    }
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
    groundColour(direction) {
      const n = normalize(direction);
      const map = sampleSlot(slot.day, mapCoords(n, n.y, U_AT_LON0)).rgb;
      return tiles ? tiles.imagery(n, sphereFootprint(n), map).colour : map;
    },
    sunlight(mu) {
      return sunAt(true, 1, mu);
    },
    update(frame, cameraWorld) {
      uTime.value = frame.time;
      uLight.value = frame.light;
      const turn = frame.time * CLOUD_DRIFT * 2 * Math.PI;
      uDriftCos.value = Math.cos(turn);
      uDriftSin.value = Math.sin(turn);
      inverse.copy(object.matrixWorld).invert();
      uSun.value.set(frame.sun.x, frame.sun.y, frame.sun.z).transformDirection(inverse);
      uMoon.value.set(frame.moon.x, frame.moon.y, frame.moon.z).transformDirection(inverse);
      uMoonLight.value = NIGHT.moonlight * frame.moonLit;
      uEye.value.copy(cameraWorld).applyMatrix4(inverse);
      object.visible = frame.light > 1e-3;
    },
    setMarks(list) {
      marks.set(list);
    },
    setClimate(bandsK, temperature) {
      climate.set(bandsK, temperature, true);
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
      evict(detail);
    },
    dispose() {
      for (const m of surfaces.values()) m.dispose();
      for (const m of cloudMaterials.values()) m.dispose();
      for (const g of geometries.values()) g.dispose();
      for (const a of airs.values()) a.dispose();
    },
  };
}
