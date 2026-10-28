/**
 * Walking on the Earth, the Moon and Mars (src/explore/walk): the terrain tiles' encoding and Web
 * Mercator arithmetic (against the terrarium definition and the standard tile scheme, on worlds of any
 * size), the PNG decoder that reads them without a canvas (exact on the mocked tile and on every row
 * filter; a canvas read-back's 256 m spikes mended), heights read seamlessly across tiles and from
 * coarser tiles until finer arrive (and no finer than a world's grids hold), tiles that failed asked
 * for again after a back-off, and the walker: its frame, a jump's height under a world's own gravity
 * (v^2 / 2g), walking speed, the look's first-person sense, a place it may not enter, the suit's
 * figures; and the light on foot (src/explore/walk/light): the setting Sun reddening through the
 * Earth's air, its disc always far brighter than the sky round it, the sky's colours and its glow round
 * the Sun held under the bloom (and graded, not a plateau), the eye's adapted exposure and its meter for
 * dark ground, the regolith's lunar-Lambert law, the terrain's horizons (a ridge's and a cliff's, to half a
 * degree), the Sun's true size, and the stars' fade, eased through an airless world's sunset and sunrise.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { pngOf } from '../support/terrain';
import { createHeights, decodeTerrarium, despike, mercatorPixel, TERRAIN, zoomFor, type TileLoader } from '../../src/explore/walk/terrain';
import { decodePng } from '../../src/explore/walk/png';
import { createWalker, localFrame, look, pressureKpa, solarTimeHours, stepWalker, sunAzimuthDeg, sunElevationDeg, WALK, walkerPose, type WalkInput, type WalkWorld } from '../../src/explore/walk/walker';
import { AIRLESS_DAY, DAYLIGHT, footStarLight, pointsSeen, starlight } from '../../src/explore/walk/daylight';
import { kneedStarLight, starLight } from '../../src/explore/starlight';
import { FOOT_MAX_RATE } from '../../src/explore/time';
import { clearDayAir, dayAdaptation, EXPOSURE, groundIlluminance, horizonRise, luminance, lunarLambert, METER, skyCompression, SKY_KNEE, skyRadiance, SUN_DISC, sunDiscTint, sunThroughAir, walkExposure } from '../../src/explore/walk/light';
import { earthAir } from '../../src/explore/render/air';
import { equirectMaxZoom } from '../../src/explore/walk/equirect';
import type { DataStore } from '../../src/core/types';

const still: WalkInput = { forward: 0, right: 0, run: false, jump: false, turn: 0, tip: 0 };
const flat = (gravity: number, radiusKm = 6371): WalkWorld => ({ radiusKm, gravity, ground: () => 100, blocked: () => false });
const settle = async (): Promise<void> => {
  for (let k = 0; k < 5; k += 1) await Promise.resolve();
};

test('terrarium decoding and the Web Mercator tile scheme', () => {
  // height = R x 256 + G + B / 256 - 32768 m.
  expect(Array.from(decodeTerrarium([128, 0, 0, 255, 128, 100, 128, 255, 0, 0, 0, 255]))).toEqual([0, 100.5, -32768]);
  // The prime meridian and equator sit at the middle of the world at every zoom; zoom 1 has 512 px.
  expect(mercatorPixel(0, 0, 1)).toEqual({ x: 256, y: 256 });
  expect(mercatorPixel(0, -180, 0).x).toBeCloseTo(0, 9);
  expect(mercatorPixel(85.05112878, 0, 0).y).toBeCloseTo(0, 4);
  // About 4.8 m a pixel at zoom 15 on the equator, so 5 m asks for zoom 15 and 10 m for zoom 14.
  expect(TERRAIN.metresPerPixel0 / 2 ** 15).toBeCloseTo(4.777, 3);
  expect(zoomFor(5, 0)).toBe(15);
  expect(zoomFor(10, 0)).toBe(14);
  expect(zoomFor(1e7, 0)).toBe(0);
  // The same tiling over the Moon (1,737.4 km) has pixels 0.272 of the Earth's: 1.3 km asks for zoom 5
  // there (42.6 km / 2^5), where on the Earth it asks for zoom 7.
  expect(zoomFor(1300, 0, 1737.4)).toBe(5);
  expect(zoomFor(1300, 0)).toBe(7);
});

test('the Moon’s and Mars’s heights asked no finer than their grids hold, and walks kept within the tiles’ latitudes', async () => {
  // Their grids at 8 pixels a degree: zoom 6's pixels (360 / 2^14 degrees) are a quarter of theirs or finer.
  const grids = { datumKm: 1737.4, base: { path: 'b', ppd: 2 }, detail: { path: 'd', ppd: 8, tileDeg: 90, cols: 4, rows: 2 } };
  expect(equirectMaxZoom(grids)).toBe(6);
  expect(360 / (TERRAIN.tilePx * 2 ** 6)).toBeLessThanOrEqual(1 / 8 / 4);
  // Heights capped at zoom 6: asked for zoom 15, only zooms 5 and 6 are requested, and zoom 6 answers.
  const asked: number[] = [];
  const h = createHeights((z) => {
    asked.push(z);
    return Promise.resolve(new Float32Array(TERRAIN.tilePx * TERRAIN.tilePx).fill(-1200));
  }, 6);
  h.at(-20, 30, 15);
  await settle();
  expect(Math.max(...asked)).toBe(6);
  expect(h.at(-20, 30, 15)).toEqual({ metres: -1200, zoom: 6 });
  // A walk begun or walking toward a pole stops at 85 degrees (Web Mercator's tiles end at 85.05).
  const s = createWalker(89, 10, 0);
  expect(s.lat).toBe(WALK.maxLatDeg);
  const flatMoon: WalkWorld = { radiusKm: 1737.4, gravity: 1.62, ground: () => -1200, blocked: () => false };
  for (let k = 0; k < 100; k += 1) stepWalker(s, { ...still, forward: 1, run: true }, 0.2, flatMoon);
  expect(s.lat).toBeLessThanOrEqual(WALK.maxLatDeg);
  // Below the datum on a world without a sea (the walker stands on the ground the heights give).
  expect(s.feetM).toBe(-1200);
});

test('heights: exact on a plane across tile edges, and from a coarser tile until the finer arrives', async () => {
  // A plane tilted east (1 m per pixel of zoom 3) loaded only at zooms 2 and 3.
  const loader: TileLoader = (z, x, y) => {
    if (z > 3) return Promise.resolve(null);
    const out = new Float32Array(TERRAIN.tilePx * TERRAIN.tilePx);
    for (let j = 0; j < TERRAIN.tilePx; j += 1) for (let i = 0; i < TERRAIN.tilePx; i += 1) out[j * TERRAIN.tilePx + i] = (x * TERRAIN.tilePx + i + 0.5) * 2 ** (3 - z) + y * 0;
    return Promise.resolve(out);
  };
  const h = createHeights(loader);
  expect(h.at(10, 20, 3)).toBeNull();
  await settle();
  // Across the edge between two zoom-3 tiles the plane is exact (the neighbour's pixels are read).
  const edge = 360 / 8;
  for (const lon of [edge - 180 - 0.01, edge - 180, edge - 180 + 0.01]) {
    h.want(10, lon, 3);
    await settle();
    const got = h.at(10, lon, 3);
    expect(got?.zoom).toBe(3);
    expect(got?.metres ?? 0).toBeCloseTo(mercatorPixel(10, lon, 3).x, 6);
  }
  // Asked for zoom 5 (never loaded), it answers from zoom 3.
  expect(h.at(10, 21, 5)?.zoom).toBe(3);
  expect(h.stats().ready).toBeGreaterThan(0);
});

test('heights: their slope continuous across every pixel (no crease for a low Sun to find), and a cliff never overshot', async () => {
  // A valley's curve east and west (the height the square of the pixel's distance from a column, m), and a
  // cliff 500 m high, at zoom 3.
  const at = (z: number, x: number, i: number): number => (x * TERRAIN.tilePx + i + 0.5 - 1000) ** 2 * 0.01 * 2 ** (3 - z);
  const valley: TileLoader = (z, x) => {
    const out = new Float32Array(TERRAIN.tilePx * TERRAIN.tilePx);
    for (let j = 0; j < TERRAIN.tilePx; j += 1) for (let i = 0; i < TERRAIN.tilePx; i += 1) out[j * TERRAIN.tilePx + i] = at(z, x, i);
    return Promise.resolve(out);
  };
  const h = createHeights(valley, 3);
  const lonOf = (px: number): number => (px / (TERRAIN.tilePx * 8)) * 360 - 180;
  h.want(10, lonOf(1100), 3);
  await settle();
  // About a pixel's centre (x 1100.5), the slope just west of it and just east of it: the same (bilinear's
  // differed by the curve's whole second difference, 0.02 m a pixel).
  const read = (px: number): number => h.at(10, lonOf(px), 3)?.metres ?? Number.NaN;
  const e = 1e-3;
  const west = (read(1100.5) - read(1100.5 - e)) / e;
  const east = (read(1100.5 + e) - read(1100.5)) / e;
  expect(Math.abs(east - west)).toBeLessThan(0.002);
  // Exact at the pixels' centres, and a parabola's cubic interpolation near the curve between them.
  expect(read(1100.5)).toBeCloseTo(at(3, 0, 1100), 3);
  expect(Math.abs(read(1100.75) - (1100.75 - 1000) ** 2 * 0.01)).toBeLessThan(0.01);
  // A cliff: nowhere above its top or below its foot, however near the edge.
  const cliff: TileLoader = (_z, x) => {
    const out = new Float32Array(TERRAIN.tilePx * TERRAIN.tilePx);
    for (let j = 0; j < TERRAIN.tilePx; j += 1) for (let i = 0; i < TERRAIN.tilePx; i += 1) out[j * TERRAIN.tilePx + i] = x * TERRAIN.tilePx + i < 1100 ? 1000 : 1500;
    return Promise.resolve(out);
  };
  const c = createHeights(cliff, 3);
  c.want(10, lonOf(1100), 3);
  await settle();
  for (let px = 1097; px <= 1103; px += 0.1) {
    const m = c.at(10, lonOf(px), 3)?.metres ?? Number.NaN;
    expect(m).toBeGreaterThanOrEqual(1000);
    expect(m).toBeLessThanOrEqual(1500);
  }
});

test('the walker: its frame, a jump of v^2 / 2g on the Earth and the Moon, walking speed, a place it may not enter', () => {
  // The local frame is orthonormal, up out of the sphere.
  const f = localFrame(30, 45);
  const dot = (a: number[], b: number[]): number => a.reduce((s, x, k) => s + x * (b[k] ?? 0), 0);
  expect(dot(f.up, f.east)).toBeCloseTo(0, 12);
  expect(dot(f.up, f.north)).toBeCloseTo(0, 12);
  expect(dot(f.east, f.north)).toBeCloseTo(0, 12);
  expect(dot(f.up, f.up)).toBeCloseTo(1, 12);
  for (const [gravity, name] of [
    [9.81, 'Earth'],
    [1.62, 'Moon'],
  ] as const) {
    const s = createWalker(0, 0, 100);
    let top = 0;
    stepWalker(s, { ...still, jump: true }, 1e-4, flat(gravity));
    for (let k = 0; k < 200_000 && s.airborne; k += 1) {
      stepWalker(s, still, 1e-4, flat(gravity));
      top = Math.max(top, s.feetM - 100);
    }
    expect(top, name).toBeCloseTo((WALK.jumpMps * WALK.jumpMps) / (2 * gravity), 2);
    expect(s.feetM).toBe(100);
  }
  // Ten seconds' walk north covers 14 m (WALK.walkMps), and running east is faster.
  const w = createWalker(0, 0, 100);
  for (let k = 0; k < 1000; k += 1) stepWalker(w, { ...still, forward: 1 }, 0.01, flat(9.81));
  expect(w.walkedM).toBeCloseTo(14, 6);
  expect((w.lat * Math.PI * 6371e3) / 180).toBeCloseTo(14, 3);
  // Turned to face east (a drag to the right: the view turns the way the hand moves), the pose looks east.
  look(w, Math.PI / 2 / WALK.lookPerPx, 0);
  const p = walkerPose(w, 6371);
  expect(p.forward[2]).toBeCloseTo(-1, 6);
  // A drag up looks up; nothing that is not a number moves the look.
  const pitch = w.pitch;
  look(w, 0, -50);
  expect(w.pitch).toBeGreaterThan(pitch);
  const before = { heading: w.heading, pitch: w.pitch };
  look(w, Number.NaN, Number.POSITIVE_INFINITY);
  expect({ heading: w.heading, pitch: w.pitch }).toEqual(before);
  // A place it may not enter: the step is refused and the walker stays.
  const b = createWalker(0, 0, 100);
  stepWalker(b, { ...still, forward: 1 }, 1, { ...flat(9.81), blocked: () => true });
  expect(b.blocked).toBe(true);
  expect(b.lat).toBe(0);
});

test('the suit’s figures: pressure falling by e each scale height, the Sun’s elevation, local solar time', () => {
  expect(pressureKpa(0, 101.4, 8.5)).toBeCloseTo(101.4, 9);
  expect(pressureKpa(8500, 101.4, 8.5)).toBeCloseTo(101.4 / Math.E, 9);
  // The Sun straight over the place is at 90 degrees; on its horizon at 0.
  const up = localFrame(10, 20).up;
  expect(sunElevationDeg(10, 20, up)).toBeCloseTo(90, 9);
  expect(sunElevationDeg(10, 20, localFrame(10, 20).east)).toBeCloseTo(0, 9);
  // Where the Sun is overhead it is noon; 15 degrees east, an hour later.
  expect(solarTimeHours(40, 40)).toBeCloseTo(12, 12);
  expect(solarTimeHours(55, 40)).toBeCloseTo(13, 12);
  expect(solarTimeHours(-140, 40)).toBeCloseTo(0, 12);
});

test('the stars on foot: hidden by day, all through by nautical dusk, never fewer as the Sun sinks', () => {
  expect(starlight(30)).toBe(0);
  expect(starlight(DAYLIGHT.starsGoneDeg)).toBe(0);
  expect(starlight(DAYLIGHT.starsAllDeg)).toBe(1);
  expect(starlight(-40)).toBe(1);
  let last = 0;
  for (let e = 0; e >= -14; e -= 0.5) {
    expect(starlight(e)).toBeGreaterThanOrEqual(last);
    last = starlight(e);
  }
});

/** The explorer's Earth air from the cited constants, as the page builds it (render/air earthAir). */
const constants = (JSON.parse(readFileSync(new URL('../../data/constants.json', import.meta.url), 'utf8')) as { constants: Array<{ id: string; value: number }> }).constants;
const store = { constant: (id: string) => ({ value: constants.find((c) => c.id === id)?.value ?? Number.NaN }) } as unknown as DataStore;
/** The Sun's angular radius from the Earth (its radius over the astronomical unit, as the explorer takes them). */
const SUN_RADIUS = Math.asin(695_700 / 149_597_870.7);
const AIR = clearDayAir(earthAir(store, 6371, SUN_RADIUS));
const sinDeg = (d: number): number => Math.sin((d * Math.PI) / 180);
/** A view direction at an elevation and an azimuth from the Sun's (degrees; the zenith +z, the Sun in the x-z plane). */
const ray = (elevationDeg: number, fromSunDeg: number): [number, number, number] => {
  const e = (elevationDeg * Math.PI) / 180;
  const a = (fromSunDeg * Math.PI) / 180;
  return [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
};

test('the Sun through the Earth’s air from the ground: white high, reddened and dimmed low, gone once its disc has set', () => {
  const at = (deg: number): [number, number, number] => sunThroughAir(AIR, 0, sinDeg(deg));
  // High, nearly white (a touch yellow: the blue is scattered out); a degree up, deep red (blue gone).
  const high = at(60);
  expect(high[2] / high[0]).toBeGreaterThan(0.75);
  expect(high[0]).toBeGreaterThan(0.85);
  const low = at(1);
  expect(low[2] / low[0]).toBeLessThan(0.35);
  expect(low[0]).toBeGreaterThan(low[1]);
  expect(low[1]).toBeGreaterThan(low[2]);
  // Below the horizon by more than its disc (0.27 degrees): none.
  expect(at(-1)).toEqual([0, 0, 0]);
  // Dimming all the way down, every colour.
  let last = at(90);
  for (let e = 89; e >= -1; e -= 1) {
    const now = at(e);
    for (let k = 0; k < 3; k += 1) expect(now[k] ?? 0).toBeLessThanOrEqual((last[k] ?? 0) + 1e-9);
    last = now;
  }
  // From higher up the Sun sets later: still seen a degree below the level horizon from 2 km.
  expect(luminance(sunThroughAir(AIR, 2 / 6371, sinDeg(-1)))).toBeGreaterThan(0);
});

test('the sky from the ground: blue overhead, paler at the horizon, a glow round the Sun held under the bloom, reds under the setting Sun', () => {
  const h = 2 / 6371;
  for (const sun of [60, 42]) {
    const zenith = skyRadiance(AIR, h, sinDeg(sun), [0, 0, 1]);
    // A blue sky.
    expect(zenith[2]).toBeGreaterThan(zenith[1]);
    expect(zenith[1]).toBeGreaterThan(zenith[0]);
    // Paler and brighter toward the horizon (more air along the line of sight).
    const horizon = skyRadiance(AIR, h, sinDeg(sun), ray(2, 90));
    expect(luminance(horizon)).toBeGreaterThan(luminance(zenith));
    expect(horizon[0] / horizon[2]).toBeGreaterThan(zenith[0] / zenith[2]);
    // The aerosols' glow round the Sun: brighter than the zenith, but no plateau (at 10 degrees at most five times the zenith:
    // the CIE standard clear sky, ISO 15469, gives about 4.3 with the Sun 45 degrees up).
    expect(luminance(skyRadiance(AIR, h, sinDeg(sun), ray(sun, 10)))).toBeLessThanOrEqual(5 * luminance(zenith));
    expect(luminance(skyRadiance(AIR, h, sinDeg(sun), ray(sun + 3, 0)))).toBeGreaterThan(luminance(zenith));
  }
  // At sunset the horizon under the Sun is red-orange, and the one opposite is not.
  const toward = skyRadiance(AIR, h, sinDeg(1), ray(1, 0));
  const away = skyRadiance(AIR, h, sinDeg(1), ray(1, 180));
  expect(toward[0] / toward[2]).toBeGreaterThan(2);
  expect(toward[0] / toward[2]).toBeGreaterThan(away[0] / away[2]);
  // Deep in the night (the Sun 18 degrees down), the sky is all but black.
  expect(luminance(skyRadiance(AIR, h, sinDeg(-18), [0, 0, 1]))).toBeLessThan(1e-3);
});

test('the sky held under the bloom: never above its ceiling on screen, unchanged below its knee, smooth and rising, a brighter glow still brighter', () => {
  expect(skyCompression(0.2)).toBe(1);
  expect(skyCompression(SKY_KNEE.knee)).toBe(1);
  expect(skyCompression(Number.NaN)).toBe(1);
  let last = 0;
  for (let l = 0.01; l < 500; l *= 1.05) {
    const shown = l * skyCompression(l);
    expect(shown).toBeLessThanOrEqual(SKY_KNEE.ceiling + 1e-9);
    expect(shown).toBeGreaterThan(last);
    last = shown;
  }
  // Continuous at the knee, and so is its slope (no crease in a sky's gradient there).
  const held = (l: number): number => l * skyCompression(l);
  expect(Math.abs(held(SKY_KNEE.knee + 1e-6) - SKY_KNEE.knee)).toBeLessThan(1e-5);
  expect((held(SKY_KNEE.knee + 2e-4) - held(SKY_KNEE.knee + 1e-4)) / 1e-4).toBeGreaterThan(0.99);
  // No plateau: a sunset glow ten times brighter on screen still shows brighter (by more than a 1% step in luminance).
  for (const l of [1, 3, 10]) expect(held(10 * l) / held(l)).toBeGreaterThan(1.01);
  // With the walk's own exposure, no sky pixel 3 degrees or more from the Sun reaches the bloom's threshold (0.75 on screen), at any Sun height.
  const h = 2 / 6371;
  for (let sun = -6; sun <= 90; sun += 6) {
    const x = walkExposure(groundIlluminance('earth', sun, 1, AIR, h));
    for (const [el, az] of [[sun + 3, 0], [sun + 10, 0], [2, 0], [2, 180], [90, 0], [30, 90]] as const) {
      const c = skyRadiance(AIR, h, sinDeg(sun), ray(Math.min(90, el), az), 16);
      const l = luminance(c) * x;
      expect(l * skyCompression(l), `Sun ${String(sun)}, view ${String(el)}/${String(az)}`).toBeLessThan(0.75);
    }
  }
});

test('the eye’s adaptation to the day (what the airless sky’s hold on the stars eases in by): none by night, all of it by day, never less as the Sun climbs', () => {
  for (const light of [1, 6.7]) {
    let last = 0;
    for (let e = -5; e <= 30; e += 0.05) {
      const w = dayAdaptation(groundIlluminance('airless', e, light, null), light);
      expect(w, `${String(e)} degrees`).toBeGreaterThanOrEqual(last - 1e-12);
      expect(w).toBeLessThanOrEqual(1);
      last = w;
    }
    expect(dayAdaptation(groundIlluminance('airless', -1, light, null), light)).toBe(0);
    expect(dayAdaptation(groundIlluminance('airless', 10, light, null), light)).toBe(1);
  }
  expect(dayAdaptation(EXPOSURE.floorE)).toBe(0);
  expect(dayAdaptation(EXPOSURE.dayE)).toBe(1);
  expect(dayAdaptation(Number.NaN)).toBe(0);
  expect(dayAdaptation(0.5, Number.NaN)).toBe(0);
});

test('sunset and sunrise on an airless world: the stars’ light on the screen (the faint and the brightest) and the planets’ share ease through the twilight with the eye’s adaptation, no step (in real time, at the most the clock runs on foot, and a day a second)', () => {
  // The Moon's dark mare and Mercury (their sunlight, the Sun's pace across their sky in degrees a second, the ground the eye's meter sees).
  const seen: Record<string, unknown> = {};
  const top = starLight(-1.46);
  for (const [world, light, degPerSecond] of [
    ['moon', 1, 360 / (29.530589 * 86400)],
    ['mercury', 6.7, 360 / (175.94 * 86400)],
  ] as const) {
    // On the screen (after the exposure), at one pixel a CSS pixel, the eye at its adapted exposure; the explorer's light follows a fifth of
    // it (src/explore/index STARS), the sky's brightest is Sirius (V -1.46), held back by the day's knee as the shader holds it.
    const at = (h: number): { faint: number; brightest: number; points: number } => {
      const e = groundIlluminance('airless', h, light, null);
      const day = dayAdaptation(e, light);
      const exposure = walkExposure(e, light, 0.12);
      const stars = footStarLight('airless', h, day, 0.85 * exposure ** -0.8, exposure, 1, -1.46);
      return { faint: stars.light * exposure, brightest: (kneedStarLight(top * stars.light, stars.knee) / top) * exposure, points: pointsSeen('airless', h, day) };
    };
    // The worst change from one frame to the next (a ratio, either way) as the Sun sinks from 8 degrees to 3 below at a frame's step.
    const worst = (stepDeg: number): { faint: number; brightest: number; points: number } => {
      let prev = at(8);
      const out = { faint: 1, brightest: 1, points: 1 };
      for (let h = 8 - stepDeg; h >= -3; h -= stepDeg) {
        const next = at(h);
        for (const k of ['faint', 'brightest', 'points'] as const) out[k] = Math.max(out[k], Math.exp(Math.abs(Math.log(next[k] / prev[k]))));
        prev = next;
      }
      return out;
    };
    // Real time at 60 frames a second is far finer than a thousandth of a degree (the Moon's Sun sinks that in 2 minutes): bounded by that step's change.
    const fine = worst(0.001);
    const realTime = Math.max(fine.faint, fine.brightest) ** (degPerSecond / 60 / 0.001);
    // On foot the clock runs at most an hour a second (src/explore/time FOOT_MAX_RATE); a day a second is a time-lapse no walk reaches.
    const most = worst((degPerSecond * FOOT_MAX_RATE) / 60);
    const day = worst((degPerSecond * 86400) / 60);
    seen[world] = { thousandthDeg: fine, realTime, mostOnFoot: most, dayPerSecond: day };
    // No step: the share that stepped from a third to all of it as the Sun crossed the horizon changed 2.86 times in one frame at any pace.
    for (const k of ['faint', 'brightest', 'points'] as const) {
      expect(fine[k], `${world}, ${k}`).toBeLessThan(1.01);
      expect(most[k], `${world}, ${k}`).toBeLessThan(1.05);
      // A day a second sweeps the eye's whole adaptation in a few frames: still well under the old step.
      expect(day[k], `${world}, ${k}`).toBeLessThan(2);
    }
    expect(realTime, world).toBeLessThan(1.0001);
    // By day all of the glare, by night none: the planets at their share, the stars the night's.
    expect(at(10).points).toBeCloseTo(AIRLESS_DAY.stars, 12);
    expect(at(-1).points).toBe(1);
    expect(at(-1).faint / at(-3).faint).toBeCloseTo(1, 12);
    expect(at(10).brightest).toBeLessThan(at(-1).brightest / 10);
    expect(at(10).faint).toBeLessThan(at(-1).faint / 5);
  }
  test.info().annotations.push({ type: 'sunset', description: JSON.stringify(seen) });
});

test('the eye’s adaptation on foot: opening as the light fails, continuous through sunset, within its stops, darker worlds opened further', () => {
  const h = 2 / 6371;
  for (const kind of ['earth', 'mars', 'airless'] as const) {
    let last = 0;
    const light = kind === 'mars' ? 0.43 : 1;
    for (let e = 90; e >= -20; e -= 0.05) {
      const x = walkExposure(groundIlluminance(kind, e, light, AIR, h), light);
      expect(x, `${kind} at ${String(e)} degrees`).toBeGreaterThanOrEqual(last - 1e-9);
      expect(x).toBeGreaterThanOrEqual(EXPOSURE.min);
      expect(x).toBeLessThanOrEqual(EXPOSURE.max);
      // No jump (the slew limiter eases what change there is): a twentieth of a degree moves it under a quarter of a stop.
      if (last > 0) expect(Math.abs(Math.log2(x / last)), `${kind} at ${String(e)} degrees`).toBeLessThan(0.25);
      last = x;
    }
    // Night: the eye opens no further than its limit, so the night stays dark.
    expect(walkExposure(groundIlluminance(kind, -20, 1, AIR, h))).toBe(EXPOSURE.max);
  }
  // A day's ground near middle grey: at noon on the Earth about one (the explorer's exposure from orbit).
  const noon = walkExposure(groundIlluminance('earth', 60, 1, AIR, h));
  expect(noon).toBeGreaterThan(0.9);
  expect(noon).toBeLessThan(1.5);
  // The eye adapts wholly to its world's sunlight: Mars (0.43 of the Earth's, through its dust) opens at least
  // 1 / 0.43 wider than the Earth at the same Sun height; Mercury (6.7) closes at least that much.
  expect(walkExposure(groundIlluminance('mars', 40, 0.43, null), 0.43)).toBeGreaterThan(walkExposure(groundIlluminance('earth', 40, 1, AIR, h)) / 0.43);
  expect(walkExposure(groundIlluminance('airless', 40, 6.7, null), 6.7)).toBeCloseTo(walkExposure(groundIlluminance('airless', 40, 1, null)) / 6.7, 9);
  // Non-numbers never make an exposure that is not one.
  expect(Number.isFinite(walkExposure(Number.NaN))).toBe(true);
  expect(Number.isFinite(walkExposure(0.5, Number.NaN))).toBe(true);
  // Ground seen darker than the meter's grey (Apollo 11's mare, Jezero's floor) opened up as a camera
  // metering it would, never more than METER.most; bright level ground left (sand stays bright); and a
  // darker ground still shown a little darker than a brighter one.
  const e = groundIlluminance('airless', 30, 1, null);
  expect(walkExposure(e, 1, 0.05) / walkExposure(e)).toBeCloseTo((METER.reference / 0.05) ** METER.power, 9);
  expect(walkExposure(e, 1, 0.45)).toBe(walkExposure(e));
  expect(walkExposure(e, 1, 1e-4) / walkExposure(e)).toBeCloseTo(METER.most, 9);
  // A slope turned to a low Sun, seen brighter than any level ground: stopped down, at most METER.most.
  expect(walkExposure(e, 1, 2) / walkExposure(e)).toBeCloseTo((METER.bright / 2) ** METER.power, 9);
  expect(walkExposure(e, 1, 1e4) / walkExposure(e)).toBeCloseTo(1 / METER.most, 9);
  expect(walkExposure(e, 1, 0.03) * 0.03).toBeLessThan(walkExposure(e, 1, 0.08) * 0.08);
  expect(walkExposure(e, 1, 0)).toBe(walkExposure(e));
});

test('the Sun’s disc on foot: the air’s colour, dimmed as the light fails, but never as dim as the sky round it', () => {
  const h = 2 / 6371;
  for (let deg = 90; deg >= 0; deg -= 0.5) {
    const tint = sunDiscTint(sunThroughAir(AIR, h, sinDeg(deg)));
    // On screen the explorer's disc of 5 times this: always several times the sky's ceiling (four at least), no channel past the disc's own ceiling.
    expect(5 * luminance(tint), `Sun ${String(deg)}`).toBeGreaterThanOrEqual(4 * SKY_KNEE.ceiling);
    for (const c of tint) expect(c).toBeLessThanOrEqual(SUN_DISC.most + 1e-9);
    // Still the air's colour: red over green over blue.
    expect(tint[0]).toBeGreaterThanOrEqual(tint[1] - 1e-9);
    expect(tint[1]).toBeGreaterThanOrEqual(tint[2] - 1e-9);
  }
  // High, white as it was; low, deep orange (its core paler than its light, as an overexposed sunset's).
  const noon = sunDiscTint(sunThroughAir(AIR, h, sinDeg(60)));
  expect(noon[2] / noon[0]).toBeGreaterThan(0.75);
  const low = sunDiscTint(sunThroughAir(AIR, h, sinDeg(1.5)));
  expect(low[2] / low[0]).toBeLessThan(0.5);
  // Set: none.
  expect(sunDiscTint([0, 0, 0])).toEqual([0, 0, 0]);
});

test('the regolith’s lunar-Lambert law: Lambert’s straight down, flat-lit and brighter at a low Sun seen down-Sun, Lambert’s toward the Sun', () => {
  // Lit and seen from overhead (phase 0): Lambert's 1, times the opposition surge (1.4 at the shadow point).
  expect(lunarLambert(1, 1, 0)).toBeCloseTo(1.4, 9);
  // A low Sun (60 degrees from the normal) seen from near it (small phase): brighter than Lambert's mu0.
  expect(lunarLambert(0.5, 0.45, 5)).toBeGreaterThan(0.5 * 1.3);
  // Seen at a large phase angle the law is Lambert's (and no surge).
  expect(lunarLambert(0.5, 0.9, 140)).toBeCloseTo(0.5, 2);
  // No light from behind the ground.
  expect(lunarLambert(-0.2, 0.5, 30)).toBe(0);
});

test('the terrain’s horizons: a ridge and a cliff seen to within half a degree, none over flat ground, the world’s curve counted', () => {
  const R = 6371;
  const deg = (t: number): number => (Math.atan(t) * 180) / Math.PI;
  // A ridge 1,000 m high, a Gaussian 300 m wide, 2 km east; and a cliff 1,000 m high from 2 km east on.
  const ridge = (e: number): number => 1000 * Math.exp(-((e - 2) ** 2) / (2 * 0.3 ** 2));
  const cliff = (e: number): number => (e >= 2 ? 1000 : 0);
  for (const [name, h] of [['ridge', ridge], ['cliff', cliff]] as const) {
    // The truth: every metre marched.
    let truth = -1;
    for (let x = 0.008; x < 60; x += 0.001) truth = Math.max(truth, (h(x) - (x * x * 1000) / (2 * R)) / (x * 1000));
    const got = horizonRise((e) => h(e), 0, 0, 0, 1, 0, 0.008, R);
    expect(Math.abs(deg(got) - deg(truth)), name).toBeLessThan(0.5);
    expect(Math.abs(deg(got) - deg(0.5)), `${name}: about atan(1000 / 2000)`).toBeLessThan(name === 'cliff' ? 0.5 : 3);
    // Looking the other way, nothing rises.
    expect(horizonRise((e) => h(e), 0, 0, 0, -1, 0, 0.008, R)).toBeLessThan(0);
  }
  // Flat ground: the world's curve takes it below the level; the march stops where the heights are not known.
  expect(horizonRise(() => 0, 0, 0, 0, 0, 1, 0.008, R)).toBeLessThan(0);
  expect(horizonRise((e) => (e < 1 ? 0 : null), 0, 0, 0, 1, 0, 0.008, R)).toBeLessThan(0);
});

test('the Sun at its true size: about 0.53 degrees across from the Earth, so a few pixels on foot', () => {
  const diameterDeg = (2 * SUN_RADIUS * 180) / Math.PI;
  expect(diameterDeg).toBeGreaterThan(0.52);
  expect(diameterDeg).toBeLessThan(0.545);
  // On foot (70 degrees of field, 900 px tall) its disc's radius is pxPerTan x tan(radius): about 3 px.
  const pxPerTan = 900 / (2 * Math.tan((35 * Math.PI) / 180));
  expect(pxPerTan * Math.tan(SUN_RADIUS)).toBeCloseTo(3.0, 1);
});

test('the Sun’s azimuth: clockwise from north', () => {
  const f = localFrame(10, 20);
  expect(sunAzimuthDeg(10, 20, f.north)).toBeCloseTo(0, 9);
  expect(sunAzimuthDeg(10, 20, f.east)).toBeCloseTo(90, 9);
  expect(sunAzimuthDeg(10, 20, f.north.map((v) => -v) as [number, number, number])).toBeCloseTo(180, 9);
  expect(sunAzimuthDeg(10, 20, f.east.map((v) => -v) as [number, number, number])).toBeCloseTo(270, 9);
});

test('PNG decoded in script (no canvas a browser may tamper with): exact on the mocked terrain tile and through every row filter', async () => {
  // The browser specs' terrain tile: flat at 1,000 m everywhere, to the bit.
  const flat = await decodePng(new Uint8Array(readFileSync(new URL('../support/terrain-1000m.png', import.meta.url))));
  expect(flat).not.toBeNull();
  if (!flat) return;
  expect([flat.width, flat.height, flat.channels]).toEqual([256, 256, 3]);
  const heights = decodeTerrarium(flat.data, new Float32Array(256 * 256), flat.channels);
  expect(Math.min(...heights)).toBe(1000);
  expect(Math.max(...heights)).toBe(1000);
  // Every filter (none, sub, up, average, Paeth) on a varied image: every byte back.
  const pixel = (x: number, y: number): [number, number, number] => [(x * 37 + y * 11) & 0xff, (x * x + y * 3) & 0xff, (x ^ (y * 7)) & 0xff];
  const file = pngOf(19, 15, pixel, [0, 1, 2, 3, 4]);
  const back = await decodePng(file);
  expect(back).not.toBeNull();
  for (let y = 0; y < 15; y += 1)
    for (let x = 0; x < 19; x += 1)
      for (let k = 0; k < 3; k += 1) expect(back?.data[(y * 19 + x) * 3 + k]).toBe(pixel(x, y)[k]);
  // What it does not read (not a PNG, a cut file) is null, for the canvas to try.
  expect(await decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull();
  expect(await decodePng(file.subarray(0, 40))).toBeNull();
});

test('a canvas read-back’s tampering mended: 256 m spikes and pits put back, real relief left alone', () => {
  const size = 16;
  const ramp = new Float32Array(size * size).map((_, i) => 1000 + (i % size) * 30 + Math.floor(i / size) * 7);
  const tampered = ramp.slice();
  // Brave's farbling flips the low bit of a red byte: exactly 256 m up or down.
  tampered[5 * size + 5] = (tampered[5 * size + 5] ?? 0) + 256;
  tampered[9 * size + 10] = (tampered[9 * size + 10] ?? 0) - 256;
  despike(tampered, size);
  expect(Array.from(tampered)).toEqual(Array.from(ramp));
  // A real cliff (a 400 m step along a row) is not a spike: unchanged.
  const cliff = new Float32Array(size * size).map((_, i) => (i % size < 8 ? 1000 : 1400));
  const copy = cliff.slice();
  despike(copy, size);
  expect(Array.from(copy)).toEqual(Array.from(cliff));
});

test('heights: a tile that failed is asked for again after a growing back-off, never hammering a host that is down, at once on retry', async () => {
  let clock = 0;
  const calls: number[] = [];
  let fail = 2;
  const h = createHeights(
    () => {
      calls.push(clock);
      if (fail > 0) {
        fail -= 1;
        return Promise.reject(new Error('down'));
      }
      return Promise.resolve(new Float32Array(TERRAIN.tilePx * TERRAIN.tilePx).fill(321));
    },
    0,
    () => clock,
  );
  h.want(0, 0, 0);
  await settle();
  expect(h.stats().failed).toBe(1);
  // Not again before its wait (TERRAIN.retryS: 1 s first).
  clock = 500;
  h.want(0, 0, 0);
  await settle();
  expect(calls.length).toBe(1);
  clock = 1000;
  h.want(0, 0, 0);
  await settle();
  expect(calls.length).toBe(2);
  // The second wait is longer; then it loads.
  clock = 2500;
  h.want(0, 0, 0);
  await settle();
  expect(calls.length).toBe(2);
  clock = 3001;
  h.want(0, 0, 0);
  await settle();
  expect(calls.length).toBe(3);
  expect(h.at(0, 0, 0)?.metres).toBe(321);
  // A host that never answers, asked every second for 200 s: the waits 1, 2, 4 and 8 s, then every 30 s.
  let tries = 0;
  const down = createHeights(
    () => {
      tries += 1;
      return Promise.resolve(null);
    },
    0,
    () => clock,
  );
  for (let t = 0; t < 200; t += 1) {
    down.want(10, 10, 0);
    await settle();
    clock += 1000;
  }
  const fast = TERRAIN.retryS.slice(0, -1).reduce((a, b) => a + b, 0);
  expect(tries).toBe(1 + (TERRAIN.retryS.length - 1) + Math.floor((200 - fast - 1) / (TERRAIN.retryS.at(-1) ?? 30)));
  expect(tries).toBeLessThan(12);
  // Retry asks again at once.
  const before = tries;
  down.retry();
  down.want(10, 10, 0);
  await settle();
  expect(tries).toBe(before + 1);
});
