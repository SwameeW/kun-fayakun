/**
 * Scaled space: how bodies beyond the depth range are drawn. Pure, like ./origin.
 *
 * The far plane follows the camera (./lens), so from 200 km above the Earth it is about 1.6
 * million km away and the Sun, at 150 million km, is far beyond it. Such a body is moved toward
 * the camera along its true direction and shrunk by the same factor k: drawn at position x k with
 * radius x k. A perspective camera sees only directions, so its outline on screen is exactly the
 * true one (angular size asin(R k / d k) = asin(R / d)), and its shading, done in the body's own
 * unit-radius frame, does not change at all.
 *
 * Bodies whose bounding sphere starts beyond half the far plane are placed between 0.5 and 0.95 of
 * it, by the logarithm of their distance, so nearer ones stay in front of farther ones; none reaches
 * past 0.95 (the starfield sits at 0.98). Orbit lines get the same per-point remap with a zero radius.
 */

import { length, type Km } from './origin';

export const SCALED = {
  /** Bodies whose bounding sphere starts beyond this share of the far plane are pulled in. */
  start: 0.5,
  /** They land between `start` and `start + span` of the far plane, by log distance. */
  span: 0.45,
  /** Nothing reaches beyond this share of the far plane. */
  cap: 0.95,
  /** The distance that maps to `start + span` (about 670 au, far beyond the planets). */
  maxDistanceKm: 1e11,
} as const;

/**
 * The factor k to draw an object k times nearer and k times smaller: 1 while its bounding sphere
 * (radius `bound`, centre `d` km from the camera) starts within half the far plane.
 */
export function scaledFactor(d: number, bound: number, far: number): number {
  const start = SCALED.start * far;
  if (!(d > 0) || d - bound <= start) return 1;
  const range = Math.log(Math.max(SCALED.maxDistanceKm / start, Math.E));
  const s = Math.min(1, Math.max(0, Math.log(d / start) / range));
  const placed = Math.min(far * (SCALED.start + SCALED.span * s), (SCALED.cap * far) / (1 + bound / d));
  return placed / d;
}

/** Writes where an object at camera-relative `rel` is drawn; returns k (scale its size by it too). */
export function placeScaled(rel: Km, bound: number, far: number, out: Km): number {
  const k = scaledFactor(length(rel), bound, far);
  out.x = rel.x * k;
  out.y = rel.y * k;
  out.z = rel.z * k;
  return k;
}
