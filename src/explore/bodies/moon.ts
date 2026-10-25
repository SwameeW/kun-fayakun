/**
 * The Moon, for the explorer, from NASA's CGI Moon Kit: LROC WAC colour (albedo with no shading in
 * it) and LOLA relief as a normal map.
 *
 * The Low and Medium colour files are ETC1S, whose 4 x 4 blocks carry colour errors (magenta and green
 * blocks) that show as soon as the map is magnified. The Moon is nearly grey, so its colour is read
 * as the fine map's brightness over the colour of a much coarser level (where the blocks average
 * out); at Low, where the 1024 maps are magnified most, both maps are read through a cubic B-spline
 * so neither shows its texels.
 *
 * Light is Lommel-Seeliger, as airless regolith reflects it (a full Moon is as bright at its limb as
 * at its centre), with a Hapke-like shadow-hiding opposition surge, the steep brightening as the
 * Sun comes to stand behind the viewer, and a gentle darkening with phase. Their shapes follow
 * Hapke's model; their widths and strengths are illustrative, not fitted. The map is normalised to
 * a standard geometry (incidence 30 degrees, emission 0, phase 30), so the law is divided by its
 * value there: the map shows as published where the light is as it was measured.
 *
 * Near the terminator the relief casts shadows: each pixel looks along the ground toward the Sun,
 * adding up the LOLA slopes it crosses (the normal map read at coarser levels further out), and is in
 * shadow while the ground ahead stands above the sunlight's ray (the Moon's curvature included),
 * softened over the Sun's angular size. Crater floors fill with shadow and the rims facing the Sun
 * stand bright, as in a telescope at first quarter. The shadows are cast by the relief as drawn,
 * which planets.json records as exaggerated (reliefExaggeration).
 *
 * Close up, where even the relief map is magnified, illustrative small craters (the analytic layers of
 * ./shading, no real crater placed) fill in below its resolution, each scale fading in only once its
 * craters span a few pixels and staying out of view from afar; the interface says they are illustrative.
 *
 * The night side gets earthshine: sunlight the Earth sends back, from its direction and as much of it
 * as the Earth's lit face turned toward the Moon. Real earthshine is about 10^-4 of sunlight, far below
 * what a camera exposed for the day side records; it is shown a few hundred times stronger, as the eye
 * sees it, so the dark disc reads (a visual aid, like the points of light).
 */

import { FrontSide, Group, Matrix4, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3, type Node, type Object3D } from 'three/webgpu';
import { atan, dot, exp, length, float, Fn, If, int, Loop, max, mix, normalize, positionLocal, smoothstep, sqrt, tan, uniform, vec2, vec3 } from 'three/tsl';
import type { PlanetTextures } from '../assets/streaming';
import type { ExploreDetail } from '../detail';
import { decodeNormal, mapCoords, mipLevel, sampleSlot, sampleSlotLevel, sampleSlotSmooth, tangentFrame, type FloatNode, type Vec3Node } from '../render/sampling';
import { bumpGradient, craters, keepOnSphere, litCosine, sphereFootprint, sunlit, tiltNormal } from './shading';
import { textureTier } from '../detail';
import { blendAdditive } from '../render/blending';

/** The kit's maps put the near side's centre (east longitude 0) at u = 0.5 (planets.json bodies.moon.uAtLon0). */
const U_AT_LON0 = 0.5;
/** Earthlight is bluer than sunlight (the Earth's oceans and sky). */
const EARTHLIGHT = vec3(0.72, 0.84, 1);
/** Earthshine shown on the night side, as a share of full sunlight from a full Earth (about 300 times the true share). */
export const EARTHSHINE = 0.03;
/** Opposition surge (Hapke's shadow-hiding form): amplitude and angular width (radians); phase darkening per radian. Illustrative shapes. */
const SURGE = { amplitude: 0.7, width: 0.06 } as const;
const PHASE_DARKENING = 0.4;
/** The map's standard geometry: incidence 30 degrees, emission 0, phase 30 degrees. */
const STANDARD = { mu0: Math.cos(Math.PI / 6), mu: 1, phase: Math.PI / 6 } as const;
/** Shadow march: steps per detail tier, and the farthest it looks (radii: about 100 km, the reach of the longest shadows it draws). */
const SHADOW_STEPS: Readonly<Record<ExploreDetail['tier'], number>> = { ultra: 14, high: 12, medium: 7, low: 4 };
/** Mip levels coarser than the colour's own that its colour (not its brightness) is read at, for the block-compressed files. */
const CHROMA_BLUR = 3;
/**
 * Mars: how much of each texel's own hue is kept against the map's mean hue (brightness untouched).
 * The Viking mosaic's colour was built from red- and violet-filter images (USGS), which pushes the
 * dark albedo regions toward blue; halfway to the mean they read grey-brown, as in true-colour views.
 */
