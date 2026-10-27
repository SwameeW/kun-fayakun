import { Group } from 'three/webgpu';
import { blackbodyRgb } from '../../chapters/shared/blackbody';
import type { Look } from '../../sim/looks';
import { createImpostors, type ImpostorDot } from '../bodies/impostor';
import type { ExploreTier } from '../detail';
import { km, type Km } from '../space/origin';
import { placeScaled } from '../space/scaled-space';
import { createAnnulus, PROFILE_BINS, radialProfile, RING_FORMED, ringCoverage, type Annulus } from './annulus';
import { Fireballs, type Fireball, type FireballEvent } from './fireball';
import { FlashGuard } from './flash-guard';
import { incandescence } from './incandescence';
import { effectsFor, type LabEffects } from './ladder';
import { axesFor, crossover, discPx, effectiveTemperature, irregularity, seedOf, starLights } from './look';
import { createRocks, type RockInstance, type Rocks } from './rocks';
import { createSplats, SPLAT_SIZE, type Splat, type Splats } from './splats';

/**
 * The laboratory's effects (docs/SANDBOX-ROADMAP.md M1; docs/LAB.md, "How experiments are drawn"): its
 * own chunk, loaded with the first experiment (src/explore/lab), drawing what the experiment holds
 * that the explorer's ten worlds do not:
 * - bodies as lit rocks (./rocks) at the engine's radius, tumbling (by the model's spin, or, where the
 *   model gives none, slowly, illustrative), in another body's shadow unlit, crossing to a point of
 *   light when under a few pixels, and stars as shining discs with a glare;
 * - rings, belts and a torn body's dust as soft splats (./splats) lit by the star, dark in their
 *   body's shadow, sized by their spacing; once spread round their body, a band (./annulus);
 * - impacts' fireballs (./fireball) and decorative dust plumes, every brightness change eased and
 *   passed through the flash guard (./flash-guard);
 * - everything fading in and out over at least half a second (flash safety), never popping.
 * The explorer's detail tier sets how finely (./ladder). It reports what it drew (labDraw, for the
 * tests and the effects' A/B checks). Nothing here touches the physics.
 */

/** A body to draw (scenario frame positions; one of the explorer's worlds is drawn by the explorer). */
export interface FxBody {
  id: string;
  /** Where it is drawn now (scenario frame, km), its radius (km), GM, look, spin (G units) and moment of inertia factor. */
  pos: readonly number[];
  radiusKm: number;
  gm: number;
  look: Look;
  spin: readonly number[];
  inertia: number;
  /** A star's luminosity (W), or null. */
  luminosityW: number | null;
  /** Its surface's temperature now if hot (K; 0 when not glowing), and how much of it shows (fades in and out, 0 to 1). */
  heatK: number;
  fade: number;
  selected: boolean;
}

/** A ring, belt or dust cloud: its primary as drawn (scenario frame), its particles relative to it as the snapshot had them, and when. */
export interface FxSwarm {
  id: string;
  kind: 'dust' | 'belt' | 'ring';
  look: Look;
  normal: readonly number[];
  primaryPos: readonly number[];
  primaryKm: number;
  primaryGm: number;
  rel: Float32Array;
  /** The snapshot's time (s) and sequence (its profile and coverage are worked out once a snapshot). */
  snapT: number;
  seq: number;
  fade: number;
}

/** A decorative dust plume's points this frame (scenario frame, km) and their brightness (0 to 1), with the target's look. */
export interface FxPlume {
  points: Float64Array;
  count: number;
  strength: Float32Array;
  look: Look;
}

/** A star's light: where it is (scenario frame) and its luminosity (W). */
export interface FxLight {
  id: string;
  pos: readonly number[];
  watts: number;
}

/** A body that can shade others: where (scenario frame) and its radius (km). */
export interface FxOccluder {
  id: string;
  pos: readonly number[];
  radiusKm: number;
}

export interface FxFrame {
  /** The wall clock (s) and its step; the drawn simulated time (s); reduced motion. */
  nowS: number;
  dtS: number;
  simT: number;
  reduced: boolean;
  /** The camera: pixels per unit tangent, the far plane (km), the viewport (CSS px), the exposure's adaptation (points are drawn in display terms). */
  pxPerTan: number;
  far: number;
  widthPx: number;
  heightPx: number;
  compensation: number;
  /** The view's direction (render frame, a unit vector). */
  forward: Km;
  /** Scenario frame (km) to camera-relative render frame (km); a camera-relative point to the canvas (CSS px), or null behind. */
  toView(pos: readonly number[], out: Km): Km;
  toScreen(rel: Km): { x: number; y: number } | null;
  bodies: readonly FxBody[];
  swarms: readonly FxSwarm[];
  plumes: readonly FxPlume[];
  lights: readonly FxLight[];
  occluders: readonly FxOccluder[];
  /** Impacts first seen this frame: their fireballs, with the target's centre as drawn (scenario frame) found by `bodyAt`. */
  impacts: readonly FireballEvent[];
  bodyAt(id: string): readonly number[] | null;
  /** Where an impact's site is now (a unit vector from its body's centre, scenario frame): on a turning world, where its crater has turned to; else as it struck. */
  siteAt(key: string, struck: readonly number[], out: number[]): void;
}

