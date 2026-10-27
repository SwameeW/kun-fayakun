/**
 * The stars by day and night on foot, by the Sun's height above the horizon (degrees): the sky hides
 * the stars (and the planets' points, and their names) until the Sun is 4 degrees down (the brightest
 * show at the end of civil twilight) and lets them all through by 12 (nautical twilight's end). The
 * day's light itself, and what the eye adapts to, is ./light's.
 */

export const DAYLIGHT = {
  /** The Sun's height (degrees) above which the day sky hides every star, and below which all show. */
  starsGoneDeg: -4,
  starsAllDeg: -12,
} as const;

/** Hermite step from 0 at a to 1 at b (either way round). */
function step(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** How much starlight the sky lets through: 1 at night, 0 by day. */
export function starlight(elevationDeg: number): number {
  return step(DAYLIGHT.starsGoneDeg, DAYLIGHT.starsAllDeg, elevationDeg);
}
