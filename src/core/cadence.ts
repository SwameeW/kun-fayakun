/**
 * The frame interval the display actually allows, shared by both governors.
 *
 * rAF normally runs at the display's refresh rate, but some setups cap it at 30 Hz
 * (Low Power Mode on Apple devices, battery savers, 30 Hz displays). A capped rAF
 * delivers steady 33 ms frames however light the scene is, so judging them against
 * 60 fps would make the governors give up resolution and effects for nothing.
 *
 * The cadence is learned as the fastest sustained frame rate seen so far, snapped to
 * 60 or 30 Hz. The home screen and loading frames are light, so a GPU that merely
 * struggles with a chapter still shows its 60 Hz display there; displays faster than
 * 60 Hz keep the 60 fps target they always had.
 */

export interface FrameCadence {
  /** Feed one frame's duration in seconds. */
  sample(frameSeconds: number): void;
  /** Target frame interval in seconds: 1/60, or 1/30 while rAF has never run faster than 30 Hz. */
  readonly interval: number;
}

/** Frames longer than this (seconds) are stalls (tab switch, GC, shader compile) and say nothing about the display. */
export const STALL_SECONDS = 0.25;

const FRAME_60HZ = 1 / 60;
const FRAME_30HZ = 1 / 30;
/** A sustained average at or above this reads as a 30 Hz cap (5% below 1/30 s, for timer jitter). */
const CAPPED_AT_30HZ = 0.95 / 30;
/** Smoothing of the frame-time average (seconds), so single quick frames cannot teach a faster cadence. */
const AVERAGE_SECONDS = 0.25;
/** Seconds of frames before the average is trusted. */
const SETTLE_SECONDS = 0.5;

export function createFrameCadence(): FrameCadence {
  let average = 0;
  let observed = 0;
  let fastest = Infinity;

  return {
    get interval() {
      return fastest !== Infinity && fastest >= CAPPED_AT_30HZ ? FRAME_30HZ : FRAME_60HZ;
    },
    sample(frameSeconds) {
      if (!(frameSeconds > 0) || frameSeconds > STALL_SECONDS) return;
      average = observed === 0 ? frameSeconds : average + (frameSeconds - average) * (1 - Math.exp(-frameSeconds / AVERAGE_SECONDS));
      observed += frameSeconds;
      if (observed >= SETTLE_SECONDS) fastest = Math.min(fastest, average);
    },
  };
}
