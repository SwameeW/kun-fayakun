import { Color, Group } from 'three/webgpu';
import type { ChapterContent, ChapterContext, ChapterModule } from '../../core/types';
import contentJson from './content.json';
import { blackbodyRgb, type Rgb } from './blackbody';
import { createDust, type Dust } from './dust';
import { createGlow, HALO_WIDTH, type Glow } from './glow';
import { createLuminanceGuard } from './luminance-guard';
import { createNoiseVolume } from '../shared/noise-volume';
import { createMediumState, createPlasmaMedium, type PlasmaMedium } from '../shared/plasma-medium';
import { createFrameState, createTimingModel, isSceneEvent, readEventTimes, type TimingModel } from './timing';

/**
 * Chapter 1, "The beginning": from darkness a single point of light softly
 * brightens; then space itself stretches. The light diffuses into a uniform
 * glow that cools from blue-white to deep red as the comoving dust drifts
 * apart, every point from every other, with the camera inside it. Nothing is
 * timed to the verse.
 */

const content = contentJson as unknown as ChapterContent;

/**
 * As the plasma condenses out of the light, light and dust warm toward the plasma's gold
 * (white light mixed with gold plasma reads as grey-brown, not as one glow).
 */
const PLASMA_GOLD: Rgb = [1.0, 0.6, 0.24];
/** The dust is matter within the light: the glow's colour, lifted toward a warm white. */
const DUST_WHITE: Rgb = [1, 0.92, 0.82];
const DUST_TINT = 0.6;
/** Rough contribution of fully visible dust to the screen's mean brightness (for the luminance guard). */
const DUST_MEAN = 0.0006;
/** Below this exposure the engine has faded to black (a chapter change), so the guard starts afresh. */
const FRESH_EXPOSURE = 0.02;
/** Longest frame step the guard accepts, matching the engine's clamp. */
const MAX_FRAME_SECONDS = 0.1;
/** Noise volume shared with Chapter 2 (same size and seed), so the plasma at the join is identical. */
const NOISE_SIZE = 64;
const NOISE_SEED = 20_180_717;
/**
 * Approximate mean scene luminance of the plasma medium at emission 1 and full density, for
 * the luminance guard (Chapter 2's opaque plasma measures about this).
 */
const MEDIUM_MEAN = 0.32;
/**
 * The guard dims the plasma by cooling it (about 0.3 of heat per stop) rather than by scaling
 * its emission: a dimmer incandescent glow is a redder one, never a brown one.
 */
const HEAT_PER_STOP = 0.3;
/** Plasma drift runs at this fraction of real time with reduced motion (as in Chapter 2). */
const REDUCED_FLOW_RATE = 0.5;
/**
 * Angular radius (radians, about 5°) of the region around the light that the guard also watches,
 * roughly the 10° field WCAG uses for flashes. The swelling orb fills it while the screen's mean
 * brightness stays low, so it needs its own estimate.
 */
const LOCAL_FIELD = 0.087;
/** Mean of the halo's profile over that field, relative to its peak. */
const HALO_SHARE = 2 * (HALO_WIDTH / LOCAL_FIELD) ** 2 * (1 - 1 / Math.hypot(1, LOCAL_FIELD / HALO_WIDTH));
/**
 * Guard black levels: the screen mean below 2^-10, and the field around the light below 0.05 (the
 * steady point of light, ~0.04, shows there as under 0.02 relative luminance: far from a flash).
 */
const GUARD_BLACKS = [2 ** -10, 0.05] as const;

function luminance(rgb: Rgb): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/** erfc(-y) for y ≥ 0 (closed-form approximation, as in the glow shader): 1 inside the light, 2 far outside it. */
function erfcBehind(y: number): number {
  return 1 + Math.sqrt(1 - Math.exp(-(4 / Math.PI) * y * y));
}

interface Parts {
  glow: Glow;
  dust: Dust;
  medium: PlasmaMedium;
  dispose(): void;
}

