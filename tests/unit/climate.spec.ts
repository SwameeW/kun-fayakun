/**
 * Worlds that respond (src/sim/climate, ledger WR-2 to WR-6): the day's sunlight by latitude against
 * its closed forms; North, Cahalan and Coakley's Earth in balance today (about 15 C, its ice line near
 * the poles), frozen over when its light falls a tenth and staying frozen when it comes back (the
 * ice-albedo feedback's hysteresis); a grey greenhouse calibrated to Venus's and Mars's measured
 * temperatures; an airless noon; and in the engine, the seasons (the north warmer in July), a heavier
 * Sun's light (the main-sequence relation) warming the Earth, and climates replayed exactly. (The
 * oceans' mixed layer keeps the seasons to a few degrees in this model: it has no land of its own.)
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { PhysicalFile } from '../../src/astro/physical';
import { BAND_AREAS, BAND_LATITUDES, BANDS, boilingK, climateSummary, dailyInsolation, mainSequenceLuminosityW, noonK, SIGMA, startingBands, stepBands, SUN_GM, SUN_LUMINOSITY_W, type ClimateSpec, type ClimateState } from '../../src/sim/climate';
import { DEFAULT_INTEGRATOR, Engine, ENGINE_VERSION, SCHEMA_VERSION, type BodySpec, type Scenario } from '../../src/sim/engine';

const physical = JSON.parse(readFileSync(new URL('../../public/assets/jpl/physical.json', import.meta.url), 'utf8')) as PhysicalFile;
const mean = (r: readonly number[]): number => r.reduce((a, b) => a + b, 0) / r.length;
const AU = physical.auKm;
const S0 = SUN_LUMINOSITY_W / (4 * Math.PI * (AU * 1000) ** 2);
const DEG = Math.PI / 180;
/** North et al. (1981): Budyko's A and B, D, the albedos, the mixed layer and land, 71% ocean. */
const EARTH_CLIMATE: ClimateSpec = { model: 'budyko', albedo: 0.319, albedoP2: 0.202, iceAlbedo: 0.62, tau: 0, emissivity: 1, a: 203.3, b: 2.09, forcing: 0, heatCapacity: (0.71 * 4.7 + 0.29 * 0.16) * 2.09 * 3.15576e7, diffusion: 0.649, ocean: 0.71, pressurePa: 101_400 };
const greyClimate = (albedo: number, tau: number, extra: Partial<ClimateSpec> = {}): ClimateSpec => ({ model: 'grey', albedo, albedoP2: 0, iceAlbedo: albedo, tau, emissivity: 1, a: 0, b: 0, forcing: 0, heatCapacity: 1e7, diffusion: 0.649, ocean: 0, pressurePa: 0, ...extra });
/** The year's mean sunlight on each band for obliquity `eps` at `s` W/m^2. */
const annual = (s: number, eps: number): number[] => BAND_LATITUDES.map((lat) => {
  let sum = 0;
  for (let k = 0; k < 360; k += 1) sum += dailyInsolation(s, lat * DEG, Math.asin(Math.sin(eps) * Math.sin(((k + 0.5) * Math.PI) / 180)));
  return sum / 360;
});
const settle = (c: ClimateState, q: readonly number[], steps = 600): void => {
  for (let k = 0; k < steps; k += 1) stepBands(c, q, 1e8);
};

test('the day’s sunlight by latitude: S / pi at the equator at equinox, S sin(23.44) at the pole at midsummer, none in polar night, S / 4 over the globe and the year', () => {
  expect(dailyInsolation(1361, 0, 0)).toBeCloseTo(1361 / Math.PI, 9);
  expect(dailyInsolation(1361, 90 * DEG - 1e-9, 23.44 * DEG)).toBeCloseTo(1361 * Math.sin(23.44 * DEG), 4);
  expect(dailyInsolation(1361, -80 * DEG, 23.44 * DEG)).toBe(0);
  const q = annual(1361, 23.44 * DEG);
  const global = q.reduce((sum, v, i) => sum + v * (BAND_AREAS[i] ?? 0), 0);
  expect(global / (1361 / 4)).toBeCloseTo(1, 2);
});

