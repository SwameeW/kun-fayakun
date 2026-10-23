/**
 * The Moon, for the explorer, from NASA's CGI Moon Kit: LROC WAC colour (albedo with no shading in
 * it) and LOLA relief as a normal map (Medium and up).
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
 * The night side gets earthshine: sunlight the Earth sends back, from its direction and as much of it
 * as the Earth's lit face turned toward the Moon. Real earthshine is about 10^-4 of sunlight, far below
 * what a camera exposed for the day side records; it is shown a few hundred times stronger, as the eye
 * sees it, so the dark disc reads (a visual aid, like the points of light).
 */

import { FrontSide, Group, Matrix4, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3, type Node, type Object3D } from 'three/webgpu';
import { atan, dot, float, Fn, If, int, Loop, max, normalize, positionLocal, smoothstep, sqrt, tan, uniform, vec2, vec3 } from 'three/tsl';
import type { PlanetTextures } from '../assets/streaming';
import type { ExploreDetail } from '../detail';
import { decodeNormal, mapCoords, mipLevel, sampleSlot, sampleSlotLevel, tangentFrame, type FloatNode, type Vec3Node } from '../render/sampling';
import { bumpGradient, litCosine, sunlit, tiltNormal } from './shading';

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
const SHADOW_STEPS: Readonly<Record<ExploreDetail['tier'], number>> = { ultra: 14, high: 12, medium: 7, low: 0 };
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

export function createMoon(textures: PlanetTextures, sunAngularRadius: number, initial: ExploreDetail): ExploreMoon {
  const object = new Group();
  object.name = 'explore-moon';
  const uLight = uniform(1);
  // Light, the Earth and the eye in the Moon's own frame (set on the CPU), so the relief is lit there.
  const uSun = uniform(new Vector3(1, 0, 0));
  const uEarth = uniform(new Vector3(-1, 0, 0));
  const uEarthshine = uniform(0);
  const uEye = uniform(new Vector3(0, 0, 3));
  const colourSlot = textures.slot('moon', 'colour');
  const normalSlot = textures.slot('moon', 'normal');
  const standard = lommel(STANDARD.mu0, STANDARD.mu).mul(surge(STANDARD.phase)).mul(Math.exp(-PHASE_DARKENING * STANDARD.phase));

  const build = (detail: ExploreDetail): MeshBasicNodeMaterial => {
    const n = normalize(positionLocal);
    const c = mapCoords(n, n.y, U_AT_LON0);
    const albedo = sampleSlot(colourSlot, c).rgb;
    const { east, north } = tangentFrame(n);
    let relief: Vec3Node;
    if (detail.normalMaps) {
      const t = decodeNormal(sampleSlot(normalSlot, c));
      relief = normalize(east.mul(t.x).add(north.mul(t.y)).add(n.mul(t.z)));
    } else {
      // No relief map at this detail: a hint of relief from the colour map's local contrast (crater
      // rims and young ejecta are bright), so the terminator is not flat. Illustrative.
      const luma = (v: Vec3Node): FloatNode => dot(v, vec3(0.2126, 0.7152, 0.0722));
      const contrast = luma(albedo).sub(luma(sampleSlot(colourSlot, c, 2.5).rgb));
      relief = tiltNormal(n, bumpGradient(positionLocal, n, contrast.mul(ALBEDO_RELIEF)), 1);
    }
    const view = normalize(uEye.sub(n));
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
            worst.assign(max(worst, above.div(max(s.mul(sunAngularRadius * 2), 1e-6))));
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
    return material;
  };

  const materials = new Map<string, MeshBasicNodeMaterial>();
  const keyOf = (d: ExploreDetail): string => `${d.normalMaps}|${d.normalMaps ? SHADOW_STEPS[d.tier] : 0}`;
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
  const inverse = new Matrix4();
  const scratch = new Vector3();

  return {
    object,
    update(frame, cameraWorld) {
      uLight.value = frame.light;
      inverse.copy(object.matrixWorld).invert();
      // Directions turn with the body only (no translation, no scale).
      uSun.value.set(frame.sun.x, frame.sun.y, frame.sun.z).transformDirection(inverse);
      uEarth.value.set(frame.earth.x, frame.earth.y, frame.earth.z).transformDirection(inverse);
      uEarthshine.value = EARTHSHINE * frame.earthLit;
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
    },
    dispose() {
      for (const g of geometries.values()) g.dispose();
      for (const m of materials.values()) m.dispose();
    },
  };
}
