/**
 * The Moon, for the explorer: dark maria gathered on the near side, bright cratered highlands,
 * and relief. Illustrative until the mission maps arrive (Stage 7): no real crater or sea is placed.
 *
 * Craters are drawn at several scales (src/explore/bodies/shading.ts), each with an analytic
 * slope, so near the terminator their walls fall into shadow and their rims catch the light, and
 * each scale fades out before its craters would be smaller than a few pixels. Light is
 * Lommel-Seeliger, as airless regolith reflects it (a full Moon is as bright at its limb as at its
 * centre), softened over a pixel at the terminator so a thin crescent never breaks into dashes.
 *
 * The night side gets earthshine: sunlight the Earth sends back, from the Earth's direction and as
 * much of it as the Earth's lit face turned toward the Moon. Real earthshine is about 10^-4 of
 * sunlight, far below what a camera exposed for the day side records; it is shown a few hundred
 * times stronger, as the eye sees it, so the dark disc reads (a visual aid, like the points of light).
 */

import { FrontSide, Group, Matrix4, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3, type Data3DTexture } from 'three/webgpu';
import { dot, float, max, mix, normalize, positionLocal, smoothstep, texture3D, uniform, vec3 } from 'three/tsl';
import { bumpGradient, craters, keepOnSphere, litCosine, noiseIfKept, sphereFootprint, sunlit, tiltNormal, type FloatNode, type Tier, type Vec3Node } from './shading';

const SEGMENTS: Readonly<Record<Tier, readonly [number, number]>> = { high: [192, 128], mid: [160, 112], low: [112, 80] };
/**
 * Crater scales: cells per unit on the unit sphere (the largest about 250 km across, the smallest
 * about 4 km), the share of cells that hold one, and depth over diameter (large craters are
 * shallower for their size). More scales on higher tiers.
 */
const CRATER_SCALES = [
  { cells: 2.6, density: 0.55, ratio: 0.05 },
  { cells: 6.5, density: 0.7, ratio: 0.08 },
  { cells: 16, density: 0.8, ratio: 0.1 },
  { cells: 40, density: 0.85, ratio: 0.12 },
  { cells: 100, density: 0.85, ratio: 0.12 },
] as const;
const CRATER_COUNT: Readonly<Record<Tier, number>> = { high: 5, mid: 4, low: 3 };

const HIGHLAND = vec3(0.36, 0.347, 0.326);
const MARE = vec3(0.16, 0.155, 0.149);
/** Hummocky ground between the craters: its height (radii) at two scales, for the terminator's texture. */
const ROUGH = 0.0012;
/** Earthlight is bluer than sunlight (the Earth's oceans and sky). */
const EARTHLIGHT = vec3(0.72, 0.84, 1);
/** Earthshine shown on the night side, as a share of full sunlight from a full Earth (about 300 times the true share). */
export const EARTHSHINE = 0.03;

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
  setTier(tier: Tier): void;
  dispose(): void;
}