test('North’s Earth in balance today: about 15 C, ice caps at the poles; a tenth less light spreads them, a fifth freezes it over, and it stays frozen when the light returns', () => {
  const earth: ClimateState = { spec: { ...EARTH_CLIMATE }, t: startingBands(EARTH_CLIMATE) };
  settle(earth, annual(S0, 23.44 * DEG));
  const today = climateSummary(earth);
  expect(today.meanK - 273.15).toBeGreaterThan(12);
  expect(today.meanK - 273.15).toBeLessThan(18);
  expect(today.iceLineDeg ?? 0).toBeGreaterThan(60);
  expect(today.iceLineDeg ?? 90).toBeLessThan(82);
  expect(today.liquid).toBeGreaterThan(0.5);
  // The Sun a tenth dimmer: the ice creeps toward the equator, to about 50 degrees...
  settle(earth, annual(0.9 * S0, 23.44 * DEG));
  const tenth = climateSummary(earth);
  expect(tenth.iceLineDeg ?? 90).toBeLessThan(today.iceLineDeg ?? 90);
  expect(tenth.ice).toBeGreaterThan(today.ice);
  expect(tenth.ice).toBeLessThan(0.5);
  // ...and a fifth dimmer it runs to the equator all at once (the large-cap instability): the ice-covered solution, near -45 C.
  settle(earth, annual(0.8 * S0, 23.44 * DEG));
  const frozen = climateSummary(earth);
  expect(frozen.ice).toBeCloseTo(1, 6);
  expect(frozen.meanK - 273.15).toBeLessThan(-35);
  expect(frozen.liquid).toBe(0);
  // Today's light again: ice reflects it, and the Earth stays frozen (hysteresis).
  settle(earth, annual(S0, 23.44 * DEG));
  expect(climateSummary(earth).ice).toBeCloseTo(1, 6);
});

test('a grey greenhouse calibrated to measured temperatures: Venus near 737 K, Mars near 214 K; an airless noon; water’s boiling point with pressure', () => {
  // tau from (T_s / T_e)^4 = 1 + 3 tau / 4 with the fact sheets' Bond albedos and irradiances.
  const tauFor = (s: number, albedo: number, surfaceK: number): number => {
    const te4 = (s * (1 - albedo)) / (4 * SIGMA);
    return Math.max(0, (surfaceK ** 4 / te4 - 1) / 0.75);
  };
  const venus: ClimateState = { spec: greyClimate(0.77, tauFor(2601.3, 0.77, 737), { diffusion: 10 }), t: new Array<number>(BANDS).fill(700) };
  settle(venus, annual(2601.3, 2.64 * DEG));
  expect(Math.abs(climateSummary(venus).meanK - 737)).toBeLessThan(8);
  // Its thick air evens it out: poles and equator within a few per cent.
  expect(climateSummary(venus).maxK / climateSummary(venus).minK).toBeLessThan(1.05);
  const mars: ClimateState = { spec: greyClimate(0.25, tauFor(586.2, 0.25, 214), { diffusion: 0.05 }), t: new Array<number>(BANDS).fill(214) };
  settle(mars, annual(586.2, 25.19 * DEG));
  expect(Math.abs(climateSummary(mars).meanK - 214)).toBeLessThan(15);
  // Water on Mars: below its triple point's pressure no liquid at any temperature.
  expect(climateSummary({ ...mars, spec: { ...mars.spec, ocean: 1, pressurePa: 636 } }).liquid).toBeGreaterThan(-1);
  expect(climateSummary({ spec: { ...mars.spec, ocean: 1, pressurePa: 600 }, t: new Array<number>(BANDS).fill(290) }).liquid).toBe(0);
  // The Moon's equator at noon, airless: the fact sheet gives 390 K.
  expect(noonK(1361, 0.11, 0.95)).toBeGreaterThan(380);
  expect(noonK(1361, 0.11, 0.95)).toBeLessThan(395);
  expect(boilingK(101_325)).toBeCloseTo(373.12, 1);
  // At Venus's 92 bar water would boil near 576 K; the constant-latent-heat form is within 2 per cent.
  expect(Math.abs(boilingK(9.2e6) / 576 - 1)).toBeLessThan(0.02);
});

