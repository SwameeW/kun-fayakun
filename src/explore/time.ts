/**
 * The explorer's time machine: how fast its clock runs (explorer seconds for each real second),
 * forwards or backwards, paused or running, stepped along a ladder of rates from real time to thirty
 * days a second. Everything the explorer shows follows the clock: the worlds along their orbits, the
 * Moon's phase, each world's turn, day and night, eclipses, the day's imagery of the Earth.
 *
 * The clock stays inside the data's span (the Moon's table, 2026 to 2035; planets.json is good for
 * longer): it stops at either end. During a trip it runs at real time, so the destination does not
 * race away from the camera.
 */

/** Explorer seconds per real second, smallest first: real time, then ten seconds, a minute, ten minutes, an hour, six hours, a day, a week, thirty days. */
export const TIME_RATES = [1, 10, 60, 600, 3600, 21_600, 86_400, 604_800, 2_592_000] as const;

export type TimeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week';

/** The rung of the ladder nearest a rate's size. */
function rung(rate: number): number {
  const size = Math.abs(rate);
  let best = 0;
  TIME_RATES.forEach((r, i) => {
    if (Math.abs(Math.log(r / Math.max(size, 1e-9))) < Math.abs(Math.log((TIME_RATES[best] ?? 1) / Math.max(size, 1e-9)))) best = i;
  });
  return best;
}

const direction = (rate: number): number => (rate < 0 ? -1 : 1);

/** One rung faster, in the same direction (the fastest stays fastest). */
export function fasterRate(rate: number): number {
  return direction(rate) * (TIME_RATES[Math.min(TIME_RATES.length - 1, rung(rate) + 1)] ?? 1);
}

/** One rung slower, in the same direction (never slower than real time). */
export function slowerRate(rate: number): number {
  return direction(rate) * (TIME_RATES[Math.max(0, rung(rate) - 1)] ?? 1);
}

/** A rate in words' parts: how many of which unit pass each real second (1 second is real time). */
export function rateParts(rate: number): { count: number; unit: TimeUnit } {
  const size = Math.abs(rate);
  if (size >= 604_800 && size % 604_800 === 0) return { count: size / 604_800, unit: 'week' };
  if (size >= 86_400 && size % 86_400 === 0) return { count: size / 86_400, unit: 'day' };
  if (size >= 3600 && size % 3600 === 0) return { count: size / 3600, unit: 'hour' };
  if (size >= 60 && size % 60 === 0) return { count: size / 60, unit: 'minute' };
  return { count: size, unit: 'second' };
}

/**
 * The clock's next date (Julian days) after `dtSeconds` of real time at `rate`, kept in [start, end],
 * and which end it stopped at (null if neither).
 */
export function advanceClock(jd: number, dtSeconds: number, rate: number, start: number, end: number): { jd: number; edge: 'start' | 'end' | null } {
  const next = jd + (dtSeconds * rate) / 86_400;
  if (next >= end) return { jd: end, edge: rate > 0 ? 'end' : null };
  if (next <= start) return { jd: start, edge: rate < 0 ? 'start' : null };
  return { jd: next, edge: null };
}
