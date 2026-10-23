/**
 * The Sun's disc, for the explorer. Seen small it is a brilliant white point that the glare
 * (./glare) surrounds; seen large it is shown as through a solar filter, the way the Sun is
 * photographed: amber, its limb darkened by the measured law (quadratic in mu, Allen's Astrophysical
 * Quantities at 550 nm, from data/constants.json) and reddened (there we see higher, cooler layers),
 * mottled by supergranulation and, closer, by the granulation's cells (bright upwelling cells and
 * dark lanes, each scale fading in only once it spans a few pixels), with bright faculae toward the
 * limb and a crisp edge. The mottling is illustrative; its scales and the limb darkening are the
 * real Sun's. The colour is the blackbody colour of its temperature, never picked by eye.
 *
 * With 'full' Sun detail, the limb carries more (one sprite behind the disc): the chromosphere's thin
 * red rim, prominences (flames and arches of cooler gas in the colour of hydrogen-alpha light, rising
 * from a few active regions and slowly changing), and a layered corona (a steep inner glow and fainter
 * streamers reaching out radially). All three are anchored to the Sun, not the screen, so turning
 * around it brings other prominences to the limb. Their shapes are illustrative; the real corona is
 * about a millionth of the disc's brightness and is drawn brighter, as in eclipse photographs.
 *
 * Flash safety: nothing here changes faster than slow drifts, and the disc's radiance has a ceiling in
 * display terms, so however the exposure and the filter move it never exceeds a fixed brightness.
 */

import { BackSide, FrontSide, Group, Matrix4, Mesh, MeshBasicNodeMaterial, Quaternion, SphereGeometry, Vector3, Vector4, type Data3DTexture, type Object3D } from 'three/webgpu';
import { abs, dot, exp, float, Fn, If, max, min, mix, mx_worley_noise_float, normalize, normalView, positionLocal, positionViewDirection, pow, smoothstep, texture3D, uniform, vec2, vec3 } from 'three/tsl';
import { blackbodyRgb } from '../../chapters/shared/blackbody';
import type { ExploreDetail } from '../detail';
import { blendAdditive } from '../render/blending';
import type { FloatNode, Vec3Node } from '../render/sampling';
import { keepOnSphere, noiseIfKept, sphereFootprint } from './shading';

/** The limb's light comes from layers about this much cooler (its reddening): illustrative. */
const LIMB_COOLING = 0.66;
/** The disc's brightest, display terms (after the exposure): the radiance ceiling. */
const SUN_CEILING = 6;
/** The limb sprite reaches this many solar radii from the centre. */
const HALO_EXTENT = 3.2;
/** The mean of 1 - |2 noise - 1| over the explorer's noise volume (measured: 0.676 per texel, a little more filtered). */
const RIDGE_MEAN = 0.68;
/** Loop prominences drawn at once (the ones whose footpoints are nearest the limb). */
const LOOP_SLOTS = 4;
/** Granulation cells per unit of the unit sphere (granules are about 1,000 km across, the Sun 696,000 km in radius), and supergranulation. */
const GRANULES = 650;
const SUPERGRANULES = 22;

/**
 * Loop prominences (illustrative): footpoint directions on the Sun, the arch's radius and thickness
 * (solar radii) and brightness, from a fixed seed so every visit shows the same Sun.
 */
const LOOPS = ((): ReadonlyArray<{ direction: [number, number, number]; radius: number; width: number; strength: number; seed: number }> => {
  let s = 0x5eed1234;
  const random = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: 14 }, () => {
    // Active latitudes: within about 35 degrees of the equator, as sunspots and their prominences are.
    const lat = (random() * 2 - 1) * 0.6;
    const lon = random() * Math.PI * 2;
    return {
      direction: [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)],
      radius: 0.03 + random() * 0.06,
      width: 0.005 + random() * 0.006,
      strength: 0.8 + random() * 0.8,
      seed: random() * 10,
    };
  });
})();

const smoothstepJs = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface SunLimb {
  /** I(mu) / I(1) = a0 + a1 mu + a2 mu^2. */
  a1: number;
  a2: number;
}

export interface SunFrame {
  time: number;
  kelvin: number;
  /** The disc's brightness (scene units). */
  light: number;
  /** The exposure the picture is shown at (the ceiling is held in display terms). */
  exposure: number;
  /** The filter's colour (white for none), and how far it is on (0 to 1). */
  filter: readonly [number, number, number];
  filtered: number;
  /** The disc's radius on screen, CSS px. */
  radiusPx: number;
  /** The camera's right and up (render frame, unit), for the limb sprite. */
  right: Vector3;
  up: Vector3;
}