export default function create(): ChapterModule {
  const times = readEventTimes(content.cues);
  const root = new Group();
  root.name = 'ch01';
  const state = createFrameState();
  const guard = createLuminanceGuard(GUARD_BLACKS);
  const hue: Rgb = [1, 1, 1];
  const glowColor = new Color();
  const dustColor = new Color();
  const medium = createMediumState();

  let ctx: ChapterContext | null = null;
  let parts: Parts | null = null;
  let model: TimingModel | null = null;
  let modelIsReduced = false;
  let entered = false;
  let lastFrameMs: number | null = null;
  let mediumCompiled = false;

  const timingModel = (reduced: boolean): TimingModel => {
    if (!model || modelIsReduced !== reduced) {
      model = createTimingModel(times, reduced, content.duration);
      modelIsReduced = reduced;
    }
    return model;
  };

  /** Real seconds since the previous frame, so the guard keeps working while the film is paused. */
  const realSeconds = (): number => {
    const now = performance.now();
    const seconds = lastFrameMs === null ? 0 : Math.min(MAX_FRAME_SECONDS, (now - lastFrameMs) / 1000);
    lastFrameMs = now;
    return seconds;
  };

  return {
    id: 'ch01',
    content,
    cues: content.cues,

    async load(c) {
      ctx = c;
      if (!parts) {
        const noise = await createNoiseVolume(NOISE_SIZE, NOISE_SEED);
        const glow = createGlow();
        const dust = createDust();
        const plasma = createPlasmaMedium(noise, c.quality.tier);
        // Drawn after the light and the dust and composited over them: the plasma hides what lies behind it.
        plasma.mesh.renderOrder = 10;
        root.add(glow.mesh, dust.object, plasma.mesh);
        parts = {
          glow,
          dust,
          medium: plasma,
          dispose() {
            root.remove(glow.mesh, dust.object, plasma.mesh);
            glow.dispose();
            dust.dispose();
            plasma.dispose();
            noise.dispose();
          },
        };
      }
      parts.dust.setBudget(c.quality.particles);
    },

    enter(c) {
      ctx = c;
      if (!parts) throw new Error('ch01: enter() before load()');
      parts.dust.setBudget(c.quality.particles);
      c.scene.add(root);
      entered = true;
      lastFrameMs = null;
      // A seek that re-enters the chapter keeps the guard's history; a fresh entry starts dark.
      if (c.exposure.current < FRESH_EXPOSURE) guard.reset();
    },

    update(t) {
      if (!ctx || !parts) return;
      const reduced = ctx.reducedMotion;
      timingModel(reduced).sample(t, state);

      blackbodyRgb(state.temperature, hue);
      // Normalised to the blackbody's luminance so the warmer colour keeps the light's brightness.
      const warm = state.mediumCoverage;
      const goldScale = luminance(hue) / luminance(PLASMA_GOLD);
      for (let i = 0; i < 3; i += 1) hue[i] = (hue[i] ?? 0) + ((PLASMA_GOLD[i] ?? 0) * goldScale - (hue[i] ?? 0)) * warm;
      glowColor.setRGB(hue[0], hue[1], hue[2]);
      dustColor.setRGB(
        DUST_WHITE[0] + (hue[0] - DUST_WHITE[0]) * DUST_TINT,
        DUST_WHITE[1] + (hue[1] - DUST_WHITE[1]) * DUST_TINT,
        DUST_WHITE[2] + (hue[2] - DUST_WHITE[2]) * DUST_TINT,
      );

      // Mean screen brightness: the glow covers the view once it is wider than the camera's distance.
      const lum = luminance(hue);
      const distance = Math.max(ctx.camera.position.length(), 1e-3);
      const sigma = Math.max(state.glowSigma, 1e-4);
      const cover = 1 - Math.exp(-((sigma / distance) ** 2));
      const dustMean = DUST_MEAN * state.dust;
      // Added heat brightens the ramp roughly threefold per unit at these levels.
      const mediumMean =
        MEDIUM_MEAN *
        state.mediumEmission *
        state.mediumCoverage *
        (1 - Math.exp(-3 * state.mediumDensity));
      const mean = 0.5 * state.glowPeak * cover * lum + dustMean + mediumMean;
      // Mean brightness of the field around the light (where the orb is brightest), as if looking at it.
      const spread = (sigma / (distance * LOCAL_FIELD)) ** 2;
      const fill = spread * (1 - Math.exp(-1 / spread));
      const local = (0.5 * state.glowPeak * erfcBehind(distance / sigma) * fill + state.halo * HALO_SHARE) * lum + dustMean;
      const gain = guard.gain([mean, local], realSeconds(), reduced);

      parts.glow.update({ sigma: state.glowSigma, peak: state.glowPeak * gain, halo: state.halo * gain, color: glowColor });
      parts.dust.update({ a: state.a, reach: state.dustReach, intensity: state.dust * gain, color: dustColor });

      // The plasma ends exactly in Chapter 2's opening state (flow 0 and scale 1 at the end).
      medium.heatBoost = HEAT_PER_STOP * Math.log2(Math.max(gain, 1 / 64));
      medium.emission = state.mediumEmission;
      medium.density = state.mediumDensity;
      medium.contrast = state.mediumContrast;
      medium.coverage = state.mediumCoverage;
      medium.scale = state.mediumScale;
      medium.flow = (t - content.duration) * (reduced ? REDUCED_FLOW_RATE : 1);
      medium.warmUp = !mediumCompiled;
      mediumCompiled = true;
      parts.medium.update(medium, ctx.camera.position);
      if (entered) ctx.exposure.setTarget(state.exposure);
    },

    onSceneEvent(event) {
      // The picture is derived from t in update(); events only need to be ones this scene knows.
      if (!isSceneEvent(event)) console.warn(`[ch01] Unknown scene event "${event}"`);
    },

    setQuality(profile) {
      parts?.dust.setBudget(profile.particles);
      parts?.medium.setTier(profile.tier);
    },

    exit() {
      root.removeFromParent();
      entered = false;
    },

    dispose() {
      root.removeFromParent();
      parts?.dispose();
      parts = null;
      mediumCompiled = false;
      entered = false;
      ctx = null;
    },
  };
}
