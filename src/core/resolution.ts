/**
 * Dynamic resolution: keeps frame pacing smooth by trading a little sharpness
 * before the quality governor has to trade whole effects.
 *
 * The render scale (a multiplier on the device-pixel-ratio cap) drops in small
 * steps when frames run slow for a moment, and creeps back up after a long
 * stretch of comfortable frames. A probe upward that makes frames slow again is
 * undone at once and not retried for a while, so the scale never oscillates.
 * It reacts faster than the tier governor (0.75 s against 2 s), so a brief dip
 * costs resolution rather than particles or bloom.
 */

export interface ResolutionGovernor {
  /** Feed one frame's duration in seconds; returns a new scale when it changes, else null. */
  sample(frameSeconds: number): number | null;
  /** Ignore the next few seconds (a chapter is loading and compiling). */
  holdOff(): void;
  readonly scale: number;
}

const MIN_SCALE = 0.6;
/** Frames slower than this (seconds, ~50 fps) count as slow. */
const SLOW = 1 / 50;
/** Frames faster than this (~58 fps) count as comfortable. */
const COMFORTABLE = 1 / 58;
/** Smoothing of the frame-time average (seconds). */
const AVERAGE_SECONDS = 0.25;
const DOWN = { after: 0.75, factor: 0.88, cooldown: 1.5 } as const;
const UP = { after: 6, factor: 1.07, cooldown: 4 } as const;
/** A probe upward is judged over this long; a failed one locks the scale for LOCK seconds. */
const PROBE_SECONDS = 2;
const LOCK_SECONDS = 20;
const HOLD_OFF_SECONDS = 3;

export function createResolutionGovernor(options: { enabled: boolean }): ResolutionGovernor {
  let scale = 1;
  let average = 1 / 60;
  let slowFor = 0;
  let comfortableFor = 0;
  let cooldown = 0;
  let lockedFor = 0;
  let holdOff = HOLD_OFF_SECONDS;
  /** Scale before the current probe upward, while it is being judged. */
  let probeFrom: number | null = null;
  let probeLeft = 0;

  const set = (next: number): number => {
    scale = Math.min(1, Math.max(MIN_SCALE, next));
    slowFor = 0;
    comfortableFor = 0;
    return scale;
  };

  return {
    get scale() {
      return scale;
    },
    holdOff() {
      holdOff = HOLD_OFF_SECONDS;
      slowFor = 0;
      comfortableFor = 0;
    },
    sample(frameSeconds) {
      if (!options.enabled || !(frameSeconds > 0)) return null;
      const dt = Math.min(frameSeconds, 0.25);
      average += (dt - average) * (1 - Math.exp(-dt / AVERAGE_SECONDS));
      if (holdOff > 0) {
        holdOff -= dt;
        return null;
      }
      cooldown = Math.max(0, cooldown - dt);
      lockedFor = Math.max(0, lockedFor - dt);
      slowFor = average > SLOW ? slowFor + dt : 0;
      comfortableFor = average < COMFORTABLE ? comfortableFor + dt : 0;

      if (probeFrom !== null) {
        probeLeft -= dt;
        if (slowFor > DOWN.after / 2) {
          // The probe made frames slow: undo it and leave the scale alone for a while.
          const back = probeFrom;
          probeFrom = null;
          lockedFor = LOCK_SECONDS;
          cooldown = DOWN.cooldown;
          return set(back);
        }
        if (probeLeft <= 0) probeFrom = null;
      }

      if (cooldown > 0) return null;
      if (slowFor >= DOWN.after && scale > MIN_SCALE) {
        cooldown = DOWN.cooldown;
        probeFrom = null;
        return set(scale * DOWN.factor);
      }
      if (comfortableFor >= UP.after && scale < 1 && lockedFor <= 0) {
        cooldown = UP.cooldown;
        probeFrom = scale;
        probeLeft = PROBE_SECONDS;
        return set(scale * UP.factor);
      }
      return null;
    },
  };
}