const MARS_HUE_KEEP = 0.5;
/**
 * Illustrative small craters: a crater cell spans this many texels of the streamed map (so the craters
 * are just below what it resolves), the second scale's cells are this much smaller, the craters' depth
 * over diameter, and how much of each cell holds a crater.
 */
const CRATERS = { cellTexels: 3, second: 2.8, ratio: 0.14, density: 0.62 } as const;

/** Width of the files streamed at a detail level. */
const mapWidth = (detail: ExploreDetail): number => ({ low: 1024, medium: 2048, high: 4096, ultra: 8192 })[textureTier(detail)];
/** Crater cells per radian for a detail level's first scale. */
const crateredCells = (detail: ExploreDetail): number => mapWidth(detail) / (2 * Math.PI * CRATERS.cellTexels);

/**
 * True while the illustrative craters show: the first scale is kept straight below a camera
 * `altitudeRadii` up, with `pxPerRadian` device pixels per radian (the readout then says so).
 */
export function craterDetailShown(detail: ExploreDetail, altitudeRadii: number, pxPerRadian: number): boolean {
  return (Math.max(0, altitudeRadii) / Math.max(pxPerRadian, 1)) * crateredCells(detail) * 3 < 0.55;
}
const SHADOW_REACH = 0.06;
/** Without a relief map: height (radii) per unit of the colour map's local contrast (illustrative). */
const ALBEDO_RELIEF = 0.006;

export interface MoonFrame {
  time: number;
  /** Unit direction to the Sun, render frame. */
  sun: { x: number; y: number; z: number };
  /** Sunlight on the Moon (1 at 1 au). */
  light: number;
  /** Unit direction to the Earth, render frame, and how much of the Earth's face toward the Moon is lit (0 to 1). */
  earth: { x: number; y: number; z: number };
  earthLit: number;
}

export interface ExploreMoon {
  readonly object: Group;
  /** Set the object's position, scale and orientation first, and its world matrix current. */
  update(frame: MoonFrame, cameraWorld: Vector3): void;
  prepare(detail: ExploreDetail): Object3D[];
  apply(detail: ExploreDetail): void;
  dispose(): void;
}

const node = (x: FloatNode | number): FloatNode => (typeof x === 'number' ? float(x) : x);
const surge = (phase: FloatNode | number): FloatNode => float(1).add(float(SURGE.amplitude).div(float(1).add(tan(node(phase).mul(0.5)).div(SURGE.width))));
const lommel = (mu0: FloatNode | number, mu: FloatNode | number): FloatNode => node(mu0).mul(2).div(node(mu0).add(node(mu)).add(1e-3));

export interface RockOptions {
  body: 'moon' | 'mercury' | 'mars';
  uAtLon0: number;
  polar: number;
}

