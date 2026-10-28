import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  Object3D,
  PlaneGeometry,
  PointsNodeMaterial,
  SphereGeometry,
  Sprite,
  Vector3,
  type Data3DTexture,
  type Node,
} from 'three/webgpu';
import {
  abs,
  cameraPosition,
  cos,
  dot,
  exp,
  float,
  fract,
  hash,
  instanceIndex,
  instancedBufferAttribute,
  max,
  mix,
  normalize,
  positionLocal,
  sin,
  smoothstep,
  texture3D,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import type { ChapterContent, ChapterContext, ChapterModule, Cue, QualityTier, SceneLabel, SceneScale } from '../../core/types';
import { airSteps, createFilmAir, type FilmAir } from '../shared/film-air';
import { createNoiseVolume } from '../shared/noise-volume';
import { createEarth, type Earth } from '../shared/planet';
import { createStarfield, type Starfield } from '../shared/starfield';
import contentJson from './content.json';

/**
 * Chapter 9, "Life from water": inside an early ocean, close up, light filters down from the
 * surface in shafts and shimmering caustics; specks drift; single cells (illustrative, not a
 * reconstruction of any real microbe) turn slowly in the water. The view rises through the
 * surface in a soft dissolve to the whole planet, whose seas and sky shift colour as oxygen
 * builds up, and whose land later turns green, under the explorer's air (shared/film-air.ts).
 * The chapter ends before the first humans.
 */

const content = contentJson as unknown as ChapterContent;

/**
 * The Sun, low over the southern tropic (23 degrees, as far from the equator as it goes), placed so
 * that along the camera's slow orbit the planet is seen from about 50 to 110 degrees off the Sun's
 * direction: a terminator across the disc and a dark night side.
 */
const SUN = new Vector3(0.889, -0.391, 0.238).normalize();
/** Micro scene: one world unit is 10 micrometres; the planet scene: one unit is the Earth's radius. */
const METRES_PER_UNIT = { micro: 1e-5, planet: 6.371e6 } as const;
const COUNT: Readonly<Record<QualityTier, { specks: number; cells: number }>> = {
  high: { specks: 9000, cells: 220 },
  mid: { specks: 5000, cells: 160 },
  low: { specks: 2500, cells: 110 },
};
const SURFACE_Y = 2.6;
/** The camera position (set each frame by the scene) for CPU-side billboards. */
const cameraPositionValue = new Vector3();

const smootherstep = (edge0: number, edge1: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return u * u * u * (u * (u * 6 - 15) + 10);
};
const span = (a: number, b: number, c: number, d: number, t: number): number => smootherstep(a, b, t) * (1 - smootherstep(c, d, t));

function eventTime(cues: readonly Cue[], event: string, fallback: number): number {
  return cues.find((c): c is Extract<Cue, { type: 'scene' }> => c.type === 'scene' && c.event === event)?.t ?? fallback;
}

function createQuad(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  return geometry;
}

interface Ocean {
  readonly object: Group;
  update(state: { time: number; light: number }): void;
  setCounts(counts: { specks: number; cells: number }): void;
  dispose(): void;
}

function createOcean(noise: Data3DTexture): Ocean {
  const object = new Group();
  object.name = 'ch09-ocean';
  const uTime = uniform(0);
  const uLight = uniform(0);
  const disposables: Array<{ dispose(): void }> = [];

  // The water around: brighter toward the surface above, deep blue-black below.
  const waterMaterial = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  const dir = normalize(positionLocal);
  waterMaterial.colorNode = mix(vec3(0.0, 0.025, 0.05), vec3(0.08, 0.3, 0.34), smoothstep(-0.5, 0.9, dir.y)).mul(uLight);
  const waterGeometry = new SphereGeometry(40, 48, 32);
  const water = new Mesh(waterGeometry, waterMaterial);
  water.renderOrder = -20;
  disposables.push(waterMaterial, waterGeometry);

  // The surface overhead: sunlight broken into moving caustics.
  const surfaceMaterial = new MeshBasicNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, fog: false });
  const sp = positionLocal.xy.mul(0.35);
  const ripple = texture3D(noise, vec3(sp, uTime.mul(0.05))).r.add(texture3D(noise, vec3(sp.mul(2.1).add(0.3), uTime.mul(-0.07))).r);
  const caustic = float(1).sub(smoothstep(0, 0.1, abs(ripple.sub(1))));
  const fade = float(1).sub(smoothstep(4, 18, positionLocal.xy.length()));
  surfaceMaterial.colorNode = vec3(0.55, 0.85, 0.85).mul(caustic.mul(0.5).add(0.12)).mul(fade).mul(uLight);
  surfaceMaterial.opacityNode = float(1);
  const surfaceGeometry = new PlaneGeometry(40, 40, 1, 1);
  const surface = new Mesh(surfaceGeometry, surfaceMaterial);
  surface.rotation.x = Math.PI / 2;
  surface.position.y = SURFACE_Y;
  disposables.push(surfaceMaterial, surfaceGeometry);

  // Shafts of light from the surface: tall soft planes that turn to face the camera about the vertical.
  const shaftCount = 26;
  const shaftMaterial = new MeshBasicNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, side: DoubleSide, fog: false });
  const su = uv();
  const across = exp(su.x.sub(0.5).mul(2).pow(2).mul(-6));
  const down = smoothstep(0, 1, su.y);
  const flicker = texture3D(noise, vec3(su.x.mul(0.6), uTime.mul(0.04), hash(instanceIndex).mul(3))).r.mul(0.8).add(0.4);
  shaftMaterial.colorNode = vec3(0.45, 0.78, 0.74).mul(across.mul(down).mul(flicker)).mul(0.07).mul(uLight);
  shaftMaterial.opacityNode = float(1);
  const shaftGeometry = new PlaneGeometry(1, 1);
  const shafts = new InstancedMesh(shaftGeometry, shaftMaterial, shaftCount);
  shafts.frustumCulled = false;
  const shaftSpots = Array.from({ length: shaftCount }, (_, i) => ({
    x: (Math.random() - 0.5) * 7,
    z: (Math.random() - 0.5) * 7 - 1.5,
    width: 0.25 + Math.random() * 0.7,
    lean: (Math.random() - 0.5) * 0.25,
    i,
  }));
  disposables.push(shaftMaterial, shaftGeometry);

  // Drifting specks.
  const speckMax = COUNT.high.specks;
  const speckMaterial = new PointsNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, sizeAttenuation: false, fog: false });
  const seed = instanceIndex.mul(4);
  const base = vec3(hash(seed), hash(seed.add(1)), hash(seed.add(2))).sub(0.5).mul(8);
  const drifting = base.add(vec3(sin(uTime.mul(0.07).add(hash(seed.add(3)).mul(6))).mul(0.2), uTime.mul(-0.02), 0));
  const wrapped = vec3(drifting.x, fract(drifting.y.div(8).add(0.5)).sub(0.5).mul(8), drifting.z);
  speckMaterial.positionNode = wrapped;
  const toCamera = wrapped.sub(cameraPosition).length();
  speckMaterial.sizeNode = float(5).div(max(toCamera, 0.4)).max(1.2);
  const kc = uv().sub(0.5).mul(2);
  const k2 = dot(kc, kc);
  speckMaterial.colorNode = vec3(0.6, 0.85, 0.82).mul(exp(k2.mul(-5)).mul(max(float(1).sub(k2), 0))).mul(0.16).mul(uLight).mul(smoothstep(0.3, 1, toCamera));
  speckMaterial.opacityNode = float(1);
  const speckGeometry = createQuad();
  const specks = new Sprite(speckMaterial);
  specks.geometry = speckGeometry;
  specks.count = speckMax;
  specks.frustumCulled = false;
  disposables.push(speckMaterial, speckGeometry);

  // Single cells: soft translucent capsules (rods and spheres), slowly turning and drifting. Illustrative.
  const cellMax = COUNT.high.cells;
  const cellData = new Float32Array(cellMax * 4);
  for (let i = 0; i < cellMax; i += 1) {
    const r = 0.2 + 1.9 * Math.cbrt(Math.random());
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    cellData.set([r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi) * 0.7, r * Math.sin(phi) * Math.sin(theta) - 0.3, Math.random()], i * 4);
  }
  const cellAttr = instancedBufferAttribute(new InstancedBufferAttribute(cellData, 4)) as unknown as Node<'vec4'>;
  const cellMaterial = new PointsNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, sizeAttenuation: false, fog: false });
  const kind = cellAttr.w;
  const wobble = vec3(sin(uTime.mul(0.11).add(kind.mul(20))), sin(uTime.mul(0.08).add(kind.mul(13))), cos(uTime.mul(0.09).add(kind.mul(7)))).mul(0.06);
  const cellPos = cellAttr.xyz.add(wobble);
  cellMaterial.positionNode = cellPos;
  const cellDistance = cellPos.sub(cameraPosition).length();
  const cellSize = float(0.09).add(kind.mul(0.05));
  cellMaterial.sizeNode = cellSize.mul(900).div(max(cellDistance, 0.2));
  const cc = uv().sub(0.5).mul(2);
  const spin = kind.mul(6.28).add(uTime.mul(kind.sub(0.5).mul(0.2)));
  const rot = vec2(cc.x.mul(cos(spin)).sub(cc.y.mul(sin(spin))), cc.x.mul(sin(spin)).add(cc.y.mul(cos(spin))));
  // Rods (about 60%) stretched along one axis; the rest round.
  const stretch = mix(float(1), float(2.6), smoothstep(0.38, 0.42, kind));
  const capsule = vec2(rot.x.mul(stretch).mul(0.5).sub(rot.x.mul(stretch).mul(0.5).clamp(-0.55, 0.55)), rot.y).length();
  const body = smoothstep(0.62, 0.5, capsule);
  const membrane = exp(capsule.sub(0.56).div(0.05).pow(2).negate());
  const inside = texture3D(noise, vec3(rot.mul(1.4), kind.mul(5).add(uTime.mul(0.02)))).r;
  const cellColor = mix(vec3(0.35, 0.8, 0.62), vec3(0.42, 0.72, 0.9), hash(instanceIndex.mul(9)));
  const depthFade = smoothstep(0.25, 0.8, cellDistance).mul(float(1).sub(smoothstep(3.5, 6, cellDistance)));
  cellMaterial.colorNode = cellColor.mul(membrane.mul(0.55).add(body.mul(inside.mul(0.12).add(0.04)))).mul(uLight).mul(depthFade);
  cellMaterial.opacityNode = float(1);
  const cellGeometry = createQuad();
  const cells = new Sprite(cellMaterial);
  cells.geometry = cellGeometry;
  cells.count = cellMax;
  cells.frustumCulled = false;
  disposables.push(cellMaterial, cellGeometry);

  object.add(water, surface, shafts, specks, cells);
  const placer = new Object3D();
  const toward = new Vector3();
  return {
    object,
    update(state) {
      uTime.value = state.time;
      uLight.value = state.light;
      object.visible = state.light > 1e-3;
      // Shafts face the camera about the vertical, leaning a little, as light through moving water.
      for (const s of shaftSpots) {
        placer.position.set(s.x, SURFACE_Y - 3.2, s.z);
        toward.set(cameraPositionValue.x - s.x, 0, cameraPositionValue.z - s.z);
        placer.rotation.set(0, Math.atan2(toward.x, toward.z), s.lean + Math.sin(state.time * 0.1 + s.i) * 0.03);
        placer.scale.set(s.width, 6.4, 1);
        placer.updateMatrix();
        shafts.setMatrixAt(s.i, placer.matrix);
      }
      shafts.instanceMatrix.needsUpdate = true;
    },
    setCounts(counts) {
      specks.count = Math.min(speckMax, counts.specks);
      cells.count = Math.min(cellMax, counts.cells);
    },
    dispose() {
      for (const d of disposables) d.dispose();
      shafts.dispose();
    },
  };
}

