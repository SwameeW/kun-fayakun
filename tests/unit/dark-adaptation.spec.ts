/**
 * The Earth's night side as a camera exposed for what is in view records it (src/explore/bodies/earth.ts
 * litShare, darkAdaptation): from afar the lit share is the phase's illuminated fraction; from low
 * orbit only the cap in view counts; the dark-adapted look (moonlit night side, airglow) only while the
 * night fills the view, none once a few percent of the disc is in sunlight.
 */
import { expect, test } from '@playwright/test';
import { darkAdaptation, litShare } from '../../src/explore/bodies/earth';

const SUN = { x: 0, y: 0, z: 1 };
/** An eye `radii` from the centre at `phaseDeg` from the Sun's direction. */
const eye = (radii: number, phaseDeg: number): { x: number; y: number; z: number } => {
  const a = (phaseDeg * Math.PI) / 180;
  return { x: Math.sin(a) * radii, y: 0, z: Math.cos(a) * radii };
};

test('from afar the lit share is the phase’s illuminated fraction', () => {
  for (const phase of [0, 30, 60, 90, 120, 150, 175]) {
    const k = (1 + Math.cos((phase * Math.PI) / 180)) / 2;
    expect(litShare(eye(1e6, phase), SUN)).toBeCloseTo(k, 4);
  }
});

test('from low orbit only the cap in view counts', () => {
  // 300 km up over the night side, the terminator below the horizon: nothing lit in view, though the phase angle is only 120 degrees.
  expect(litShare(eye(1 + 300 / 6371, 120), SUN)).toBe(0);
  // Over the day side, all of it.
  expect(litShare(eye(1 + 300 / 6371, 30), SUN)).toBe(1);
  // Over the terminator, part of it, more of it as the eye moves sunward.
  const across = [95, 90, 85].map((p) => litShare(eye(1 + 300 / 6371, p), SUN));
  expect(across[0]).toBeGreaterThan(0);
  expect(across[1]).toBeGreaterThan(across[0] ?? 1);
  expect(across[2]).toBeGreaterThan(across[1] ?? 1);
  expect(across[2]).toBeLessThan(1);
});

test('the dark-adapted look only while the night fills the view', () => {
  // The explorer's views (tests/visual): the night side from 30,000 km keeps it; a crescent from 45,000 km and anything more lit does not.
  expect(darkAdaptation(litShare(eye(30_000 / 6371, 160), SUN))).toBe(1);
  expect(darkAdaptation(litShare(eye(45_000 / 6371, 145), SUN))).toBeLessThan(0.01);
  expect(darkAdaptation(litShare(eye(45_000 / 6371, 75), SUN))).toBe(0);
  // Eased between, never rising as more of the disc is lit.
  let last = 1;
  for (let s = 0; s <= 0.1; s += 0.005) {
    const d = darkAdaptation(s);
    expect(d).toBeLessThanOrEqual(last);
    last = d;
  }
});
