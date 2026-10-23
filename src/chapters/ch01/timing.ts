import type { Cue } from '../../core/types';

/**
 * The chapter's visual state as a pure function of chapter time, so playing,
 * seeking and deep links all land on exactly the same picture.
 *
 * Story: darkness; at `ignite` one point of light softly brightens; at
 * `expand` space begins to stretch (scale factor a(t) rises with a soft start
 * and a slowly fading rate, never a burst), the light diffuses into a uniform
 * glow and the comoving dust resolves out of it; the glow's temperature falls
 * as 1/a, so its colour runs from blue-white through yellow and orange to deep
 * gold; at `cool` the glow dims. Around the viewer the hot plasma of the early
 * universe takes shape as a translucent haze whose faint structure (the seeds
 * of all later structure, exaggerated) is fixed in comoving space, so it grows
 * as space stretches. Over the last seconds the haze thickens into the opaque
 * plasma Chapter 2 opens inside: the same medium, pattern, colour and camera, so
 * the two chapters join without a cut. Nothing is tied to the verse: after
 * `cool` there is only the same slow, continuous stretching.
 */

/** Scene events of this chapter, in order (docs/CONTRACTS.md). */
export const SCENE_EVENTS = ['ignite', 'expand', 'cool'] as const;
export type SceneEvent = (typeof SCENE_EVENTS)[number];
export type EventTimes = Readonly<Record<SceneEvent, number>>;

const FALLBACK_TIMES: EventTimes = { ignite: 2, expand: 11, cool: 24 };

export function isSceneEvent(name: string): name is SceneEvent {
  return (SCENE_EVENTS as readonly string[]).includes(name);
}

/** First time each scene event is cued in content.json (fallbacks keep the scene usable if one is missing). */
export function readEventTimes(cues: readonly Cue[]): EventTimes {
  const found: Partial<Record<SceneEvent, number>> = {};
  for (const cue of cues) {
    if (cue.type === 'scene' && isSceneEvent(cue.event) && found[cue.event] === undefined) found[cue.event] = cue.t;
  }
  return { ...FALLBACK_TIMES, ...found };
}

export interface FrameState {
  /** Cosmic scale factor; 1 until `expand`. Every point sits at its comoving position × a. */
  a: number;
  /** Glow temperature in kelvin; falls as a power of a (see TEMPERATURE_EXPONENT). */
  temperature: number;
  /** Width (world units) of the glow's Gaussian; grows from a point until it surrounds the camera. */
  glowSigma: number;
  /** Radiance at the glow's brightest point (centre of the point, or twice the uniform level). */
  glowPeak: number;
  /** Soft angular halo around the point, for tiers without bloom; fades as the light diffuses. */
  halo: number;
  /** Overall dust brightness (0 while hidden). */
  dust: number;
  /**
   * Distance (world units, High-tier density) within which dust points are resolved at full
   * brightness; beyond it they fade as 1/d² into the glow, which stands for their unresolved light.
   */
  dustReach: number;
  /** Target for the engine's exposure control. */
  exposure: number;
  /** The plasma medium (src/chapters/shared/plasma-medium.ts). */
  mediumEmission: number;
  mediumDensity: number;
  mediumContrast: number;
  /** 0..1 of the plasma condensed (it gathers as islands of light that spread). */
  mediumCoverage: number;
  /** Comoving pattern scale: a(t) / a(end), so the pattern matches Chapter 2's at the end. */
  mediumScale: number;
}

export function createFrameState(): FrameState {
  return {
    a: 1,
    temperature: 0,
    glowSigma: 0,
    glowPeak: 0,
    halo: 0,
    dust: 0,
    dustReach: 1,
    exposure: 1,
    mediumEmission: 0,
    mediumDensity: 0,
    mediumContrast: 0,
    mediumCoverage: 0,
    mediumScale: 1,
  };
}

/* Light ------------------------------------------------------------- */

