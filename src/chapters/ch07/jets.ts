import {
  AdditiveBlending,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Vector3,
  type Data3DTexture,
  type Node,
  type PerspectiveCamera,
} from 'three/webgpu';
import { abs, cross, exp, float, floor, fract, hash, length, max, min, mix, normalize, select, smoothstep, texture3D, uniform, uv, varying, vec2, vec3 } from 'three/tsl';
import type { QualityTier } from '../../core/types';

/**
 * The newborn Sun's jets: while a young star still gathers gas from its disk it drives two narrow,
 * collimated jets out along its poles, at a few hundred kilometres a second. The jet comes in
 * bursts, so where faster gas runs into slower it is shocked and glows in a chain of knots, each a
 * small bow moving outward, and where the jet ploughs into the cloud around it, a larger bow-shaped
 * front (Herbig-Haro objects: Reipurth & Bally 2001, ARA&A 39, 403; HH 211 seen by JWST, Ray et al.
 * 2023, Nature 622, 48). Shock-lit gas glows red, in hydrogen-alpha and ionised sulphur: the knots
 * and the bow's apex, the stronger shocks, pinker (more hydrogen), the beam and the bow's wings
 * deeper red. The star's light also escapes through cavities the outflow has cleared in the dust
 * above and below the disk, lighting their walls (the hourglass of L1527, JWST 2022), here in the
 * disk's own warm colour. Below the disk the counter-jet and its cavity are seen through the dust,
 * so their bases are hidden, as the disk hides HH 30's (Burrows et al. 1996, ApJ 473, 437).
 *
 * An illustration, tagged as one: real jets reach light-years, far beyond their disk; these are
 * shorter than the disk is wide, and their knots move far faster than real ones. They shine by
 * their own shocks, not by the star's light, so they never brighten with the Sun's ignition (the
 * scene fades them as it shines), and they stay below the bloom threshold, so nothing here blooms.
 *
 * Each jet and its cavity are one ribbon along the axis turned to face the camera, the knots, bow
 * and walls drawn in the fragment stage from the jets' own clock (half speed under reduced motion).
 * Low draws the same without the filaments' and wisps' noise, on coarser ribbons.
 */

/** The beam: half-width at the base and how it widens per unit (needle-thin), and where it comes up to full light from its base. */
const BEAM = { width: 0.03, opening: 0.02, rise: 0.45, decay: 7, light: 0.24 } as const;
/**
 * The knots: their speed along the jet (scene units per chapter second), the mean time between
 * bursts (s), their length along the jet, how much wider than the beam they are, the curvature of
 * their small bows (radius, units) and their light.
 */
const KNOT = { speed: 0.42, period: 2.1, length: 0.07, widen: 1.8, bow: 0.3, light: 0.8 } as const;
/** The bow shock at each jet's end: radius of curvature at its apex, thickness, extent of its wings, the apex's width, the glow behind it, and its light. */
const BOW = { curvature: 0.3, thickness: 0.04, extent: 0.42, apex: 0.2, wake: 0.3, light: 0.55, fill: 0.12 } as const;
/** Each jet's length to its bow's apex (units from the star's centre), how fast the bow advances (units per second), and the lower one's light. */
const LENGTH = { upper: 5.4, lower: 3, growth: 0.02, lowerLight: 0.75 } as const;
/**
 * The cavities: where they leave the disk and their height (units from the star); their walls' flare
 * (radius = width * height^exponent), thickness and its growth, the faint glow inside, the scattered
 * light's fall-off, and their light.
 */
