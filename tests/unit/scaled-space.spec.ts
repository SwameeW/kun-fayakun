/**
 * Scaled space (src/explore/space/scaled-space.ts): bodies beyond half the far plane are drawn
 * nearer and smaller by the same factor, which a perspective camera cannot tell from the truth.
 */
import { expect, test } from '@playwright/test';
import { km, length, type Km } from '../../src/explore/space/origin';
import { placeScaled, scaledFactor, SCALED } from '../../src/explore/space/scaled-space';

const AU_KM = 149_597_870.7;

const angularRadius = (radius: number, distance: number): number => Math.asin(Math.min(1, radius / distance));

test('the remap keeps every body’s angular size within 1e-6 rad and its direction exactly', () => {
  const fars = [2e4, 1.2e6, 1.1e8, 2e9];
  const bodies: Array<[Km, number]> = [
    [km(AU_KM, 0, 0), 695_700],
    [km(-3e8, 4e8, -1.2e8), 71_492],
    [km(1.2e9, -3e8, 7e8), 144_987.5],
    [km(384_400, 0, 1_000), 1_737.4],
    [km(6e10, 1e10, -2e10), 695_700],
  ];
  for (const far of fars) {
    for (const [rel, radius] of bodies) {
      const drawn = km();
      const k = placeScaled(rel, radius, far, drawn);
      const d = length(rel);
      const dDrawn = length(drawn);
      expect(Math.abs(angularRadius(radius * k, dDrawn) - angularRadius(radius, d)), `far ${far}`).toBeLessThan(1e-6);
      const cos = (rel.x * drawn.x + rel.y * drawn.y + rel.z * drawn.z) / (d * dDrawn);
      expect(1 - cos).toBeLessThan(1e-12);
    }
  }
});

test('within half the far plane nothing moves; beyond it, bodies land between 0.5 and 0.95 of it', () => {
  const far = 1e6;
  expect(scaledFactor(1e5, 6_378, far)).toBe(1);
  expect(scaledFactor(far * SCALED.start - 10, 5, far)).toBe(1);
  for (const d of [6e5, 1e6, 1e7, 1e9, 1e11, 1e13]) {
    const k = scaledFactor(d, 1_000, far);
    expect(k).toBeLessThan(1);
    expect(d * k).toBeGreaterThanOrEqual(SCALED.start * far);
    expect(d * k * (1 + 1_000 / d)).toBeLessThanOrEqual(SCALED.cap * far + 1e-6);
  }
});

test('nearer bodies stay in front of farther ones (out to the remap’s horizon, about 670 au)', () => {
  const far = 5e7;
  let previous = 0;
  for (let d = 2.6e7; d < SCALED.maxDistanceKm; d *= 1.37) {
    const placed = d * scaledFactor(d, 0, far);
    expect(placed).toBeGreaterThan(previous);
    previous = placed;
  }
});

test('a point (radius 0) moves continuously across the start of scaled space', () => {
  const far = 1e6;
  const edge = SCALED.start * far;
  const inside = (edge - 1e-3) * scaledFactor(edge - 1e-3, 0, far);
  const outside = (edge + 1e-3) * scaledFactor(edge + 1e-3, 0, far);
  expect(Math.abs(outside - inside)).toBeLessThan(0.01);
});
