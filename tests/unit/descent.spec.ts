/**
 * The atmospheres a visitor descends through (src/explore/descent/profile.ts), from the probes'
 * tables as committed (public/assets/descent): Venus from the Pioneer Venus Day and Large Probes,
 * Jupiter from the Galileo probe. Readings at the tables' own rows are the rows; between them the
 * pressure falls exponentially; the gap between Venus's two probes is marked; the clouds are where
 * the nephelometers saw them; the winds are Galileo's.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createProfile, type DescentFile } from '../../src/explore/descent/profile';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const venus = createProfile(readJson('public/assets/descent/venus.json') as DescentFile);
const jupiter = createProfile(readJson('public/assets/descent/jupiter.json') as DescentFile);

test('Venus from the Pioneer Venus probes: the ground, the 1-bar level, the gap between the probes, a reading between rows', () => {
  // The Large Probe's last reading, on the ground: 92.16 bar and 731.0 K.
  const ground = venus.at(0);
  expect(ground.pressureBar).toBeCloseTo(92.16, 6);
  expect(ground.temperatureK).toBeCloseTo(731.0, 6);
  // The Day Probe's highest reading, 128.3 km up.
  expect(venus.topKm).toBeCloseTo(128.3, 6);
  // One bar on Venus is near 50 km up (where the Earth's surface pressure is), and the reading there is one bar.
  const oneBar = venus.altitudeAtPressure(1);
  expect(oneBar).toBeGreaterThan(48);
  expect(oneBar).toBeLessThan(52);
  expect(venus.at(oneBar).pressureBar).toBeCloseTo(1, 4);
  // Between the probes (64.8 to 70.5 km): marked, and the pressure between the readings either side.
  const gap = venus.file.gapKm ?? [0, 0];
  const mid = venus.at((gap[0] + gap[1]) / 2);
  expect(mid.between).toBe(true);
  expect(venus.at(gap[0] - 0.5).between).toBe(false);
  expect(mid.pressureBar).toBeGreaterThan(venus.at(gap[1]).pressureBar);
  expect(mid.pressureBar).toBeLessThan(venus.at(gap[0]).pressureBar);
  // Between two rows the pressure is exponential in height: halfway in altitude, the geometric mean.
  const rows = venus.file.layers;
  const i = rows.findIndex((r) => (r[0] ?? 0) < 30);
  const a = rows[i - 1] ?? [];
  const b = rows[i] ?? [];
  const half = venus.at(((a[0] ?? 0) + (b[0] ?? 0)) / 2);
  expect(half.pressureBar).toBeCloseTo(Math.sqrt((a[1] ?? 0) * (b[1] ?? 0)), 6);
  expect(half.temperatureK).toBeCloseTo(((a[2] ?? 0) + (b[2] ?? 0)) / 2, 6);
});

test('Venus’s clouds where the Large Probe’s nephelometer saw them: a deck from about 47 to 65 km, clear air below', () => {
  // Its layers (thinner near 50 km, between the lower cloud and the middle one).
  expect(venus.at(52).cloud).toBeGreaterThan(0.3);
  expect(venus.at(48).cloud).toBeGreaterThan(0.2);
  expect(venus.at(60).cloud).toBeGreaterThan(0.2);
  expect(venus.at(50).cloud).toBeLessThan(venus.at(52).cloud);
  expect(venus.at(30).cloud).toBeLessThan(0.1);
  expect(venus.at(10).cloud).toBeLessThan(0.1);
  // More cloud above the ground than above the cloud tops; none below the ground.
  expect(venus.cloudAbove(30)).toBeGreaterThan(venus.cloudAbove(66) + 2);
  expect(venus.cloudBelow(0)).toBe(0);
});

test('Jupiter from the Galileo probe: the 1-bar level at its zero, its last reading at 22 bar, its winds', () => {
  const oneBar = jupiter.at(0);
  expect(oneBar.pressureBar).toBeGreaterThan(0.97);
  expect(oneBar.pressureBar).toBeLessThan(1.03);
  // The temperature at one bar, about 166 K (Seiff et al. 1998).
  expect(oneBar.temperatureK).toBeGreaterThan(163);
  expect(oneBar.temperatureK).toBeLessThan(169);
  const last = jupiter.at(jupiter.bottomKm);
  expect(last.pressureBar).toBeCloseTo(22.05, 6);
  expect(last.temperatureK).toBeCloseTo(428, 6);
  // The winds: about 87 m/s near the top of the descent, about 170 m/s deep down.
  expect(jupiter.at(12).windMs ?? 0).toBeGreaterThan(80);
  expect(jupiter.at(12).windMs ?? 0).toBeLessThan(100);
  expect(jupiter.at(-120).windMs ?? 0).toBeGreaterThan(160);
  expect(jupiter.at(150).windMs).toBeNull();
  expect(jupiter.at(-50).between).toBe(false);
});
