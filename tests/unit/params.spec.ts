/** Launch parameters (src/core/params.ts), parsed from a query string without a browser. */
import { expect, test } from '@playwright/test';
import { readLaunchParams } from '../../src/core/params';

test('defaults when nothing is set', () => {
  expect(readLaunchParams('')).toEqual({
    forceWebGL: false,
    tier: null,
    reducedMotion: null,
    autoplay: false,
    showFps: false,
    profile: false,
    jd: null,
  });
});

test('?jd pins a Julian date', () => {
  expect(readLaunchParams('?jd=2461000.5').jd).toBe(2461000.5);
  expect(readLaunchParams('?jd=2451545').jd).toBe(2451545);
  expect(readLaunchParams('?jd=%202451545.0%20').jd).toBe(2451545);
});

test('?jd ignores anything that is not a plausible Julian date', () => {
  for (const value of ['', 'abc', '-2451545', '0x10', '1e6', '2451545.', 'NaN', 'Infinity', '2026', '1761177600', '9999999']) {
    expect(readLaunchParams(`?jd=${encodeURIComponent(value)}`).jd, value).toBeNull();
  }
});

test('?tier keeps its meaning', () => {
  expect(readLaunchParams('?tier=LOW').tier).toBe('low');
  expect(readLaunchParams('?tier=ultra').tier).toBeNull();
});