export function createMoon(noise: Data3DTexture, tier: Tier): ExploreMoon {
  const object = new Group();
  object.name = 'explore-moon';
  const uLight = uniform(1);
  // Light, the Earth and the eye in the Moon's own frame (set on the CPU), so the relief is lit there.
  const uSun = uniform(new Vector3(1, 0, 0));
  const uEarth = uniform(new Vector3(-1, 0, 0));
  const uEarthshine = uniform(0);
  const uEye = uniform(new Vector3(0, 0, 3));

  const T = (p: Vec3Node): FloatNode => texture3D(noise, p).r;

  const build = (level: Tier): MeshBasicNodeMaterial => {
    const n = normalize(positionLocal);
    const footprint = sphereFootprint(n);
    // Basins: large and rounded, filled where the near side's bias lifts them over the threshold
    // (local +x faces the Earth in the IAU model); dark lava plains with soft shores.
    // A gentle warp bends the basins' shores, so no trace of the noise's grid shows in them.
    const bend = vec3(T(n.mul(3.1).add(0.12)), T(n.mul(3.1).add(0.52)), T(n.mul(3.1).add(0.92))).sub(0.5).mul(0.16);
    const shore = n.add(bend);
    const basins = T(shore.mul(1.1).add(0.83)).mul(0.7).add(T(shore.mul(2.3).add(0.4)).mul(0.3));
    const nearSide = smoothstep(-0.2, 0.7, n.x);
    const mare = smoothstep(0.54, 0.7, basins.add(nearSide.mul(0.2)).sub(0.06));
    const rough = T(n.mul(4.4).add(0.21));
    const toneKept = keepOnSphere(footprint, 100);
    const tone = noiseIfKept(noise, n.mul(13).add(0.57), toneKept).sub(0.5).mul(toneKept);
    const flow = T(n.mul(7).add(0.66)).sub(0.5);
    const highland = HIGHLAND.mul(rough.mul(0.24).add(tone.mul(0.18)).add(0.86));
    const sea = MARE.mul(flow.mul(0.3).add(tone.mul(0.14)).add(1)).mul(vec3(1, 0.99, 1.02));
    let albedo: Vec3Node = mix(highland, sea, mare);

    // Relief: craters at every scale the pixels can hold; the seas are younger and smoother.
    let gradient: Vec3Node = vec3(0, 0, 0);
    let rims: FloatNode = float(0);
    let floors: FloatNode = float(0);
    let ejecta: FloatNode = float(0);
    CRATER_SCALES.slice(0, CRATER_COUNT[level]).forEach((layer, i) => {
      const c = craters(n, layer.cells, i, layer.density, layer.ratio);
      const kept = keepOnSphere(footprint, layer.cells * 3);
      const smooth = float(1).sub(mare.mul(i < 2 ? 0.85 : 0.5));
      gradient = gradient.add(c.gradient.mul(kept).mul(smooth));
      rims = rims.add(c.rim.mul(kept).mul(smooth).mul(0.5));
      floors = floors.add(c.inside.mul(kept).mul(smooth));
      ejecta = ejecta.add(c.ejecta.mul(kept));
    });
    // Young craters' bright ejecta, the speckle of a full Moon; rims a little brighter, floors darker.
    albedo = albedo.mul(rims.mul(0.12).add(ejecta.mul(0.3)).add(1)).mul(float(1).sub(floors.mul(0.04)));
    // Rolling, hummocky ground: the screen-space change of a rough height, tilting the normal.
    const roughKept = keepOnSphere(footprint, 88);
    const fineKept = keepOnSphere(footprint, 250);
    const hummocks = noiseIfKept(noise, n.mul(11).add(0.13), roughKept).mul(roughKept).add(noiseIfKept(noise, n.mul(31).add(0.47), fineKept).mul(0.5).mul(fineKept));
    const tilt = bumpGradient(positionLocal, n, hummocks.mul(ROUGH).mul(float(1).sub(mare.mul(0.6))));
    // Foreshortened toward the limb, relief would only break the edge into specks: it fades there.
    const view = normalize(uEye.sub(n));
    const edgeOn = smoothstep(0.03, 0.22, max(dot(n, view), 0));
    const relief = tiltNormal(n, gradient.add(tilt).mul(edgeOn), 1);

    // Lommel-Seeliger on the relief; the disc's own terminator softened over a pixel, a little
    // past it so rims just beyond still catch the light.
    const mu0 = litCosine(dot(relief, uSun));
    const mu = max(dot(relief, view), 0);
    const lommel = mu0.mul(2).div(mu0.add(mu).add(1e-3)).mul(0.9);
    const terminator = sunlit(dot(n, uSun).add(0.02), 0.03);
    const earthshine = max(dot(relief, uEarth), 0).mul(uEarthshine);
    const light = vec3(lommel.mul(terminator)).add(EARTHLIGHT.mul(earthshine));
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
  const mesh = new Mesh(geometry, materialFor(tier));
  mesh.name = 'explore-moon-surface';
  object.add(mesh);
  let current = tier;
  const inverse = new Matrix4();
  const scratch = new Vector3();

  return {
    object,
    update(frame, cameraWorld) {
      uLight.value = frame.light;
      inverse.copy(object.matrixWorld).invert();
      // Directions turn with the body only (no translation, no scale).
      const turn = (v: { x: number; y: number; z: number }, out: Vector3): void => {
        out.set(v.x, v.y, v.z).transformDirection(inverse);
      };
      turn(frame.sun, uSun.value);
      turn(frame.earth, uEarth.value);
      uEarthshine.value = EARTHSHINE * frame.earthLit;
      uEye.value.copy(scratch.copy(cameraWorld).applyMatrix4(inverse));
      object.visible = frame.light > 1e-3;
    },
    setTier(next) {
      if (next === current) return;
      current = next;
      const old = geometry;
      geometry = new SphereGeometry(1, ...SEGMENTS[next]);
      mesh.geometry = geometry;
      old.dispose();
      mesh.material = materialFor(next);
    },
    dispose() {
      geometry.dispose();
      for (const m of materials.values()) m.dispose();
    },
  };
}
