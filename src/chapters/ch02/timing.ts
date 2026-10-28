import type { Cue } from '../../core/types';
import { CMB_LINES } from './lines-window';

/** Scene events of Chapter 2, in story order (docs/CONTRACTS.md). */
export const CH02_EVENTS = ['plasma', 'recombination', 'cmb-reveal', 'cmb-hold'] as const;
export type Ch02Event = (typeof CH02_EVENTS)[number];

export type EventTimes = Readonly<Record<Ch02Event, number>>;

/**
 * Reads each scene event's time from the chapter's cues, so content.json stays
 * the single place where timing lives. A missing event is a content error.
 */
export function readEventTimes(cues: readonly Cue[]): EventTimes {
  const find = (event: Ch02Event): number => {
    const cue = cues.find((c) => c.type === 'scene' && c.event === event);
    if (!cue) throw new Error(`ch02: scene cue "${event}" is missing from content.json`);
    return cue.t;
  };
  return {
    plasma: find('plasma'),
    recombination: find('recombination'),
    'cmb-reveal': find('cmb-reveal'),
    'cmb-hold': find('cmb-hold'),
  };
}

/* ------------------------------------------------------------------ */
/* Durations                                                           */
/* ------------------------------------------------------------------ */

/**
 * Seconds for the plasma to cool and clear: a slow ease (flash safety) whose
 * visible dimming spans about six seconds. Reduced motion slows it slightly; with
 * the cue times in content.json it still ends by cmb-reveal, so the two never overlap.
 */
const CLEAR_SECONDS = { normal: 10, reduced: 10.5 } as const;
/**
 * Seconds for the sphere of last scattering to fade in after cmb-reveal. At the
 * steepest point of the ease the sphere's own area brightens by roughly
 * 0.48 / REVEAL_SECONDS relative luminance per 1/3 s (measured 0.106 at 4.5 s);
 * 5 s keeps every region of the screen under 0.1 per 1/3 s.
 */
const REVEAL_SECONDS = { normal: 5, reduced: 5.5 } as const;
/** Slow spin of the map during cmb-hold: one turn in about eight minutes. */
const SPIN_RADIANS_PER_SECOND = (2 * Math.PI) / 480;
/** The spin eases in over this long instead of starting abruptly. */
const SPIN_RAMP_SECONDS = 6;

/* ------------------------------------------------------------------ */
/* Easing                                                              */
/* ------------------------------------------------------------------ */

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Smooth 0..1 ramp with zero slope at both ends (Perlin's smootherstep). */
export const smootherstep = (x: number): number => {
  const s = clamp01(x);
  return s * s * s * (s * (s * 6 - 15) + 10);
};

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const s = clamp01((x - edge0) / (edge1 - edge0));
  return s * s * (3 - 2 * s);
};

/* ------------------------------------------------------------------ */
/* Visual state as a pure function of chapter time                     */
/* ------------------------------------------------------------------ */

export interface Ch02State {
  /** 0 = glowing opaque plasma, 1 = fully cooled and transparent. */
  clear: number;
  /** 0..1 fade of the CMB sphere (time since cmb-reveal and camera distance). */
  reveal: number;
  /** Extra rotation of the map about the galactic poles, in radians. */
  spin: number;
}

/**
 * Everything the scene shows is derived from absolute chapter time t, so seeking
 * to any time gives the same picture as playing up to it.
 */
export function stateAt(t: number, times: EventTimes, reducedMotion: boolean): Ch02State {
  const pace = reducedMotion ? 'reduced' : 'normal';
  const clear = smoothstep(0, 1, (t - times.recombination) / CLEAR_SECONDS[pace]);
  // The map first appears around the viewer as the sky (camera inside the sphere), then the
  // camera draws back out through it to see the whole shell, so the reveal depends on time only.
  const reveal = smootherstep((t - times['cmb-reveal']) / REVEAL_SECONDS[pace]);
  return { clear, reveal, spin: reducedMotion ? 0 : spinAt(t - times['cmb-hold']) };
}

/* ------------------------------------------------------------------ */
/* Polarisation lines                                                  */
/* ------------------------------------------------------------------ */

/** Nothing new appears under a verse or a hadith, or in the seconds before one. */
const QUIET_BEFORE_TEXT_SECONDS = 2;

/**
 * Throws when the lines' window (lines-window.ts) would reach under a verse or a hadith or into
 * the seconds before one: content.json's cues are the timing's single source, so a change there
 * that collides with the lines is a content error, not something to show.
 */
export function checkLinesWindow(cues: readonly Cue[], duration: number): void {
  for (const cue of cues) {
    if (cue.type !== 'verse' && cue.type !== 'hadith') continue;
    const quietFrom = cue.t - QUIET_BEFORE_TEXT_SECONDS;
    const quietTo = cue.t + cue.duration;
    if (quietFrom < duration && quietTo > CMB_LINES.from) {
      const name = cue.type === 'verse' ? cue.key : cue.id;
      throw new Error(`ch02: the polarisation lines (from ${CMB_LINES.from} s) would show under ${cue.type} ${name} or just before it`);
    }
  }
}

/**
 * 0..1: how strongly the polarisation lines darken the globe at chapter time t (held at 1 to the
 * end). The eye judges darkness about as the cube root of light, so a line at half strength looks
 * barely there; the square root of the ease spreads their coming-in evenly to the eye across the
 * window instead of bunching it at its end (it still starts and ends with zero slope).
 */
export function linesAt(t: number): number {
  return Math.sqrt(smootherstep((t - CMB_LINES.from) / (CMB_LINES.to - CMB_LINES.from)));
}

/** Angle after `s` seconds of a spin whose speed ramps linearly up to full over SPIN_RAMP_SECONDS. */
function spinAt(s: number): number {
  if (s <= 0) return 0;
  const ramp = SPIN_RAMP_SECONDS;
  const seconds = s < ramp ? (s * s) / (2 * ramp) : s - ramp / 2;
  return seconds * SPIN_RADIANS_PER_SECOND;
}

/* ------------------------------------------------------------------ */
/* Photons                                                             */
/* ------------------------------------------------------------------ */

/** Seconds for the photons to brighten in as the chapter opens (they are part of the plasma's light). */
const PHOTONS_IN_SECONDS = 2.5;
/** After release the freed light reddens and fades; it is gone before the map appears. */
const REDDEN_START_SECONDS = 3;

export interface PhotonLight {
  brightness: number;
  /** 0 = fresh light, 1 = stretched into the red and faded. */
  redshift: number;
}

export function photonLight(t: number, times: EventTimes, reducedMotion: boolean): PhotonLight {
  const pace = reducedMotion ? 1.15 : 1;
  const brightness = smootherstep(t / (PHOTONS_IN_SECONDS * pace));
  const reddenFrom = times.recombination + REDDEN_START_SECONDS;
  const reddenTo = Math.max(reddenFrom + 1, times['cmb-reveal'] - 0.5);
  const redshift = smoothstep(reddenFrom, reddenTo, t);
  return { brightness, redshift };
}
