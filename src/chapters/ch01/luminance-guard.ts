/**
 * Keeps seeks flash-safe. The picture is a pure function of chapter time, so
 * scrubbing the timeline could otherwise jump the screen between darkness and
 * the bright glow many times a second. The guard follows estimates of the
 * scene's brightness and returns a gain (≤ 1) that lets each of them rise no
 * faster than the engine's own exposure limiter allows (src/core/post.ts);
 * falls are immediate. In normal playback the scene already changes more
 * slowly than this, so the gain stays at 1 apart from slightly softening the
 * glow's swell.
 *
 * Several estimates (channels) are guarded together because a seek can make
 * one fall while another rises: from the dim, uniform glow back to the
 * swelling orb the screen's mean brightness falls, but the region around the
 * light brightens a lot. The channel that is held back most sets the gain for
 * the whole picture, and every channel then remembers what is actually shown.
 *
 * Why falls may be instant: this scene's brightest state stays under ~0.2
 * relative luminance (full screen) and ~0.1 around the light, so a flash
 * (opposing changes of ≥ 0.1 each) needs a rise of more than a stop from a
 * channel's black level, which takes ≥ 0.7 s here; that is well under three
 * flashes per second.
 */

const RISE_STOPS_PER_SECOND = 1.4;
const REDUCED_MOTION_SCALE = 0.75;
/** Default black level: brightness below 2^-10 counts as black. */
const DEFAULT_BLACK = 2 ** -10;

export interface LuminanceGuard {
  /** Forget the history: the next sample is shown as is (the screen is dark after a chapter change anyway). */
  reset(): void;
  /** Gain to apply this frame for a scene whose brightness estimates (one per channel, in order) would be `targets`. */
  gain(targets: readonly number[], realSeconds: number, reducedMotion: boolean): number;
}

/**
 * `blacks[i]` is the brightness, in channel i's own units, below which that channel counts as
 * black: changes below it are too small to matter, so rising from it is never held back.
 */
export function createLuminanceGuard(blacks: readonly number[] = [DEFAULT_BLACK]): LuminanceGuard {
  const floors = blacks.map((black) => Math.log2(black));
  const floor = (i: number): number => floors[i] ?? Math.log2(DEFAULT_BLACK);
  let shown: number[] | null = null;
  return {
    reset() {
      shown = null;
    },
    gain(targets, realSeconds, reducedMotion) {
      const goals = targets.map((value, i) => Math.max(floor(i), Math.log2(Math.max(value, Number.MIN_VALUE))));
      const rise = RISE_STOPS_PER_SECOND * (reducedMotion ? REDUCED_MOTION_SCALE : 1) * Math.max(0, realSeconds);
      const previous = shown !== null && shown.length === goals.length ? shown : null;
      // Stops (≤ 0) by which the picture is held below its goal: the most that any channel needs.
      let held = 0;
      if (previous) {
        goals.forEach((goal, i) => {
          const before = previous[i] ?? goal;
          held = Math.min(held, Math.min(goal, before + rise) - goal);
        });
      }
      shown = goals.map((goal, i) => Math.max(floor(i), goal + held));
      return 2 ** held;
    },
  };
}
