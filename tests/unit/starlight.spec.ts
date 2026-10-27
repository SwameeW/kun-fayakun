/**
 * Star light (src/explore/starlight.ts): the error function the shader approximates, each pixel's
 * share of a star integrated over its square, the same light wherever a star falls in a pixel and at
 * any pixel density, the faintest stars kept above the tone curve's black, and the visitor's settings;
 * a hold on the light (the brightest star held at a peak, the rest dimmed with it), and the walk's hold
 * by day on an airless world (src/explore/walk/daylight AIRLESS_DAY): only the brightest stars, none
 * near white.
 */
import { expect, test } from '@playwright/test';
import { erf, heldStarLight, pixelShare, setStarlight, STARLIGHT, starLight, starlightUniforms, starPeakPerLight, starPixels, starSharpness, STARLIGHT_DEFAULTS, STARLIGHT_RANGE } from '../../src/explore/starlight';
import { AIRLESS_DAY } from '../../src/explore/walk/daylight';

/** erf by its series (exact to 1e-15 here). */
function erfExact(x: number): number {
  let sum = 0;
  let term = x;
  for (let n = 0; Math.abs(term) > 1e-17; n += 1) {
    sum += term / (2 * n + 1);
    term *= (-x * x) / (n + 1);
  }
  return (2 / Math.sqrt(Math.PI)) * sum;
}

/** three's ACES filmic curve for grey light at exposure 1 (its input and output matrices keep grey grey), then sRGB's, as 0 to 255. */
function display(linear: number): number {
  const v = linear / 0.6;
  const fit = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const c = Math.max(0, Math.min(1, fit));
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(255 * s);
}

/** A seeded generator, for the sub-pixel places. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('the shader’s error function is within 4e-4 of the true one', () => {
  let worst = 0;
  for (let x = -4; x <= 4; x += 0.001) worst = Math.max(worst, Math.abs(erf(x) - erfExact(x)));
  expect(worst).toBeLessThan(4e-4);
});

test('a star’s light shared over pixels sums to it, for widths from 0.6 to 3 pixels', () => {
  for (const sigma of [0.6, 0.8, 1.2, 2, 3]) {
    for (const offset of [0, 0.25, 0.5]) {
      let sum = 0;
      for (let x = -20; x <= 20; x += 1) for (let y = -20; y <= 20; y += 1) sum += pixelShare(x - offset, sigma) * pixelShare(y - offset / 2, sigma);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-3);
    }
  }
});

test('the same light wherever a star falls inside a pixel, at any pixel density (no flicker as the view turns)', () => {
  const next = random(7);
  for (const dpr of [1, 1.5, 2]) {
    const light = starLight(6.5);
    const sums: number[] = [];
    for (let k = 0; k < 100; k += 1) sums.push(starPixels(light, dpr, next() - 0.5, next() - 0.5).perCss);
    const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
    for (const s of sums) expect(Math.abs(s - mean) / mean).toBeLessThan(0.05);
    // All of it, raised only by the documented sharpness (coarse pixels flatten a peak: at most a half more).
    expect(Math.abs(mean - light * starSharpness(dpr)) / light).toBeLessThan(0.01);
    expect(starSharpness(dpr)).toBeGreaterThanOrEqual(1);
    expect(starSharpness(dpr)).toBeLessThanOrEqual(1.5);
  }
});

test('the same faint stars seen at one and two device pixels per CSS pixel: the brightest pixel the same on average, the light on the same area of screen within a third', () => {
  const next = random(11);
  for (const v of [5, 6.5, 8]) {
    const light = starLight(v);
    const ratio = starPixels(light, 1).perCss / starPixels(light, 2).perCss;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.4);
    // The brightest pixel, on average over where the star falls, within a tenth: the same faint stars cross the tone curve's black.
    let one = 0;
    let two = 0;
    for (let k = 0; k < 200; k += 1) {
      one += starPixels(light, 1, next() - 0.5, next() - 0.5).peak;
      two += starPixels(light, 2, next() - 0.5, next() - 0.5).peak;
    }
    expect(one / two).toBeGreaterThan(0.9);
    expect(one / two).toBeLessThan(1.1);
  }
});

test('faint stars stay above the tone curve’s black: magnitude 6.5 at 30 or more of 255, magnitude 4 at 80 or more, at worst placed', () => {
  for (const dpr of [1, 2]) {
    expect(display(starPixels(starLight(6.5), dpr, 0.5, 0.5).peak)).toBeGreaterThanOrEqual(30);
    expect(display(starPixels(starLight(4), dpr, 0.5, 0.5).peak)).toBeGreaterThanOrEqual(80);
  }
  // A star a magnitude above the faintest drawn is still seen.
  expect(display(starPixels(starLight(STARLIGHT_DEFAULTS.faintest - 1), 1, 0.5, 0.5).peak)).toBeGreaterThanOrEqual(25);
});

test('brighter stars are brighter, fainter than the faintest are not drawn, and the visitor’s settings scale and cut', () => {
  let previous = Infinity;
  for (let v = -1.5; v < STARLIGHT_DEFAULTS.faintest; v += 0.25) {
    const l = starLight(v);
    expect(l).toBeLessThan(previous);
    previous = l;
  }
  expect(starLight(STARLIGHT_DEFAULTS.faintest + 0.01)).toBe(0);
  expect(starLight(Number.NaN)).toBe(0);
  expect(starLight(10, 12)).toBeGreaterThan(0);
  // The faintest magnitude only adds or takes away stars: a star drawn either way is as bright.
  for (const v of [-1, 2, 5, 7]) expect(starLight(v, 12.5)).toBeCloseTo(starLight(v, 8.5), 12);
  expect(starLight(5, 8.5, 2)).toBeCloseTo(2 * starLight(5), 12);
  setStarlight(100, -5);
  expect(starlightUniforms.brightness.value).toBe(STARLIGHT_RANGE.brightness[1]);
  expect(starlightUniforms.faintest.value).toBe(STARLIGHT_RANGE.faintest[0]);
  setStarlight(Number.NaN, Number.POSITIVE_INFINITY);
  expect(starlightUniforms.brightness.value).toBe(STARLIGHT_DEFAULTS.brightness);
  expect(starlightUniforms.faintest.value).toBe(STARLIGHT_DEFAULTS.faintest);
});

/** The Bright Star Catalogue's brightest star (Sirius, V -1.46), the explorer's sky's brightest. */
const SIRIUS = -1.46;

