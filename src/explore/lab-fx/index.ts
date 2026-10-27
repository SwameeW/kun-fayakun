import { Group } from 'three/webgpu';
import { blackbodyRgb } from '../../chapters/shared/blackbody';
import type { Look } from '../../sim/looks';
import { createImpostors, type ImpostorDot } from '../bodies/impostor';
import type { ExploreTier } from '../detail';
import { km, type Km } from '../space/origin';
import { placeScaled } from '../space/scaled-space';
import { createAnnulus, PROFILE_BINS, radialProfile, RING_FORMED, ringCoverage, type Annulus } from './annulus';
import { Fireballs, type FireballEvent } from './fireball';
import { FlashGuard } from './flash-guard';
import { incandescence } from './incandescence';
import { effectsFor, type LabEffects } from './ladder';
import { axesFor, crossover, discPx, effectiveTemperature, irregularity, seedOf } from './look';
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
  bodies: Array<{ id: string; discPx: number; mesh: number; point: number; lit: number; drawnRadiusKm: number; screen: { x: number; y: number } | null; irregular: number; star: boolean; glow: number }>;
  meshes: readonly [number, number, number];
  dust: { drawn: number; particles: number; medianSizePx: number; color: [number, number, number]; shadowed: number; brightest: number };
  annuli: Array<{ id: string; weight: number; coverageDeg: number }>;
  fireballs: Array<{ key: string; strength: number; luminance: number; kelvin: number; radiusKm: number; radiusPx: number }>;
  /** The light the laboratory's own drawing sends this frame (colour times opacity times area, CSS px^2; display terms). */
  light: number;
}

export interface LabFx {
  readonly root: Group;
  readonly effects: LabEffects;
  readonly fireballs: Fireballs;
  readonly guard: FlashGuard;
  frame(f: FxFrame): FxReport;
  clear(): void;
  dispose(): void;
}

