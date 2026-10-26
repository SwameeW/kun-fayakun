/**
 * The Moon's and Mars's heights for walking (src/explore/walk/equirect): a grid read bilinearly
 * between pixel centres, wrapping in longitude; Web Mercator tiles resampled from the world's grid,
 * and from the finer tile where the Mercator pixels are finer than the world's.
 */
import { expect, test } from '@playwright/test';
import { equirectLoader, sampleGrid, type EquirectGrids, type Grid } from '../../src/explore/walk/equirect';
import { TERRAIN } from '../../src/explore/walk/terrain';

/** A height that is a known function of place: a ramp with longitude and latitude (m). */
const ramp = (lat: number, lon: number): number => lat * 10 + lon;
/** A grid of `ppd` pixels a degree spanning a box, filled from the ramp at its pixel centres. */
const grid = (ppd: number, westDeg: number, northDeg: number, widthDeg: number, heightDeg: number): Grid => {
  const width = widthDeg * ppd;
  const height = heightDeg * ppd;
  const heights = new Float32Array(width * height);
  for (let r = 0; r < height; r += 1) for (let c = 0; c < width; c += 1) heights[r * width + c] = ramp(northDeg - (r + 0.5) / ppd, westDeg + (c + 0.5) / ppd);
  return { width, height, heights, westDeg, northDeg, ppd };
};

test('a grid is read between its pixel centres, exactly for a ramp, and wraps round in longitude', () => {
  const world = grid(2, -180, 90, 360, 180);
  expect(sampleGrid(world, 10.1, 20.3)).toBeCloseTo(ramp(10.1, 20.3), 3);
  expect(sampleGrid(world, -45.6, -100.2)).toBeCloseTo(ramp(-45.6, -100.2), 3);
  // Across the date line the ramp jumps (it is not periodic), but the read stays between its neighbours.
  const across = sampleGrid(world, 0, 179.9);
  expect(across).toBeLessThanOrEqual(ramp(0, 179.75));
  expect(across).toBeGreaterThanOrEqual(ramp(0, -179.75));
});

test('Mercator tiles from the grids: the world’s grid when coarse, the 90-degree tile where finer, every pixel where it lies', async () => {
  const grids: EquirectGrids = { datumKm: 1737.4, base: { path: 'base', ppd: 2 }, detail: { path: '{col}-{row}', ppd: 8, tileDeg: 90, cols: 4, rows: 2 } };
  const asked: string[] = [];
  const decode = (url: string): Promise<{ width: number; height: number; heights: Float32Array }> => {
    asked.push(url);
    if (url === 'base') return Promise.resolve(grid(2, -180, 90, 360, 180));
    const [col, row] = url.split('-').map(Number);
    return Promise.resolve(grid(8, -180 + (col ?? 0) * 90, 90 - (row ?? 0) * 90, 90, 90));
  };
  const load = equirectLoader(grids, (p) => p, decode);
  // Zoom 0: one tile for the world, from the coarse grid alone.
  const world = await load(0, 0, 0);
  expect(world?.length).toBe(TERRAIN.tilePx ** 2);
  expect(asked).toEqual(['base']);
  // Zoom 8, a tile near 10 N, 20 E: from the detailed tile (column 2, row 0: 0 to 90 E, 90 N to 0).
  const z = 8;
  const n = 2 ** z;
  const x = Math.floor(((20 + 180) / 360) * n);
  const latRad = (10 * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  const tile = await load(z, x, y);
  expect(asked).toContain('2-0');
  // Its first pixel's centre: the ramp there.
  const lon = ((x + 0.5 / TERRAIN.tilePx) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5 / TERRAIN.tilePx)) / n))) * 180) / Math.PI;
  expect(tile?.[0] ?? 0).toBeCloseTo(ramp(lat, lon), 2);
});