/** What was drawn (window.__kf.universe.labDraw()). */
export interface FxReport {
  tier: ExploreTier | 'unknown';
  /**
   * Per body: its disc's radius (CSS px, as on the view's axis) and the radius its mesh is drawn at on screen
   * across the line from the view's middle (from where it is placed and scaled; off the axis a perspective view
   * draws it wider there by 1 / cos of its angle off the axis, `axis`); the way its light comes from on screen
   * (a unit vector, y down; null for none).
   */
  bodies: Array<{ id: string; discPx: number; projectedPx: number; axis: number; mesh: number; point: number; lit: number; light: { x: number; y: number } | null; drawnRadiusKm: number; screen: { x: number; y: number } | null; irregular: number; star: boolean; glow: number }>;
  meshes: readonly [number, number, number];
  dust: { drawn: number; particles: number; medianSizePx: number; color: [number, number, number]; shadowed: number; brightest: number };
  annuli: Array<{ id: string; weight: number; coverageDeg: number }>;
  /** Per fireball: as drawn (after the flash guard), where on screen and the share of its flash tile it covers. */
  fireballs: Array<{ key: string; strength: number; luminance: number; kelvin: number; radiusKm: number; radiusPx: number; screen: { x: number; y: number } | null; share: number }>;
  /** The light the laboratory's own drawing sends this frame (colour times opacity times area, CSS px^2; display terms). */
  light: number;
}

/** The effects that can be switched off for an A/B measurement: the rocks and points, the dust and plumes, the fireballs and glare, the bands. */
export interface FxParts {
  rocks: boolean;
  dust: boolean;
  fire: boolean;
  bands: boolean;
}

export interface LabFx {
  readonly root: Group;
  readonly effects: LabEffects;
  readonly fireballs: Fireballs;
  readonly guard: FlashGuard;
  frame(f: FxFrame): FxReport;
  /** The effects' A/B switches (docs/SANDBOX-ROADMAP.md W1.0, the perf checks): each kind drawn or not, its work skipped when not; returns them as they now are. */
  toggle(parts: Partial<FxParts>): FxParts;
  clear(): void;
  dispose(): void;
}

const MAX_BODIES = 64;
const MAX_ANNULI = 4;
/** A star as drawn (the explorer's Sun's display law: white and brilliant when small, through a filter when it fills the view). */
const STAR = { white: 5, filtered: 0.5, fromPx: 12, toPx: 110, refPx: 800, filter: [1, 0.5, 0.12], glarePx: 28 } as const;
/** Hot rock's glow is drawn at most this bright (a share of sunlit white ground: under the sunlit face's). */
const GLOW_CEILING = 0.5;
/** Points of light: the floor and gain of a body's brightness as a point (as the explorer's worlds' points), their size (CSS px). */
const POINT = { floor: 0.22, gain: 2.1, sizePx: 5 } as const;
/**
 * A particle's light: each stands for an equal share of a layer of dust of optical depth DUST_TAU over
 * the area the swarm spans (illustrative: the dust's mass is not modelled, the tracers are massless), so
 * the light it sends is that share of the area times the layer's brightness (its albedo, the phase, the
 * light there) whatever its size on screen; spread over its splat (whose profile covers pi size^2 / 12),
 * that gives its peak, never above the layer's own ground's (albedo times phase times light: dust can
 * be no brighter than a surface of it). A plume's points by the same rule at a fixed share (decorative),
 * held under DUST_CAP.
 */
const DUST_TAU = 0.6;
const DUST_CAP = 0.2;
const PLUME_GAIN = 2.2;
/** Particles drawn over a band are this much fainter. */
const OVER_BAND = 0.35;
/** A rock with no spin in the model tumbles once every so many hours (illustrative; seeded per body). */
const TUMBLE_H = { min: 4, max: 20 } as const;
/** A turn faster than this a frame (radians) is too fast to show: the rock is held still (as the explorer's worlds are). */
const TOO_FAST = (30 * Math.PI) / 180;
/** The band eases in and out at this rate (per second: two seconds either way). */
const BAND_EASE = 0.5;
/** Fireballs drawn at once (the rest wait, fading in when one has gone). */
const FIREBALLS = 6;
/**
 * Particles over a formed band, as a share of their light: OVER_BAND, and down to SPARSE where their
 * splats are held at their largest (each then stands for more of the layer than its splat can show, and
 * would be a blot: the band carries that light).
 */
const SPARSE = 0.08;

