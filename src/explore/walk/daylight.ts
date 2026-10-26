/**
 * The light of the day on foot, by the Sun's height above the horizon (degrees): what the walker's
 * eyes adapt to, so a low Sun's sky is not drawn as dark as a fixed exposure would leave it (the
 * explorer's own exposure is set by the distance from the Sun, not by the hour). Illustrative, as the
 * sky model is: the shape of a day's light, not a measurement of the day's real air.
 *
 * - The daylight sky (./sky, Preetham's model) is brightened as its Sun's intensity falls (about
 *   fifteenfold from the Sun at 42 degrees to the horizon), at most twentyfold; its sky still darkens
 *   faster than its Sun dims, so at sunset it is drawn about a quarter as bright overhead as by day.
 * - That model has no twilight (its Sun's light ends 2.3 degrees below the horizon), so twilight is a
 *   gradient of its own: blue overhead, a warm glow on the horizon under the Sun, dimming as the Sun
 *   goes down.
 * - The sky hides the stars until the Sun is 4 degrees down (the brightest show at the end of civil
 *   twilight) and lets them all through by 12 (nautical twilight's end).
 * - The ground's ambient light (the sky's fill) follows the same adapted level, down to a faint floor
 *   at night, so the land stays a shape against the stars; the haze (the air's own light between the
 *   walker and the distance) goes sooner, mostly gone a few degrees after sunset.
 */

export const DAYLIGHT = {
  /** The Sun's height (degrees) above which the day sky hides every star, and below which all show. */
  starsGoneDeg: -4,
  starsAllDeg: -12,
  /** The Sun's height (degrees) the sky is scaled at (./sky SKY_SCALE), and the most the eye makes up for its fall since. */
  referenceDeg: 42,
  maxGain: 20,
  /** The ground's ambient level: full from this height, falling to `night` below `nightDeg`. */
  fullDeg: 10,
  nightDeg: -12,
  night: 0.06,
  /** The haze: full from `fullDeg`, all but gone (to `hazeNight`) by this height. */
  hazeGoneDeg: -8,
  hazeNight: 0.01,
} as const;

/** Hermite step from 0 at a to 1 at b (either way round). */
function step(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Preetham's Sun intensity for a Sun this high (three.js SkyMesh's cutoff and steepness). */
export function preethamSunIntensity(elevationDeg: number): number {
  const zenith = Math.PI / 2 - (elevationDeg * Math.PI) / 180;
  return 1000 * Math.max(0, 1 - Math.exp(-(1.6110731556870734 - zenith) / 1.5));
}

/** How much starlight the sky lets through: 1 at night, 0 by day. */
export function starlight(elevationDeg: number): number {
  return step(DAYLIGHT.starsGoneDeg, DAYLIGHT.starsAllDeg, elevationDeg);
}

/** The daylight sky's brightening for the eye's adaptation: 1 at the reference height and above. */
export function skyGain(elevationDeg: number): number {
  const reference = preethamSunIntensity(DAYLIGHT.referenceDeg);
  const now = preethamSunIntensity(elevationDeg);
  if (now <= 0) return DAYLIGHT.maxGain;
  return Math.min(DAYLIGHT.maxGain, Math.max(1, reference / now));
}

/** The ground's adapted ambient level (1 by day, `night` at night). */
export function ambient(elevationDeg: number): number {
  return DAYLIGHT.night + (1 - DAYLIGHT.night) * step(DAYLIGHT.nightDeg, DAYLIGHT.fullDeg, elevationDeg);
}

/** The haze's adapted level (1 by day, `hazeNight` at night): it fades faster than the sky's fill. */
export function haze(elevationDeg: number): number {
  const day = step(DAYLIGHT.hazeGoneDeg, DAYLIGHT.fullDeg, elevationDeg);
  return DAYLIGHT.hazeNight + (1 - DAYLIGHT.hazeNight) * day * day;
}

type Rgb = [number, number, number];

/**
 * Twilight's own sky (linear colour, the explorer's scale): overhead, on the horizon, and the glow on
 * the horizon under the Sun. None while the Sun is well up; in as the daylight model's light ends.
 */
export function twilight(elevationDeg: number): { zenith: Rgb; horizon: Rgb; glow: Rgb } {
  const e = elevationDeg;
  const on = 1 - step(-2.3, 3, e);
  // Dimming with the Sun's depression: about e-fold each 2.5 degrees overhead, each 2 in the glow.
  const dim = on * Math.exp(Math.min(0, e + 2) / 2.5);
  const glow = on * Math.exp(Math.min(0, e + 1) / 2);
  const scale = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];
  return { zenith: scale([0.0075, 0.0135, 0.03], dim), horizon: scale([0.0105, 0.012, 0.0165], dim), glow: scale([0.12, 0.054, 0.018], glow) };
}