/** Temperature of the light before space stretches: blue-white. */
const HOT_KELVIN = 12_000;
/** Scale factor reached at `cool`. */
const A_AT_COOL = 11;
/**
 * The light's colour cools as a^-0.37 (not as the physical 1/a: the stretching shown is a
 * visual scale, not the real factor of ~10^26), from blue-white to a warm gold of about
 * 4,500 K at the chapter's end, where it becomes the 3,000-4,000 K plasma of Chapter 2.
 */
const TEMPERATURE_EXPONENT = 0.37;
/** Exposure target while the screen is still in darkness; `ignite` raises it to 1 through the engine's limiter. */
const DARK_EXPOSURE = 0.05;
/** The point's own brightening after `ignite` (on top of the exposure ramp). */
const IGNITE_SECONDS = 4.5;
const POINT_SIGMA = 0.05;
const POINT_PEAK = 7;
const HALO = 0.3;
/** Once diffused, the glow's width is this many world units per unit of a (always far wider than the camera's distance). */
const WIDE_SIGMA_PER_A = 5;
/**
 * Seconds after `expand` for the point to diffuse into a glow that surrounds the camera. Slow
 * enough that the screen brightens at under ~1.8 stops/s (the light swells; it never bursts).
 */
const DIFFUSE_SECONDS = 10;
/** The peak settles a little before the width does, so the swelling light stays soft-edged. */
const PEAK_FALL_SECONDS = 8.5;
/** Brightness of the surrounding glow just after it forms; it fades as a^-0.35 as the light thins and reddens. */
const UNIFORM_LEVEL = 0.085;
const UNIFORM_FALLOFF = 0.35;
/** At `cool` the glow eases down to this fraction over DIM_SECONDS. */
const COOL_DIM = 0.4;
const DIM_SECONDS = 5;

/* Expansion --------------------------------------------------------- */

/** Seconds after `expand` at which space stretches fastest (the soft start's peak rate). */
const STRETCH_PEAK_SECONDS = 3;
/** A gentle, slowly fading rate that keeps space stretching through the rest of the chapter. */
const TAIL_SECONDS = 10;
const TAIL_GAIN = 0.5;

/* Dust -------------------------------------------------------------- */

/** Seconds after `expand` over which the dust fades in: as the glow reaches the camera, so it is never seen streaming out of the light. */
const DUST_IN_START = 5.5;
const DUST_IN_END = 9;
const DUST_COOL_DIM = 0.6;
/** Peak dust brightness; individual points carry a share of it by distance and chance. */
const DUST_LEVEL = 2.4;
/**
 * As the plasma condenses the dust yields to it: millions of faint points sum to a grey veil
 * that would wash the plasma's colour out, so only the brighter glints stay.
 */
const DUST_UNDER_PLASMA = 0.3;
/**
 * Resolved reach at a = 1. It grows as a^0.7, slower than space, so fewer and fewer points stay
 * close by: the dust visibly thins out as it stretches (a few thousand resolved points at first).
 */
const REACH_BASE = 3.2;
const REACH_GROWTH = 0.7;

/* Plasma medium ----------------------------------------------------- */

/** Seconds after `expand` over which the plasma gathers, as the swelling light reaches the viewer. */
const MEDIUM_IN = { start: 6, end: 13 } as const;
/**
 * While space stretches the plasma is luminous structure with dark gaps: bright cores,
 * deep-red edges and near-black voids where the dust glints (an even haze reads as smoke).
 * Its colours are exactly Chapter 2's (the same incandescent ramp), so the join is seamless.
 */
const HAZE = { emission: 1.0, density: 0.5, contrast: 1.0 } as const;
/** Seconds before the end over which the haze thickens into opaque plasma (Chapter 2's opening state). */
const THICKEN_SECONDS = 16;

/** Reduced motion: slower crossfades (the expansion itself is unchanged; see createTimingModel). */
const REDUCED_FADE = 1.4;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Zero slope at both ends, so nothing starts or stops abruptly. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const u = clamp01((x - edge0) / (edge1 - edge0));
  return u * u * u * (u * (u * 6 - 15) + 10);
}

function logLerp(from: number, to: number, s: number): number {
  return Math.exp(Math.log(from) + (Math.log(to) - Math.log(from)) * s);
}