/** The Sun's light at 1 au (W/m^2) from the IAU's nominal luminosity: lights are given as shares of it. */
const S_1AU = 3.828e26 / (4 * Math.PI * 1.495978707e11 ** 2);
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
 * that gives its peak. Held so a dense patch stays under sunlit ground. A plume's points by the same rule
 * at a fixed share (decorative).
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
  const fire: Splats = createSplats(8, 'fire', false);
  const points = createImpostors(MAX_BODIES);
  const annuli: Annulus[] = Array.from({ length: MAX_ANNULI }, () => createAnnulus());
  root.add(...rocks.objects, dust.object, fire.object, points.object, ...annuli.map((a) => a.object));
  const fireballs = new Fireballs();
  const guard = new FlashGuard();

  const rockList: RockInstance[] = Array.from({ length: MAX_BODIES }, () => ({ id: '', x: 0, y: 0, z: 0, radius: 0, discPx: 0, q: [0, 0, 0, 1], axes: [1, 1, 1], irregular: 0, color: [0, 0, 0], alpha: 0, light0: [0, 1, 0, 0], light1: [0, 1, 0, 0], glow: [0, 0, 0], star: 0 }));
  const pointList: ImpostorDot[] = Array.from({ length: MAX_BODIES }, () => ({ position: km(), color: [0, 0, 0], opacity: 0, sizePx: POINT.sizePx, marker: 0 }));
  const dustList: Splat[] = Array.from({ length: effects.splats + effects.plumePoints * 3 }, () => ({ x: 0, y: 0, z: 0, sizePx: SPLAT_SIZE.min, r: 0, g: 0, b: 0 }));
  const fireList: Splat[] = Array.from({ length: 8 }, () => ({ x: 0, y: 0, z: 0, sizePx: 6, r: 0, g: 0, b: 0 }));
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

  /** The light of every star on a point (scenario frame), the strongest two: direction (render frame) and strength (1: the Sun's at 1 au), nought behind an occluder. */
  const lightsAt = (f: FxFrame, at: readonly number[], self: string, radiusKm: number, out0: number[], out1: number[]): void => {
    out0[3] = 0;
    out1[3] = 0;
    for (const light of f.lights) {
      if (light.id === self) continue;
      const dx = (light.pos[0] ?? 0) - (at[0] ?? 0);
      const dy = (light.pos[1] ?? 0) - (at[1] ?? 0);
      const dz = (light.pos[2] ?? 0) - (at[2] ?? 0);
      const d = Math.hypot(dx, dy, dz);
      if (!(d > 0)) continue;
      let strength = light.watts / (4 * Math.PI * (d * 1000) ** 2) / S_1AU;
      // Eclipses: the point behind an occluder (from this star), within its radius (softened over the body's own).
      for (const o of f.occluders) {
        if (o.id === self || o.id === light.id || strength <= 0) continue;
        const sx = (at[0] ?? 0) - (o.pos[0] ?? 0);
        const sy = (at[1] ?? 0) - (o.pos[1] ?? 0);
        const sz = (at[2] ?? 0) - (o.pos[2] ?? 0);
        // Along the light's way (away from the star) past the occluder, and how far off its axis.
        const along = -(sx * dx + sy * dy + sz * dz) / d;
        if (along <= 0) continue;
        const off = Math.sqrt(Math.max(0, sx * sx + sy * sy + sz * sz - along * along));
        strength *= smoothstep(o.radiusKm - radiusKm, o.radiusKm + radiusKm + 1e-6, off);
      }
      toRenderDir(dx / d, dy / d, dz / d, dir);
      const target = strength > out0[3] ? out0 : strength > out1[3] ? out1 : null;
      if (!target) continue;
      if (target === out0) for (let c = 0; c < 4; c += 1) out1[c] = out0[c] ?? 0;
      target[0] = dir[0] ?? 0;
      target[1] = dir[1] ?? 0;
      target[2] = dir[2] ?? 0;
      target[3] = strength;
    }
  };

  const l0 = [0, 1, 0, 0];
  const l1 = [0, 1, 0, 0];
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
        if (rocksUsed >= MAX_BODIES) break;
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
        lightsAt(f, b.pos, b.id, b.radiusKm, l0, l1);
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
          const g = fireList[7];
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
        report.bodies.push({ id: b.id, discPx: px, mesh: w.mesh, point: w.point, lit: l0[3] ?? 0, drawnRadiusKm: b.radiusKm, screen, irregular, star, glow: glowLum });
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
        if (n === 0) continue;
        lightsAt(f, w.primaryPos, '', 0, l0, l1);
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
        // Its share of the layer's area on screen (px^2) over its splat's: the peak for a layer of DUST_TAU (the size held to its range keeps the light, not the peak).
        const sharePx = (f.pxPerTan * spacing) / primaryDistance;
        const gain = ((DUST_TAU * 12) / Math.PI) * (sharePx * sharePx) / (sizePx * sizePx) * light * w.look.albedo * w.fade * (1 - (1 - OVER_BAND) * band.weight);
        // The light's direction (scenario frame) for the phase and the shadow.
        const lx = l0[0] ?? 0;
        const ly = -(l0[2] ?? 0);
        const lz = l0[1] ?? 0;
        // Particles carried on round their orbits since the snapshot (circular Kepler motion about the swarm's pole), at most an eighth of a turn.
        const ahead = f.simT - w.snapT;
        const [nx, ny, nz] = [w.normal[0] ?? 0, w.normal[1] ?? 0, w.normal[2] ?? 1];
        for (let i = 0; i < n && used < limit; i += 1) {
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
          const bright = Math.min(DUST_CAP, gain * lambertPhase(Math.acos(Math.min(1, Math.max(-1, cosPhase))))) * lit;
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
        if (a && band.weight > 1e-3 && w.kind !== 'belt') {
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
        for (let i = 0; i < p.count && used < dustList.length; i += 1) {
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

      // Fireballs: new impacts in, eased, guarded, drawn at the contact on the body as it is drawn now.
      for (const e of f.impacts) fireballs.add(e, f.nowS);
      fireballs.update(f.nowS, f.dtS, f.reduced);
      report.fireballs.length = 0;
      let lit = 0;
      for (const ball of fireballs.live) {
        const s = fireList[lit];
        const centre = f.bodyAt(ball.body);
        if (!s || !centre || lit >= 6) continue;
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
        const seen = smoothstep(-0.08, 0.12, facing);
        const radiusPx = Math.max(3, (f.pxPerTan * ball.radiusKm * ball.grown) / dd);
        const screen = f.toScreen(rel);
        // The flash guard: the light it sends into its tile (display terms), held back if it would flash.
        let luminance = ball.luminance * seen;
        if (screen) {
          const tile = FlashGuard.tileAt(screen.x, screen.y, f.widthPx);
          const share = Math.min(1, area(radiusPx) / FlashGuard.tileArea(f.widthPx));
          const asked = luminance / Math.max(f.compensation, 1e-6);
          const allowed = guard.limit(tile, asked, share, f.nowS);
          if (asked > 0) luminance *= Math.min(1, allowed / asked);
        }
        placeScaled(rel, 1, f.far, drawn);
        s.x = drawn.x;
        s.y = drawn.y;
        s.z = drawn.z;
        s.sizePx = radiusPx * 2;
        s.r = ball.rgb[0] * luminance;
        s.g = ball.rgb[1] * luminance;
        s.b = ball.rgb[2] * luminance;
        report.light += (luminance / Math.max(f.compensation, 1e-6)) * area(radiusPx);
        report.fireballs.push({ key: ball.key, strength: ball.strength, luminance, kelvin: ball.kelvin, radiusKm: ball.radiusKm * ball.grown, radiusPx });
        lit += 1;
      }
      for (let k = lit; k < 7; k += 1) {
        const s = fireList[k];
        if (s) {
          s.r = 0;
          s.g = 0;
          s.b = 0;
        }
      }
      if (!f.bodies.some((b) => b.look.material === 'star')) {
        const g = fireList[7];
        if (g) {
          g.r = 0;
          g.g = 0;
          g.b = 0;
        }
      }
      fire.update(fireList, 8);
      for (const id of turned.keys()) if (!f.bodies.some((b) => b.id === id)) turned.delete(id);
      return report;
    },
    clear() {
      fireballs.clear();
      guard.clear();
      turned.clear();
      bands.clear();
      rocks.update(rockList, 0);
      dust.update(dustList, 0);
      fire.update(fireList, 0);
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
      points.dispose();
      for (const a of annuli) a.dispose();
    },
  };
  return fx;
}

export type { FireballEvent } from './fireball';
export { incandescence } from './incandescence';
export { crustK, giantMeltK, MELT } from './heat';
