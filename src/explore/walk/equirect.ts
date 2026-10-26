/**
 * The ground's heights for walking on the Moon and Mars (docs/WALKING.md, ledger GR-5): the global
 * grids scripts/walk/heights.py writes (public/assets/walk: LOLA's for the Moon, MOLA's for Mars,
 * terrarium-encoded, in metres above each world's datum), served to the walk as the Web Mercator
 * tiles its ground reads (./terrain), resampled bilinearly from the finest grid loaded for the place:
 * the whole world at 2 pixels a degree, then the 90 by 90 degree tile under the walker at 8 (about 3.8
 * km a pixel on the Moon, 7.4 on Mars). Anything finer than that is the ground's illustrative grain
 * (./ground), and the suit's readout says so.
 */

import { TERRAIN, terrariumImage, type TileLoader } from './terrain';

/** A world's grids, as public/assets/walk/heights.json lists them. */
export interface EquirectGrids {
  datumKm: number;
  base: { path: string; ppd: number };
  detail: { path: string; ppd: number; tileDeg: number; cols: number; rows: number };
}

/** A decoded grid: its heights (row-major from its north-west corner), size, and where its first pixel's corner lies. */
export interface Grid {
  width: number;
  height: number;
  heights: Float32Array;
  westDeg: number;
  northDeg: number;
  ppd: number;
}

type Decode = (url: string) => Promise<{ width: number; height: number; heights: Float32Array } | null>;

/** A grid's height at a place by bilinear interpolation between pixel centres (wrapping in longitude when it spans the world, clamped at its edges otherwise). */
export function sampleGrid(g: Grid, latDeg: number, lonDeg: number): number {
  const global = g.width === 360 * g.ppd;
  let x = (lonDeg - g.westDeg) * g.ppd - 0.5;
  if (global) x = ((x % g.width) + g.width) % g.width;
  const y = Math.max(0, Math.min(g.height - 1, (g.northDeg - latDeg) * g.ppd - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const col = (c: number): number => (global ? ((c % g.width) + g.width) % g.width : Math.max(0, Math.min(g.width - 1, c)));
  const row = (r: number): number => Math.max(0, Math.min(g.height - 1, r));
  const at = (c: number, r: number): number => g.heights[row(r) * g.width + col(c)] ?? 0;
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * The finest zoom worth asking of a world's grids: its pixels a quarter of the detailed grid's at the
 * equator (for any radius: a zoom-z pixel is 360 / (256 x 2^z) degrees), so reading a tile between its
 * pixels adds nothing a direct reading of the grid would not.
 */
export const equirectMaxZoom = (grids: EquirectGrids): number => Math.ceil(Math.log2((360 * grids.detail.ppd * 4) / TERRAIN.tilePx));

/** Web Mercator's latitude (degrees) at a fraction of the way down the world (0 the top edge). */
const mercatorLat = (t: number): number => (Math.atan(Math.sinh(Math.PI * (1 - 2 * t))) * 180) / Math.PI;

/**
 * A tile loader for the walk (./terrain's TileLoader) from a world's grids: `url` turns an asset path
 * into a URL; `decode` reads a terrarium PNG (the browser's, by default).
 */
export function equirectLoader(grids: EquirectGrids, url: (path: string) => string, decode: Decode = terrariumImage): TileLoader {
  let base: Promise<Grid | null> | null = null;
  const detail = new Map<string, Promise<Grid | null>>();
  const loadBase = (): Promise<Grid | null> => {
    base ??= decode(url(grids.base.path)).then((d) => (d ? { ...d, westDeg: -180, northDeg: 90, ppd: grids.base.ppd } : null));
    return base;
  };
  const loadDetail = (col: number, row: number): Promise<Grid | null> => {
    const key = `${col}-${row}`;
    let p = detail.get(key);
    if (!p) {
      const path = grids.detail.path.replace('{col}', String(col)).replace('{row}', String(row));
      p = decode(url(path)).then((d) => (d ? { ...d, westDeg: -180 + col * grids.detail.tileDeg, northDeg: 90 - row * grids.detail.tileDeg, ppd: grids.detail.ppd } : null));
      detail.set(key, p);
    }
    return p;
  };
  const tileOf = (latDeg: number, lonDeg: number): [number, number] => {
    const span = grids.detail.tileDeg;
    const col = Math.max(0, Math.min(grids.detail.cols - 1, Math.floor((((lonDeg + 180) % 360) + 360) % 360 / span)));
    const row = Math.max(0, Math.min(grids.detail.rows - 1, Math.floor((90 - latDeg) / span)));
    return [col, row];
  };
  return async (z, x, y) => {
    const n = 2 ** z;
    const world = await loadBase();
    if (!world) return null;
    // Finer than the world's grid: the detailed tiles the Mercator tile overlaps (its corners and middle cover a 90 degree tile's span).
    const pixelDeg = 360 / (n * TERRAIN.tilePx);
    const fine: Grid[] = [];
    if (pixelDeg < 1 / grids.base.ppd) {
      const westDeg = (x / n) * 360 - 180;
      const eastDeg = ((x + 1) / n) * 360 - 180;
      const northDeg = mercatorLat(y / n);
      const southDeg = mercatorLat((y + 1) / n);
      const wanted = new Set<string>();
      for (const la of [northDeg, (northDeg + southDeg) / 2, southDeg]) for (const lo of [westDeg, (westDeg + eastDeg) / 2, eastDeg - 1e-9]) wanted.add(tileOf(la, lo).join('-'));
      for (const key of wanted) {
        const [col, row] = key.split('-').map(Number);
        const g = await loadDetail(col ?? 0, row ?? 0);
        if (g) fine.push(g);
      }
    }
    const out = new Float32Array(TERRAIN.tilePx * TERRAIN.tilePx);
    for (let py = 0; py < TERRAIN.tilePx; py += 1) {
      const lat = mercatorLat((y + (py + 0.5) / TERRAIN.tilePx) / n);
      for (let px = 0; px < TERRAIN.tilePx; px += 1) {
        const lon = ((x + (px + 0.5) / TERRAIN.tilePx) / n) * 360 - 180;
        const g = fine.find((d) => lon >= d.westDeg && lon < d.westDeg + d.width / d.ppd && lat <= d.northDeg && lat > d.northDeg - d.height / d.ppd);
        out[py * TERRAIN.tilePx + px] = sampleGrid(g ?? world, lat, lon);
      }
    }
    return out;
  };
}