const CAVITY = { from: 0.3, height: 4.5, width: 1, exponent: 0.5, thickness: 0.1, thicken: 0.08, inside: 0.22, falloff: 1.4, light: 0.3 } as const;
/** The ribbons' half-width (they hold the bows' wings and the cavities' walls). */
const RIBBON = 2.4;
/** How much of what lies behind the disk shows through it: little through its inner part, more toward its edge (its outer radius 8.6). */
const DISK = { through: 0.08, inner: 3, outer: 8.6 } as const;
/** Linear colours: shock-lit gas, the stronger shocks pinker; the young star's light scattered off the cavity walls (the disk's warm colour). */
const COLOUR = { red: [1, 0.12, 0.1], pink: [1, 0.3, 0.28], cavity: [1, 0.72, 0.45] } as const;
/** The brightest any jet pixel gets (its colour's luminance times this stays under the bloom threshold, 0.75 in src/core/post.ts). */
export const JET_PEAK = 1.1;
/** And a cavity's (both its walls together). */
export const CAVITY_PEAK = 0.25;
/** The knots' pace under reduced motion. */
export const REDUCED_MOTION_RATE = 0.5;
/** Seconds over which the jets fade once the Sun begins to shine. */
export const FADE_SECONDS = 18;
/** The colours above, for the tests. */
export const JETS_COLOURS = COLOUR;
export const JETS_TAG_KEY = 'ch07.hud.jets';

const smootherstep = (edge0: number, edge1: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return u * u * u * (u * (u * 6 - 15) + 10);
};

/** The jets' light at chapter time t: whole until the Sun begins to shine (`ignite`), then gone over FADE_SECONDS; it never rises with the Sun. */
export function jetLight(t: number, ignite: number): number {
  return 1 - smootherstep(ignite, ignite + FADE_SECONDS, t);
}

/** The jets' own clock (the knots' and bows' motion): chapter time, at half pace under reduced motion. */
export function jetClock(t: number, reducedMotion: boolean): number {
  return t * (reducedMotion ? REDUCED_MOTION_RATE : 1);
}

/** How much of a point behind the disk shows through it, by the radius where the line of sight crosses the disk's plane. */
export function diskTransmission(radius: number): number {
  const u = Math.min(1, Math.max(0, (radius - DISK.inner) / (DISK.outer - DISK.inner)));
  return DISK.through + (1 - DISK.through) * u * u * (3 - 2 * u);
}

export interface JetsFrame {
  /** Chapter time, s. */
  time: number;
  /** 0 to 1: the scene's fade (jetLight with the disk's fade-in). */
  light: number;
  reducedMotion: boolean;
  camera: PerspectiveCamera;
}

export interface Jets {
  /** Centred on the star, its axis the jets'; place it where the star is. */
  readonly object: Group;
  update(frame: JetsFrame): void;
  setQuality(tier: QualityTier): void;
  /**
   * Where the tag goes (world space, into `out`) for a view `widthPx` by `heightPx` CSS px, and how
   * much it shows: beside the upper jet where there is room, otherwise above it, from the view's
   * left edge, so its words are never cut off.
   */
  tag(camera: PerspectiveCamera, widthPx: number, heightPx: number, out: Vector3): number;
  dispose(): void;
}

type Detail = 'full' | 'plain';

