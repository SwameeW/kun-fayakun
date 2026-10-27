/**
 * Star light (src/explore/starlight.ts): the error function the shader approximates, each pixel's
 * share of a star integrated over its square, the same light wherever a star falls in a pixel and at
 * any pixel density, the faintest stars kept above the tone curve's black, and the visitor's settings.
 */
import { expect, test } from '@playwright/test';
import { erf, pixelShare, setStarlight, starLight, starlightUniforms, starPixels, starSharpness, STARLIGHT_DEFAULTS, STARLIGHT_RANGE } from '../../src/explore/starlight';

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