test('a hold on the stars’ light: the brightest star held at its peak at any pixel density, every other dimmed with it in its order, eased in, never raised', () => {
  const brightest = starLight(SIRIUS);
  for (const dpr of [0.75, 1, 1.5, 2, 3]) {
    // While a core is under its cap, its peak is in proportion to its light.
    expect(starPixels(1e-3, dpr).peak / 1e-3).toBeCloseTo(starPeakPerLight(dpr), 9);
    for (const peak of [0.01, 0.1, 0.5]) {
      const held = heldStarLight(10, brightest, peak, 1, dpr);
      expect(held).toBeLessThan(10);
      expect(starPixels(brightest * held, dpr).peak).toBeCloseTo(peak, 9);
      // One multiple for all: a fainter star under it, and in the same proportion to it as before.
      const fainter = starPixels(starLight(2) * held, dpr).peak;
      expect(fainter).toBeLessThan(peak);
      expect(fainter / peak).toBeCloseTo(starLight(2) / brightest, 9);
    }
  }
  // Eased in log terms: half its weight, half the way; none, the light as it was; a light already under the hold, never raised.
  const full = heldStarLight(10, brightest, 0.1, 1, 1);
  expect(heldStarLight(10, brightest, 0.1, 0.5, 1)).toBeCloseTo(Math.sqrt(10 * full), 9);
  expect(heldStarLight(10, brightest, 0.1, 0, 1)).toBe(10);
  expect(heldStarLight(full / 2, brightest, 0.1, 1, 1)).toBe(full / 2);
  // A peak above the core's cap holds the core at its cap: no held star spreads into a halo.
  expect(starPixels(brightest * heldStarLight(1e6, brightest, 50, 1, 1), 1).peak).toBeCloseTo(STARLIGHT.coreMax, 9);
  // Nonsense leaves the light alone.
  expect(heldStarLight(2, 0, 0.1, 1, 1)).toBe(2);
  expect(heldStarLight(2, brightest, Number.NaN, 1, 1)).toBe(2);
});

test('by day on an airless world, the sunlit ground’s glare: the brightest star under the sky’s white and the faint ones gone, at any exposure the eye takes there and at one or two pixels a CSS pixel', () => {
  const brightest = starLight(SIRIUS);
  for (const exposure of [0.3, 1, 4, 9.7, 64, 384]) {
    for (const dpr of [1, 2]) {
      // The sky's light as the explorer would have it without the hold (a share of the night's), from far too dim to far too bright.
      for (const share of [1e-4, 1e-2, 1, 100]) {
        const light = heldStarLight(share / exposure, brightest, AIRLESS_DAY.starPeak / exposure, 1, dpr);
        // On the screen (the exposure multiplies what the stars draw), at worst placed: centred on a pixel.
        const shown = (v: number): number => display(starPixels(starLight(v) * light, dpr).peak * exposure);
        const at = `exposure ${String(exposure)}, ${String(dpr)} px, share ${String(share)}`;
        expect(shown(SIRIUS), at).toBeLessThan(200);
        // Magnitude 6.5, kept at 30 or more of 255 by night, is not seen (the tone curve's black).
        expect(shown(6.5), at).toBeLessThan(5);
        // Where the hold is what dims them, the brightest stars are still seen: Sirius at the peak (or, where
        // the eye is stopped far down, at its core's cap), a first-magnitude star plainly.
        if (share >= 1) {
          expect(Math.abs(shown(SIRIUS) - display(Math.min(AIRLESS_DAY.starPeak, STARLIGHT.coreMax * exposure))), at).toBeLessThanOrEqual(1);
          expect(shown(SIRIUS), at).toBeGreaterThan(160);
          expect(shown(1), at).toBeGreaterThan(60);
        }
      }
    }
  }
  // The star light by night is untouched (no hold): magnitude 6.5 still seen there.
  expect(display(starPixels(starLight(6.5), 1, 0.5, 0.5).peak)).toBeGreaterThanOrEqual(30);
});