export interface ExploreSun {
  readonly object: Group;
  update(frame: SunFrame): void;
  prepare(detail: ExploreDetail): Object3D[];
  apply(detail: ExploreDetail): void;
  dispose(): void;
}

export function createSun(noise: Data3DTexture, limb: SunLimb, initial: ExploreDetail): ExploreSun {
  const object = new Group();
  object.name = 'explore-sun';
  const uTime = uniform(0);
  const uLight = uniform(1);
  const uCeiling = uniform(SUN_CEILING);
  const uCentre = uniform(new Vector3(1, 1, 1));
  const uLimb = uniform(new Vector3(1, 0.7, 0.4));
  const uFilter = uniform(new Vector3(1, 1, 1));
  const uFiltered = uniform(0);
  const uRight = uniform(new Vector3(1, 0, 0));
  const uUp = uniform(new Vector3(0, 1, 0));
  const uEye = uniform(new Vector3(0, 0, 4));
  /** The loop prominences shown now: footpoint (Sun's frame) and shape (radius, width, strength, seed). */
  const uLoops = Array.from({ length: LOOP_SLOTS }, () => ({ foot: uniform(new Vector3(1, 0, 0)), shape: uniform(new Vector4(0.05, 0.01, 0, 0)) }));
  const T = (p: Vec3Node): FloatNode => texture3D(noise, p).r;
  const a0 = 1 - limb.a1 - limb.a2;

  const buildDisc = (detail: ExploreDetail): MeshBasicNodeMaterial => {
    const n = normalize(positionLocal);
    const footprint = sphereFootprint(n);
    const mu = abs(dot(normalView, positionViewDirection));
    const darkening = float(a0).add(mu.mul(limb.a1)).add(mu.mul(mu).mul(limb.a2));
    // Large, slow cells (the chapters' boiling), then supergranulation, then granulation as the disc grows.
    const cells = T(n.mul(2.2).add(vec3(uTime.mul(0.006), 0.31, uTime.mul(-0.004)))).sub(0.5);
    const network = T(n.mul(7).add(vec3(uTime.mul(0.002), 0.81, 0))).sub(0.5).mul(keepOnSphere(footprint, 56));
    const superKept = keepOnSphere(footprint, SUPERGRANULES * 2);
    const granKept = keepOnSphere(footprint, GRANULES * 2);
    // Cellular patterns: bright cell centres, dark lanes (worley F1), skipped where they would be under a pixel.
    const cellular = (scale: number, kept: FloatNode, drift: number): FloatNode =>
      Fn(() => {
        const value = float(0).toVar();
        If(kept.greaterThan(1e-3), () => {
          const f1 = mx_worley_noise_float(n.mul(scale).add(vec3(uTime.mul(drift), 0.37, uTime.mul(drift * 0.7))), 0.9);
          // Less F1's mean distance (0.517 for this jitter, sampled), so its fade never shifts the brightness.
          value.assign(float(0.517).sub(f1).mul(kept));
        });
        return value;
      })();
    const full = detail.sunDetail === 'full';
    // Supergranulation: a ridged noise (cell-like, one lookup) at every detail; true cells (worley)
    // only for the granulation, which needs them and shows only very close up.
    const ridge = float(1).sub(noiseIfKept(noise, n.mul(SUPERGRANULES / 4).add(vec3(uTime.mul(0.0008), 0.37, 0)), superKept).mul(2).sub(1).abs());
    // Less its mean over the volume (0.68), so fading it in by the pixel's footprint never shifts the brightness.
    const supergranules = ridge.sub(RIDGE_MEAN).mul(superKept);
    const granules = full ? cellular(GRANULES, granKept, 0.004) : float(0);
    const fine = detail.tier === 'low' ? float(0) : noiseIfKept(noise, n.mul(40).add(vec3(0, uTime.mul(0.01), 0.27)), keepOnSphere(footprint, 320)).sub(0.5).mul(keepOnSphere(footprint, 320));
    const mottle = cells.mul(0.12).add(network.mul(0.2)).add(supergranules.mul(0.18)).add(granules.mul(0.34)).add(fine.mul(0.12)).add(1);
    // Faculae: bright patches of the network, seen best toward the limb.
    const faculae = smoothstep(0.1, 0.28, network).mul(float(1).sub(smoothstep(0.06, 0.45, mu))).mul(0.5);
    const tint = mix(uLimb, uCentre, pow(mu, 0.45));
    const disc: Vec3Node = tint.mul(darkening).mul(mottle.add(faculae)).mul(uFilter).mul(uLight);
    const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
    material.colorNode = min(disc, vec3(uCeiling, uCeiling, uCeiling));
    return material;
  };

  /**
   * The limb: chromosphere, prominences and corona, on a shell around the Sun drawn from inside (back
   * faces), so the disc hides what lies behind it. Each pixel's ray is followed to its closest
   * approach to the Sun's centre: its distance there in solar radii is the height above the limb
   * (exact in any perspective), its direction anchors the pattern to the Sun.
   */
  const buildHalo = (): MeshBasicNodeMaterial => {
    const material = blendAdditive(new MeshBasicNodeMaterial({ side: BackSide, transparent: true, depthWrite: false, fog: false }));
    const ray = normalize(positionLocal.sub(uEye));
    const along = dot(uEye, ray).negate();
    const ahead = smoothstep(0, 0.05, along);
    const q = uEye.add(ray.mul(max(along, 0)));
    const r = q.length().max(1e-4);
    const h = r.sub(1);
    const d = q.div(r);
    // Coordinates in the plane of the sky, solar radii (for arches standing on the limb).
    const c = vec2(dot(q, uRight), dot(q, uUp));
    const above = smoothstep(-0.004, 0.004, h).mul(ahead);
    // Lookups that may sit in a branch name their level (the volume has one).
    const TL = (p: Vec3Node): FloatNode => texture3D(noise, p).level(float(0)).r;
    // The limb's detail only where the ray passes within a third of a radius of the photosphere.
    const near = Fn(() => {
      const value = vec2(0, 0).toVar();
      If(h.lessThan(0.34).and(above.greaterThan(1e-4)), () => {
        // Chromosphere: a thin red rim just above the photosphere, its top ragged with spicules.
        const spicules = TL(d.mul(90).add(vec3(0.19, uTime.mul(0.01), 0.61))).mul(0.6).add(0.7);
        const chromosphere = exp(max(h, 0).div(spicules.mul(-0.01))).mul(0.6);
        // Hedgerow prominences: soft flames in a few active regions, their height and shape from slow noise.
        const regions = smoothstep(0.6, 0.72, TL(d.mul(1.3).add(0.21)));
        const flame = TL(vec3(d.mul(7)).add(vec3(h.mul(3.5), uTime.mul(0.002), h.mul(-2.5))).add(0.47));
        const hedge = smoothstep(0.02, 0.07, flame.mul(0.11).sub(h)).mul(smoothstep(-0.002, 0.008, h)).mul(regions);
        // Loop prominences: arches standing on the limb over footpoints fixed on the Sun; the CPU picks
        // the few whose footpoints are near the limb now (uLoops).
        let loops: FloatNode = float(0);
        for (const slot of uLoops) {
          const sky = vec2(dot(slot.foot, uRight), dot(slot.foot, uUp));
          const base = sky.div(sky.length().max(1e-4));
          const fromBase = c.sub(base);
          // Wavy, so no arch is a perfect circle.
          const wobble = TL(vec3(fromBase.mul(9), uTime.mul(0.003)).add(slot.shape.w)).sub(0.5).mul(slot.shape.x.mul(0.35));
          const offset = fromBase.length().sub(wobble.add(slot.shape.x)).div(slot.shape.y);
          loops = loops.add(exp(offset.mul(offset).negate()).mul(slot.shape.z));
        }
        value.assign(vec2(chromosphere, hedge.add(loops).mul(exp(max(h, 0).div(-0.12)))));
      });
      return value;
    })();
    const chromosphere = near.x.mul(above);
    const prominences = near.y.mul(above);
    // Corona: a steep inner glow and fainter radial streamers (sampled by direction only: they run outward).
    const streamers = texture3D(noise, d.mul(3.4).add(0.63)).level(float(0)).r.mul(0.6).add(texture3D(noise, d.mul(11).add(0.17)).level(float(0)).r.mul(0.4));
    const inner = pow(max(r, 1), -7).mul(0.28);
    const outer = pow(max(r, 1), -2.6).mul(0.06).mul(smoothstep(0.35, 0.8, streamers).mul(1.6).add(0.2));
    const fadeOut = float(1).sub(smoothstep(HALO_EXTENT * 0.6, HALO_EXTENT * 0.95, r));
    const corona = inner.add(outer).mul(above).mul(fadeOut);
    const hAlpha = vec3(1, 0.32, 0.16);
    // Through the filter the prominences and rim stand out; unfiltered, the pearly corona does.
    const filteredLight = hAlpha.mul(chromosphere.add(prominences.mul(0.9))).mul(uFiltered.mul(0.7).add(0.3));
    const coronaLight = vec3(1, 0.95, 0.88).mul(corona).mul(float(1).sub(uFiltered.mul(0.8)));
    const colour = filteredLight.add(coronaLight).mul(uFilter).mul(uLight);
    material.colorNode = min(colour, vec3(uCeiling, uCeiling, uCeiling));
    material.opacityNode = float(1);
    return material;
  };

  const discs = new Map<string, MeshBasicNodeMaterial>();
  const discFor = (d: ExploreDetail): MeshBasicNodeMaterial => {
    const key = `${d.sunDetail}|${d.tier === 'low'}`;
    let m = discs.get(key);
    if (!m) {
      m = buildDisc(d);
      discs.set(key, m);
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
  const sunSegments = (d: ExploreDetail): number => Math.min(128, d.sphereSegments);
  const mesh = new Mesh(sphere(sunSegments(initial)), discFor(initial));
  mesh.name = 'explore-sun-disc';
  object.add(mesh);
  const haloMaterial = buildHalo();
  const haloGeometry = new SphereGeometry(HALO_EXTENT, 48, 24);
  const halo = new Mesh(haloGeometry, haloMaterial);
  halo.renderOrder = 1;
  halo.name = 'explore-sun-limb';
  halo.visible = initial.sunDetail === 'full';
  object.add(halo);
  let full = initial.sunDetail === 'full';
  let kelvin = 0;
  const inverse = new Quaternion();
  const toLocal = new Matrix4();
  const toward = new Vector3();

  return {
    object,
    update(frame) {
      uTime.value = frame.time;
      uLight.value = frame.light;
      uCeiling.value = SUN_CEILING / Math.max(frame.exposure, 1e-6);
      uFilter.value.set(frame.filter[0], frame.filter[1], frame.filter[2]);
      uFiltered.value = frame.filtered;
      if (frame.kelvin !== kelvin) {
        kelvin = frame.kelvin;
        const centre = blackbodyRgb(kelvin);
        const limbColour = blackbodyRgb(kelvin * LIMB_COOLING);
        uCentre.value.set(centre[0], centre[1], centre[2]);
        uLimb.value.set(limbColour[0], limbColour[1], limbColour[2]);
      }
      // The eye and the camera's axes in the Sun's own frame (radii).
      toLocal.copy(object.matrixWorld).invert();
      uEye.value.set(0, 0, 0).applyMatrix4(toLocal);
      inverse.copy(object.quaternion).invert();
      uRight.value.copy(frame.right).applyQuaternion(inverse);
      uUp.value.copy(frame.up).applyQuaternion(inverse);
      // The loops whose footpoints lie near the limb as seen now, strongest there.
      toward.crossVectors(uRight.value, uUp.value).normalize();
      const ranked = LOOPS.map((loop) => {
        const depth = Math.abs(loop.direction[0] * toward.x + loop.direction[1] * toward.y + loop.direction[2] * toward.z);
        return { loop, weight: 1 - smoothstepJs(0.1, 0.6, depth) };
      }).sort((a, b) => b.weight - a.weight);
      uLoops.forEach((slot, i) => {
        const pick = ranked[i];
        if (!pick) return;
        slot.foot.value.set(...pick.loop.direction);
        slot.shape.value.set(pick.loop.radius, pick.loop.width, pick.loop.strength * pick.weight, pick.loop.seed);
      });
      // The limb's detail only once the disc is large enough to show it (under a few px it is glare).
      halo.visible = full && frame.radiusPx > 6;
      object.visible = frame.light > 1e-4;
    },
    prepare(detail) {
      const out: Object3D[] = [];
      const m = discFor(detail);
      if (mesh.material !== m) {
        const warm = new Mesh(sphere(sunSegments(detail)), m);
        warm.frustumCulled = false;
        out.push(warm);
      }
      return out;
    },
    apply(detail) {
      mesh.material = discFor(detail);
      mesh.geometry = sphere(sunSegments(detail));
      full = detail.sunDetail === 'full';
      if (!full) halo.visible = false;
    },
    dispose() {
      for (const g of geometries.values()) g.dispose();
      for (const m of discs.values()) m.dispose();
      haloGeometry.dispose();
      haloMaterial.dispose();
    },
  };
}
