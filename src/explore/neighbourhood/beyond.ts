import { AdditiveBlending, BufferAttribute, BufferGeometry, InstancedBufferAttribute, PointsNodeMaterial, Sprite, type Node } from 'three/webgpu';
import { dot, exp, float, instancedBufferAttribute, max, min, modelViewMatrix, uniform, uv, varying, vec4 } from 'three/tsl';
import type { SceneLabel } from '../../core/types';
import { skyDirection } from '../sky';
import { armRadius, galactocentric, MILKY_WAY, sampleMilkyWay, type SpiralArm } from './galaxy';

/**
 * Beyond the stars (ledger IS-6, docs/NEIGHBOURHOOD.md; part of the neighbourhood's chunk): what the
 * camera sees as it leaves the Sun's neighbourhood. The Milky Way as a model (./galaxy: its arms,
 * disc and bar from measured parameters, illustrative); the galaxies of the Local Group where
 * McConnachie's catalogue puts them (public/assets/stars/localgroup.json), each a glow of its
 * half-light radius and brightness, the four largest as discs of points at their measured sizes and
 * orientations; and, loaded when the camera goes that far, the Sloan Digital Sky Survey's galaxies
 * (the film's sample, public/assets/sdss/), the web they trace.
 *
 * Every point is held in parsecs from the Sun (render frame), single precision on the GPU, and its
 * object moved by minus the camera's place each frame: a parsec's precision near the Sun, a few
 * hundred at the survey's billions. Each point's size on the screen follows its distance (a radius
 * in parsecs), its light thinned when it is smaller than a pixel, so a galaxy's surface keeps its
 * brightness however far it is, and fades in or out with the scale.
 */

type V3 = [number, number, number];

/** A galaxy of the Local Group, as the file gives it (see scripts/stars/beyond.py). */
export interface LocalGroupFile {
  fields: string[];
  galaxies: Array<[string, string, string | null, number, number, number, number | null, number | null, number | null, number | null, boolean, number | null, number | null, number | null, number | null]>;
}

export interface LocalGalaxy {
  name: string;
  group: string;
  type: string | null;
  distKpc: number;
  /** Half-light radius (kpc), from the catalogue's angle, or a quarter of SIMBAD's isophotal diameter for the largest. */
  radiusKpc: number | null;
  absV: number | null;
  absVDerived: boolean;
  massMsun: number | null;
  /** Its isophotal diameter (kpc), where SIMBAD gives one. */
  diameterKpc: number | null;
  position: V3;
}

/** The film's survey sample (public/assets/sdss/galaxies.json). */
export interface WebManifest {
  file: string;
  count: number;
  scaleMpc: number;
  nearLimit: number;
  redshiftScale: number;
}

export interface BeyondPlace {
  id: 'centre' | 'milky-way' | 'lmc' | 'smc' | 'andromeda' | 'triangulum' | 'local-group' | 'web';
  /** Where the camera looks (pc from the Sun, render frame), and from how far it arrives. */
  position: V3;
  arrivePc: number;
  /** A direction to arrive from (the Milky Way's north pole, to see it face on), or null to keep the bearing. */
  from: V3 | null;
  galaxy: LocalGalaxy | null;
}

export type Scale = 'stars' | 'galaxy' | 'local-group' | 'universe';

export interface Beyond {
  readonly galaxies: readonly LocalGalaxy[];
  readonly places: readonly BeyondPlace[];
  /** Places everything for a camera (pc from the Sun) and its screen; asks for the survey when it is far enough to need it. */
  update(camera: V3, fromSunPc: number, focalPx: number): void;
  /** The share of the catalogue's stars and of the band of the galaxy's light to keep at this distance from the Sun. */
  starsShown(fromSunPc: number): number;
  bandShown(fromSunPc: number): number;
  scale(fromSunPc: number): Scale;
  /** Whether the survey's galaxies are drawn (loaded), and how many. */
  readonly webCount: number;
  labels(out: SceneLabel[], camera: V3, fromSunPc: number): void;
  search(text: string): LocalGalaxy[];
  dispose(): void;
}

