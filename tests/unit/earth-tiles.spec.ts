/**
 * The streamed imagery's placement (src/explore/earth-tiles): each window knows where its aim falls
 * in it, worked out in double precision (also across the antimeridian), and the shader's arithmetic
 * (./sample: a pixel placed by its angle from the aim) keeps the imagery within a few hundredths of a
 * texel at zoom 13 far from the prime meridian, where the tile coordinate formed the plain way,
 * (longitude + 180) times tiles per degree in single precision, stepped by up to half a texel (the
 * terraces on the valley floor under Aoraki at dusk). The second test models the shader's arithmetic
 * in single precision (Math.fround), step for step.
 */
import { expect, test } from '@playwright/test';
import type { WebGPURenderer } from 'three/webgpu';
import { createClipmap } from '../../src/explore/earth-tiles/clipmap';
import { spanDeg, tileCoord } from '../../src/explore/earth-tiles/grid';
import { CLEAR } from '../../src/explore/earth-tiles/sources';

const DEG = Math.PI / 180;
const f = Math.fround;
/** The renderer as the clipmap uses it before any tile arrives: it only creates the atlas. */
const renderer = { initTexture() {}, backend: {} } as unknown as WebGPURenderer;

/** A clipmap of the cloudless layer aimed at a place (degrees), its requests left waiting. */
function aimed(latDeg: number, lonDeg: number) {
  const clipmap = createClipmap(renderer, CLEAR, { levels: 4, k: 8, cacheTiles: 8, writesPerFrame: 1, concurrency: 1, fromZoom: 5 });
  // A footprint of a few centimetres: the finest zoom the layer has (13).
  clipmap.update({ lat: latDeg * DEG, lon: lonDeg * DEG, footprint: 1e-8 });
  return clipmap;
}

test.describe('the imagery placed from its aim', () => {
  const fetched = globalThis.fetch;
  test.beforeAll(() => {
    // Requests never answer: only where the windows sit is checked.
    globalThis.fetch = () => new Promise<Response>(() => undefined);
  });
  test.afterAll(() => {
    globalThis.fetch = fetched;
  });

  test('each window holds its aim a few tiles in, where the grid puts it, across the antimeridian too', () => {
    for (const [lat, lon] of [
      [-43.7, 170.1],
      [27.98, 86.83],
      [10, 179.999],
      [-16.5, -179.999],
      [64.1, -21.9],
    ] as const) {
      const clipmap = aimed(lat, lon);
      expect(clipmap.aim.lat).toBeCloseTo(lat * DEG, 12);
      expect(clipmap.aim.lon).toBeCloseTo(lon * DEG, 12);
      for (const r of clipmap.ranks) {
        expect(r.on).toBe(true);
        const at = tileCoord(CLEAR.grid, r.zoom, lat * DEG, lon * DEG);
        expect(r.around).toBeCloseTo(360 / spanDeg(CLEAR.grid, r.zoom), 9);
        // The aim within the window's middle tile, and the window's origin plus it the aim's own column (in the wrap).
        expect(r.aimX).toBeGreaterThanOrEqual(4);
        expect(r.aimX).toBeLessThan(5);
        expect(r.aimY).toBeGreaterThanOrEqual(4);
        expect(r.aimY).toBeLessThan(5);
        const column = (((r.originX + r.aimX - at.x) % r.around) + r.around) % r.around;
        expect(Math.min(column, r.around - column)).toBeLessThan(1e-9);
        expect(r.originY + r.aimY - at.y).toBeCloseTo(0, 9);
      }
      clipmap.dispose();
    }
  });

  test('in single precision, a pixel placed from the aim is within a few hundredths of a texel at zoom 13; placed the plain way, it stepped by up to half a texel', () => {
    // Under Aoraki at dusk, a line 200 m long across the valley floor, a point every 5 cm.
    const clipmap = aimed(-43.7, 170.1);
    const fine = clipmap.ranks[clipmap.ranks.length - 1];
    if (!fine) throw new Error('no ranks');
    expect(fine.zoom).toBe(13);
    const tilesPerDeg = fine.scale;
    const { lat: lat0, lon: lon0 } = clipmap.aim;
    const turn = [f(Math.cos(lon0)), f(Math.sin(lon0)), f(Math.cos(lat0)), f(Math.sin(lat0))] as const;
    const R = 6_371_000;
    const errors: Array<{ fresh: number; plain: number; freshY: number; plainY: number }> = [];
    for (let m = 0; m <= 200; m += 0.05) {
      const lat = lat0 + 30 / R + (m * 0.3) / R;
      const lon = lon0 + (400 + m) / (R * Math.cos(lat));
      // The direction as the GPU holds it (single precision), and where it truly falls in the window.
      const x = f(Math.cos(lat) * Math.cos(lon));
      const y = f(Math.sin(lat));
      const z = f(-Math.cos(lat) * Math.sin(lon));
      const truth = ((lon / DEG + 180) * tilesPerDeg - fine.originX) * CLEAR.grid.tilePx;
      const truthY = ((90 - lat / DEG) * tilesPerDeg - fine.originY) * CLEAR.grid.tilePx;
      // ./sample: the direction turned to the aim's meridian, the longitude from it, added to the aim's place.
      const east = f(-z);
      const along = f(f(x * turn[0]) + f(east * turn[1]));
      const across = f(f(east * turn[0]) - f(x * turn[1]));
      const dLon = f(Math.atan2(across, along));
      const fresh = f(f(fine.aimX) + f(dLon * f(tilesPerDeg / DEG))) * CLEAR.grid.tilePx;
      // The plain way: (longitude + 180) times tiles per degree, less the origin.
      const plainLon = f(f(Math.atan2(east, x)) * f(1 / DEG));
      const plain = f(f(f(plainLon + 180) * f(tilesPerDeg)) - f(fine.originX)) * CLEAR.grid.tilePx;
      // And the latitude from the aim's, in its meridian's plane (rows run south).
      const level = f(Math.hypot(x, z));
      const dLat = f(Math.atan2(f(f(y * turn[2]) - f(level * turn[3])), f(f(level * turn[2]) + f(y * turn[3]))));
      const freshY = f(f(fine.aimY) - f(dLat * f(tilesPerDeg / DEG))) * CLEAR.grid.tilePx;
      const plainY = f(f(f(90 - f(f(Math.asin(y)) * f(1 / DEG))) * f(tilesPerDeg)) - f(fine.originY)) * CLEAR.grid.tilePx;
      errors.push({ fresh: fresh - truth, plain: plain - truth, freshY: freshY - truthY, plainY: plainY - truthY });
    }
    // Errors about their mean (a constant offset is no step), in texels.
    const worst = (k: 'fresh' | 'plain' | 'freshY' | 'plainY'): number => {
      const mean = errors.reduce((sum, e) => sum + e[k], 0) / errors.length;
      return errors.reduce((most, e) => Math.max(most, Math.abs(e[k] - mean)), 0);
    };
    // East to west about a hundredth of a texel (it was nearly a half); north to south about a
    // twentieth, as fine as the single-precision direction itself holds the place (it was a sixth).
    expect(worst('fresh')).toBeLessThan(0.03);
    expect(worst('freshY')).toBeLessThan(0.08);
    expect(worst('plain')).toBeGreaterThan(0.3);
    expect(worst('plainY')).toBeGreaterThan(0.12);
    clipmap.dispose();
  });
});
