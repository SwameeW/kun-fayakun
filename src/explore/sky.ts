import { AdditiveBlending, BufferAttribute, BufferGeometry, Group, InstancedBufferAttribute, LineBasicNodeMaterial, LineSegments, type Sprite, type Node } from 'three/webgpu';
import { attribute, cameraPosition, instancedBufferAttribute, uniform, vec3 } from 'three/tsl';
import { blackbodyRgb } from '../chapters/shared/blackbody';
import type { SceneLabel, SkyLayerName } from '../core/types';
import { starMaterial, starSprites } from './starlight';

/**
 * The real night sky behind the explorer (public/assets/sky/sky.json, from scripts/sky/build.py):
 * the Bright Star Catalogue's 9,096 naked-eye stars at their J2000 places, each in its colour (B-V,
 * through Ballesteros's temperature to a blackbody's colour) and brightness (its V magnitude), on a
 * sphere that moves with the camera, so they sit at infinity; and, when asked for, the constellation
 * figures, their boundaries, a grid of right ascension and declination with the celestial equator
 * and the ecliptic, and names (the IAU's for the brightest stars, and the constellations'; and with
 * the stars' names, the Andromeda Galaxy's, al-Sufi's "little cloud", at its place).
 *
 * Positions: right ascension and declination (ICRF) to the ecliptic of J2000 by the obliquity, then
 * to the render frame (x to the equinox, y to the ecliptic's north, z = -ecliptic y). Lines join
 * points on the sphere with straight chords, which from its centre are great circles; boundaries and
 * the grid follow small circles too, so they are drawn in steps of at most STEP_DEG.
 *
 * How bright a star is drawn is the explorer's star light (./starlight): its magnitude's light,
 * integrated over each pixel, the same at any pixel density, the brightest spreading into a halo.
 * On foot the walk holds their light in display terms (./walk/daylight footStarLight): short of white
 * by night, and on an airless world by day under the sunlit ground's glare; and, the exposure there far
 * above the orbit's, which stars are drawn is judged on the screen (./starlight StarScreen).
 */

export interface SkyFile {
  stars: Array<[number, number, number, number, number | null]>;
  names: Array<[number, string]>;
  constellations: Array<{ id: string; name: string; label: [number, number]; lines: Array<Array<[number, number]>>; bounds: Array<Array<[number, number]>> }>;
}

export const SKY_URL = 'assets/sky/sky.json';
export type SkyLayer = SkyLayerName;
export const SKY_LAYERS: readonly SkyLayer[] = ['constellations', 'boundaries', 'grid', 'names'];

export interface Sky {
  /** The stars: one draw call, the explorer's first of each frame (it reads the frame's target from it). */
  readonly object: Sprite;
  /** The figures, boundaries and grid. */
  readonly lines: Group;
  readonly count: number;
  /** The brightest star's magnitude (Sirius's, in the Bright Star Catalogue), for a hold on the light. */
  readonly brightest: number;
  setRadius(radius: number): void;
  /**
   * The stars' light (a multiple of the star light's) and, on foot, the exposure the screen puts on it
   * and a knee on the brightest (./starlight StarScreen): by default 1 and none, as in orbit.
   */
  setLight(light: number, exposure?: number, knee?: number): void;
  setLayer(layer: SkyLayer, on: boolean): void;
  readonly layers: Readonly<Record<SkyLayer, boolean>>;
  /** Eases the layers in and out (dt, s). */
  update(dt: number): void;
  /** Names on the sky (camera-relative render positions, at the sphere's radius), for the layers shown. */
  labels(out: SceneLabel[]): void;
  dispose(): void;
}

const DEG = Math.PI / 180;
/** Boundaries and the grid are drawn in steps no longer than this (degrees). */
const STEP_DEG = 2;
/** Stars brighter than this have their IAU name shown (with the names layer). */
const NAMED_BRIGHTER_THAN = 2.6;
/**
 * The Andromeda Galaxy (M 31), named with the stars: SIMBAD's ICRS position (2MASS; data/sources.json
 * "simbad-m31"), the "little cloud" Abd al-Rahman al-Sufi described in his Book of Fixed Stars (964).
 * Only named: its faint light is not among the Bright Star Catalogue's stars.
 */
export const LITTLE_CLOUD = { id: 'sky-m31', raDeg: 10.684708, decDeg: 41.26875 } as const;
/** Shares of a frame the layers ease by (a 1/60 s frame), and their colours (linear, faint). */
const EASE = 0.1;
const COLOURS: Readonly<Record<'constellations' | 'boundaries' | 'grid' | 'equator' | 'ecliptic', readonly [number, number, number]>> = {
  constellations: [0.32, 0.42, 0.62],
  boundaries: [0.22, 0.24, 0.32],
  grid: [0.14, 0.2, 0.3],
  equator: [0.2, 0.32, 0.5],
  ecliptic: [0.55, 0.42, 0.2],
};