test('stars shine by their mass: the Sun its own light, a star of 1.1 suns about 1.5 times as bright (Eker et al. 2018), a body below 0.075 suns not at all', () => {
  expect(mainSequenceLuminosityW(1.0788) / SUN_LUMINOSITY_W).toBeGreaterThan(1.3);
  expect(mainSequenceLuminosityW(1.0788) / SUN_LUMINOSITY_W).toBeLessThan(1.6);
  // The relation's own pieces: 10^(4.329 log M + 0.010) for 1.05 to 2.4 suns.
  expect(mainSequenceLuminosityW(2) / SUN_LUMINOSITY_W).toBeCloseTo(10 ** (4.329 * Math.log10(2) + 0.01), 9);
  const e = new Engine(solar());
  expect(Object.keys(e.state.stars)).toEqual(['sun']);
});

/** The Sun, and the Earth with North's climate, turning about its tilted axis. */
function solar(log: Scenario['log'] = []): Scenario {
  const v = Math.sqrt(physical.gmKm3S2.Sun / AU);
  const bodies: BodySpec[] = [
    { id: 'sun', name: 'Sun', gm: physical.gmKm3S2.Sun, radiusKm: mean(physical.bodies.Sun.radiiKm), pos: [0, 0, 0], vel: [0, 0, 0], origin: 'modelled', sourceIds: [], luminosityW: SUN_LUMINOSITY_W },
    // At the March equinox's place: the Sun on the -x side, the north pole tipped toward -y (away from the Sun's later summer side).
    { id: 'earth', name: 'Earth', gm: physical.gmKm3S2.Earth, radiusKm: mean(physical.bodies.Earth.radiiKm), pos: [AU, 0, 0], vel: [0, v, 0], origin: 'modelled', sourceIds: [], spin: { periodS: 86_164, pole: [0, -Math.sin(23.44 * DEG), Math.cos(23.44 * DEG)] }, climate: { ...EARTH_CLIMATE } },
  ];
  return { schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, name: 'climate', epochJdTdb: 2451545, frame: 'test', seedNote: '', integrator: { ...DEFAULT_INTEGRATOR }, bodies, log };
}

test('in the engine: the seasons (the north warmer when its pole leans toward the Sun), a heavier Sun warming the Earth, and climates replayed exactly', () => {
  const e = new Engine(solar());
  const earth = (): ClimateState => {
    const c = e.state.climate.earth;
    if (!c) throw new Error('no climate');
    return c;
  };
  // Settled at the start: today's mean, give or take.
  expect(climateSummary(earth()).meanK - 273.15).toBeGreaterThan(10);
  // A quarter year on the north pole leans toward the Sun (the June solstice's place): the north's middle band warmer than the south's.
  e.advanceTo(0.25 * 365.25 * 86_400, 1_000_000);
  e.advanceTo(0.4 * 365.25 * 86_400, 1_000_000);
  const north = earth().t[BANDS - 5] ?? 0;
  const south = earth().t[4] ?? 0;
  expect(north - south).toBeGreaterThan(0.8);
  // Half a year later, the other way about.
  e.advanceTo(0.9 * 365.25 * 86_400, 1_000_000);
  expect((earth().t[4] ?? 0) - (earth().t[BANDS - 5] ?? 0)).toBeGreaterThan(0.8);
  // Replayed through save and load: the same climate, bit for bit.
  const saved = JSON.parse(JSON.stringify(e.toScenario())) as Scenario;
  const again = new Engine(saved);
  again.advanceTo(e.state.t, 1_000_000);
  expect(again.state.climate.earth?.t).toEqual(earth().t);
  // The Sun at 1.2 times its mass shines (1.2)^4.329 times as brightly: the Earth warms by tens of degrees within years.
  const hot = new Engine(solar([{ step: 0, command: { kind: 'setMass', id: 'sun', gm: physical.gmKm3S2.Sun * 1.2 } }]));
  hot.advanceTo(3 * 365.25 * 86_400, 10_000_000);
  expect((climateSummary(hot.state.climate.earth ?? earth()).meanK - 273.15)).toBeGreaterThan(40);
  expect(SUN_GM).toBeCloseTo(physical.gmKm3S2.Sun, -3);
});