export function createMoon(textures: PlanetTextures, sunAngularRadius: number, initial: ExploreDetail, options: RockOptions = { body: 'moon', uAtLon0: U_AT_LON0, polar: 1 }): ExploreMoon {
  const object = new Group();
  object.name = `explore-${options.body}`;
  const uLight = uniform(1);
  const uSunAngularRadius = uniform(sunAngularRadius);
  // Light, the Earth and the eye in the Moon's own frame (set on the CPU), so the relief is lit there.
  const uSun = uniform(new Vector3(1, 0, 0));
  const uEarth = uniform(new Vector3(-1, 0, 0));
  const uEarthshine = uniform(0);
  const uEye = uniform(new Vector3(0, 0, 3));
  const colourSlot = textures.slot(options.body, 'colour');
  const normalSlot = textures.slot(options.body, 'normal');
  const standard = lommel(STANDARD.mu0, STANDARD.mu).mul(surge(STANDARD.phase)).mul(Math.exp(-PHASE_DARKENING * STANDARD.phase));

  const build = (detail: ExploreDetail): MeshBasicNodeMaterial => {
    const point = options.body === 'moon' ? positionLocal : vec3(positionLocal.x, positionLocal.y.mul(options.polar), positionLocal.z);
    const n = normalize(point);
    const surfaceNormal = options.body === 'moon' ? n : normalize(vec3(positionLocal.x, positionLocal.y.div(options.polar), positionLocal.z));
    const c = mapCoords(n, n.y, options.uAtLon0);
    const smooth = detail.tier === 'low';
    const read = smooth ? sampleSlotSmooth : sampleSlot;
    const luma = (v: Vec3Node): FloatNode => dot(v, vec3(0.2126, 0.7152, 0.0722));
    let albedo: Vec3Node = read(colourSlot, c).rgb;
    if (options.body !== 'mars' && (detail.tier === 'low' || detail.tier === 'medium')) {
      // The fine map's brightness over a coarse level's colour: ETC1S's colour blocks average out there
      // (and at Low the colour a little desaturated: the Moon is nearly grey, its blocks' tints are not).
      const coarse = sampleSlot(colourSlot, c, CHROMA_BLUR).rgb;
      const brightness = luma(albedo);
      albedo = coarse.mul(brightness.div(max(luma(coarse), 1e-3)));
      if (smooth) albedo = mix(vec3(brightness), albedo, 0.55);
    }
    if (options.body === 'mars') {
      const brightness = luma(albedo);
      const mean = colourSlot.mean.rgb;
      const meanHue = mean.div(max(luma(mean), 1e-3));
      const hue = albedo.div(max(brightness, 1e-3));
      albedo = mix(meanHue, hue, MARS_HUE_KEEP).mul(brightness);
    }
    const { east, north } = tangentFrame(surfaceNormal);
    let relief: Vec3Node;
    if (detail.normalMaps) {
      const t = decodeNormal(read(normalSlot, c));
      relief = normalize(east.mul(t.x).add(north.mul(t.y)).add(surfaceNormal.mul(t.z)));
    } else {
      // No relief map at this detail: a hint of relief from the colour map's local contrast (crater
      // rims and young ejecta are bright), so the terminator is not flat. Illustrative.
      const contrast = luma(albedo).sub(luma(sampleSlot(colourSlot, c, 2.5).rgb));
      relief = tiltNormal(surfaceNormal, bumpGradient(positionLocal, surfaceNormal, contrast.mul(ALBEDO_RELIEF)), 1);
    }
    // Illustrative small craters below the map's resolution, each scale only once it spans a few pixels.
    const footprint = sphereFootprint(n);
    const cells = crateredCells(detail);
    const small = craters(n, cells, 1, CRATERS.density, CRATERS.ratio);
    const smaller = craters(n, cells * CRATERS.second, 2, CRATERS.density, CRATERS.ratio);
    const keepSmall = options.body === 'moon' ? keepOnSphere(footprint, cells * 3) : float(0);
    const keepSmaller = options.body === 'moon' ? keepOnSphere(footprint, cells * CRATERS.second * 3) : float(0);
    relief = tiltNormal(relief, small.gradient.mul(keepSmall).add(smaller.gradient.mul(keepSmaller)), 1);
    // Fresh rims a little brighter, floors a little darker.
    const marks = small.rim.mul(0.12).sub(small.inside.mul(0.06)).mul(keepSmall).add(smaller.rim.mul(0.1).sub(smaller.inside.mul(0.05)).mul(keepSmaller));
    albedo = albedo.mul(marks.add(1));
    const view = normalize(uEye.sub(options.body === 'moon' ? n : point));
    const nDotL = dot(n, uSun);
    const mu0 = litCosine(dot(relief, uSun));
    const mu = max(dot(relief, view), 0);
    const phase = atan(max(sqrt(max(float(1).sub(dot(uSun, view).pow(2)), 0)), 1e-5), dot(uSun, view));
    const law = lommel(mu0, mu).mul(surge(phase)).mul(phase.mul(-PHASE_DARKENING).exp()).div(standard);

    // Cast shadows near the terminator: march toward the Sun over the relief.
    const steps = detail.normalMaps ? SHADOW_STEPS[detail.tier] : 0;
    let lit: FloatNode = float(1);
    if (steps > 0) {
      const width = float((normalSlot.node.size(int(0)) as unknown as Node<'ivec2'>).x);
      const footprint = mipLevel(c, width);
      lit = Fn(() => {
        // Built here, before any branch: the footprint comes from screen-space derivatives.
        const level = footprint.toVar();
        const texelsPerRadian = width.div(2 * Math.PI).toVar();
        const result = float(1).toVar();
        const sinE = nDotL;
        If(sinE.greaterThan(-0.03).and(sinE.lessThan(0.4)), () => {
          const cosE = sqrt(max(float(1).sub(sinE.mul(sinE)), 1e-4));
          const tanE = sinE.div(cosE);
          const se = dot(uSun, east);
          const sn = dot(uSun, north);
          const flat = max(sqrt(se.mul(se).add(sn.mul(sn))), 1e-4);
          const dirE = se.div(flat);
          const dirN = sn.div(flat);
          const cosLat = max(sqrt(n.x.mul(n.x).add(n.z.mul(n.z))), 0.05);
          // Steps grow geometrically from about a texel of the 2048 map to SHADOW_REACH.
          const first = 0.0016;
          const growth = (SHADOW_REACH / first) ** (1 / Math.max(1, steps - 1));
          const height = float(0).toVar();
          const travelled = float(0).toVar();
          const worst = float(-1).toVar();
          Loop(steps, ({ i }) => {
            const s = float(first).mul(float(growth).pow(float(i)));
            const ds = s.sub(travelled);
            const mid = travelled.add(ds.mul(0.5));
            const uv = c.uv.add(vec2(dirE.mul(mid).div(cosLat.mul(2 * Math.PI)), dirN.mul(mid).div(Math.PI)));
            // Coarser levels further out: each tap spans about its step.
            const tapLevel = max(level, texelsPerRadian.mul(ds).max(1e-6).log2());
            const t = decodeNormal(sampleSlotLevel(normalSlot, uv, tapLevel));
            const slope = t.x.mul(dirE).add(t.y.mul(dirN)).negate().div(max(t.z, 0.2));
            height.addAssign(slope.mul(ds));
            travelled.assign(s);
            // Ground ahead above the sunlight's ray (the sphere falls away as s^2 / 2), in units of the Sun's spread there.
            const above = height.sub(s.mul(s).mul(0.5)).sub(s.mul(tanE));
            worst.assign(max(worst, above.div(max(s.mul(options.body === 'moon' ? sunAngularRadius * 2 : uSunAngularRadius.mul(2)), 1e-6))));
          });
          result.assign(float(1).sub(smoothstep(-0.5, 0.5, worst)));
        });
        If(sinE.lessThanEqual(-0.03), () => {
          result.assign(0);
        });
        return result;
      })();
    }
    const terminator = sunlit(nDotL.add(0.015), 0.012);
    const earthshine = max(dot(relief, uEarth), 0).mul(uEarthshine);
    const light = vec3(law.mul(terminator).mul(lit)).add(EARTHLIGHT.mul(earthshine));
    const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
    material.colorNode = albedo.mul(light).mul(uLight);
    if (options.polar !== 1) material.positionNode = point;
    return material;
  };

  const materials = new Map<string, MeshBasicNodeMaterial>();
  const keyOf = (d: ExploreDetail): string => `${d.tier}|${d.normalMaps}`;
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
  const mesh = new Mesh(sphere(initial.sphereSegments), materialFor(initial));
  mesh.name = 'explore-moon-surface';
  object.add(mesh);
  // Mars only: a faint, explicitly labelled dust-haze limb. Height and strength are visual
  // choices, not an atmospheric measurement. The shader changes continuously with phase.
  let haze: Mesh<SphereGeometry, MeshBasicNodeMaterial> | null = null;
  if (options.body === 'mars') {
    const eye = vec3(uEye.x, uEye.y.div(options.polar), uEye.z);
    const ray = normalize(positionLocal.sub(eye));
    const along = dot(eye, ray);
    const closest = eye.sub(ray.mul(along));
    const tangent = length(closest);
    const height = tangent.sub(1);
    const up = closest.div(max(tangent, 1e-6));
    const column = exp(max(height, 0).div(-0.002)).mul(smoothstep(-0.002, 0, height));
    const lit = smoothstep(-0.1, 0.15, dot(up, uSun));
    const ahead = smoothstep(0, 0.02, along.negate());
    const m = blendAdditive(new MeshBasicNodeMaterial({ side: FrontSide, transparent: true, depthWrite: false, fog: false }));
    m.colorNode = vec3(1, 0.55, 0.3).mul(column.mul(lit).mul(ahead).mul(0.12)).mul(uLight);
    m.opacityNode = float(1);
    haze = new Mesh(new SphereGeometry(1.012, 96, 48), m);
    haze.scale.y = options.polar;
    haze.name = 'explore-mars-dust-haze';
    haze.renderOrder = 2;
    object.add(haze);
  }
  const inverse = new Matrix4();
  const scratch = new Vector3();

  return {
    object,
    update(frame, cameraWorld) {
      uLight.value = frame.light;
      uSunAngularRadius.value = Math.asin(Math.min(1, Math.sin(sunAngularRadius) * Math.sqrt(frame.light)));
      inverse.copy(object.matrixWorld).invert();
      // Directions turn with the body only (no translation, no scale).
      uSun.value.set(frame.sun.x, frame.sun.y, frame.sun.z).transformDirection(inverse);
      uEarth.value.set(frame.earth.x, frame.earth.y, frame.earth.z).transformDirection(inverse);
      uEarthshine.value = options.body === 'moon' ? EARTHSHINE * frame.earthLit : 0;
      uEye.value.copy(scratch.copy(cameraWorld).applyMatrix4(inverse));
      object.visible = frame.light > 1e-3;
    },
    prepare(detail) {
      const m = materialFor(detail);
      if (mesh.material === m) return [];
      const warm = new Mesh(sphere(detail.sphereSegments), m);
      warm.frustumCulled = false;
      return [warm];
    },
    apply(detail) {
      mesh.material = materialFor(detail);
      mesh.geometry = sphere(detail.sphereSegments);
      // Only what this detail level uses is kept.
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
    },
    dispose() {
      haze?.geometry.dispose();
      haze?.material.dispose();
      for (const g of geometries.values()) g.dispose();
      for (const m of materials.values()) m.dispose();
    },
  };
}
