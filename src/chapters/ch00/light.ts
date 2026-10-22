/**
 * The light of the word over chapter time, as pure functions of t, so playing,
 * pausing and seeking always show the same frame for the same t.
 *
 * darkness -> kun-reveal: light gathers over >= 4 s, soft then crisp
 *          -> kun-hold: still, with a very slow breathing of the glow
 *          -> kun-fade: the whole word fades out together, then darkness.
 *
 * Every change is eased over seconds (flash safety: far slower than 0.5 s).
 */
import { EASINGS } from '../../core/camera';
import type { Cue } from '../../core/types';

export interface KunSchedule {
  /** kun-reveal: light begins to gather. */
  readonly reveal: number;
  /** The reveal is complete (kun-hold, but never sooner than MIN_REVEAL_SECONDS). */
  readonly revealEnd: number;
  /** kun-hold: breathing begins. */
  readonly hold: number;
  /** kun-fade: the word begins to fade out whole. */
  readonly fade: number;
  /** Dark again. */
  readonly fadeEnd: number;
}

export interface KunLight {
  /** Light of the letter core, 0..1 (perceptually eased). */
  readonly core: number;
  /** Light of the glow, 0..~1.15: it gathers a little ahead of the core, and breathes. */
  readonly glow: number;
  /** 0 = soft letterforms, 1 = crisp. */
  readonly focus: number;
  /** 0..1 progress of the almost imperceptible push-in. */
  readonly drift: number;
}

/** Art direction: the reveal is a slow fade of light over at least 4 s. */
const MIN_REVEAL_SECONDS = 4;
const FADE_SECONDS = 6.5;
/** One slow breath of the glow, and how deep it goes (fraction of the glow). */
const BREATH_PERIOD = 11;
const BREATH_DEPTH = 0.14;
/** Breathing eases in after kun-hold and out at kun-fade, so it never starts or stops abruptly. */
const BREATH_RAMP = 4;
/** Exponent of the glow envelope (core uses 2): below 2, the glow gathers ahead of the letters. */
const GLOW_LEAD = 1.3;
/** Darkness the fade leaves before the chapter ends. */
const END_MARGIN = 1;

/** Fallback times if a cue is missing (the validator requires all three). */
const DEFAULTS = { reveal: 5.5, hold: 10.5, fade: 56.5 } as const;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const ease = EASINGS.inOutSine;
/** Linear light that looks like an even fade once tone-mapped and sRGB-encoded. */
const perceptual = (x: number): number => x * x;

function sceneCueTime(cues: readonly Cue[], event: string): number | undefined {
  return cues.find((c): c is Extract<Cue, { type: 'scene' }> => c.type === 'scene' && c.event === event)?.t;
}

export function kunSchedule(cues: readonly Cue[], duration: number): KunSchedule {
  const reveal = sceneCueTime(cues, 'kun-reveal') ?? DEFAULTS.reveal;
  const hold = Math.max(reveal, sceneCueTime(cues, 'kun-hold') ?? DEFAULTS.hold);
  const fade = Math.max(hold, sceneCueTime(cues, 'kun-fade') ?? DEFAULTS.fade);
  const fadeSeconds = Math.max(1, Math.min(FADE_SECONDS, duration - END_MARGIN - fade));
  return {
    reveal,
    revealEnd: Math.max(hold, reveal + MIN_REVEAL_SECONDS),
    hold,
    fade,
    fadeEnd: fade + fadeSeconds,
  };
}

/**
 * @param motion 1 = full motion (breathing and drift), 0 = reduced motion (neither).
 *   Values in between come from the scene easing a mid-chapter change of the
 *   preference, so switching it never steps the light in one frame.
 */
export function kunLightAt(t: number, s: KunSchedule, motion: number): KunLight {
  const m = clamp01(motion);
  const p = clamp01((t - s.reveal) / (s.revealEnd - s.reveal));
  const q = clamp01((t - s.fade) / (s.fadeEnd - s.fade));
  const out = perceptual(1 - ease(q));
  const core = perceptual(ease(p)) * out;
  // The glow leads: light gathers as a soft haze, then the letters fill with it.
  const gathered = ease(p) ** GLOW_LEAD * out;

  // Crisp a little before the reveal completes, so the hold opens on clean letterforms.
  const focus = ease(clamp01(p / 0.85));

  let breath = 1;
  if (m > 0 && t > s.hold) {
    const inRamp = ease(clamp01((t - s.hold) / BREATH_RAMP));
    const outRamp = 1 - ease(clamp01((t - s.fade) / (BREATH_RAMP / 2)));
    breath = 1 + BREATH_DEPTH * m * inRamp * outRamp * Math.sin((2 * Math.PI * (t - s.hold)) / BREATH_PERIOD);
  }

  const drift = m * ease(clamp01((t - s.reveal) / (s.fadeEnd - s.reveal)));
  return { core, glow: gathered * breath, focus, drift };
}
