import type { BodyId } from '../core/types';

/**
 * The way in from Chapter 7: the film's solar system, compressed so that every orbit fits, stretches
 * out to true scale in front of the visitor. Distances go from the film's (the square root of the
 * distance) to the real ones, sizes from the film's enlarged ones down to the real ones (the worlds
 * shrink to points of light), and sunlight from the film's (every world lit alike) to its real
 * falloff with distance. Then the view flies on to the Earth. It happens only on the way in from that
 * chapter and never under reduced motion; otherwise the explorer opens at true scale, as it does
 * from anywhere else.
 *
 * The film's proportions are Chapter 7's own (src/chapters/ch07/ephemeris.ts DISTANCE_SCALE, and the
 * radii and the Moon's orbit in src/chapters/ch07/scene.ts), copied here so the explorer's chunk does
 * not load the chapter. The film's scene unit is set so that Saturn's orbit keeps its size: the
 * stretch pulls the inner worlds in toward the Sun instead of pushing Saturn out of the frame.
 * Every quantity is blended in log space, so a factor of a thousand changes as smoothly as a factor of two.
 */

/** Chapter 7's display, in its scene units: distance = distanceScale * sqrt(r / 1 au); radii; the Moon's orbit around the Earth. */
const FILM = {
  distanceScale: 1.25,
  radii: { sun: 0.32, earth: 0.05, moon: 0.014, jupiter: 0.13, saturn: 0.11 },
  moonOrbit: 0.16,
} as const satisfies { distanceScale: number; radii: Record<BodyId, number>; moonOrbit: number };

export const STRETCH = {
  /** The film's view holds this long (while the picture comes up), stretches over `seconds`, and rests `settle` before the flight on. */
  hold: 2.6,
  seconds: 6.5,
  settle: 0.9,
  /** A trip the visitor asks for meanwhile finishes the stretch over this long. */
  rush: 0.9,
  /** Where it is watched from: the Sun in the middle, from this far (times Saturn's orbit), this high above the ecliptic, turned from the Earth's side. */
  framing: 2.35,
  elevationDeg: 32,
  azimuthDeg: -28,
} as const;

/** a^(1-s) b^s: from a at s = 0 to b at s = 1, evenly in log space. */
function logMix(a: number, b: number, s: number): number {
  if (s >= 1) return b;
  if (s <= 0) return a;
  return Math.exp(Math.log(a) * (1 - s) + Math.log(b) * s);
}

/** The film's scene unit, km: the one in which Saturn's orbit (its semi-major axis, km) is drawn at its true size. */
export function filmUnitKm(saturnOrbitKm: number, auKm: number): number {
  return saturnOrbitKm / (FILM.distanceScale * Math.sqrt(saturnOrbitKm / auKm));
}

/** A world's distance from the Sun at stretch s (0 the film's, 1 true), km. */
export function stretchedDistance(trueKm: number, s: number, unitKm: number, auKm: number): number {
  if (trueKm <= 0) return 0;
  return logMix(FILM.distanceScale * Math.sqrt(trueKm / auKm) * unitKm, trueKm, s);
}

/** How many times its true radius a body is drawn at stretch s (1 at true scale). */
export function sizeFactor(id: BodyId, trueRadiusKm: number, s: number, unitKm: number): number {
  return logMix((FILM.radii[id] * unitKm) / trueRadiusKm, 1, s);
}

/** How many times its true distance from the Earth the Moon is drawn at stretch s. */
export function moonOffsetFactor(trueOffsetKm: number, s: number, unitKm: number): number {
  return trueOffsetKm > 0 ? logMix((FILM.moonOrbit * unitKm) / trueOffsetKm, 1, s) : 1;
}

/** Sunlight on a world at stretch s, given its true share of the Earth's: the film lights every world alike (1). */
export function stretchedLight(trueShare: number, s: number): number {
  return logMix(1, trueShare, s);
}

/** Eases the stretch's progress: slow to start and to end, so nothing jumps when it begins or stops. */
export function stretchEase(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u * u * u * (u * (u * 6 - 15) + 10);
}
