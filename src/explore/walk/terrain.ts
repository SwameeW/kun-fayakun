/**
 * The ground's heights for walking on the Earth: AWS Terrain Tiles, the explorer's relief source
 * (../earth-tiles/sources RELIEF; data/sources.json "aws-terrain-tiles": SRTM, GMTED2010, ETOPO1,
 * 3DEP and national models, each credited there). Web Mercator tiles of 256 px, terrarium-encoded
 * (height = R x 256 + G + B / 256 - 32768 m), to zoom 15 (about 4.8 m a pixel at the equator; the
 * data underneath is about 30 m in most places, finer where national surveys give it).
 *
 * Tiles are decoded once and kept (the most recently used, up to CACHE_TILES); a height is read by
 * Catmull-Rom's cubic over the four by four pixel centres around it (exact on a plane, and its slope
 * continuous, so a low Sun finds no crease at every pixel's edge, as it did between bilinear patches;
 * kept within the four nearest, so a cliff does not ring), across tile edges where the neighbour is
 * loaded, from the finest zoom at or below the one asked for that holds the place, so the ground is
 * there at once (coarse) and sharpens as finer tiles arrive. Pure apart from the loader it is given.
 */

import { decodePng } from './png';

export const TERRAIN = {
  tilePx: 256,
  maxZoom: 15,
  /** Metres per pixel at zoom 0 on the equator (Web Mercator: 2 pi x 6378137 m / 256). */
  metresPerPixel0: 156543.03392804097,
  /** Tiles kept decoded (256 x 256 floats each, 256 kB). */
  cacheTiles: 192,
  /** Requests in flight at once. */
  concurrent: 8,
  /** A tile that failed is asked for again (while still wanted) after these waits (seconds), the last one over and over: a host that is down is not hammered, and one that comes back is found. */
  retryS: [1, 2, 4, 8, 30],
} as const;

/** Web Mercator's latitude limit (degrees): tiles stop here, and so do walks (./walker). */
export const MERCATOR_LAT = 85.05112878;
/** The radius Web Mercator's metres are measured on (WGS 84's equatorial, km). */
const MERCATOR_RADIUS_KM = 6378.137;

/** Decodes terrarium pixels (`channels` bytes each, RGB first: 4 for RGBA) into heights in metres. */
export function decodeTerrarium(rgba: ArrayLike<number>, out: Float32Array = new Float32Array(Math.floor(rgba.length / 4)), channels = 4): Float32Array {
  for (let i = 0; i < out.length; i += 1) out[i] = (rgba[i * channels] ?? 0) * 256 + (rgba[i * channels + 1] ?? 0) + (rgba[i * channels + 2] ?? 0) / 256 - 32768;
  return out;
}

/**
 * Undoes a canvas read-back's tampering (a fingerprinting guard's: Brave's flips the lowest bit of
 * scattered bytes, and in a terrarium tile's red byte that is exactly 256 m): a pixel standing more
 * than half that above or below every one of its eight neighbours, which 256 m the other way brings
 * back among them, gets those 256 m back. Only for tiles decoded through a canvas (./png reads the
 * file's own bytes, which no guard alters). In place; returns the heights.
 */
export function despike(heights: Float32Array, size: number = TERRAIN.tilePx): Float32Array {
  const STEP = 256;
  const around: number[] = [];
  for (let y = 1; y < size - 1; y += 1)
    for (let x = 1; x < size - 1; x += 1) {
      const i = y * size + x;
      const h = heights[i] ?? 0;
      around.length = 0;
      for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const) around.push(heights[i + dy * size + dx] ?? 0);
      const low = Math.min(...around);
      const high = Math.max(...around);
      const back = h > high + STEP / 2 ? h - STEP : h < low - STEP / 2 ? h + STEP : h;
      if (back !== h && back >= low - STEP / 4 && back <= high + STEP / 4) heights[i] = back;
    }
  return heights;
}

/** Where a place falls at a zoom: global pixel coordinates (x east, y south; pixel centres at half-integers). */
export function mercatorPixel(latDeg: number, lonDeg: number, zoom: number): { x: number; y: number } {
  const n = TERRAIN.tilePx * 2 ** zoom;
  const lat = (Math.max(-MERCATOR_LAT, Math.min(MERCATOR_LAT, latDeg)) * Math.PI) / 180;
  const lon = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n,
  };
}

