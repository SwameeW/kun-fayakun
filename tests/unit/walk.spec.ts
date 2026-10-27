/**
 * Walking on the Earth, the Moon and Mars (src/explore/walk): the terrain tiles' encoding and Web
 * Mercator arithmetic (against the terrarium definition and the standard tile scheme, on worlds of any
 * size), the PNG decoder that reads them without a canvas (exact on the mocked tile and on every row
 * filter; a canvas read-back's 256 m spikes mended), heights read seamlessly across tiles and from
 * coarser tiles until finer arrive (and no finer than a world's grids hold), tiles that failed asked
 * for again after a back-off, and the walker: its frame, a jump's height under a world's own gravity
 * (v^2 / 2g), walking speed, the look's first-person sense, a place it may not enter, the suit's
 * figures; and the light on foot (src/explore/walk/light): the setting Sun reddening through the
 * Earth's air, the sky's colours and its glow round the Sun held under the bloom, the eye's adapted
 * exposure, the Sun's true size, and the stars' fade.
 */
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { createHeights, decodeTerrarium, despike, mercatorPixel, TERRAIN, zoomFor, type TileLoader } from '../../src/explore/walk/terrain';
import { decodePng } from '../../src/explore/walk/png';
import { createWalker, localFrame, look, pressureKpa, solarTimeHours, stepWalker, sunAzimuthDeg, sunElevationDeg, WALK, walkerPose, type WalkInput, type WalkWorld } from '../../src/explore/walk/walker';
import { DAYLIGHT, starlight } from '../../src/explore/walk/daylight';
import { ALBEDO_KEY, clearDayAir, EXPOSURE, groundIlluminance, luminance, skyCompression, SKY_KNEE, skyRadiance, sunThroughAir, walkExposure } from '../../src/explore/walk/light';
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

test('the sky held under the bloom: never above its ceiling on screen, unchanged below its knee, smooth and rising', () => {
  expect(skyCompression(0.2)).toBe(1);
  expect(skyCompression(SKY_KNEE.knee)).toBe(1);
  let last = 0;
  for (let l = 0.01; l < 500; l *= 1.05) {
    const shown = l * skyCompression(l);
    expect(shown).toBeLessThanOrEqual(SKY_KNEE.ceiling + 1e-9);
    expect(shown).toBeGreaterThanOrEqual(last - 1e-12);
    last = shown;
  }
  // Continuous at the knee.
  expect(Math.abs((SKY_KNEE.knee + 1e-6) * skyCompression(SKY_KNEE.knee + 1e-6) - SKY_KNEE.knee)).toBeLessThan(1e-5);
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

test('the eye’s adaptation on foot: opening as the light fails, continuous through sunset, within its stops, darker worlds opened further', () => {
  const h = 2 / 6371;
  for (const kind of ['earth', 'mars', 'airless'] as const) {
    let last = 0;
    for (let e = 90; e >= -20; e -= 0.05) {
      const x = walkExposure(groundIlluminance(kind, e, kind === 'mars' ? 0.43 : 1, AIR, h));
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
  // Mars (0.43 of the Earth's sunlight, through its dust) opens wider than the Earth at the same Sun height; Mercury (6.7) far less.
  expect(walkExposure(groundIlluminance('mars', 40, 0.43, null))).toBeGreaterThan(walkExposure(groundIlluminance('earth', 40, 1, AIR, h)) * (1 / 0.43) ** EXPOSURE.adapt * 0.7);
  expect(walkExposure(groundIlluminance('airless', 40, 6.7, null))).toBeLessThan(walkExposure(groundIlluminance('airless', 40, 1, null)) / 4);
  // Non-numbers never make an exposure that is not one.
  expect(Number.isFinite(walkExposure(Number.NaN))).toBe(true);
  // A dark world's ground (the Moon's albedo 0.11, Mercury's 0.068) opened up as a camera metering it would,
  // a bright one (Mars's 0.25) not dimmed, and never more than ALBEDO_KEY.most.
  const e = groundIlluminance('airless', 30, 1, null);
  expect(walkExposure(e, 0.11) / walkExposure(e)).toBeCloseTo((ALBEDO_KEY.reference / 0.11) ** ALBEDO_KEY.power, 9);
  expect(walkExposure(e, 0.25)).toBe(walkExposure(e));
  expect(walkExposure(e, 0.001) / walkExposure(e)).toBeCloseTo(ALBEDO_KEY.most, 9);
  expect(walkExposure(e, 0.068)).toBeGreaterThan(walkExposure(e, 0.11));
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

/** A PNG of 8-bit RGB rows, each row filtered with the given filter type (PNG section 9), from Node's zlib. */
function pngOf(width: number, height: number, pixel: (x: number, y: number) => [number, number, number], filters: readonly number[]): Uint8Array {
  const bpp = 3;
  const stride = width * bpp;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), y * stride + x * bpp);
  const out = new Uint8Array(height * (stride + 1));
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const type = filters[y % filters.length] ?? 0;
    out[y * (stride + 1)] = type;
    for (let x = 0; x < stride; x += 1) {
      const v = raw[y * stride + x] ?? 0;
      const a = x >= bpp ? (raw[y * stride + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (raw[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= bpp && y > 0 ? (raw[(y - 1) * stride + x - bpp] ?? 0) : 0;
      const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][type] ?? 0;
      out[y * (stride + 1) + 1 + x] = (v - predicted) & 0xff;
    }
  }
  const chunk = (name: string, body: Uint8Array): Uint8Array => {
    const c = new Uint8Array(12 + body.length);
    const view = new DataView(c.buffer);
    view.setUint32(0, body.length);
    for (let i = 0; i < 4; i += 1) c[4 + i] = name.charCodeAt(i);
    c.set(body, 8);
    return c;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', new Uint8Array(deflateSync(out))), chunk('IEND', new Uint8Array(0))];
  const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    file.set(p, at);
    at += p.length;
  }
  return file;
}

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