export default function create(): ChapterModule {
  const times = {
    rise: eventTime(content.cues, 'rise', 58),
    oxygen: eventTime(content.cues, 'oxygen', 72),
    green: eventTime(content.cues, 'green', 96),
  };
  const swap = times.rise + 8;
  const root = new Group();
  root.name = 'ch09';
  let ctx: ChapterContext | null = null;
  let noise: Data3DTexture | null = null;
  let air: FilmAir | null = null;
  let ocean: Ocean | null = null;
  let earth: Earth | null = null;
  let stars: Starfield | null = null;
  let now = 0;
  // The dissolve between the ocean and the planet: a pale veil around the camera, eased up and down.
  const uVeil = uniform(0);
  const veilMaterial = new MeshBasicNodeMaterial({ transparent: true, side: BackSide, depthWrite: false, depthTest: false, fog: false });
  veilMaterial.colorNode = vec3(0.62, 0.8, 0.86);
  veilMaterial.opacityNode = uVeil;
  const veilGeometry = new SphereGeometry(0.5, 24, 16);
  const veil = new Mesh(veilGeometry, veilMaterial);
  veil.renderOrder = 100;
  veil.frustumCulled = false;

  return {
    id: 'ch09',
    content,
    cues: content.cues,

    async load(c) {
      ctx = c;
      if (!ocean) {
        noise = await createNoiseVolume(64, 9_009);
        ocean = createOcean(noise);
        air = createFilmAir(c);
        earth = createEarth(noise, 1, { model: air.model, table: air.table, steps: airSteps(c.quality.tier) });
        stars = createStarfield();
        root.add(stars.object, ocean.object, earth.object, veil);
      }
      ocean.setCounts(COUNT[c.quality.tier]);
      earth?.setAirSteps(airSteps(c.quality.tier));
    },

    enter(c) {
      ctx = c;
      ocean?.setCounts(COUNT[c.quality.tier]);
      earth?.setAirSteps(airSteps(c.quality.tier));
      c.exposure.setTarget(1);
      c.scene.add(root);
    },

    update(t) {
      if (!ctx || !ocean || !earth || !stars) return;
      now = t;
      cameraPositionValue.copy(ctx.camera.position);
      const underwater = t < swap;
      ocean.update({ time: t, light: underwater ? smootherstep(0, 3, t) : 0 });
      const planet = underwater ? 0 : 1;
      air?.bake(ctx.renderer);
      stars.setLight(planet);
      earth.update({
        time: t,
        sun: SUN,
        spin: t * 0.1,
        light: planet,
        eye: ctx.camera.position,
        epoch: {
          molten: 0,
          steam: 0,
          ocean: 1,
          land: 1,
          drift: 3 + t * 0.03,
          oxygen: smootherstep(times.oxygen, times.oxygen + 26, t),
          life: smootherstep(times.green, times.green + 26, t),
          clouds: 0.55 + 0.15 * smootherstep(times.oxygen, times.green + 20, t),
        },
      });
      veil.position.copy(ctx.camera.position);
      uVeil.value = span(swap - 3.5, swap - 0.6, swap + 0.6, swap + 3.5, t) * 0.92;
      veil.visible = uVeil.value > 1e-3;
    },

    labels(): readonly SceneLabel[] {
      const opacity = span(4, 6, 27, 29, now);
      return opacity > 0 ? [{ id: 'cells', textKey: 'ui.hud.cells', position: [0.35, 0.25, 0.4], opacity }] : [];
    },

    scale(): SceneScale | null {
      if (!ctx) return null;
      const underwater = now < swap;
      return { metresPerUnit: underwater ? METRES_PER_UNIT.micro : METRES_PER_UNIT.planet, distance: ctx.camera.position.length() };
    },

    setQuality(profile) {
      ocean?.setCounts(COUNT[profile.tier]);
      earth?.setAirSteps(airSteps(profile.tier));
    },

    exit() {
      root.removeFromParent();
    },

    dispose() {
      root.removeFromParent();
      ocean?.dispose();
      earth?.dispose();
      stars?.dispose();
      noise?.dispose();
      air?.dispose();
      veilGeometry.dispose();
      veilMaterial.dispose();
      air = null;
      ocean = null;
      earth = null;
      stars = null;
      noise = null;
      ctx = null;
    },
  };
}