/**
 * The zoom whose pixels are about `metres` across at a latitude, on a world of `radiusKm` (the same
 * tiling spread over a smaller world has smaller pixels: the Moon's are 0.27 of the Earth's), clamped
 * to the tiles' range.
 */
export function zoomFor(metres: number, latDeg: number, radiusKm = MERCATOR_RADIUS_KM): number {
  const z = Math.log2((TERRAIN.metresPerPixel0 * (radiusKm / MERCATOR_RADIUS_KM) * Math.cos((latDeg * Math.PI) / 180)) / Math.max(metres, 1e-3));
  return Math.max(0, Math.min(TERRAIN.maxZoom, Math.round(z)));
}

/** Catmull-Rom's cubic through four evenly spaced values, at `t` (0 to 1) between the second and the third. */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

/** A tile's heights (metres, row-major from the north-west corner), or null where it could not be loaded. */
export type TileLoader = (z: number, x: number, y: number) => Promise<Float32Array | null>;

export interface Heights {
  /**
   * The ground's height (m) at a place, from the finest zoom at or below `zoom` that holds it, and
   * which zoom that was; null where nothing for it has loaded yet. Asks for the tile at `zoom` when
   * it is missing.
   */
  at(latDeg: number, lonDeg: number, zoom: number): { metres: number; zoom: number } | null;
  /** As `at`, without asking for anything (for many reads over ground whose tiles were asked for once). */
  read(latDeg: number, lonDeg: number, zoom: number): { metres: number; zoom: number } | null;
  /** Asks for the tiles covering a place at a zoom (and its parent, so a coarse fallback comes first). */
  want(latDeg: number, lonDeg: number, zoom: number): void;
  /** Counts: tiles decoded, in flight, failed (waiting to be asked again). */
  stats(): { ready: number; loading: number; failed: number };
  /** Asks again at once for every tile that failed (each gets its tries afresh). */
  retry(): void;
  /**
   * How many tiles at this zoom or coarser have come back (loaded or failed) so far, which is all a
   * height read at that zoom can depend on: ground drawn from them is stale once it grows.
   */
  revision(zoom: number): number;
  clear(): void;
}

interface Entry {
  state: 'loading' | 'ready' | 'failed';
  heights: Float32Array | null;
  /** Failures so far, and when (now(), ms) a failed tile may be asked for again. */
  tries: number;
  retryAt: number;
}

/**
 * Heights from a loader whose tiles hold nothing finer past `maxZoom` (asked for finer, it reads that
 * zoom's). A tile that fails is asked for again while it is still wanted, after TERRAIN.retryS's
 * growing waits (on the clock `now`, ms); retry() asks again at once.
 */