/**
 * ln a(u) for u seconds after `expand`: a soft pulse in the expansion rate
 * (zero at u = 0, peaking at u = tau, then decaying) plus a long tail whose
 * rate also starts at zero and then falls off as about 1/u.
 */
function pulse(u: number, tau: number): number {
  const x = u / tau;
  return 1 - (1 + x) * Math.exp(-x);
}
function tail(u: number): number {
  return TAIL_GAIN * (Math.log1p(u / TAIL_SECONDS) + TAIL_SECONDS / (TAIL_SECONDS + u) - 1);
}

export interface TimingModel {
  sample(t: number, out: FrameState): FrameState;
}

export function createTimingModel(times: EventTimes, reducedMotion: boolean, duration: number): TimingModel {
  /*
   * Reduced motion keeps the same expansion and slows only the fades, so the dust appears later,
   * when space is stretching more slowly. Stretching the expansion itself over a longer time would
   * push part of it past `cool` and into the verse (faster than with full motion there), and
   * shrinking it would put the dust closer to the camera, so the camera's drift would sweep it
   * across the screen faster.
   */
  const tau = STRETCH_PEAK_SECONDS;
  const fade = reducedMotion ? REDUCED_FADE : 1;
  // Chosen so a(cool) = A_AT_COOL whatever the cue times are.
  const toCool = Math.max(1, times.cool - times.expand);
  const gain = Math.max(0, (Math.log(A_AT_COOL) - tail(toCool)) / pulse(toCool, tau));

  const scaleFactor = (u: number): number => (u <= 0 ? 1 : Math.exp(gain * pulse(u, tau) + tail(u)));
  const finalA = scaleFactor(duration - times.expand);

  return {
    sample(t, out) {
      const sinceExpand = t - times.expand;
      const sinceCool = t - times.cool;
      const a = scaleFactor(sinceExpand);
      const ignition = smootherstep(0, IGNITE_SECONDS * fade, t - times.ignite);
      const diffused = smootherstep(0, DIFFUSE_SECONDS * fade, sinceExpand);
      const dim = smootherstep(0, DIM_SECONDS * fade, sinceCool);
      const uniform = UNIFORM_LEVEL * a ** -UNIFORM_FALLOFF * (1 + (COOL_DIM - 1) * dim);

      // The haze thickens into the opaque plasma over the last THICKEN_SECONDS (the handoff).
      const thicken = smootherstep(duration - THICKEN_SECONDS, duration - 1, t);
      const gathered = smootherstep(MEDIUM_IN.start * fade, MEDIUM_IN.end * fade, sinceExpand);

      out.a = a;
      out.temperature = HOT_KELVIN * a ** -TEMPERATURE_EXPONENT;
      out.glowSigma = logLerp(POINT_SIGMA, WIDE_SIGMA_PER_A * a, diffused);
      // As the plasma gathers it takes over from the uniform glow (the two together read as murk).
      out.glowPeak =
        ignition *
        logLerp(POINT_PEAK, 2 * uniform, smootherstep(0, PEAK_FALL_SECONDS * fade, sinceExpand)) *
        (1 - 0.75 * gathered) *
        (1 - thicken);
      out.halo = ignition * HALO * (1 - diffused) ** 2;
      out.dust =
        DUST_LEVEL *
        smootherstep(DUST_IN_START * fade, DUST_IN_END * fade, sinceExpand) *
        (1 + (DUST_COOL_DIM - 1) * dim) *
        (1 + (DUST_UNDER_PLASMA - 1) * gathered) *
        (1 - thicken);
      out.dustReach = REACH_BASE * a ** REACH_GROWTH;
      out.exposure = t < times.ignite ? DARK_EXPOSURE : 1;
      // How much exists grows with `gathered`; the shader cools thin, partly condensed plasma.
      out.mediumEmission = HAZE.emission + (1 - HAZE.emission) * thicken;
      out.mediumDensity = HAZE.density + (1 - HAZE.density) * thicken;
      out.mediumCoverage = gathered;
      out.mediumContrast = HAZE.contrast + (1 - HAZE.contrast) * thicken;
      out.mediumScale = a / finalA;
      return out;
    },
  };
}