/** A star's temperature from its B-V colour (Ballesteros 2012), kelvin. */
export const bvKelvin = (bv: number): number => 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));

/** A unit direction in the render frame from right ascension and declination (degrees, ICRF), by the obliquity of J2000 (radians). */
export function skyDirection(raDeg: number, decDeg: number, obliquity: number, out: number[] = [0, 0, 0]): number[] {
  const a = raDeg * DEG;
  const d = decDeg * DEG;
  const ex = Math.cos(d) * Math.cos(a);
  const ey = Math.cos(d) * Math.sin(a);
  const ez = Math.sin(d);
  // Equatorial to ecliptic (about x), then ecliptic (x, y, z) to render (x, z, -y).
  const ly = ey * Math.cos(obliquity) + ez * Math.sin(obliquity);
  const lz = -ey * Math.sin(obliquity) + ez * Math.cos(obliquity);
  out[0] = ex;
  out[1] = lz;
  out[2] = -ly;
  return out;
}

/** Points along a path in (RA, Dec), each step at most STEP_DEG, unwrapping RA across 0/360. */
function steps(path: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  path.forEach(([ra, dec], i) => {
    if (i === 0) {
      out.push([ra, dec]);
      return;
    }
    const [pra, pdec] = path[i - 1] ?? [ra, dec];
    let dra = ra - pra;
    if (dra > 180) dra -= 360;
    if (dra < -180) dra += 360;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dra) * Math.cos(((pdec + dec) / 2) * DEG), Math.abs(dec - pdec)) / STEP_DEG));
    for (let k = 1; k <= n; k += 1) out.push([pra + (dra * k) / n, pdec + ((dec - pdec) * k) / n]);
  });
  return out;
}