export function createHeights(load: TileLoader, maxZoom: number = TERRAIN.maxZoom, now: () => number = () => performance.now()): Heights {
  const tiles = new Map<string, Entry>();
  const queue: Array<[number, number, number]> = [];
  let inFlight = 0;
  const arrivedAt = new Array<number>(TERRAIN.maxZoom + 1).fill(0);
  const key = (z: number, x: number, y: number): string => `${z}/${x}/${y}`;

  const pump = (): void => {
    while (inFlight < TERRAIN.concurrent && queue.length > 0) {
      const next = queue.pop();
      if (!next) break;
      const [z, x, y] = next;
      const entry = tiles.get(key(z, x, y));
      if (!entry || entry.state !== 'loading') continue;
      inFlight += 1;
      const failed = (): void => {
        entry.state = 'failed';
        entry.retryAt = now() + (TERRAIN.retryS[Math.min(entry.tries, TERRAIN.retryS.length - 1)] ?? 30) * 1000;
        entry.tries += 1;
      };
      load(z, x, y)
        .then((heights) => {
          if (!heights) {
            failed();
            return;
          }
          entry.state = 'ready';
          entry.heights = heights;
        })
        .catch(failed)
        .finally(() => {
          inFlight -= 1;
          arrivedAt[z] = (arrivedAt[z] ?? 0) + 1;
          pump();
        });
    }
  };

  const request = (z: number, x: number, y: number): void => {
    const n = 2 ** z;
    if (y < 0 || y >= n) return;
    const xx = ((x % n) + n) % n;
    const k = key(z, xx, y);
    const had = tiles.get(k);
    if (had) {
      // Most recently used last, so the oldest are the first to go.
      tiles.delete(k);
      tiles.set(k, had);
      // A failed tile still wanted is asked for again once its wait is over.
      if (had.state !== 'failed' || now() < had.retryAt) return;
      had.state = 'loading';
      queue.push([z, xx, y]);
      pump();
      return;
    }
    tiles.set(k, { state: 'loading', heights: null, tries: 0, retryAt: 0 });
    // The newest request first: the ground under the walker before the ground behind.
    queue.push([z, xx, y]);
    while (tiles.size > TERRAIN.cacheTiles) {
      const oldest = tiles.keys().next().value;
      if (oldest === undefined) break;
      tiles.delete(oldest);
    }
    pump();
  };

  // The tile read last (a ring's neighbouring points nearly always share one): no key built for it.
  let last: { z: number; tx: number; ty: number; heights: Float32Array } | null = null;
  /** A loaded tile's heights, or null. */
  const tileAt = (z: number, tx: number, ty: number): Float32Array | null => {
    if (last && last.z === z && last.tx === tx && last.ty === ty) return last.heights;
    const entry = tiles.get(key(z, tx, ty));
    if (!entry || entry.state !== 'ready' || !entry.heights) return null;
    last = { z, tx, ty, heights: entry.heights };
    return entry.heights;
  };
  /** A pixel's height at global pixel (px, py) of a zoom, from whichever loaded tile holds it. */
  const pixel = (z: number, px: number, py: number): number | null => {
    const n = 2 ** z;
    const size = n * TERRAIN.tilePx;
    const gx = ((Math.floor(px) % size) + size) % size;
    const gy = Math.max(0, Math.min(size - 1, Math.floor(py)));
    const tx = Math.floor(gx / TERRAIN.tilePx);
    const ty = Math.floor(gy / TERRAIN.tilePx);
    const heights = tileAt(z, tx, ty);
    return heights ? (heights[(gy - ty * TERRAIN.tilePx) * TERRAIN.tilePx + (gx - tx * TERRAIN.tilePx)] ?? null) : null;
  };

  /** The 4 x 4 pixels around a point (row by row from its north-west), read by `sample`. */
  const near = new Float64Array(16);
  /**
   * Catmull-Rom's cubic over the 4 x 4 pixel centres around a point, at one zoom, kept within the four
   * nearest; null if its own pixel is not loaded.
   */
  const sample = (z: number, latDeg: number, lonDeg: number): number | null => {
    const p = mercatorPixel(latDeg, lonDeg, z);
    const x = p.x - 0.5;
    const y = p.y - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const size = 2 ** z * TERRAIN.tilePx;
    const gx = ((x0 % size) + size) % size;
    // Most points: all sixteen in one loaded tile, read straight from it.
    const tx = Math.floor((gx - 1) / TERRAIN.tilePx);
    const ty = Math.floor((y0 - 1) / TERRAIN.tilePx);
    const tile = tx === Math.floor((gx + 2) / TERRAIN.tilePx) && ty === Math.floor((y0 + 2) / TERRAIN.tilePx) ? tileAt(z, tx, ty) : null;
    if (tile) {
      const ox = gx - 1 - tx * TERRAIN.tilePx;
      const oy = y0 - 1 - ty * TERRAIN.tilePx;
      for (let j = 0; j < 4; j += 1) for (let i = 0; i < 4; i += 1) near[j * 4 + i] = tile[(oy + j) * TERRAIN.tilePx + ox + i] ?? 0;
    } else {
      const h00 = pixel(z, x0, y0);
      if (h00 === null) return null;
      // A neighbour across an edge whose tile has not arrived reads as its loaded side; the outer ring
      // of pixels, where missing, carries on the slope of the two inside it.
      const h10 = pixel(z, x0 + 1, y0) ?? h00;
      const h01 = pixel(z, x0, y0 + 1) ?? h00;
      const h11 = pixel(z, x0 + 1, y0 + 1) ?? h10;
      near[5] = h00;
      near[6] = h10;
      near[9] = h01;
      near[10] = h11;
      for (const j of [1, 2]) {
        const a = near[j * 4 + 1] ?? 0;
        const b = near[j * 4 + 2] ?? 0;
        near[j * 4] = pixel(z, x0 - 1, y0 + j - 1) ?? 2 * a - b;
        near[j * 4 + 3] = pixel(z, x0 + 2, y0 + j - 1) ?? 2 * b - a;
      }
      for (let i = 0; i < 4; i += 1) {
        const a = near[4 + i] ?? 0;
        const b = near[8 + i] ?? 0;
        near[i] = pixel(z, x0 + i - 1, y0 - 1) ?? 2 * a - b;
        near[12 + i] = pixel(z, x0 + i - 1, y0 + 2) ?? 2 * b - a;
      }
    }
    const row = (j: number): number => catmullRom(near[j * 4] ?? 0, near[j * 4 + 1] ?? 0, near[j * 4 + 2] ?? 0, near[j * 4 + 3] ?? 0, fx);
    const value = catmullRom(row(0), row(1), row(2), row(3), fy);
    const h00 = near[5] ?? 0;
    const h10 = near[6] ?? 0;
    const h01 = near[9] ?? 0;
    const h11 = near[10] ?? 0;
    return Math.min(Math.max(h00, h10, h01, h11), Math.max(Math.min(h00, h10, h01, h11), value));
  };

  const want = (latDeg: number, lonDeg: number, zoom: number): void => {
    const z = Math.max(0, Math.min(maxZoom, Math.round(zoom)));
    for (const zz of z > 0 ? [z - 1, z] : [z]) {
      // Every tile the interpolation reads (the 4 x 4 pixels' corners): near an edge, the neighbour's too, so the ground has no seam.
      const p = mercatorPixel(latDeg, lonDeg, zz);
      const x0 = Math.floor(p.x - 0.5);
      const y0 = Math.floor(p.y - 0.5);
      const seen = new Set<string>();
      for (const [dx, dy] of [
        [-1, -1],
        [2, -1],
        [-1, 2],
        [2, 2],
      ] as const) {
        const tx = Math.floor((x0 + dx) / TERRAIN.tilePx);
        const ty = Math.floor((y0 + dy) / TERRAIN.tilePx);
        if (seen.has(`${tx}/${ty}`)) continue;
        seen.add(`${tx}/${ty}`);
        request(zz, tx, ty);
      }
    }
  };

  return {
    at(latDeg, lonDeg, zoom) {
      want(latDeg, lonDeg, zoom);
      return this.read(latDeg, lonDeg, zoom);
    },
    read(latDeg, lonDeg, zoom) {
      const z = Math.max(0, Math.min(maxZoom, Math.round(zoom)));
      for (let zz = z; zz >= 0; zz -= 1) {
        const h = sample(zz, latDeg, lonDeg);
        if (h !== null) return { metres: h, zoom: zz };
      }
      return null;
    },
    want,
    stats() {
      let ready = 0;
      let loading = 0;
      let failed = 0;
      for (const e of tiles.values()) {
        if (e.state === 'ready') ready += 1;
        else if (e.state === 'loading') loading += 1;
        else failed += 1;
      }
      return { ready, loading, failed };
    },
    retry() {
      for (const e of tiles.values()) {
        if (e.state !== 'failed') continue;
        e.tries = 0;
        e.retryAt = 0;
      }
    },
    revision(zoom) {
      let n = 0;
      for (let z = 0; z <= Math.min(maxZoom, Math.round(zoom)); z += 1) n += arrivedAt[z] ?? 0;
      return n;
    },
    clear() {
      tiles.clear();
      queue.length = 0;
      last = null;
    },
  };
}

/**
 * A terrarium-encoded PNG fetched and decoded to heights (row-major from the top left), or null: its
 * own bytes decoded in script (./png), or where that cannot be (no DecompressionStream, a kind of PNG
 * it does not read) drawn without colour conversion, read back and mended (despike).
 */
export async function terrariumImage(url: string): Promise<{ width: number; height: number; heights: Float32Array } | null> {
  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) return null;
  const blob = await response.blob();
  const png = typeof DecompressionStream === 'function' ? await decodePng(new Uint8Array(await blob.arrayBuffer())) : null;
  if (png && png.channels >= 3) return { width: png.width, height: png.height, heights: decodeTerrarium(png.data, new Float32Array(png.width * png.height), png.channels) };
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const heights = decodeTerrarium(context.getImageData(0, 0, canvas.width, canvas.height).data);
  return { width: canvas.width, height: canvas.height, heights: canvas.width === canvas.height ? despike(heights, canvas.width) : heights };
}

/** The browser's loader for the Earth's tiles: each tile's PNG decoded to heights. */
export function terrariumLoader(url: (z: number, x: number, y: number) => string): TileLoader {
  return async (z, x, y) => (await terrariumImage(url(z, x, y)))?.heights ?? null;
}