const KPC = 1000;
const MPC = 1e6;
const DEG = Math.PI / 180;
/** The galactic frame's pole and centre (ICRS degrees; Hipparcos's definition), as the neighbourhood's band uses them. */
const GALAXY = { poleRa: 192.85948, poleDec: 27.12825, centreRa: 266.40499, centreDec: -28.93617 } as const;
/** The four the catalogue gives no half-light radius, drawn as discs of points from SIMBAD's sizes. */
const DISCS: Record<string, { points: number; thickness: number; colour: V3; light: number }> = {
  Andromeda: { points: 9000, thickness: 0.06, colour: [1, 0.88, 0.74], light: 0.05 },
  Triangulum: { points: 4000, thickness: 0.06, colour: [0.82, 0.86, 1], light: 0.05 },
  LMC: { points: 5000, thickness: 0.25, colour: [0.86, 0.9, 1], light: 0.06 },
  SMC: { points: 2500, thickness: 0.35, colour: [0.86, 0.9, 1], light: 0.06 },
};
/** Display terms: when each part shows (pc from the Sun), and how bright its points are. */
const FADE = { band: [800, 2500], stars: [3000, 8000], galaxy: [1200, 4000], glows: [500, 2000], web: [2e6, 2e7], webLoad: 1.5e6 } as const;
const LIGHT = { galaxy: 0.07, glow: 0.5, web: 0.35 } as const;
/** The Milky Way's points' radius (pc) and the survey's (pc). */
const RADIUS = { galaxy: 200, web: 6e5 } as const;
/** Where the scales change for the labels (pc from the Sun): the galaxy's own, then the Local Group's, then the universe's. */
const LABELS = { arms: 400_000, galaxy: 300_000, universe: 2e7 } as const;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot3(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalised(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** The galactic frame's axes in the render frame: x toward the centre, y toward longitude 90 degrees, z to the north pole. */
export function galacticAxes(obliquity: number): { x: V3; y: V3; z: V3 } {
  const z = skyDirection(GALAXY.poleRa, GALAXY.poleDec, obliquity, [0, 0, 0]) as V3;
  const centre = skyDirection(GALAXY.centreRa, GALAXY.centreDec, obliquity, [0, 0, 0]) as V3;
  const y = normalised(cross(z, centre));
  return { x: normalised(cross(y, z)), y, z };
}

/**
 * A sprite per point: its size on the screen from a radius in parsecs and its distance, its light
 * thinned below a pixel (but never under `minCoverage`, so a far galaxy still marks its place).
 */
function cloud(positions: Float32Array, colours: Float32Array, radii: Float32Array, maxPx: number, name: string, minCoverage = 0) {
  const count = radii.length;
  const posAttr = new InstancedBufferAttribute(positions, 3);
  const colourAttr = new InstancedBufferAttribute(colours, 3);
  const radiusAttr = new InstancedBufferAttribute(radii, 1);
  const uFocal = uniform(800);
  const uLight = uniform(1);
  const material = new PointsNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, sizeAttenuation: false, fog: false });
  const at = instancedBufferAttribute(posAttr) as unknown as Node<'vec3'>;
  const depth = max(modelViewMatrix.mul(vec4(at, 1)).z.negate(), float(1e-3));
  const diameter = (instancedBufferAttribute(radiusAttr) as unknown as Node<'float'>).mul(uFocal).mul(2).div(depth);
  const size = diameter.clamp(1.5, maxPx);
  material.positionNode = at;
  material.sizeNode = size;
  // Smaller than its drawn size: the light it would spread over its own area, no more.
  const coverage = varying(max(min(diameter.div(size), 1), float(minCoverage)));
  const c = uv().sub(0.5).mul(2);
  const r2 = dot(c, c);
  material.colorNode = (instancedBufferAttribute(colourAttr) as unknown as Node<'vec3'>).mul(uLight).mul(coverage.mul(coverage)).mul(exp(r2.mul(-5)).mul(max(float(1).sub(r2), 0)));
  material.opacityNode = float(1);
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.count = count;
  sprite.frustumCulled = false;
  sprite.name = name;
  sprite.renderOrder = -1;
  return {
    sprite,
    uFocal,
    uLight,
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}

export function readLocalGroup(file: LocalGroupFile, obliquity: number): LocalGalaxy[] {
  return file.galaxies.map(([name, group, type, ra, dec, distKpc, rhArcmin, , , absV, absVDerived, massMillions, diamArcmin]) => {
    const dir = skyDirection(ra, dec, obliquity, [0, 0, 0]);
    const pc = distKpc * KPC;
    const diameterKpc = diamArcmin === null ? null : distKpc * Math.tan((diamArcmin / 60) * DEG);
    const radiusKpc = rhArcmin !== null ? distKpc * Math.tan((rhArcmin / 60) * DEG) : diameterKpc !== null ? diameterKpc / 4 : null;
    return {
      name,
      group,
      type,
      distKpc,
      radiusKpc,
      absV,
      absVDerived,
      massMsun: massMillions === null ? null : massMillions * 1e6,
      diameterKpc,
      position: [(dir[0] ?? 0) * pc, (dir[1] ?? 0) * pc, (dir[2] ?? 0) * pc],
    };
  });
}

/** A seeded generator (mulberry32), for the four discs. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What lies beyond the stars, its objects handed to `add` (the survey's when it arrives); `loadWeb`
 * fetches the survey's sample, asked for once the camera is a million and a half parsecs out.
 */
export function createBeyond(file: LocalGroupFile, obliquity: number, loadWeb: () => Promise<{ manifest: WebManifest; data: ArrayBuffer }>, detail: 'full' | 'basic', add: (s: Sprite) => void): Beyond {
  const axes = galacticAxes(obliquity);
  /** A galactic-frame vector (any unit) in the render frame. */
  const toRender = (g: readonly [number, number, number], unit: number, out: Float32Array | number[], at: number): void => {
    for (let k = 0; k < 3; k += 1) out[at + k] = (g[0] * (axes.x[k] ?? 0) + g[1] * (axes.y[k] ?? 0) + g[2] * (axes.z[k] ?? 0)) * unit;
  };
  const r0 = MILKY_WAY.r0Kpc;
  const centre: V3 = [axes.x[0] * r0 * KPC, axes.x[1] * r0 * KPC, axes.x[2] * r0 * KPC];

  // The Milky Way: galactocentric kpc to pc from the Sun (the Sun at -R0 on the x axis).
  const model = sampleMilkyWay(detail === 'full' ? 72_000 : 36_000);
  const mwPositions = new Float32Array(model.count * 3);
  for (let i = 0; i < model.count; i += 1) toRender([(model.positions[i * 3] ?? 0) + r0, model.positions[i * 3 + 1] ?? 0, model.positions[i * 3 + 2] ?? 0], KPC, mwPositions, i * 3);
  const milkyWay = cloud(mwPositions, model.colours.slice(0, model.count * 3), new Float32Array(model.count).fill(RADIUS.galaxy), 10, 'explore-beyond-milky-way');

  // The Local Group: a glow for each galaxy, and the four largest as discs of points.
  const galaxies = readLocalGroup(file, obliquity);
  const glowPos = new Float32Array(galaxies.length * 3);
  const glowColour = new Float32Array(galaxies.length * 3);
  const glowRadius = new Float32Array(galaxies.length);
  galaxies.forEach((g, i) => {
    glowPos.set(g.position, i * 3);
    // Its surface's brightness (display terms): luminosity over area, softened; the four discs' own glow kept low.
    // One whose size the catalogue does not give (the Canis Major overdensity) has no glow: a size is not made up for it.
    const lum = 10 ** (-0.4 * ((g.absV ?? -8) + 15));
    const r = Math.max(g.radiusKpc ?? 0.1, 0.02);
    const surface = g.radiusKpc === null ? 0 : Math.min(1.5, 0.12 * Math.sqrt(lum / (r * r))) * (DISCS[g.name] ? 0.4 : 1);
    glowColour.set([0.9 * surface, 0.88 * surface, 0.85 * surface], i * 3);
    glowRadius[i] = r * KPC;
  });
  const glows = cloud(glowPos, glowColour, glowRadius, 160, 'explore-beyond-local-group', 0.35);

  const discPoints: number[] = [];
  const discColours: number[] = [];
  const discRadii: number[] = [];
  const ncp = skyDirection(0, 90, obliquity, [0, 0, 0]) as V3;
  const rand = random(1447);
  const gauss = (): number => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
  for (const row of file.galaxies) {
    const [name, , , , , , , , , , , , diamArcmin, diamMinArcmin, paDeg] = row;
    const style = DISCS[name];
    const g = galaxies.find((x) => x.name === name);
    if (!style || !g || diamArcmin === null || diamMinArcmin === null || paDeg === null || g.diameterKpc === null) continue;
    // Its axes on the sky (the major axis at its position angle, east of north), the disc tilted by
    // the inclination its axis ratio gives (which side is nearer is not known from the ratio).
    const n = normalised(g.position);
    const east = normalised(cross(ncp, n));
    const north = cross(n, east);
    const pa = paDeg * DEG;
    const major: V3 = [Math.cos(pa) * north[0] + Math.sin(pa) * east[0], Math.cos(pa) * north[1] + Math.sin(pa) * east[1], Math.cos(pa) * north[2] + Math.sin(pa) * east[2]];
    const minorSky: V3 = [-Math.sin(pa) * north[0] + Math.cos(pa) * east[0], -Math.sin(pa) * north[1] + Math.cos(pa) * east[1], -Math.sin(pa) * north[2] + Math.cos(pa) * east[2]];
    const inc = Math.acos(Math.max(0.15, Math.min(1, diamMinArcmin / diamArcmin)));
    const second: V3 = [Math.cos(inc) * minorSky[0] + Math.sin(inc) * n[0], Math.cos(inc) * minorSky[1] + Math.sin(inc) * n[1], Math.cos(inc) * minorSky[2] + Math.sin(inc) * n[2]];
    const normal = normalised(cross(major, second));
    const radiusPc = (g.diameterKpc * KPC) / 2;
    // An exponential disc whose isophotal radius is about three and a half scale lengths.
    const h = radiusPc / 3.5;
    for (let k = 0; k < style.points; k += 1) {
      let r = -h * (Math.log(Math.max(rand(), 1e-12)) + Math.log(Math.max(rand(), 1e-12)));
      if (r > radiusPc * 1.3) r = rand() * radiusPc;
      const t = rand() * 2 * Math.PI;
      const x = r * Math.cos(t);
      const y = r * Math.sin(t);
      const z = gauss() * style.thickness * h;
      for (let a = 0; a < 3; a += 1) discPoints.push((g.position[a] ?? 0) + x * (major[a] ?? 0) + y * (second[a] ?? 0) + z * (normal[a] ?? 0));
      discColours.push(style.colour[0] * style.light, style.colour[1] * style.light, style.colour[2] * style.light);
      discRadii.push(radiusPc * 0.02);
    }
  }
  const discs = cloud(new Float32Array(discPoints), new Float32Array(discColours), new Float32Array(discRadii), 10, 'explore-beyond-discs');

  for (const c of [milkyWay, glows, discs]) add(c.sprite);

  // The survey's galaxies, once the camera is far enough to need them.
  let web: ReturnType<typeof cloud> | null = null;
  let webAsked = false;
  const askWeb = (): void => {
    webAsked = true;
    void loadWeb()
      .then(({ manifest, data }) => {
        const count = Math.min(manifest.count, Math.floor(data.byteLength / 8), detail === 'full' ? manifest.count : 160_000);
        const view = new DataView(data);
        const pos = new Float32Array(count * 3);
        const colours = new Float32Array(count * 3);
        for (let i = 0; i < count; i += 1) {
          const o = i * 8;
          // The film's frame: x toward the centre, y to the galaxy's north pole, z toward longitude 270.
          const x = view.getInt16(o, true) * manifest.scaleMpc;
          const y = view.getInt16(o + 2, true) * manifest.scaleMpc;
          const z = view.getInt16(o + 4, true) * manifest.scaleMpc;
          toRender([x, -z, y], MPC, pos, i * 3);
          // The survey takes one galaxy in nine beyond its near part: those drawn brighter, to stand for the rest.
          const far = view.getInt16(o + 6, true) / manifest.redshiftScale >= manifest.nearLimit;
          colours.set(far ? [1.6, 1.5, 1.7] : [0.32, 0.33, 0.38], i * 3);
        }
        web = cloud(pos, colours, new Float32Array(count).fill(RADIUS.web), 6, 'explore-beyond-web', 0.3);
        web.sprite.visible = false;
        add(web.sprite);
      })
      .catch(() => {
        webAsked = false;
      });
  };

  // The Local Group seen across the line from the Milky Way to Andromeda, its two largest, from the side.
  const andromeda = galaxies.find((g) => g.name === 'Andromeda');
  const pair: V3 = andromeda ? [(centre[0] + andromeda.position[0]) / 2, (centre[1] + andromeda.position[1]) / 2, (centre[2] + andromeda.position[2]) / 2] : centre;
  const along = andromeda ? normalised([andromeda.position[0] - centre[0], andromeda.position[1] - centre[1], andromeda.position[2] - centre[2]]) : axes.x;
  const across = normalised([axes.z[0] - along[0] * dot3(axes.z, along), axes.z[1] - along[1] * dot3(axes.z, along), axes.z[2] - along[2] * dot3(axes.z, along)]);
  const places: BeyondPlace[] = [
    { id: 'centre', position: centre, arrivePc: 6000, from: null, galaxy: null },
    { id: 'milky-way', position: centre, arrivePc: 55_000, from: axes.z, galaxy: null },
    ...(['LMC', 'SMC', 'Andromeda', 'Triangulum'] as const).flatMap((name): BeyondPlace[] => {
      const g = galaxies.find((x) => x.name === name);
      if (!g) return [];
      const id = name === 'LMC' ? 'lmc' : name === 'SMC' ? 'smc' : name === 'Andromeda' ? 'andromeda' : 'triangulum';
      return [{ id, position: g.position, arrivePc: Math.max(4 * (g.diameterKpc ?? 5) * KPC, 8000), from: null, galaxy: g }];
    }),
    { id: 'local-group', position: pair, arrivePc: 1.6 * MPC, from: across, galaxy: null },
    // The survey from outside it, from the side: its fan of sky opening from the Milky Way.
    { id: 'web', position: [0, 0, 0], arrivePc: 7e9, from: axes.y, galaxy: null },
  ];

  // Names for the arms, at the middle of the azimuths their parallaxes trace.
  const armLabels = MILKY_WAY.arms
    .filter((a: SpiralArm) => a.id !== 'three-kpc')
    .map((a) => {
      const beta = (a.betaFromDeg + a.betaToDeg) / 2;
      const p = galactocentric(armRadius(a, beta), beta);
      const at = [0, 0, 0];
      toRender([p[0] + r0, p[1], p[2]], KPC, at, 0);
      return { id: a.id, at: at as V3 };
    });

  const fades = { galaxy: 0, web: 0, glows: 0 };

  return {
    galaxies,
    places,
    update(camera, fromSunPc, focalPx) {
      const shift = (s: Sprite): void => {
        s.position.set(-camera[0], -camera[1], -camera[2]);
      };
      fades.galaxy = smoothstep(FADE.galaxy[0], FADE.galaxy[1], fromSunPc);
      fades.web = smoothstep(FADE.web[0], FADE.web[1], fromSunPc);
      for (const c of [milkyWay, glows, discs, ...(web ? [web] : [])]) {
        shift(c.sprite);
        c.uFocal.value = focalPx;
      }
      milkyWay.uLight.value = LIGHT.galaxy * fades.galaxy;
      milkyWay.sprite.visible = fades.galaxy > 0.001;
      // The dwarf galaxies' glows come in past the stars near the Sun (as faint as they are, they would sit among the stars).
      fades.glows = smoothstep(FADE.glows[0], FADE.glows[1], fromSunPc);
      glows.uLight.value = LIGHT.glow * fades.glows;
      glows.sprite.visible = fades.glows > 0.001;
      discs.uLight.value = 1;
      if (web) {
        web.uLight.value = LIGHT.web * fades.web;
        web.sprite.visible = fades.web > 0.001;
      }
      if (!webAsked && fromSunPc > FADE.webLoad) askWeb();
    },
    starsShown: (fromSunPc) => 1 - smoothstep(FADE.stars[0], FADE.stars[1], fromSunPc),
    bandShown: (fromSunPc) => 1 - smoothstep(FADE.band[0], FADE.band[1], fromSunPc),
    scale: (fromSunPc) => (fromSunPc < 3000 ? 'stars' : fromSunPc < 300_000 ? 'galaxy' : fromSunPc < 2e7 ? 'local-group' : 'universe'),
    get webCount() {
      return web ? web.sprite.count : 0;
    },
    labels(out, camera, fromSunPc) {
      const rel = (p: V3): [number, number, number] => [p[0] - camera[0], p[1] - camera[1], p[2] - camera[2]];
      const dist = (p: V3): number => Math.hypot(p[0] - camera[0], p[1] - camera[1], p[2] - camera[2]);
      if (fades.galaxy > 0.3 && fromSunPc < LABELS.galaxy) {
        out.push({ id: 'beyond-centre', textKey: 'ui.universe.stars.beyond.centre', position: rel(centre), opacity: fades.galaxy });
        out.push({ id: 'beyond-sun', textKey: 'ui.universe.stars.beyond.sun', position: rel([0, 0, 0]), opacity: fades.galaxy });
        if (fromSunPc < LABELS.arms) for (const a of armLabels) out.push({ id: `beyond-arm-${a.id}`, textKey: `ui.universe.stars.beyond.arm.${a.id}`, position: rel(a.at), opacity: 0.8 * fades.galaxy });
      }
      if (fromSunPc >= LABELS.galaxy) out.push({ id: 'beyond-milky-way', textKey: 'ui.universe.stars.beyond.milkyWay', position: rel(centre), opacity: 0.9 });
      if (fromSunPc >= LABELS.universe) return;
      // Within the galaxy's scale, the galaxies largest on the screen; at the Local Group's, the most
      // luminous (at most ten), the four discs by their own names.
      // (At the Local Group's scale, the satellites close by the Milky Way or Andromeda would sit on their names.)
      const near = (g: LocalGalaxy): boolean => g.name !== 'Andromeda' && (Math.hypot(g.position[0] - centre[0], g.position[1] - centre[1], g.position[2] - centre[2]) < 150 * KPC || (andromeda !== undefined && Math.hypot(g.position[0] - andromeda.position[0], g.position[1] - andromeda.position[1], g.position[2] - andromeda.position[2]) < 150 * KPC));
      // (Among the stars, only the four seen there as discs: the dwarfs' glows are not drawn yet, and their names would read as constellations'.)
      const ranked = galaxies
        .map((g) => ({ g, seen: ((g.diameterKpc ?? (g.radiusKpc ?? 0.05) * 2) * KPC) / Math.max(dist(g.position), 1) }))
        .filter((x) => dist(x.g.position) > 1000 && (fromSunPc >= LABELS.galaxy ? x.g.absV !== null && !near(x.g) : x.seen > 0.004 && (DISCS[x.g.name] !== undefined || fades.glows > 0.3) && x.g.radiusKpc !== null))
        .sort((a, b) => (fromSunPc >= LABELS.galaxy ? (a.g.absV ?? 0) - (b.g.absV ?? 0) : b.seen - a.seen))
        .slice(0, 10);
      for (const { g } of ranked) {
        const own = DISCS[g.name] ? `ui.universe.stars.beyond.galaxy.${g.name}` : null;
        out.push({ id: `beyond-galaxy-${g.name}`, textKey: own ?? '', ...(own ? {} : { text: g.name }), position: rel(g.position), opacity: 0.85 });
      }
    },
    search(text) {
      const q = text.toLowerCase().replace(/[\s'’.-]/gu, '');
      if (q.length < 2) return [];
      const names: Record<string, string> = { Andromeda: 'andromedagalaxym31', Triangulum: 'triangulumgalaxym33', LMC: 'largemagellaniccloudlmc', SMC: 'smallmagellaniccloudsmc' };
      // The brightest first: Andromeda itself before its dwarf companions named after it.
      return galaxies
        .filter((g) => (names[g.name] ?? g.name.toLowerCase().replace(/[\s'’.-]/gu, '')).includes(q))
        .sort((a, b) => (a.absV ?? 0) - (b.absV ?? 0))
        .slice(0, 6);
    },
    dispose() {
      milkyWay.dispose();
      glows.dispose();
      discs.dispose();
      web?.dispose();
    },
  };
}