export function createSky(file: SkyFile, obliquity: number): Sky {
  const count = file.stars.length;
  // Each star's direction and its magnitude (w), and its colour.
  const directions = new Float32Array(count * 4);
  const colors = new Float32Array(count * 3);
  const dir = [0, 0, 0];
  let brightest = Number.POSITIVE_INFINITY;
  file.stars.forEach(([, ra, dec, v, bv], i) => {
    brightest = Math.min(brightest, v);
    skyDirection(ra, dec, obliquity, dir);
    directions.set([dir[0] ?? 0, dir[1] ?? 0, dir[2] ?? 0, v], i * 4);
    colors.set(blackbodyRgb(bv === null ? 6000 : bvKelvin(bv)), i * 3);
  });
  const uLight = uniform(1);
  const uExposure = uniform(1);
  const uKnee = uniform(0);
  const uRadius = uniform(400);
  const star = instancedBufferAttribute(new InstancedBufferAttribute(directions, 4)) as unknown as Node<'vec4'>;
  const color = instancedBufferAttribute(new InstancedBufferAttribute(colors, 3)) as unknown as Node<'vec3'>;
  // The stars are transparent, so they draw after every opaque body: a planet hides the stars behind it.
  const material = starMaterial(cameraPosition.add(star.xyz.mul(uRadius)), star.w, color, uLight, true, { exposure: uExposure, knee: uKnee });
  const stars = starSprites(material, count, 'explore-sky-stars');
  const geometry = stars.geometry;

  // Line layers: segments between unit directions, drawn just inside the stars' sphere.
  const group = new Group();
  group.name = 'explore-sky-lines';
  const fades: Record<SkyLayer, { value: number; target: number; uniforms: Array<{ value: number }> }> = {
    constellations: { value: 0, target: 0, uniforms: [] },
    boundaries: { value: 0, target: 0, uniforms: [] },
    grid: { value: 0, target: 0, uniforms: [] },
    names: { value: 0, target: 0, uniforms: [] },
  };
  const lineSet = (layer: SkyLayer, colour: readonly [number, number, number], paths: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, subdivide: boolean): void => {
    const points: number[] = [];
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    for (const path of paths) {
      const p = subdivide ? steps(path) : path.map(([ra, dec]) => [ra, dec] as [number, number]);
      for (let i = 1; i < p.length; i += 1) {
        const [ra0 = 0, dec0 = 0] = p[i - 1] ?? [];
        const [ra1 = 0, dec1 = 0] = p[i] ?? [];
        skyDirection(ra0, dec0, obliquity, a);
        skyDirection(ra1, dec1, obliquity, b);
        points.push(...a, ...b);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
    const fade = uniform(0);
    const m = new LineBasicNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: true, fog: false });
    const local = attribute('position', 'vec3') as unknown as Node<'vec3'>;
    m.positionNode = cameraPosition.add(local.mul(uRadius.mul(0.998)));
    m.colorNode = vec3(...colour).mul(fade).mul(uLight.max(0.6));
    const lines = new LineSegments(g, m);
    lines.frustumCulled = false;
    lines.visible = false;
    lines.name = `explore-sky-${layer}`;
    lines.renderOrder = -1;
    group.add(lines);
    fades[layer].uniforms.push(fade);
  };
  lineSet('constellations', COLOURS.constellations, file.constellations.flatMap((k) => k.lines), false);
  lineSet('boundaries', COLOURS.boundaries, file.constellations.flatMap((k) => k.bounds), true);
  // The grid: declination every 30 degrees, right ascension every 2 hours, the celestial equator, and the ecliptic (latitude 0, by the obliquity).
  const parallels = [-60, -30, 30, 60].map((dec) => Array.from({ length: 181 }, (_, i) => [i * 2, dec] as [number, number]));
  const meridians = Array.from({ length: 12 }, (_, h) => Array.from({ length: 91 }, (_, i) => [h * 30, -90 + i * 2] as [number, number]));
  lineSet('grid', COLOURS.grid, [...parallels, ...meridians], true);
  lineSet('grid', COLOURS.equator, [Array.from({ length: 181 }, (_, i) => [i * 2, 0] as [number, number])], true);
  const ecliptic = Array.from({ length: 181 }, (_, i) => {
    // The ecliptic's points in RA and Dec: longitude l on latitude 0.
    const l = i * 2 * DEG;
    const ra = Math.atan2(Math.sin(l) * Math.cos(obliquity), Math.cos(l)) / DEG;
    return [(ra + 360) % 360, Math.asin(Math.sin(obliquity) * Math.sin(l)) / DEG] as [number, number];
  });
  lineSet('grid', COLOURS.ecliptic, [ecliptic], true);

  // Names: the IAU's for the brightest named stars, and the constellations'.
  const magnitude = new Map(file.stars.map(([hr, ra, dec, v]) => [hr, { ra, dec, v }] as const));
  const starNames = file.names.flatMap(([hr, name]) => {
    const s = magnitude.get(hr);
    return s && s.v < NAMED_BRIGHTER_THAN ? [{ id: `sky-star-${hr}`, text: name, dir: skyDirection(s.ra, s.dec, obliquity) }] : [];
  });
  const constellationNames = file.constellations.map((k) => ({ id: `sky-con-${k.id}`, text: k.name, dir: skyDirection(k.label[0], k.label[1], obliquity) }));
  const littleCloud = skyDirection(LITTLE_CLOUD.raDeg, LITTLE_CLOUD.decDeg, obliquity);

  const layers: Record<SkyLayer, boolean> = { constellations: false, boundaries: false, grid: false, names: false };
  let radius = 400;
  return {
    object: stars,
    lines: group,
    count,
    brightest,
    setRadius(next) {
      radius = next;
      uRadius.value = next;
    },
    setLight(light, exposure = 1, knee = 0) {
      uLight.value = light;
      uExposure.value = exposure;
      uKnee.value = knee;
    },
    setLayer(layer, on) {
      layers[layer] = on;
      fades[layer].target = on ? 1 : 0;
    },
    layers,
    update(dt) {
      const k = 1 - (1 - EASE) ** (dt * 60);
      for (const layer of SKY_LAYERS) {
        const f = fades[layer];
        f.value += (f.target - f.value) * k;
        if (Math.abs(f.target - f.value) < 0.002) f.value = f.target;
        for (const u of f.uniforms) u.value = f.value;
      }
      group.children.forEach((child) => {
        const layer = child.name.replace('explore-sky-', '') as SkyLayer;
        child.visible = fades[layer].value > 0;
      });
    },
    labels(out) {
      const push = (list: typeof starNames, fade: number, kind: 'star' | 'constellation'): void => {
        if (fade <= 0.01) return;
        for (const n of list) {
          out.push({ id: n.id, textKey: kind === 'star' ? 'ui.universe.sky.star' : 'ui.universe.sky.constellation', text: n.text, position: [(n.dir[0] ?? 0) * radius, (n.dir[1] ?? 0) * radius, (n.dir[2] ?? 0) * radius], opacity: 0.85 * fade });
        }
      };
      push(starNames, fades.names.value, 'star');
      push(constellationNames, fades.constellations.value, 'constellation');
      if (fades.names.value > 0.01) {
        out.push({ id: LITTLE_CLOUD.id, textKey: 'ui.universe.sky.littleCloud', position: [(littleCloud[0] ?? 0) * radius, (littleCloud[1] ?? 0) * radius, (littleCloud[2] ?? 0) * radius], opacity: 0.85 * fades.names.value });
      }
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      for (const child of group.children) {
        const l = child as LineSegments;
        l.geometry.dispose();
        (l.material as LineBasicNodeMaterial).dispose();
      }
    },
  };
}
