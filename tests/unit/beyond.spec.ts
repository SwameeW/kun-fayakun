/**
 * Beyond the stars (src/explore/neighbourhood/galaxy.ts and beyond.ts; ledger IS-6), from the
 * committed files:
 *
 * - the Milky Way model's arms as Reid et al. (2019, table 2) fit them, continued past the azimuths
 *   their parallaxes trace to the tangents other surveys see in the fourth quadrant (the same table:
 *   the near 3-kpc arm at longitude 337.0, Norma 327.5, Scutum-Centaurus 306.1, Sagittarius-Carina
 *   285.6 degrees);
 * - the model's points the same every time, within the disc, the bar at its angle;
 * - the Local Group where McConnachie's catalogue (2012) puts it: Andromeda 783 kpc away, its
 *   isophotal diameter (SIMBAD's 199.5 arcminutes) about 45 kpc, its absolute magnitude derived and
 *   flagged; the Large Magellanic Cloud 51 kpc away;
 * - the galactic frame (its centre at longitude and latitude 0, its pole at the north galactic pole);
 * - the places one can go, and the survey's points turned from the film's frame into the explorer's.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Sprite } from 'three/webgpu';
import { createBeyond, galacticAxes, readLocalGroup, type LocalGroupFile, type WebManifest } from '../../src/explore/neighbourhood/beyond';
import { armRadius, galactocentric, longitudeFromSun, MILKY_WAY, sampleMilkyWay } from '../../src/explore/neighbourhood/galaxy';
import { skyDirection } from '../../src/explore/sky';

const OBLIQUITY = (23.4392911 * Math.PI) / 180;
const file = JSON.parse(readFileSync(new URL('../../public/assets/stars/localgroup.json', import.meta.url), 'utf8')) as LocalGroupFile;
const angleDeg = (a: readonly number[], b: readonly number[]): number => {
  const c = ((a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0)) / (Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0) * Math.hypot(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};

test('the arms as Reid et al. fit them, and continued, reaching the tangents other surveys see', () => {
  for (const arm of MILKY_WAY.arms) expect(armRadius(arm, arm.betaKinkDeg)).toBeCloseTo(arm.rKinkKpc, 9);
  // The Sun is at azimuth 0, R0 from the centre: just inside the Local Arm, with the Sagittarius-Carina
  // arm inside it and the Perseus arm outside.
  expect(longitudeFromSun(galactocentric(MILKY_WAY.r0Kpc + 1, 0))).toBeCloseTo(180, 9);
  const at = (id: string): number => {
    const arm = MILKY_WAY.arms.find((a) => a.id === id);
    return arm ? armRadius(arm, 0) : Number.NaN;
  };
  expect(at('sagittarius-carina')).toBeLessThan(MILKY_WAY.r0Kpc);
  expect(at('local')).toBeGreaterThan(MILKY_WAY.r0Kpc);
  expect(at('local') - MILKY_WAY.r0Kpc).toBeLessThan(0.5);
  expect(at('perseus')).toBeGreaterThan(at('local'));
  // The fourth quadrant's tangents: the least longitude past 180 along each arm.
  const tangent = (id: string): number => {
    const arm = MILKY_WAY.arms.find((a) => a.id === id);
    if (!arm) return Number.NaN;
    let best = 360;
    for (let beta = arm.betaFromDeg - 150; beta <= arm.betaToDeg; beta += 0.02) {
      const l = longitudeFromSun(galactocentric(armRadius(arm, beta), beta));
      if (l > 180 && l < best) best = l;
    }
    return best;
  };
  for (const [id, published] of [
    ['three-kpc', 337.0],
    ['norma', 327.5],
    ['scutum-centaurus', 306.1],
    ['sagittarius-carina', 285.6],
  ] as const)
    expect(Math.abs(tangent(id) - published), id).toBeLessThan(0.5);
});

test('the model’s points: the same every time, within the disc, the bar at its angle', () => {
  const a = sampleMilkyWay(20_000);
  const b = sampleMilkyWay(20_000);
  expect(a.count).toBe(20_000);
  expect(Array.from(a.positions.slice(0, 300))).toEqual(Array.from(b.positions.slice(0, 300)));
  let farthest = 0;
  let thickest = 0;
  for (let i = 0; i < a.count; i += 1) {
    farthest = Math.max(farthest, Math.hypot(a.positions[i * 3] ?? 0, a.positions[i * 3 + 1] ?? 0));
    thickest = Math.max(thickest, Math.abs(a.positions[i * 3 + 2] ?? 0));
  }
  expect(farthest).toBeLessThan(18);
  expect(thickest).toBeLessThan(5);
  // The bar's points (the last tenth or so, between 1 and 5 kpc from the centre) lie along 30 degrees from the Sun's line, the near end at positive longitudes.
  let along = 0;
  let n = 0;
  for (let i = Math.floor(a.count * 0.8); i < a.count; i += 1) {
    const x = a.positions[i * 3] ?? 0;
    const y = a.positions[i * 3 + 1] ?? 0;
    const r = Math.hypot(x, y);
    if (r < 2 || r > 5) continue;
    // Folded to one end: the angle from the line toward the Sun (-x), toward +y.
    const angle = (Math.atan2(y * Math.sign(-x || 1), -x * Math.sign(-x || 1)) * 180) / Math.PI;
    along += angle;
    n += 1;
  }
  expect(n).toBeGreaterThan(200);
  expect(along / n).toBeGreaterThan(20);
  expect(along / n).toBeLessThan(40);
});

test('the Local Group where McConnachie’s catalogue puts it, the four largest at SIMBAD’s sizes', () => {
  const galaxies = readLocalGroup(file, OBLIQUITY);
  expect(galaxies.length).toBeGreaterThan(90);
  expect(galaxies.some((g) => g.name === 'The Galaxy')).toBe(false);
  const andromeda = galaxies.find((g) => g.name === 'Andromeda');
  expect(andromeda?.distKpc).toBe(783);
  expect(Math.hypot(...(andromeda?.position ?? [0, 0, 0]))).toBeCloseTo(783_000, 3);
  // In the direction of its catalogue place.
  expect(angleDeg(andromeda?.position ?? [0, 0, 0], skyDirection(10.68458, 41.26917, OBLIQUITY))).toBeLessThan(1e-6);
  // 199.53 arcminutes at 783 kpc: about 45 kpc across.
  expect(andromeda?.diameterKpc ?? 0).toBeCloseTo(783 * Math.tan(((199.53 / 60) * Math.PI) / 180), 6);
  expect(andromeda?.diameterKpc ?? 0).toBeGreaterThan(44);
  expect(andromeda?.diameterKpc ?? 0).toBeLessThan(46);
  // Its absolute magnitude derived from SIMBAD's V, and said to be.
  expect(andromeda?.absVDerived).toBe(true);
  expect(andromeda?.absV ?? 0).toBeCloseTo(3.44 - 5 * Math.log10(78_300), 2);
  expect(galaxies.find((g) => g.name === 'LMC')?.distKpc).toBe(51);
  expect(galaxies.find((g) => g.name === 'Sculptor')?.absVDerived).toBe(false);
});

test('the galactic frame: its centre at longitude and latitude 0, its pole at the north galactic pole', () => {
  const { x, y, z } = galacticAxes(OBLIQUITY);
  for (const [a, b] of [
    [x, y],
    [y, z],
    [z, x],
  ] as const)
    expect(angleDeg(a, b)).toBeCloseTo(90, 9);
  // Sagittarius A* (17h 45m 40.04s, -29 00' 28.2"): within a few arcminutes of the frame's centre.
  expect(angleDeg(x, skyDirection(266.41683, -29.00781, OBLIQUITY))).toBeLessThan(0.1);
  expect(angleDeg(z, skyDirection(192.85948, 27.12825, OBLIQUITY))).toBeLessThan(1e-9);
});

test('the places to go, and the survey’s galaxies turned into the explorer’s frame', async () => {
  const added: Sprite[] = [];
  // One galaxy 100 Mpc toward the galaxy's centre, one toward its north pole, one toward longitude 270 (the film's +z).
  const manifest: WebManifest = { file: 'galaxies.bin', count: 3, scaleMpc: 0.1, nearLimit: 0.1, redshiftScale: 40_000 };
  const data = new ArrayBuffer(3 * 8);
  const view = new DataView(data);
  [
    [1000, 0, 0],
    [0, 1000, 0],
    [0, 0, 1000],
  ].forEach(([x, y, z], i) => {
    view.setInt16(i * 8, x ?? 0, true);
    view.setInt16(i * 8 + 2, y ?? 0, true);
    view.setInt16(i * 8 + 4, z ?? 0, true);
    view.setInt16(i * 8 + 6, 1000, true);
  });
  const beyond = createBeyond(file, OBLIQUITY, () => Promise.resolve({ manifest, data }), 'basic', (s) => added.push(s));
  expect(added.map((s) => s.name)).toEqual(['explore-beyond-milky-way', 'explore-beyond-local-group', 'explore-beyond-discs']);
  const ids = beyond.places.map((p) => p.id);
  expect(ids).toEqual(['centre', 'milky-way', 'lmc', 'smc', 'andromeda', 'triangulum', 'local-group', 'web']);
  const { x, y, z } = galacticAxes(OBLIQUITY);
  // The galaxy's centre R0 away toward longitude 0; the Milky Way seen from its north pole.
  const centre = beyond.places.find((p) => p.id === 'centre');
  expect(Math.hypot(...(centre?.position ?? [0, 0, 0]))).toBeCloseTo(MILKY_WAY.r0Kpc * 1000, 6);
  expect(angleDeg(centre?.position ?? [0, 0, 0], x)).toBeLessThan(1e-9);
  expect(angleDeg(beyond.places.find((p) => p.id === 'milky-way')?.from ?? [0, 0, 0], z)).toBeLessThan(1e-9);
  expect(beyond.search('andromeda')[0]?.name).toBe('Andromeda');
  expect(beyond.search('magellanic').map((g) => g.name).sort()).toEqual(['LMC', 'SMC']);
  // The scales, the stars and the band giving way as the camera leaves.
  expect([1, 5e4, 1e6, 1e9].map((d) => beyond.scale(d))).toEqual(['stars', 'galaxy', 'local-group', 'universe']);
  expect(beyond.starsShown(10)).toBe(1);
  expect(beyond.starsShown(1e5)).toBe(0);
  expect(beyond.bandShown(1e5)).toBe(0);
  // Far enough out, the survey is asked for and drawn, in parsecs, in the explorer's frame.
  beyond.update([0, 0, 3e6], 3e6, 800);
  await expect.poll(() => added.length).toBe(4);
  expect(beyond.webCount).toBe(3);
  const web = added[3];
  const positions = (web?.userData as { positions: Float32Array }).positions;
  const at = (i: number): number[] => [positions[i * 3] ?? 0, positions[i * 3 + 1] ?? 0, positions[i * 3 + 2] ?? 0];
  expect(Math.hypot(...at(0))).toBeCloseTo(100e6, -2);
  expect(angleDeg(at(0), x)).toBeLessThan(1e-4);
  expect(angleDeg(at(1), z)).toBeLessThan(1e-4);
  expect(angleDeg(at(2), [-y[0], -y[1], -y[2]])).toBeLessThan(1e-4);
  beyond.dispose();
});