const smoothstep = (a: number, b: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};
const lambertPhase = (alpha: number): number => (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;
/** Scenario frame (ecliptic) to render frame. */
const toRenderDir = (x: number, y: number, z: number, out: number[]): number[] => {
  out[0] = x;
  out[1] = z;
  out[2] = -y;
  return out;
};

export function createLabFx(tier: ExploreTier | undefined): LabFx {
  const effects = effectsFor(tier);
  const root = new Group();
  root.name = 'lab-fx';
  const rocks: Rocks = createRocks(effects);
  const dust: Splats = createSplats(effects.splats + effects.plumePoints * 3, 'soft');
  // Fireballs behind a nearer body are hidden by it (depth tested); a star's glare is a halo about it, over everything.
  const fire: Splats = createSplats(FIREBALLS, 'fire');
  const glare: Splats = createSplats(1, 'fire', false);
  const points = createImpostors(MAX_BODIES);
  const annuli: Annulus[] = Array.from({ length: MAX_ANNULI }, () => createAnnulus());
  root.add(...rocks.objects, dust.object, fire.object, glare.object, points.object, ...annuli.map((a) => a.object));
  const fireballs = new Fireballs();
  const guard = new FlashGuard();
  const parts: FxParts = { rocks: true, dust: true, fire: true, bands: true };

  const rockList: RockInstance[] = Array.from({ length: MAX_BODIES }, () => ({ id: '', x: 0, y: 0, z: 0, radius: 0, discPx: 0, q: [0, 0, 0, 1], axes: [1, 1, 1], irregular: 0, color: [0, 0, 0], alpha: 0, light0: [0, 1, 0, 0], light1: [0, 1, 0, 0], light2: [0, 1, 0, 0], light3: [0, 1, 0, 0], glow: [0, 0, 0], star: 0 }));
  const pointList: ImpostorDot[] = Array.from({ length: MAX_BODIES }, () => ({ position: km(), color: [0, 0, 0], opacity: 0, sizePx: POINT.sizePx, marker: 0 }));
  const dustList: Splat[] = Array.from({ length: effects.splats + effects.plumePoints * 3 }, () => ({ x: 0, y: 0, z: 0, sizePx: SPLAT_SIZE.min, r: 0, g: 0, b: 0 }));
  const fireList: Splat[] = Array.from({ length: FIREBALLS }, () => ({ x: 0, y: 0, z: 0, sizePx: 6, r: 0, g: 0, b: 0 }));
  const glareList: Splat[] = [{ x: 0, y: 0, z: 0, sizePx: 6, r: 0, g: 0, b: 0 }];
  /** Each fireball's body's centre as last drawn (scenario frame): a body gone (merged away) keeps its fireball where it was while it fades. */
  const lastCentre = new Map<string, number[]>();
  /** Each fireball drawn this frame: it, its tile (the flash guard sees a tile's together) and how much of it shows (its body's limb). */
  const fireTiles: number[] = [];
  const fireAsked: number[] = [];
  const fireKeys: Fireball[] = [];
  /** Each rock's turn so far (radians) and the simulated time it was last turned to. */
  const turned = new Map<string, { angle: number; at: number }>();
  /** Each swarm's band: its weight, coverage, profile and radii (worked out once a snapshot). */
  const bands = new Map<string, { weight: number; coverage: number; seq: number; inner: number; outer: number; profile: Float32Array }>();
  const rel = km();
  const drawn = km();
  const scratch = km();
  const dir: number[] = [0, 0, 0];
  const axis: number[] = [0, 0, 0];
  const site: number[] = [0, 0, 1];
  const sizes: number[] = [];
  const report: FxReport = { tier: tier ?? 'unknown', bodies: [], meshes: rocks.drawn, dust: { drawn: 0, particles: 0, medianSizePx: 0, color: [0, 0, 0], shadowed: 0, brightest: 0 }, annuli: [], fireballs: [], light: 0 };

  /** The light of every star on a point (scenario frame), the strongest four (./look starLights). */
  const lightsAt = (f: FxFrame, at: readonly number[], self: string, radiusKm: number, out: readonly number[][]): void => {
    starLights(f.lights, f.occluders, at, self, radiusKm, out);
  };

  const l0 = [0, 1, 0, 0];
  const l1 = [0, 1, 0, 0];
  const l2 = [0, 1, 0, 0];
  const l3 = [0, 1, 0, 0];
  const lights4 = [l0, l1, l2, l3];
  const glow = { luminance: 0, rgb: [0, 0, 0] as [number, number, number] };

  const fx: LabFx = {
    root,
    effects,
    fireballs,
    guard,
    frame(f) {
      report.bodies.length = 0;
      report.light = 0;
      const area = (px: number): number => Math.PI * px * px;
      // Bodies: a rock (or a star) where the disc is a few pixels or more, a point of light below.
      let rocksUsed = 0;
      let pointsUsed = 0;
      for (const b of f.bodies) {
        if (rocksUsed >= MAX_BODIES || !parts.rocks) break;
        f.toView(b.pos, rel);
        const d = Math.max(Math.hypot(rel.x, rel.y, rel.z), 1e-9);
        const irregular = irregularity(b.radiusKm, b.look.material);
        const r = rockList[rocksUsed];
        if (!r) break;
        axesFor(irregular, r.axes);
        const bound = b.radiusKm * Math.max(r.axes[0], r.axes[1], r.axes[2]);
        const k = placeScaled(rel, bound, f.far, drawn);
        const px = discPx(b.radiusKm, d, f.pxPerTan);
        const w = crossover(px);
        const star = b.look.material === 'star';
        lightsAt(f, b.pos, b.id, b.radiusKm, lights4);
        // Its turn: by the model's spin; with none, a slow illustrative tumble about a seeded axis; held when too fast to show.
        const seed = seedOf(b.id);
        const L = Math.hypot(b.spin[0] ?? 0, b.spin[1] ?? 0, b.spin[2] ?? 0);
        let omega = L > 0 && b.gm > 0 ? L / (b.inertia * b.gm * b.radiusKm * b.radiusKm) : 0;
        if (omega > 0) toRenderDir((b.spin[0] ?? 0) / L, (b.spin[1] ?? 0) / L, (b.spin[2] ?? 0) / L, axis);
        else if (!star && irregular > 0) {
          omega = (2 * Math.PI) / (3600 * (TUMBLE_H.min + ((seed % 1000) / 1000) * (TUMBLE_H.max - TUMBLE_H.min)));
          const z = (((seed >>> 10) % 1000) / 1000) * 2 - 1;
          const phi = (((seed >>> 20) % 1000) / 1000) * 2 * Math.PI;
          const s = Math.sqrt(1 - z * z);
          axis[0] = s * Math.cos(phi);
          axis[1] = z;
          axis[2] = s * Math.sin(phi);
        }
        let t = turned.get(b.id);
        if (!t) {
          t = { angle: ((seed >>> 4) % 6283) / 1000, at: f.simT };
          turned.set(b.id, t);
        }
        const step = omega * (f.simT - t.at);
        if (Math.abs(step) < TOO_FAST) t.angle += step;
        t.at = f.simT;
        const half = t.angle / 2;
        const sn = Math.sin(half);
        r.q[0] = (axis[0] ?? 0) * sn;
        r.q[1] = (axis[1] ?? 1) * sn;
        r.q[2] = (axis[2] ?? 0) * sn;
        r.q[3] = Math.cos(half);
        if (omega === 0) {
          // Still: a fixed orientation of its own.
          r.q[0] = 0;
          r.q[1] = Math.sin(((seed % 6283) / 1000) / 2);
          r.q[2] = 0;
          r.q[3] = Math.cos(((seed % 6283) / 1000) / 2);
        }
        r.id = b.id;
        r.x = drawn.x;
        r.y = drawn.y;
        r.z = drawn.z;
        r.radius = b.radiusKm * k;
        r.discPx = px;
        r.irregular = irregular;
        r.alpha = w.mesh * b.fade;
        r.color[0] = b.look.albedo * b.look.tint[0];
        r.color[1] = b.look.albedo * b.look.tint[1];
        r.color[2] = b.look.albedo * b.look.tint[2];
        for (let c = 0; c < 4; c += 1) {
          r.light0[c] = l0[c] ?? 0;
          r.light1[c] = l1[c] ?? 0;
          r.light2[c] = l2[c] ?? 0;
          r.light3[c] = l3[c] ?? 0;
        }
        let glowLum = 0;
        if (star) {
          // A star: its blackbody colour from L and R; brilliant when small, through the explorer's filter when large.
          const kelvin = b.luminosityW && b.luminosityW > 0 ? effectiveTemperature(b.luminosityW, b.radiusKm) : 5772;
          const bb = blackbodyRgb(kelvin);
          const filter = smoothstep(STAR.fromPx * (Math.min(f.widthPx, f.heightPx) / STAR.refPx), STAR.toPx * (Math.min(f.widthPx, f.heightPx) / STAR.refPx), px);
          const display = Math.exp(Math.log(STAR.white) + (Math.log(STAR.filtered) - Math.log(STAR.white)) * filter);
          for (let c = 0; c < 3; c += 1) r.glow[c] = (bb[c] ?? 1) * (1 + ((STAR.filter[c] ?? 1) - 1) * filter) * display;
          r.star = 1;
          r.color[0] = 0;
          r.color[1] = 0;
          r.color[2] = 0;
        } else {
          r.star = 0;
          if (b.heatK > 0) {
            incandescence(b.heatK, glow);
            glowLum = Math.min(GLOW_CEILING, glow.luminance);
          }
          for (let c = 0; c < 3; c += 1) r.glow[c] = (glow.rgb[c] ?? 0) * glowLum;
        }
        rocksUsed += 1;
        // The point of light: the explorer's worlds' law (phase and albedo), in display terms.
        const p = pointList[pointsUsed];
        const sunDir = (l0[3] ?? 0) > 0 ? l0 : null;
        if (p && (w.point > 1e-3 || b.selected)) {
          p.position.x = drawn.x;
          p.position.y = drawn.y;
          p.position.z = drawn.z;
          // Phase angle: between the star and the camera, seen from the body.
          const cos = sunDir ? -((sunDir[0] ?? 0) * rel.x + (sunDir[1] ?? 0) * rel.y + (sunDir[2] ?? 0) * rel.z) / d : 0;
          const phase = sunDir ? lambertPhase(Math.acos(Math.min(1, Math.max(-1, cos)))) : 0;
          const bright = star ? 3.2 : (POINT.floor + POINT.gain * b.look.albedo * phase) * Math.min(1, Math.sqrt(Math.max(l0[3] ?? 0, 0)));
          const tint = star ? blackbodyRgb(b.luminosityW && b.luminosityW > 0 ? effectiveTemperature(b.luminosityW, b.radiusKm) : 5772) : b.look.tint;
          p.color = [tint[0] * bright, tint[1] * bright, tint[2] * bright];
          p.opacity = w.point * b.fade;
          p.sizePx = star ? 12 : POINT.sizePx;
          p.marker = b.selected ? b.fade : 0;
          pointsUsed += 1;
          report.light += p.opacity * bright * area(p.sizePx / 4);
        }
        report.light += r.alpha * (star ? 1 : b.look.albedo * (l0[3] ?? 0)) * area(px);
        // A star's glare (a soft halo about it, not its disc).
        if (star && effects.glare) {
          const g = glareList[0];
          if (g) {
            g.x = drawn.x;
            g.y = drawn.y;
            g.z = drawn.z;
            g.sizePx = Math.max(STAR.glarePx, px * 5);
            const bb = blackbodyRgb(b.luminosityW && b.luminosityW > 0 ? effectiveTemperature(b.luminosityW, b.radiusKm) : 5772);
            const strength = (0.35 * b.fade) / Math.max(f.compensation, 1e-6);
            g.r = bb[0] * strength;
            g.g = bb[1] * strength;
            g.b = bb[2] * strength;
          }
        }
        const screen = f.toScreen(rel);
        // As drawn: the mesh's edge on screen (a point at its scaled radius square to the line of sight), and the light's way across the screen.
        let projectedPx = 0;
        let lightOn: { x: number; y: number } | null = null;
        const axisCos = (rel.x * f.forward.x + rel.y * f.forward.y + rel.z * f.forward.z) / d;
        if (screen) {
          // Across the line from the view's middle: square to the line of sight and to the view's axis (any square to it on the axis).
          let sx = rel.y * f.forward.z - rel.z * f.forward.y;
          let sy = rel.z * f.forward.x - rel.x * f.forward.z;
          let sz = rel.x * f.forward.y - rel.y * f.forward.x;
          if (Math.hypot(sx, sy, sz) < 1e-6 * d) {
            sx = -rel.z;
            sy = 0;
            sz = rel.x;
          }
          const sl = Math.hypot(sx, sy, sz) || 1;
          // The silhouette's angular radius is asin(R/d): the edge point at that angle from the centre, at the centre's distance.
          const edge = Math.tan(Math.asin(Math.min(1, b.radiusKm / d))) * Math.hypot(drawn.x, drawn.y, drawn.z);
          scratch.x = drawn.x + (sx / sl) * edge;
          scratch.y = drawn.y + (sy / sl) * edge;
          scratch.z = drawn.z + (sz / sl) * edge;
          const e = f.toScreen(scratch);
          const c = f.toScreen(drawn);
          if (e && c) projectedPx = Math.hypot(e.x - c.x, e.y - c.y);
          if ((l0[3] ?? 0) > 0 && c) {
            const reach = Math.hypot(drawn.x, drawn.y, drawn.z) * 0.01;
            scratch.x = drawn.x + (l0[0] ?? 0) * reach;
            scratch.y = drawn.y + (l0[1] ?? 0) * reach;
            scratch.z = drawn.z + (l0[2] ?? 0) * reach;
            const q = f.toScreen(scratch);
            const lx = q ? q.x - c.x : 0;
            const ly = q ? q.y - c.y : 0;
            const ll = Math.hypot(lx, ly);
            lightOn = ll > 1e-9 ? { x: lx / ll, y: ly / ll } : null;
          }
        }
        report.bodies.push({ id: b.id, discPx: px, projectedPx, axis: axisCos, mesh: w.mesh, point: w.point, lit: l0[3] ?? 0, light: lightOn, drawnRadiusKm: b.radiusKm, screen, irregular, star, glow: glowLum });
      }
      rocks.update(rockList, rocksUsed);
      for (let k = pointsUsed; k < MAX_BODIES; k += 1) {
        const p = pointList[k];
        if (p) {
          p.opacity = 0;
          p.marker = 0;
        }
      }
      points.update(pointList, f.compensation);

      // Swarms: soft splats lit by the strongest star at their body, dark in its shadow; a band once spread round it.
      let used = 0;
      let shadowed = 0;
      let brightest = 0;
      sizes.length = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let bandsUsed = 0;
      report.annuli.length = 0;
      const limit = effects.splats;
      for (const w of f.swarms) {
        const n = Math.floor(w.rel.length / 3);
        if (n === 0 || !(parts.dust || parts.bands)) continue;
        lightsAt(f, w.primaryPos, '', 0, lights4);
        const light = l0[3] ?? 0;
        // Its extent now (once a snapshot) and the spacing of its particles across it: the splats' size.
        let band = bands.get(w.id);
        if (!band || band.seq !== w.seq) {
          let inner = Number.POSITIVE_INFINITY;
          let outer = 0;
          for (let i = 0; i < n; i += 1) {
            const r = Math.hypot(w.rel[i * 3] ?? 0, w.rel[i * 3 + 1] ?? 0, w.rel[i * 3 + 2] ?? 0);
            inner = Math.min(inner, r);
            outer = Math.max(outer, r);
          }
          const profile = band?.profile ?? new Float32Array(PROFILE_BINS);
          radialProfile(w.rel, inner, outer, profile);
          band = { weight: band?.weight ?? 0, coverage: ringCoverage(w.rel, w.normal), seq: w.seq, inner, outer, profile };
          bands.set(w.id, band);
        }
        // A band where it is a ring or a torn body's dust spread round its body (not a belt about a star).
        const formed = effects.annulus && w.kind !== 'belt' && band.coverage >= RING_FORMED.arcDeg;
        band.weight = formed ? Math.min(1, band.weight + f.dtS * BAND_EASE) : Math.max(0, band.weight - f.dtS * BAND_EASE);
        report.annuli.push({ id: w.id, weight: band.weight, coverageDeg: band.coverage });
        f.toView(w.primaryPos, scratch);
        const primaryDistance = Math.max(Math.hypot(scratch.x, scratch.y, scratch.z), 1e-9);
        const spacing = Math.sqrt((Math.PI * Math.max(band.outer * band.outer - band.inner * band.inner, 1)) / n);
        const sizePx = Math.min(SPLAT_SIZE.max, Math.max(SPLAT_SIZE.min, (f.pxPerTan * spacing) / primaryDistance));
        // Its share of the layer's area on screen (px^2) over its splat's: the peak for a layer of DUST_TAU (the size held to its range keeps the light, not the peak),
        // never brighter than the layer's own ground would be (albedo, phase and light: a share of 1 of it), however few the particles.
        const sharePx = (f.pxPerTan * spacing) / primaryDistance;
        const cover = Math.min(1, ((DUST_TAU * 12) / Math.PI) * (sharePx * sharePx) / (sizePx * sizePx));
        const sparse = smoothstep(0.7 * SPLAT_SIZE.max, SPLAT_SIZE.max, sharePx);
        const gain = cover * light * w.look.albedo * w.fade * (1 - (1 - (OVER_BAND + (SPARSE - OVER_BAND) * sparse)) * band.weight);
        // The light's direction (scenario frame) for the phase and the shadow.
        const lx = l0[0] ?? 0;
        const ly = -(l0[2] ?? 0);
        const lz = l0[1] ?? 0;
        // Particles carried on round their orbits since the snapshot (circular Kepler motion about the swarm's pole), at most an eighth of a turn.
        const ahead = f.simT - w.snapT;
        const [nx, ny, nz] = [w.normal[0] ?? 0, w.normal[1] ?? 0, w.normal[2] ?? 1];
        for (let i = 0; i < n && used < limit && parts.dust; i += 1) {
          let x = w.rel[i * 3] ?? 0;
          let y = w.rel[i * 3 + 1] ?? 0;
          let z = w.rel[i * 3 + 2] ?? 0;
          const r = Math.hypot(x, y, z);
          if (ahead !== 0 && w.primaryGm > 0 && r > 0) {
            const a = Math.sqrt(w.primaryGm / (r * r * r)) * ahead;
            if (Math.abs(a) < Math.PI / 4) {
              // Rodrigues about the pole.
              const c = Math.cos(a);
              const s = Math.sin(a);
              const dot = nx * x + ny * y + nz * z;
              const cx = ny * z - nz * y;
              const cy = nz * x - nx * z;
              const cz = nx * y - ny * x;
              x = x * c + cx * s + nx * dot * (1 - c);
              y = y * c + cy * s + ny * dot * (1 - c);
              z = z * c + cz * s + nz * dot * (1 - c);
            }
          }
          // In the body's shadow: behind it from the star, within its radius.
          const along = x * lx + y * ly + z * lz;
          const off2 = x * x + y * y + z * z - along * along;
          const lit = along < 0 && off2 < w.primaryKm * w.primaryKm ? 0 : 1;
          if (!lit) shadowed += 1;
          dir[0] = (w.primaryPos[0] ?? 0) + x;
          dir[1] = (w.primaryPos[1] ?? 0) + y;
          dir[2] = (w.primaryPos[2] ?? 0) + z;
          f.toView(dir, rel);
          const dd = Math.max(Math.hypot(rel.x, rel.y, rel.z), 1e-9);
          // Phase: between the star and the camera, seen from the particle.
          const cosPhase = -((l0[0] ?? 0) * rel.x + (l0[1] ?? 0) * rel.y + (l0[2] ?? 0) * rel.z) / dd;
          const bright = gain * lambertPhase(Math.acos(Math.min(1, Math.max(-1, cosPhase)))) * lit;
          const s = dustList[used];
          if (!s) break;
          placeScaled(rel, 1, f.far, drawn);
          s.x = drawn.x;
          s.y = drawn.y;
          s.z = drawn.z;
          s.sizePx = sizePx;
          s.r = bright * w.look.tint[0];
          s.g = bright * w.look.tint[1];
          s.b = bright * w.look.tint[2];
          brightest = Math.max(brightest, bright);
          sumR += s.r;
          sumG += s.g;
          sumB += s.b;
          if (sizes.length < 512) sizes.push(sizePx);
          report.light += bright * area(sizePx / 2) / Math.max(f.compensation, 1e-6);
          used += 1;
        }
        // The band itself.
        const a = annuli[bandsUsed];
        if (a && band.weight > 1e-3 && w.kind !== 'belt' && parts.bands) {
          const k = placeScaled(scratch, band.outer, f.far, drawn);
          // Two unit vectors in its plane (render frame).
          toRenderDir(nx, ny, nz, axis);
          const hx = Math.abs(axis[1] ?? 0) < 0.9 ? 0 : 1;
          const hy = Math.abs(axis[1] ?? 0) < 0.9 ? 1 : 0;
          const e1x = (axis[1] ?? 0) * 0 - (axis[2] ?? 0) * hy;
          const e1y = (axis[2] ?? 0) * hx - (axis[0] ?? 0) * 0;
          const e1z = (axis[0] ?? 0) * hy - (axis[1] ?? 0) * hx;
          const le = Math.hypot(e1x, e1y, e1z) || 1;
          const e1: [number, number, number] = [e1x / le, e1y / le, e1z / le];
          const e2: [number, number, number] = [(axis[1] ?? 0) * e1[2] - (axis[2] ?? 0) * e1[1], (axis[2] ?? 0) * e1[0] - (axis[0] ?? 0) * e1[2], (axis[0] ?? 0) * e1[1] - (axis[1] ?? 0) * e1[0]];
          a.update({ centre: [drawn.x, drawn.y, drawn.z], k, primaryKm: w.primaryKm, e1, e2, innerKm: band.inner, outerKm: band.outer, profile: band.profile, light: [l0[0] ?? 0, l0[1] ?? 0, l0[2] ?? 0, light], albedo: w.look.albedo, tint: w.look.tint, weight: band.weight * w.fade });
          bandsUsed += 1;
        }
      }
      report.dust.particles = used;
      for (let k = bandsUsed; k < MAX_ANNULI; k += 1) annuli[k]?.update(null);
      for (const id of bands.keys()) if (!f.swarms.some((w) => w.id === id)) bands.delete(id);
      // Plumes (decorative): the same splats, lit as the body's ground.
      for (const p of f.plumes) {
        for (let i = 0; i < p.count && used < dustList.length && parts.dust; i += 1) {
          dir[0] = p.points[i * 3] ?? 0;
          dir[1] = p.points[i * 3 + 1] ?? 0;
          dir[2] = p.points[i * 3 + 2] ?? 0;
          f.toView(dir, rel);
          const dd = Math.max(Math.hypot(rel.x, rel.y, rel.z), 1e-9);
          placeScaled(rel, 1, f.far, drawn);
          const s = dustList[used];
          if (!s) break;
          const bright = Math.min(DUST_CAP, (p.strength[i] ?? 0) * p.look.albedo * PLUME_GAIN);
          s.x = drawn.x;
          s.y = drawn.y;
          s.z = drawn.z;
          s.sizePx = Math.max(3, Math.min(8, (f.pxPerTan * 2) / dd));
          s.r = bright * p.look.tint[0];
          s.g = bright * p.look.tint[1];
          s.b = bright * p.look.tint[2];
          used += 1;
        }
      }
      dust.update(dustList, used);
      sizes.sort((x, y) => x - y);
      report.dust.drawn = used;
      report.dust.medianSizePx = sizes.length > 0 ? (sizes[Math.floor(sizes.length / 2)] ?? 0) : 0;
      const total = sumR + sumG + sumB;
      report.dust.color = total > 0 ? [sumR / total, sumG / total, sumB / total] : [0, 0, 0];
      report.dust.shadowed = shadowed;
      report.dust.brightest = brightest;

      // Fireballs: new impacts in, eased, guarded, drawn at the contact on the body as it is drawn now
      // (on one gone, where it was), a little toward the camera so its own body's ground never cuts it.
      // First where each is and the light it would show (held, and risen as its ease allows), each tile's
      // together through the flash guard; then each rise let through by its tile's share.
      for (const e of f.impacts) fireballs.add(e, f.nowS);
      fireballs.plan(f.nowS, f.dtS, f.reduced);
      guard.begin(f.nowS);
      report.fireballs.length = 0;
      let lit = 0;
      for (const ball of fireballs.live) {
        const s = fireList[lit];
        let centre = f.bodyAt(ball.body);
        if (centre) lastCentre.set(ball.key, [centre[0] ?? 0, centre[1] ?? 0, centre[2] ?? 0]);
        else centre = lastCentre.get(ball.key) ?? null;
        if (!s || lit >= FIREBALLS || !centre || !parts.fire) {
          fireballs.settle(ball, 1);
          continue;
        }
        const surface = ball.targetKm;
        f.siteAt(ball.key, ball.site, site);
        dir[0] = (centre[0] ?? 0) + (site[0] ?? 0) * surface;
        dir[1] = (centre[1] ?? 0) + (site[1] ?? 0) * surface;
        dir[2] = (centre[2] ?? 0) + (site[2] ?? 0) * surface;
        f.toView(dir, rel);
        const dd = Math.max(Math.hypot(rel.x, rel.y, rel.z), 1e-9);
        // Behind the body's limb, from here: hidden (softly, as it goes round).
        toRenderDir(site[0] ?? 0, site[1] ?? 0, site[2] ?? 1, axis);
        const facing = -((axis[0] ?? 0) * rel.x + (axis[1] ?? 0) * rel.y + (axis[2] ?? 0) * rel.z) / dd;
        const seen = fireballs.seenToward(ball, smoothstep(-0.08, 0.12, facing), f.dtS);
        const radiusKm = ball.radiusKm * ball.grown;
        const radiusPx = Math.max(3, (f.pxPerTan * radiusKm) / dd);
        // Scaled as its body is (so it sits on the body as drawn), then toward the camera by its radius.
        f.toView(centre, scratch);
        const k = placeScaled(scratch, surface, f.far, drawn);
        const toward = Math.min(radiusKm, 0.5 * dd) / dd;
        s.x = rel.x * (1 - toward) * k;
        s.y = rel.y * (1 - toward) * k;
        s.z = rel.z * (1 - toward) * k;
        s.sizePx = radiusPx * 2;
        // The light it sends into its tile (display terms), held and as risen.
        const unit = (ball.unit * seen) / Math.max(f.compensation, 1e-6);
        const screen = f.toScreen(rel);
        const tile = screen ? FlashGuard.tileAt(screen.x, screen.y, f.widthPx) : -1;
        const share = Math.min(1, area(radiusPx) / FlashGuard.tileArea(f.widthPx));
        if (screen) guard.add(tile, unit * Math.min(ball.strength, ball.next), unit * ball.next, share);
        fireTiles[lit] = tile;
        fireAsked[lit] = seen;
        fireKeys[lit] = ball;
        report.fireballs.push({ key: ball.key, strength: 0, luminance: 0, kelvin: ball.kelvin, radiusKm, radiusPx, screen, share });
        lit += 1;
      }
      for (let k = 0; k < lit; k += 1) {
        const s = fireList[k];
        const r = report.fireballs[k];
        const ball = fireKeys[k];
        if (!s || !r || !ball) continue;
        const tile = fireTiles[k] ?? -1;
        fireballs.settle(ball, tile === -1 ? 1 : guard.kappa(tile));
        const luminance = ball.luminance * (fireAsked[k] ?? 0);
        s.r = ball.rgb[0] * luminance;
        s.g = ball.rgb[1] * luminance;
        s.b = ball.rgb[2] * luminance;
        r.strength = ball.strength;
        r.luminance = luminance;
        report.light += (luminance / Math.max(f.compensation, 1e-6)) * area(r.radiusPx);
      }
      for (let k = lit; k < FIREBALLS; k += 1) {
        const s = fireList[k];
        if (s) {
          s.r = 0;
          s.g = 0;
          s.b = 0;
        }
      }
      for (const key of lastCentre.keys()) if (!fireballs.live.some((b) => b.key === key)) lastCentre.delete(key);
      if (!f.bodies.some((b) => b.look.material === 'star')) {
        const g = glareList[0];
        if (g) {
          g.r = 0;
          g.g = 0;
          g.b = 0;
        }
      }
      fire.update(fireList, parts.fire ? FIREBALLS : 0);
      glare.update(glareList, parts.fire ? 1 : 0);
      for (const id of turned.keys()) if (!f.bodies.some((b) => b.id === id)) turned.delete(id);
      return report;
    },
    toggle(next) {
      Object.assign(parts, next);
      return { ...parts };
    },
    clear() {
      fireballs.clear();
      guard.clear();
      turned.clear();
      bands.clear();
      rocks.update(rockList, 0);
      dust.update(dustList, 0);
      fire.update(fireList, 0);
      glare.update(glareList, 0);
      lastCentre.clear();
      for (const p of pointList) {
        p.opacity = 0;
        p.marker = 0;
      }
      points.update(pointList, 1);
      for (const a of annuli) a.update(null);
    },
    dispose() {
      rocks.dispose();
      dust.dispose();
      fire.dispose();
      glare.dispose();
      points.dispose();
      for (const a of annuli) a.dispose();
    },
  };
  return fx;
}

export type { FireballEvent } from './fireball';
export { incandescence } from './incandescence';
export { crustK, giantMeltK, MELT } from './heat';
