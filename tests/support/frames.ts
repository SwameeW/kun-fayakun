/**
 * Synthetic frame-time traces for the governor unit tests: what rAF would report on a
 * given display and load, without a browser. All times are in seconds.
 */

export type Trace = (elapsed: number) => number;

/** Steady frames at `hz`, with ±`jitterMs` of deterministic timer noise. */
export function steady(hz: number, jitterMs = 0, seed = 1): Trace {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32: reproducible noise, so a failure replays exactly.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const unit = state / 0xffffffff - 0.5;
    return 1 / hz + (unit * 2 * jitterMs) / 1000;
  };
}

/** A fixed frame time in milliseconds (a GPU-bound scene that does not depend on scale). */
export function constant(ms: number): Trace {
  return () => ms / 1000;
}

/** Feeds `seconds` of a trace to `sample`, calling `observe` after every frame. */
export function play(seconds: number, trace: Trace, sample: (dt: number) => void, observe?: (elapsed: number) => void): void {
  let elapsed = 0;
  while (elapsed < seconds) {
    const dt = trace(elapsed);
    sample(dt);
    elapsed += dt;
    observe?.(elapsed);
  }
}
