/**
 * The qibla and the new moon (src/explore/islamic): checked against published values and physical
 * properties, not against copies of the formulas.
 *
 * - New moons: Fred Espenak's table of the Moon's phases (astropixels.com, retrieved 2026-10-26), 2026.
 * - The Sun over the Kaaba: 15 July 2026 at 12:26:44 Makkah time (09:26:44 UTC), as announced for
 *   2026, and 27 or 28 May at 09:18 UTC; over the opposite point, about 21:09 UTC in late November and
 *   21:30 UTC in mid-January (Wikipedia, "Qibla observation by shadows", retrieved 2026-10-26).
 * - Qibla bearings: New York 58.5, Kabul 250.8, Islamabad 255.9 degrees (ihadis.com's calculator).
 * - Ramadan 1447: the conjunction on 17 February 2026 at 12:01 UT, the crescent not seen by eye
 *   anywhere in the Arab or Islamic world that evening (International Astronomy Center), and easily
 *   visible in the UK and most of the world the next (moonsighting.org.uk).
 * - Umm al-Qura: 1 Ramadan 1447 on 18 February 2026 and 1 Shawwal 1447 on 20 March 2026.
 * - WGS 84's quarter meridian: 10,001.965729 km.
 * Places' coordinates come from public/assets/places/places.json (Natural Earth).
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createEphemeris, type MoonFile, type PlanetsFile } from '../../src/astro/ephemeris';
import { obliquityRad, type PhysicalFile } from '../../src/astro/physical';
import {
  centralAngleDeg,
  crescentAt,
  eveningSpan,
  GOLDEN_RATIO,
  goldenLatitude,
  KAABA,
  kaabaSuns,
  meridianArcKm,
  meridianRatio,
  newMoons,
  qiblaBearing,
  qiblaDistanceKm,
  qiblaPath,
  QUARTER_MERIDIAN_KM,
  skyTrack,
  yallopZone,
  type SkyFrame,
} from '../../src/explore/islamic/astronomy';
import { HERITAGE } from '../../src/explore/islamic/heritage';
import { hijriDate } from '../../src/explore/islamic/hijri';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const physical = readJson('public/assets/jpl/physical.json') as PhysicalFile;
const sky: SkyFrame = {
  ephemeris: createEphemeris(readJson('public/assets/jpl/planets.json') as PlanetsFile, readJson('public/assets/jpl/moon.json') as MoonFile, physical),
  time: physical.time,
  obliquityRad: obliquityRad(physical),
};
const places = (readJson('public/assets/places/places.json') as { places: Array<[string, number, number, number]> }).places;
const city = (name: string): { lat: number; lon: number } => {
  const row = places.find((p) => p[0] === name);
  if (!row) throw new Error(`no ${name} in places.json`);
  return { lat: row[1], lon: row[2] };
};
const jd = (iso: string): number => Date.parse(iso) / 86_400_000 + 2440587.5;
const iso = (julian: number): string => new Date((julian - 2440587.5) * 86_400_000).toISOString();
const MEAN_RADIUS_KM = 6371.0088;

test('the qibla: bearings as published, and the great circle in that bearing reaches the Kaaba', () => {
  expect(qiblaBearing(city('New York').lat, city('New York').lon)).toBeCloseTo(58.5, 0);
  expect(Math.abs(qiblaBearing(city('New York').lat, city('New York').lon) - 58.5)).toBeLessThan(0.3);
  expect(Math.abs(qiblaBearing(city('Kabul').lat, city('Kabul').lon) - 250.8)).toBeLessThan(0.3);
  expect(Math.abs(qiblaBearing(city('Islamabad').lat, city('Islamabad').lon) - 255.9)).toBeLessThan(0.3);
  // Due north of the Kaaba the qibla is due south, and due south of it, due north.
  expect(qiblaBearing(60, KAABA.lon)).toBeCloseTo(180, 9);
  expect(qiblaBearing(-30, KAABA.lon)).toBeCloseTo(0, 9);
  // From the world's largest places: travelling the bearing for the distance (a separate formula, the
  // destination on the same sphere) arrives within a kilometre of the Kaaba.
  for (const [, lat, lon] of places.slice(0, 40)) {
    const bearing = (qiblaBearing(lat, lon) * Math.PI) / 180;
    const delta = qiblaDistanceKm(lat, lon, MEAN_RADIUS_KM) / MEAN_RADIUS_KM;
    const p1 = (lat * Math.PI) / 180;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(delta) + Math.cos(p1) * Math.sin(delta) * Math.cos(bearing));
    const l2 = (lon * Math.PI) / 180 + Math.atan2(Math.sin(bearing) * Math.sin(delta) * Math.cos(p1), Math.cos(delta) - Math.sin(p1) * Math.sin(p2));
    expect(centralAngleDeg((p2 * 180) / Math.PI, (l2 * 180) / Math.PI, KAABA.lat, KAABA.lon) * (Math.PI / 180) * MEAN_RADIUS_KM).toBeLessThan(1);
  }
  // The drawn path starts at the place, ends at the Kaaba, and every point lies on the great circle.
  const ny = city('New York');
  const path = qiblaPath(ny.lat, ny.lon, 64);
  expect(path.slice(0, 2)).toEqual([expect.closeTo(ny.lat, 9), expect.closeTo(ny.lon, 9)]);
  expect(path.slice(-2)).toEqual([expect.closeTo(KAABA.lat, 9), expect.closeTo(KAABA.lon, 9)]);
  const total = centralAngleDeg(ny.lat, ny.lon, KAABA.lat, KAABA.lon);
  for (let k = 0; k < path.length; k += 2) {
    const a = path[k] ?? 0;
    const b = path[k + 1] ?? 0;
    expect(centralAngleDeg(ny.lat, ny.lon, a, b) + centralAngleDeg(a, b, KAABA.lat, KAABA.lon)).toBeCloseTo(total, 6);
  }
});

test('the new moons of 2026 fall within two minutes of Espenak’s table', () => {
  const table = ['2026-01-18T19:52Z', '2026-02-17T12:01Z', '2026-03-19T01:23Z', '2026-04-17T11:52Z', '2026-05-16T20:01Z', '2026-06-15T02:54Z', '2026-07-14T09:44Z', '2026-08-12T17:37Z', '2026-09-11T03:27Z', '2026-10-10T15:50Z', '2026-11-09T07:02Z', '2026-12-09T00:52Z'];
  const found = newMoons(sky, jd('2026-01-01T00:00Z'), jd('2027-01-01T00:00Z'));
  expect(found.length).toBe(12);
  found.forEach((t, k) => {
    expect(Math.abs(t - jd(table[k] ?? '')) * 1440, `${iso(t)} against ${table[k] ?? ''}`).toBeLessThan(2);
  });
});

test('the Sun over the Kaaba in 2026, and over the point opposite it, at the published times', () => {
  const events = kaabaSuns(sky, jd('2026-01-01T00:00Z'), jd('2027-01-01T00:00Z'));
  const over = events.filter((e) => e.kind === 'over');
  const opposite = events.filter((e) => e.kind === 'opposite');
  expect(over.length).toBe(2);
  expect(opposite.length).toBe(2);
  const minutes = (julian: number): number => (((julian + 0.5) % 1) + 1) % 1 * 1440;
  const [may, july] = over;
  expect(iso(may?.jdUtc ?? 0).slice(0, 10)).toMatch(/^2026-05-2[78]$/);
  expect(Math.abs(minutes(may?.jdUtc ?? 0) - (9 * 60 + 18))).toBeLessThan(1.5);
  expect(iso(july?.jdUtc ?? 0).slice(0, 10)).toBe('2026-07-15');
  expect(Math.abs(minutes(july?.jdUtc ?? 0) - (9 * 60 + 26 + 44 / 60))).toBeLessThan(1);
  for (const e of over) expect(e.zenithDeg).toBeLessThan(0.2);
  const [january, november] = opposite;
  expect(iso(january?.jdUtc ?? 0).slice(0, 10)).toMatch(/^2026-01-1[123]$/);
  expect(Math.abs(minutes(january?.jdUtc ?? 0) - (21 * 60 + 30))).toBeLessThan(3);
  expect(iso(november?.jdUtc ?? 0).slice(0, 10)).toMatch(/^2026-11-2[78]$/);
  expect(Math.abs(minutes(november?.jdUtc ?? 0) - (21 * 60 + 9))).toBeLessThan(3);
});

test('Ramadan 1447’s crescent: not seen by eye in the Arab and Islamic world on 17 February, easily seen in the UK the next evening', () => {
  const [conjunction] = newMoons(sky, jd('2026-02-15T00:00Z'), jd('2026-02-20T00:00Z'));
  expect(conjunction).toBeDefined();
  const c = conjunction ?? 0;
  const evening = (date: string): ((name: string) => ReturnType<typeof crescentAt>) => {
    const d0 = jd(`${date}T00:00Z`);
    const [from, to] = eveningSpan(d0);
    const track = skyTrack(sky, from, to);
    return (name: string) => crescentAt(track, city(name).lat, city(name).lon, d0, c);
  };
  const first = evening('2026-02-17');
  const second = evening('2026-02-18');
  const islamicWorld = ['Makkah', 'Riyadh', 'Cairo', 'Istanbul', 'Karachi', 'Islamabad', 'Jakarta', 'Kuala Lumpur', 'Rabat', 'Dakar', 'Lagos'];
  for (const name of islamicWorld) expect(['A', 'B'], `${name} on 17 February`).not.toContain(first(name).zone);
  expect(second('London').zone).toBe('A');
  for (const name of ['Makkah', 'Cairo', 'Rabat', 'Istanbul']) expect(['A', 'B'], `${name} on 18 February`).toContain(second(name).zone);
  // A day older, the crescent is wider and higher: q rises wherever both evenings have one.
  for (const name of islamicWorld) {
    const a = first(name).q;
    const b = second(name).q;
    if (a !== null && b !== null) expect(b, name).toBeGreaterThan(a);
    expect(second(name).ageHours).toBeGreaterThan(first(name).ageHours);
  }
  // Best time is between sunset and moonset, four ninths of the way.
  const m = second('Makkah');
  expect(m.bestJd).toBeCloseTo((m.sunsetJd ?? 0) + (4 / 9) * ((m.moonsetJd ?? 0) - (m.sunsetJd ?? 0)), 9);
  expect(evening('2026-02-18')('London').widthArcmin).toBeGreaterThan(0);
});

test('Yallop’s zones and the places the test is not made for', () => {
  expect([0.3, 0, -0.1, -0.2, -0.25, -0.4].map(yallopZone)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  const d0 = jd('2026-02-18T00:00Z');
  const [from, to] = eveningSpan(d0);
  expect(crescentAt(skyTrack(sky, from, to), 70, 20, d0, jd('2026-02-17T12:01Z')).zone).toBe('high-latitude');
  // An evening before the conjunction has no crescent at all.
  expect(crescentAt(skyTrack(sky, from - 2, to - 2), 21.4, 39.8, d0 - 2, jd('2026-02-17T12:01Z')).zone).toBe('before-new-moon');
});

test('the golden latitude: where the meridian divides in the golden ratio, beside the Kaaba’s', () => {
  expect(GOLDEN_RATIO).toBeCloseTo(1.6180339887, 10);
  expect(QUARTER_MERIDIAN_KM).toBeCloseTo(10_001.965729, 5);
  const golden = goldenLatitude();
  expect(meridianRatio(golden)).toBeCloseTo(GOLDEN_RATIO, 9);
  // The Kaaba: a ratio near the golden one but not it, a few kilometres north of the golden latitude.
  const ratio = meridianRatio(KAABA.lat);
  expect(ratio).toBeGreaterThan(GOLDEN_RATIO);
  expect(ratio).toBeLessThan(1.624);
  const north = meridianArcKm(KAABA.lat) - meridianArcKm(golden);
  expect(north).toBeGreaterThan(8);
  expect(north).toBeLessThan(10);
});

test('the heritage places: Wikidata items on the Earth, each with its name and note', () => {
  const messages = readJson('src/i18n/en.explore.json') as Record<string, string>;
  expect(new Set(HERITAGE.map((p) => p.id)).size).toBe(HERITAGE.length);
  for (const p of HERITAGE) {
    expect(p.qid).toMatch(/^Q\d+$/);
    expect(Math.abs(p.lat)).toBeLessThanOrEqual(90);
    expect(Math.abs(p.lon)).toBeLessThanOrEqual(180);
    expect(messages[`ui.universe.islamic.heritage.${p.id}.name`], p.id).toBeTruthy();
    expect(messages[`ui.universe.islamic.heritage.${p.id}.note`], p.id).toBeTruthy();
  }
});

test('the Umm al-Qura calendar gives the published dates of Ramadan and Shawwal 1447', () => {
  expect(hijriDate(Date.parse('2026-02-18T12:00Z'))).toEqual({ day: 1, month: 9, year: 1447 });
  expect(hijriDate(Date.parse('2026-03-20T12:00Z'))).toEqual({ day: 1, month: 10, year: 1447 });
  expect(hijriDate(Date.parse('2026-02-17T23:59Z'))?.month).toBe(8);
  expect(hijriDate(Number.NaN)).toBeNull();
});
