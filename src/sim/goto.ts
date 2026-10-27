import type { Engine } from './engine';

/**
 * A goto in the laboratory (./worker): where the run, which moves only by whole steps, ends when it is
 * sent to a moment, and the span a date's goto must end in.
 *
 * It ends on the first whole step at or past the moment (the last one short of it could be most of a
 * day before, with long steps: another date). A date is asked for with the clock's time of day, so
 * that alone would not keep it on its day: late in the day, the first step past the moment can be
 * the next day's (with steps of 14 hours, any moment after the day's last step; with steps of an
 * hour, one a minute before midnight). So a date's goto is also kept to its day (`Within`): a step
 * that would end past the day is not taken, and the goto ends on the day's last step. Any step no
 * longer than a day leaves at least one step inside every day; a longer step (a file's own
 * integrator) can pass over a whole day, and then the goto ends on whichever of the two steps
 * about the day is nearer it.
 */

/** A span of simulated time a goto must end in: s since the epoch, from `lo` up to (not including) `hi`. */
export type Within = readonly [lo: number, hi: number];

/**
 * The next move of a goto to `to` from simulated time `t`, the next whole step ending at `next`:
 * 'step' and go on, take this step and stop there ('last'), or 'stop' here.
 */
export function gotoMove(t: number, next: number, to: number, within: Within | null): 'step' | 'last' | 'stop' {
  if (t >= to) return 'stop';
  if (!within || next < within[1]) return 'step';
  // The step would end past the span: stop on its last step, or (one step over the whole span) on the nearer side.
  if (t >= within[0]) return 'stop';
  return next - within[1] < within[0] - t ? 'last' : 'stop';
}

/** A span the goto to `to` can be kept to (finite, not empty, and holding `to`), or null. */
export function validWithin(within: unknown, to: number): Within | null {
  if (!Array.isArray(within) || within.length !== 2) return null;
  const [lo, hi] = within as unknown[];
  return typeof lo === 'number' && typeof hi === 'number' && Number.isFinite(lo) && Number.isFinite(hi) && lo <= to && to < hi ? [lo, hi] : null;
}

/**
 * Runs a goto on `e` a whole step at a time (`stepOn`: the worker's, which keeps the run's recent
 * states) while `more()` allows; true once it has ended (there, kept to its span, or stopped by a
 * failure), false when it must go on later.
 */
export function seekOn(e: Engine, to: number, within: Within | null, stepOn: (e: Engine) => void, more: () => boolean): boolean {
  for (;;) {
    if (e.failure || e.state.t >= to) return true;
    const move = gotoMove(e.state.t, e.state.t + e.nextStepS(), to, within);
    if (move === 'stop') return true;
    if (!more()) return false;
    stepOn(e);
    if (move === 'last') return true;
  }
}

/**
 * The UTC day a moment falls on (Julian date, UTC) as a span of the experiment's clock (s since
 * `epochJdTdb`), with `tdbOf` turning a UTC Julian date into the TDB one as the clock is drawn.
 */
export function dayWithin(jdUtc: number, epochJdTdb: number, tdbOf: (jdUtc: number) => number): Within {
  const start = Math.floor(jdUtc - 0.5) + 0.5;
  return [(tdbOf(start) - epochJdTdb) * 86_400, (tdbOf(start + 1) - epochJdTdb) * 86_400];
}
