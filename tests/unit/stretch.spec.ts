/**
 * The stretch from the film's scale (src/explore/stretch.ts): it starts exactly at Chapter 7's
 * proportions (distances as the square root, Saturn's orbit kept), ends exactly at true scale, and
 * moves every quantity steadily from one to the other.
 */
import { expect, test } from '@playwright/test';
import { filmUnitKm, moonOffsetFactor, sizeFactor, stretchEase, stretchedDistance, stretchedLight } from '../../src/explore/stretch';

const AU = 149_597_870.7;
const SATURN = 9.537 * AU;
const unit = filmUnitKm(SATURN, AU);

test('the film’s distances are Chapter 7’s (1.25 sqrt(au) scene units), with Saturn’s orbit at its true size', () => {
  expect(stretchedDistance(SATURN, 0, unit, AU) / SATURN).toBeCloseTo(1, 9);
  // The Earth and Saturn keep the film's ratio, sqrt(9.537), instead of the true 9.537.
  expect(SATURN / stretchedDistance(AU, 0, unit, AU)).toBeCloseTo(Math.sqrt(9.537), 6);
  expect(stretchedDistance(AU, 1, unit, AU)).toBe(AU);
});

test('distances, sizes, the Moon’s offset and sunlight move steadily from the film’s to the true ones', () => {
  let distance = Infinity;
  let size = Infinity;
  let moon = Infinity;
  let light = 1;
  for (let i = 0; i <= 20; i += 1) {
    const s = i / 20;
    const d = stretchedDistance(AU, s, unit, AU);
    const k = sizeFactor('earth', 6371, s, unit);
    const m = moonOffsetFactor(384_400, s, unit);
    const l = stretchedLight(1 / 9.537 ** 2, s);
    expect(d).toBeLessThanOrEqual(distance);
    expect(k).toBeLessThanOrEqual(size);
    expect(m).toBeLessThanOrEqual(moon);
    expect(l).toBeLessThanOrEqual(light);
    [distance, size, moon, light] = [d, k, m, l];
  }
  expect(sizeFactor('earth', 6371, 1, unit)).toBe(1);
  expect(sizeFactor('earth', 6371, 0, unit)).toBeGreaterThan(1000);
  expect(moonOffsetFactor(384_400, 1, unit)).toBe(1);
  expect(stretchedLight(0.011, 0)).toBe(1);
  expect(stretchedLight(0.011, 1)).toBe(0.011);
});

test('the ease starts and stops still', () => {
  expect(stretchEase(0)).toBe(0);
  expect(stretchEase(1)).toBe(1);
  expect(stretchEase(-1)).toBe(0);
  expect(stretchEase(0.5)).toBeCloseTo(0.5, 9);
  const step = 1e-3;
  expect(stretchEase(step) / step).toBeLessThan(0.01);
  expect((1 - stretchEase(1 - step)) / step).toBeLessThan(0.01);
});
