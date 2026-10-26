/**
 * Walking on the Earth, the Moon and Mars (src/explore/walk): the terrain tiles' encoding and Web
 * Mercator arithmetic (against the terrarium definition and the standard tile scheme, on worlds of any
 * size), heights read seamlessly across tiles and from coarser tiles until finer arrive (and no finer
 * than a world's grids hold), and the walker: its frame, a jump's height under
 * a world's own gravity (v^2 / 2g), walking speed, a place it may not enter, the suit's figures, and
 * the day's light on foot (the stars' fade, the sky's adaptation, twilight).
 */
import { expect, test } from '@playwright/test';
import { createHeights, decodeTerrarium, mercatorPixel, TERRAIN, zoomFor, type TileLoader } from '../../src/explore/walk/terrain';
import { createWalker, localFrame, look, pressureKpa, solarTimeHours, stepWalker, sunElevationDeg, WALK, walkerPose, type WalkInput, type WalkWorld } from '../../src/explore/walk/walker';
import { ambient, DAYLIGHT, haze, preethamSunIntensity, skyGain, starlight, twilight } from '../../src/explore/walk/daylight';
import { equirectMaxZoom } from '../../src/explore/walk/equirect';

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
  // Turned to face east (a drag to the left: the scene moves with it), the pose looks east.
  look(w, -Math.PI / 2 / 0.0032, 0);
  const p = walkerPose(w, 6371);
  expect(p.forward[2]).toBeCloseTo(-1, 6);
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

test('the day’s light on foot: the stars hidden by day and all through by nautical dusk, the sky’s adaptation, twilight only as the daylight model’s light ends', () => {
  expect(starlight(30)).toBe(0);
  expect(starlight(DAYLIGHT.starsGoneDeg)).toBe(0);
  expect(starlight(DAYLIGHT.starsAllDeg)).toBe(1);
  expect(starlight(-40)).toBe(1);
  let last = 0;
  for (let e = 0; e >= -14; e -= 0.5) {
    expect(starlight(e)).toBeGreaterThanOrEqual(last);
    last = starlight(e);
  }
  // The sky as drawn at noon-like heights; brightened as its Sun dims, up to the cap where its light ends.
  expect(skyGain(42)).toBeCloseTo(1, 9);
  expect(skyGain(70)).toBe(1);
  expect(skyGain(0)).toBeCloseTo(preethamSunIntensity(42) / preethamSunIntensity(0), 9);
  expect(skyGain(-3)).toBe(DAYLIGHT.maxGain);
  // The ground's ambient light: full by day, a faint floor at night, never rising as the Sun sinks.
  expect(ambient(20)).toBe(1);
  expect(ambient(-30)).toBeCloseTo(DAYLIGHT.night, 9);
  for (let e = 20; e > -20; e -= 1) expect(ambient(e - 1)).toBeLessThanOrEqual(ambient(e));
  // The haze fades faster: below the fill's level from sunset down.
  expect(haze(20)).toBe(1);
  for (let e = 0; e > -12; e -= 1) expect(haze(e)).toBeLessThan(ambient(e));
  // Twilight's own sky: none with the Sun well up, brightest about sunset, dimming below.
  expect(twilight(5).zenith).toEqual([0, 0, 0]);
  expect(twilight(-2).zenith[2]).toBeGreaterThan(twilight(-6).zenith[2]);
  expect(twilight(-6).zenith[2]).toBeGreaterThan(twilight(-12).zenith[2]);
  expect(twilight(-1).glow[0]).toBeGreaterThan(twilight(-1).glow[2]);
});