export function createJets(noise: Data3DTexture, starRadius: number, tier: QualityTier): Jets {
  const object = new Group();
  object.name = 'ch07-jets';
  const uLight = uniform(0);
  const uClock = uniform(0);
  /** The camera in the jets' frame. */
  const uEye = uniform(new Vector3(0, 7, 14));
  /** 1 while the jets are seen from the side; they go as the view turns to look along them (the ribbons would show edge on). */
  const uSideOn = uniform(1);
  let light = 0;
  let clock = 0;

  /** How much of what is at p shows past the disk: all of it on the camera's side, little through its inner part. */
  const throughDisk = (p: Node<'vec3'>): Node<'float'> => {
    const f = p.y.div(p.y.sub(uEye.y));
    const crossing = p.add(uEye.sub(p).mul(f));
    const radius = length(vec2(crossing.x, crossing.z));
    const seen = mix(float(DISK.through), float(1), smoothstep(DISK.inner, DISK.outer, radius));
    return select(p.y.mul(uEye.y).lessThan(0), seen, float(1));
  };

  const ribbonMaterial = (direction: 1 | -1, detail: Detail, uTip: Node<'float'>, gain: number, seed: number): MeshBasicNodeMaterial => {
    const material = new MeshBasicNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, fog: false });
    // Added light, so the order of its faces does not matter: one pass, not one per side.
    material.forceSinglePass = true;
    const coord = uv();
    // Distance from the star along the axis, and across the ribbon (units).
    const s = mix(float(starRadius), uTip.add(0.25), coord.y);
    const x = coord.x.sub(0.5).mul(2 * RIBBON);
    // The ribbon turned about its axis to face the camera.
    const axis = vec3(0, direction, 0);
    const onAxis = axis.mul(s);
    const side = normalize(cross(axis, uEye.sub(onAxis)).add(vec3(1e-5, 0, 0)));
    const placed = onAxis.add(side.mul(x));
    material.positionNode = placed;
    const full = detail === 'full';

    // The beam: needle-thin, widening a little, up to full light just off the star, dimming as it goes, into the bow.
    const width = float(BEAM.width).add(s.mul(BEAM.opening));
    const xb = x.div(width);
    const beam = exp(xb.mul(xb).negate());
    const along = smoothstep(starRadius, starRadius + BEAM.rise, s)
      .mul(exp(s.div(-BEAM.decay)))
      .mul(float(1).sub(smoothstep(uTip.sub(0.7), uTip.sub(0.1), s)));
    // The knots: gas from one burst, carried out at the jet's speed; each a small bow, its wings trailing.
    const xk = x.div(width.mul(KNOT.widen));
    const bent = s.add(x.mul(x).div(2 * KNOT.bow));
    const burst = uClock.add(1000).sub(bent.div(KNOT.speed)).div(KNOT.period);
    const index = floor(burst);
    const centre = hash(index.add(seed)).mul(0.3).add(0.35);
    const strength = hash(index.add(seed + 977)).mul(0.55).add(0.45);
    const dp = fract(burst).sub(centre).div(KNOT.length / (KNOT.speed * KNOT.period));
    const knot = strength.mul(exp(dp.mul(dp).negate())).mul(exp(xk.mul(xk).negate()));
    // Filaments in the flowing gas (not on Low).
    const filament = full ? texture3D(noise, vec3(x.mul(5), s.sub(uClock.mul(KNOT.speed)).mul(1.2), seed * 0.013 + 0.31)).r.mul(1.1).add(0.45) : float(1);
    // The bow shock at the end: its surface a parabola about the apex, the swept-up gas glowing behind it.
    const surface = uTip.sub(x.mul(x).div(2 * BOW.curvature));
    const ds = s.sub(surface).div(BOW.thickness);
    const wings = exp(x.mul(x).div(-(BOW.extent * BOW.extent)));
    const apex = exp(x.mul(x).div(-(BOW.apex * BOW.apex)));
    const behind = max(surface.sub(s), 0).div(BOW.wake);
    const wake = exp(behind.mul(behind).negate()).mul(float(1).sub(smoothstep(surface.sub(BOW.thickness), surface, s))).mul(BOW.fill);
    const bow = exp(ds.mul(ds).negate()).add(wake).mul(wings).mul(apex.mul(0.5).add(0.5));
    const shine = along.mul(beam.mul(BEAM.light).add(knot.mul(KNOT.light))).mul(filament).add(bow.mul(BOW.light));
    // The stronger shocks (knots, the bow's apex) pinker, the rest deeper red.
    const jetColour = mix(vec3(...COLOUR.red), vec3(...COLOUR.pink), min(knot.add(apex.mul(bow)), 1));

    // The cavity: its walls flaring from the star, seen from the side. Light through a wall goes as the
    // path through it, most along its edge as seen; inside, the far and near walls glow faintly. The
    // starlight they scatter falls off with distance from the star.
    const wall = float(CAVITY.width).mul(max(s, CAVITY.from).pow(CAVITY.exponent));
    const thickness = float(CAVITY.thickness).add(s.mul(CAVITY.thicken));
    const off = abs(x).sub(wall).div(thickness);
    const walls = exp(off.mul(off).negate()).add(float(1).sub(smoothstep(-1, 1, off)).mul(CAVITY.inside));
    const r2 = s.mul(s).add(x.mul(x)).div(CAVITY.falloff * CAVITY.falloff);
    const span = smoothstep(CAVITY.from, CAVITY.from + 0.5, s).mul(float(1).sub(smoothstep(CAVITY.height * 0.4, CAVITY.height, s)));
    // Wisps in the lit dust (not on Low).
    const wisps = full ? texture3D(noise, vec3(x.mul(0.9), s.mul(0.6), seed * 0.017 + 0.57)).r.mul(1.3).add(0.35) : float(1);
    const lit = walls.mul(span).mul(wisps).div(r2.add(1)).mul(CAVITY.light);

    const seen = throughDisk(varying(placed));
    const jets = jetColour.mul(min(shine.mul(gain), JET_PEAK));
    const cavity = vec3(...COLOUR.cavity).mul(min(lit, CAVITY_PEAK));
    material.colorNode = jets.add(cavity).mul(seen).mul(uLight).mul(uSideOn);
    material.opacityNode = float(1);
    return material;
  };

  const uTips = { upper: uniform(LENGTH.upper), lower: uniform(LENGTH.lower) };
  let built: { detail: Detail; meshes: Mesh[]; dispose(): void } | null = null;
  const build = (detail: Detail): void => {
    if (built?.detail === detail) return;
    if (built) {
      object.remove(...built.meshes);
      built.dispose();
    }
    // The ribbon bends a little as it turns along its length (finer on High and Mid).
    const ribbon = new PlaneGeometry(1, 1, 1, detail === 'full' ? 24 : 8);
    ribbon.translate(0.5, 0.5, 0);
    const materials = [ribbonMaterial(1, detail, uTips.upper, 1, 11), ribbonMaterial(-1, detail, uTips.lower, LENGTH.lowerLight, 53)];
    const meshes = materials.map((material, i) => {
      const mesh = new Mesh(ribbon, material);
      mesh.frustumCulled = false;
      mesh.name = i === 0 ? 'ch07-jet-upper' : 'ch07-jet-lower';
      return mesh;
    });
    object.add(...meshes);
    built = {
      detail,
      meshes,
      dispose() {
        ribbon.dispose();
        for (const m of materials) m.dispose();
      },
    };
  };
  build(tier === 'low' ? 'plain' : 'full');

  const inverse = new Matrix4();
  const anchor = new Vector3();
  const ndc = new Vector3();

  return {
    object,
    update(frame) {
      light = Math.min(1, Math.max(0, frame.light));
      clock = jetClock(frame.time, frame.reducedMotion);
      uLight.value = light;
      uClock.value = clock;
      uTips.upper.value = LENGTH.upper + LENGTH.growth * clock;
      uTips.lower.value = LENGTH.lower + LENGTH.growth * clock;
      object.visible = light > 1e-3;
      if (!object.visible) return;
      object.updateWorldMatrix(true, false);
      inverse.copy(object.matrixWorld).invert();
      uEye.value.copy(frame.camera.position).applyMatrix4(inverse);
      const along = Math.abs(uEye.value.y) / Math.max(uEye.value.length(), 1e-9);
      uSideOn.value = 1 - smootherstep(0.9, 0.98, along);
    },
    setQuality(next) {
      build(next === 'low' ? 'plain' : 'full');
    },
    tag(camera, widthPx, heightPx, out) {
      const opacity = smootherstep(0.05, 0.25, light) * uSideOn.value;
      if (opacity <= 0 || widthPx <= 0 || heightPx <= 0) return 0;
      // Beside the upper jet, a little over halfway up, where the view leaves room on its right.
      object.localToWorld(anchor.set(0, 0.55 * uTips.upper.value, 0));
      ndc.copy(anchor).project(camera);
      const x = ((ndc.x + 1) / 2) * widthPx;
      if (widthPx - x >= 380) {
        out.copy(anchor);
        return opacity;
      }
      // Otherwise above the jet's end, from the view's left edge.
      object.localToWorld(anchor.set(0, uTips.upper.value + 0.3, 0));
      ndc.copy(anchor).project(camera);
      ndc.x = (12 / widthPx) * 2 - 1;
      out.copy(ndc).unproject(camera);
      return opacity;
    },
    dispose() {
      if (built) {
        object.remove(...built.meshes);
        built.dispose();
        built = null;
      }
    },
  };
}
