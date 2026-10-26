/**
 * The Living Earth's pure parts: the tile grids the imagery streams on (src/explore/earth-tiles),
 * how satellites are told apart and earthquakes read (src/explore/living), the place search and the
 * field notes (src/explore/field-notes): the bulletin's sums, and the notes' data, each with its
 * names and words in en.json, the honorifics, "by tradition", and Makkah framed as a city.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { SourceEntry } from '../../src/core/types';
import { matrixSize, texelAngle, tileCoord, zoomForFootprint } from '../../src/explore/earth-tiles/grid';
import { CLEAR, lastWholeDay, TODAY } from '../../src/explore/earth-tiles/sources';
import { composeBulletin, solarElevation, subPoint, terminatorPlace } from '../../src/explore/field-notes/bulletin';
import { ATLAS, MAKKAH_FRAME, PROPHETS, site, SITES } from '../../src/explore/field-notes/data';
import { centralAngle, nearestPlace, parsePlaces, searchPlaces, type Place } from '../../src/explore/field-notes/places';
import { classifySatellite, SatelliteKind } from '../../src/explore/living/satellite-kinds';
import { parseQuakes } from '../../src/explore/living/quakes';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const en = readJson('src/i18n/en.json') as Record<string, string>;
const DEG = Math.PI / 180;
const SIDEREAL_MIN = 1436.07;

test('the tile grids: EOX starts with two tiles of 180 degrees, GIBS with 288-degree tiles, and zoom follows the footprint', () => {
  expect(matrixSize(CLEAR.grid, 0)).toEqual({ cols: 2, rows: 1 });
  expect(matrixSize(CLEAR.grid, 13)).toEqual({ cols: 2 ** 14, rows: 2 ** 13 });
  expect(matrixSize(TODAY.grid, 0)).toEqual({ cols: 2, rows: 1 });
  expect(matrixSize(TODAY.grid, 2)).toEqual({ cols: 5, rows: 3 });
  // Greenwich on the equator: the corner of EOX's two z0 tiles; Makkah's tile at z10.
  expect(tileCoord(CLEAR.grid, 0, 0, 0)).toEqual({ x: 1, y: 0.5 });
  const m = tileCoord(CLEAR.grid, 10, 21.4225 * DEG, 39.8261 * DEG);
  expect(Math.floor(m.x)).toBe(Math.floor(((39.8261 + 180) / 180) * 2 ** 10));
  expect(Math.floor(m.y)).toBe(Math.floor(((90 - 21.4225) / 180) * 2 ** 10));
  // A texel at z0 is 180 / 256 degrees; each zoom halves it, and a finer footprint asks for a finer zoom.
  expect(texelAngle(CLEAR.grid, 0)).toBeCloseTo((180 / 256) * DEG, 12);
  expect(texelAngle(CLEAR.grid, 5) * 32).toBeCloseTo(texelAngle(CLEAR.grid, 0), 12);
  expect(zoomForFootprint(CLEAR.grid, texelAngle(CLEAR.grid, 7))).toBe(7);
  expect(zoomForFootprint(CLEAR.grid, texelAngle(CLEAR.grid, 7) * 0.9)).toBe(8);
  expect(zoomForFootprint(CLEAR.grid, 1e-12)).toBe(CLEAR.grid.maxZoom);
  expect(zoomForFootprint(TODAY.grid, 1e-12)).toBe(TODAY.grid.maxZoom);
  // The day mosaic is the last whole UTC day.
  expect(lastWholeDay(Date.UTC(2026, 9, 25, 0, 30))).toBe('2026-10-24');
});

test('every streamed layer is credited in data/sources.json', () => {
  const ids = new Set((readJson('data/sources.json') as { sources: SourceEntry[] }).sources.map((s) => s.id));
  for (const id of [...CLEAR.sourceIds, ...TODAY.sourceIds, 'celestrak-gp', 'usgs-earthquakes', 'satellite-js', 'natural-earth-5.1.2-places', 'wikidata-coordinates']) expect(ids.has(id), id).toBe(true);
});

test('satellites are told apart by name and period', () => {
  expect(classifySatellite('ISS (ZARYA)', 92.9, SIDEREAL_MIN)).toBe(SatelliteKind.station);
  expect(classifySatellite('CSS (TIANHE)', 92.2, SIDEREAL_MIN)).toBe(SatelliteKind.station);
  expect(classifySatellite('STARLINK-1008', 95.6, SIDEREAL_MIN)).toBe(SatelliteKind.starlink);
  expect(classifySatellite('ONEWEB-0012', 109.4, SIDEREAL_MIN)).toBe(SatelliteKind.oneweb);
  expect(classifySatellite('NAVSTAR 81 (USA 319)', 718, SIDEREAL_MIN)).toBe(SatelliteKind.navigation);
  expect(classifySatellite('GALILEO 21 (2C5)', 845, SIDEREAL_MIN)).toBe(SatelliteKind.navigation);
  expect(classifySatellite('GOES 18', 1436.1, SIDEREAL_MIN)).toBe(SatelliteKind.geostationary);
  expect(classifySatellite('HUBBLE SPACE TELESCOPE', 95.4, SIDEREAL_MIN)).toBe(SatelliteKind.other);
});

test('earthquakes are read from USGS GeoJSON, strongest first, skipping malformed events', () => {
  const quakes = parseQuakes({
    features: [
      { id: 'a', properties: { mag: 3.1, time: 1, place: '10 km N of A', url: 'u' }, geometry: { coordinates: [10, 20, 5] } },
      { id: 'b', properties: { mag: 6.5, time: 2, place: 'Bonin Islands region' }, geometry: { coordinates: [142.1, 27.5, 30] } },
      { id: 'bad', properties: { time: 3 }, geometry: { coordinates: [0, 0, 0] } },
      { id: 'c', properties: { mag: 4.4, time: 4 }, geometry: { coordinates: [-70, -30] } },
    ],
  });
  expect(quakes.map((q) => q.id)).toEqual(['b', 'c', 'a']);
  expect(quakes[0]).toMatchObject({ magnitude: 6.5, lat: 27.5, lon: 142.1, depthKm: 30, place: 'Bonin Islands region' });
  expect(quakes[1]?.depthKm).toBe(0);
});

const PLACES: Place[] = [
  { name: 'Tokyo', lat: 35.687, lon: 139.7495, population: 35_676_000 },
  { name: 'São Paulo', lat: -23.5567, lon: -46.627, population: 18_845_000 },
  { name: 'Makkah', lat: 21.43, lon: 39.82, population: 1_385_000 },
  { name: 'Port Moresby', lat: -9.4647, lon: 147.1925, population: 283_733 },
  { name: 'Moresby Town', lat: 0, lon: 0, population: 1 },
];

test('places: parsed from places.json, found by name (accents and case folded), nearest by great circle', () => {
  const file = readJson('public/assets/places/places.json') as { fields: string[]; places: unknown[] };
  expect(file.fields).toEqual(['name', 'lat', 'lon', 'population']);
  const parsed = parsePlaces(file);
  expect(parsed.length).toBe(file.places.length);
  expect(parsed.length).toBeGreaterThan(1000);
  expect(parsePlaces({ places: [['A', 1, 2, 3], ['bad', 'x'], 5] })).toEqual([{ name: 'A', lat: 1, lon: 2, population: 3 }]);
  // Names that start with the query first, then a word that does, then any; larger first in each.
  expect(searchPlaces(PLACES, 'sao paulo').map((p) => p.name)).toEqual(['São Paulo']);
  expect(searchPlaces(PLACES, 'moresby').map((p) => p.name)).toEqual(['Moresby Town', 'Port Moresby']);
  expect(searchPlaces(PLACES, '  ')).toEqual([]);
  expect(searchPlaces(parsed, 'makkah')[0]?.name).toBe('Makkah');
  // A quarter of the way round, and the nearest place with its distance.
  expect(centralAngle(0, 0, 0, 90)).toBeCloseTo(Math.PI / 2, 12);
  expect(centralAngle(90, 0, -90, 0)).toBeCloseTo(Math.PI, 12);
  const near = nearestPlace(PLACES, 35, 139, 6371);
  expect(near?.place.name).toBe('Tokyo');
  expect(near?.km).toBeGreaterThan(50);
  expect(near?.km).toBeLessThan(150);
});

test('the bulletin: the Sun overhead, dawn and dusk on the terminator, the station beneath', () => {
  const sun = { lat: -12, lon: 150 };
  // The Sun is at the zenith under itself and at the nadir opposite.
  expect(solarElevation(sun, sun)).toBeCloseTo(Math.PI / 2, 10);
  expect(solarElevation({ lat: 12, lon: -30 }, sun)).toBeCloseTo(-Math.PI / 2, 10);
  // On the terminator, 90 degrees away: west of the Sun is morning (dawn), east is evening (dusk).
  const dawnSide: Place = { name: 'West', lat: 0, lon: 60, population: 10 };
  const duskSide: Place = { name: 'East', lat: 0, lon: -120, population: 10 };
  const noon: Place = { name: 'Noon', lat: -12, lon: 150, population: 1e9 };
  const on = { lat: 0, lon: 150 };
  expect(terminatorPlace([noon, dawnSide, duskSide], on, true)?.name).toBe('West');
  expect(terminatorPlace([noon, dawnSide, duskSide], on, false)?.name).toBe('East');
  expect(terminatorPlace([noon], on, true)).toBeNull();

  const b = composeBulletin({
    sun: { lat: -9, lon: 147 },
    radiusKm: 6371,
    places: PLACES,
    station: { index: 3, name: 'ISS (ZARYA)', station: 'iss', norad: 25544, kind: 'station', lat: 35.5, lon: 139.5, altitudeKm: 420, periodMin: 92.9, sunlit: true },
    satellites: { count: 100, sunlit: 60 },
    quakes: [{ id: 'q', magnitude: 6.5, lat: 27.5, lon: 142.1, depthKm: 30, timeMs: 5, place: 'Bonin Islands region' }],
  });
  expect(b.sun.near?.name).toBe('Port Moresby');
  expect(b.station?.near?.name).toBe('Tokyo');
  expect(b.station?.altitudeKm).toBe(420);
  expect(b.satellites).toEqual({ count: 100, sunlit: 60 });
  expect(b.quakes?.count).toBe(1);
  expect(b.quakes?.strongest?.magnitude).toBe(6.5);
  expect(composeBulletin({ sun, radiusKm: 6371, places: PLACES, station: null, satellites: null, quakes: null })).toMatchObject({ station: null, satellites: null, quakes: null });
  // Earth-fixed axes: x Greenwich, y 90 E, z north.
  expect(subPoint(1, 0, 0)).toEqual({ lat: 0, lon: 0 });
  expect(subPoint(0, 1, 0).lon).toBeCloseTo(90, 12);
  expect(subPoint(0, 0, 1).lat).toBeCloseTo(90, 12);
});

test('the field notes: every place from Wikidata and named in en.json, the atlas worded and every stop real', () => {
  const ids = [...ATLAS, ...SITES].map((p) => p.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const p of [...ATLAS, ...SITES]) {
    expect(p.qid, p.id).toMatch(/^Q\d+$/u);
    expect(Math.abs(p.lat), p.id).toBeLessThanOrEqual(90);
    expect(Math.abs(p.lon), p.id).toBeLessThanOrEqual(180);
    expect(p.viewKm, p.id).toBeGreaterThan(0);
  }
  expect(ATLAS.length).toBe(23);
  for (const p of ATLAS) {
    expect(en[`ui.universe.field.atlas.${p.id}.name`], p.id).toBeTruthy();
    expect(en[`ui.universe.field.atlas.${p.id}.text`], p.id).toBeTruthy();
  }
  for (const p of SITES) expect(en[`ui.universe.field.site.${p.id}`], p.id).toBeTruthy();
});

test('the prophets: the 25 named in the Quran, with honorifics, "by tradition", and no place where traditions differ', () => {
  expect(PROPHETS.length).toBe(25);
  expect(PROPHETS[0]?.id).toBe('adam');
  expect(PROPHETS[24]?.id).toBe('muhammad');
  for (const p of PROPHETS) {
    const name = en[`ui.universe.field.prophet.${p.id}.name`] ?? '';
    const text = en[`ui.universe.field.prophet.${p.id}.text`] ?? '';
    expect(text, p.id).not.toBe('');
    if (p.id === 'muhammad') {
      expect(name).toBe('Muhammad ﷺ');
    } else {
      expect(name, p.id).toMatch(/, peace be upon him$/u);
      // Each note says where its account comes from (Muhammad's life, peace be upon him, is history).
      expect(text, p.id).toMatch(/tradition|Little is narrated/iu);
    }
    for (const id of p.sites) expect(site(id), `${p.id}: ${id}`).toBeDefined();
    if (p.sites.length === 0) expect(text, p.id).toMatch(/no place is marked/iu);
  }
  expect(PROPHETS.filter((p) => p.sites.length === 0).map((p) => p.id)).toEqual(['idris', 'ayyub', 'dhul-kifl', 'ilyas', 'al-yasa']);
  // The section says what the places are, and that they await a scholar's review.
  expect(en['ui.universe.field.prophets']).toMatch(/by tradition/u);
  expect(en['ui.universe.field.prophetsIntro']).toMatch(/Peace be upon them all/u);
  expect(en['ui.universe.field.prophetsReview']).toMatch(/qualified scholar/u);
});

test('Makkah is framed as a city in its valley: its site and every place near it frame at least MAKKAH_FRAME', () => {
  const makkah = site('mecca');
  expect(makkah).toBeDefined();
  expect(makkah?.viewKm).toBeGreaterThanOrEqual(MAKKAH_FRAME.minWidthKm);
  for (const p of [...ATLAS, ...SITES]) {
    if (!makkah) break;
    if (centralAngle(p.lat, p.lon, makkah.lat, makkah.lon) * 6371 < MAKKAH_FRAME.radiusKm) expect(p.viewKm, p.id).toBeGreaterThanOrEqual(MAKKAH_FRAME.minWidthKm);
  }
});
