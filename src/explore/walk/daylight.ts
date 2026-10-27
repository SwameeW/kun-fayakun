import { heldStarLight, STARLIGHT, starLight, starlightUniforms } from '../starlight';
import type { SkyKind } from './sky';

/**
 * The stars by day and night on foot, by the Sun's height above the horizon (degrees): the sky hides
 * the stars (and the planets' points, and their names) until the Sun is 4 degrees down (the brightest
 * show at the end of civil twilight) and lets them all through by 12 (nautical twilight's end). By
 * night they are held short of white (NIGHT_STARS); on an airless world the sunlit ground's glare dims
 * them by day (AIRLESS_DAY). The day's light itself, and what the eye adapts to, is ./light's.
 */

export const DAYLIGHT = {
  /** The Sun's height (degrees) above which the day sky hides every star, and below which all show. */
  starsGoneDeg: -4,
  starsAllDeg: -12,
} as const;

/**
 * By night on foot, the eye adapted to the dark (illustrative): a star of `magnitude` shows at most `peak`
 * on its brightest pixel (linear, on the screen, after the exposure: about 197 of 255 through the tone
 * curve), and every other star is dimmed with it by one multiple, so the stars keep their order. The
 * sky's stars follow a fifth of the eye's exposure (../index STARS), and the night's on foot is far above
 * the orbit's (39 on Mercury, 64 on the Earth and Mars, 384 on the Moon's dark mare, against about 1 near
 * the Earth), which put every star brighter than about magnitude 5.5 near white, its colour lost: looking
 * 30 degrees up away from the set Sun at Apollo 11's site, 140 of 892 lit spots (luma 64 or more) were 200
 * or more. Held so, near white are only the stars brighter than about magnitude 2.5 to 3.4 (as each falls
 * on its pixels: 92 to 257 in the whole sky, half of them up at once) and the planets, a first-magnitude
 * star keeps its colour, and the many faint ones are still seen: there, 6 of 561, the stars on the screen
 * as from orbit with a fifth less light (and no halo: a star's core stays far under its cap, ../starlight
 * CORE_MAX). Which are drawn is judged on the screen (../starlight StarScreen): judged before the
 * exposure, at 384 nothing fainter than about magnitude 5 was drawn (207 lit there, none under 64).
 */
export const NIGHT_STARS = { magnitude: 3.5, peak: 0.5 } as const;

/**
 * On an airless world by day, the sunlit ground's glare (illustrative). `stars` is the share of the
 * planets' points' and names' light that shows past it. `starPeak` is the most light any star's
 * brightest pixel shows on the screen (linear, after the exposure): about 197 of 255 through the tone
 * curve (Sirius, bluish, 174), short of the sky's white. The walk holds the sky's brightest star to it
 * (footStarLight) and every fainter star less, by up to `lift` (a knee: ../starlight kneedStarLight), so
 * a handful are seen, each still in its order and none brighter than by night: facing the Sun, 30 degrees
 * up, at Apollo 11's site, 7 lit spots (one a planet), where every star dimmed with the brightest left 3
 * (a second-magnitude star at 69 of 255 centred, now 103; magnitude 6.5 at 4, now 11, all but black). A
 * share alone is not enough: the explorer's star light (../starlight) keeps faint stars above the tone
 * curve's black and puts the brightest near white (312 lit there). All of it comes in as the eye adapts
 * to the day (./light dayAdaptation), so nothing steps at sunrise or sunset.
 */
export const AIRLESS_DAY = { stars: 0.35, starPeak: 0.5, lift: 2 } as const;

/** Hermite step from 0 at a to 1 at b (either way round). */
function step(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** How much starlight the sky lets through: 1 at night, 0 by day. */
export function starlight(elevationDeg: number): number {
  return step(DAYLIGHT.starsGoneDeg, DAYLIGHT.starsAllDeg, elevationDeg);
}

/**
 * How much of the planets' points' and names' light shows on foot under a sky of this kind, the Sun
 * `sunDeg` high and the eye adapted to the day by `day` (0 to 1, ./light dayAdaptation): the day and the
 * twilight hide them (starlight); on an airless world the sunlit ground's glare leaves a share
 * (AIRLESS_DAY), eased in as the eye adapts, so it never steps as the Sun crosses the horizon; under
 * Venus's clouds none.
 */
export function pointsSeen(kind: SkyKind, sunDeg: number, day: number): number {
  if (kind === 'airless') return AIRLESS_DAY.stars ** day;
  return kind === 'venus' ? 0 : starlight(sunDeg);
}

/** The sky's stars on foot, as ../sky setLight takes them: their light (a multiple of the star light's, before the exposure) and the knee on the brightest (../starlight StarScreen). */
export interface FootStars {
  light: number;
  knee: number;
}

/**
 * The sky's stars on foot (into `out`), from the explorer's light (`light`, which follows a fifth of the
 * eye's `exposure`) at `dpr` pixels a CSS pixel: held by night (NIGHT_STARS), every star by one
 * multiple, the brightest drawn (Sirius, of magnitude `brightest`) never past its core's cap (no halo,
 * even while the eye is still opening after sunset); then dimmed by the sky's own light as the planets'
 * points are (the day and the twilight hide them), except on an airless world, where instead the sunlit
 * ground's glare holds the brightest at AIRLESS_DAY's peak and the fainter less (its lift, by a knee) as
 * far as the eye has adapted to the day (`day`, 0 to 1: one weight for the glare and the exposure, so
 * nothing steps at sunrise or sunset). Each hold is in display terms, so the stars look the same at any
 * exposure and pixel density, and each only ever dims them.
 */
export function footStarLight(kind: SkyKind, sunDeg: number, day: number, light: number, exposure: number, dpr: number, brightest: number, out: FootStars = { light: 0, knee: 0 }): FootStars {
  const { faintest, brightness } = starlightUniforms;
  const top = starLight(brightest, faintest.value, brightness.value);
  const night = heldStarLight(heldStarLight(light, starLight(NIGHT_STARS.magnitude, faintest.value, brightness.value), NIGHT_STARS.peak / exposure, 1, dpr), top, STARLIGHT.coreMax, 1, dpr);
  out.knee = 0;
  if (kind !== 'airless') {
    out.light = night * pointsSeen(kind, sunDeg, day);
    return out;
  }
  // The brightest held at the glare's peak; every fainter star lifted toward the night's by up to the
  // lift, eased in with the day, the knee bending the brightest back to where the hold put it.
  const held = heldStarLight(night, top, AIRLESS_DAY.starPeak / exposure, day, dpr);
  const lift = held > 0 ? Math.max(1, Math.min(AIRLESS_DAY.lift ** Math.min(1, Math.max(0, day)), night / held)) : 1;
  out.light = held * lift;
  if (lift > 1 && top > 0) out.knee = (lift - 1) / (top * out.light);
  return out;
}
