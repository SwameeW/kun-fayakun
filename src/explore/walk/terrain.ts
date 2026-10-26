/**
 * The ground's heights for walking on the Earth: AWS Terrain Tiles, the explorer's relief source
 * (../earth-tiles/sources RELIEF; data/sources.json "aws-terrain-tiles": SRTM, GMTED2010, ETOPO1,
 * 3DEP and national models, each credited there). Web Mercator tiles of 256 px, terrarium-encoded
 * (height = R x 256 + G + B / 256 - 32768 m), to zoom 15 (about 4.8 m a pixel at the equator; the
 * data underneath is about 30 m in most places, finer where national surveys give it).
 *
 * Tiles are decoded once and kept (the most recently used, up to CACHE_TILES); a height is read by
 * bilinear interpolation between pixel centres, across tile edges where the neighbour is loaded, from
 * the finest zoom at or below the one asked for that holds the place, so the ground is there at once
 * (coarse) and sharpens as finer tiles arrive. Pure apart from the loader it is given.
 */

export const TERRAIN = {
  tilePx: 256,
  maxZoom: 15,
  /** Metres per pixel at zoom 0 on the equator (Web Mercator: 2 pi x 6378137 m / 256). */
  metresPerPixel0: 156543.03392804097,
  /** Tiles kept decoded (256 x 256 floats each, 256 kB). */
  cacheTiles: 192,
  /** Requests in flight at once. */
  concurrent: 8,
} as const;

/** Web Mercator's latitude limit (degrees): tiles stop here, and so do walks (./walker). */
export const MERCATOR_LAT = 85.05112878;
/** The radius Web Mercator's metres are measured on (WGS 84's equatorial, km). */
const MERCATOR_RADIUS_KM = 6378.137;

/** Decodes terrarium pixels (RGBA, 4 bytes each) into heights in metres. */
export function decodeTerrarium(rgba: ArrayLike<number>, out: Float32Array = new Float32Array(Math.floor(rgba.length / 4))): Float32Array {
  for (let i = 0; i < out.length; i += 1) out[i] = (rgba[i * 4] ?? 0) * 256 + (rgba[i * 4 + 1] ?? 0) + (rgba[i * 4 + 2] ?? 0) / 256 - 32768;
  return out;
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

/** A tile's heights (metres, row-major from the north-west corner), or null where it could not be loaded. */
export type TileLoader = (z: number, x: number, y: number) => Promise<Float32Array | null>;

export interface Heights {
  /**
   * The ground's height (m) at a place, from the finest zoom at or below `zoom` that holds it, and
   * which zoom that was; null where nothing for it has loaded yet. Asks for the tile at `zoom` when
   * it is missing.
   */
  at(latDeg: number, lonDeg: number, zoom: number): { metres: number; zoom: number } | null;
  /** Asks for the tiles covering a place at a zoom (and its parent, so a coarse fallback comes first). */
  want(latDeg: number, lonDeg: number, zoom: number): void;
  /** Counts: tiles decoded, in flight, failed. */
  stats(): { ready: number; loading: number; failed: number };
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
}

/** Heights from a loader whose tiles hold nothing finer past `maxZoom` (asked for finer, it reads that zoom's). */
export function createHeights(load: TileLoader, maxZoom: number = TERRAIN.maxZoom): Heights {
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
      load(z, x, y)
        .then((heights) => {
          entry.state = heights ? 'ready' : 'failed';
          entry.heights = heights;
        })
        .catch(() => {
          entry.state = 'failed';
        })
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
      return;
    }
    tiles.set(k, { state: 'loading', heights: null });
    // The newest request first: the ground under the walker before the ground behind.
    queue.push([z, xx, y]);
    while (tiles.size > TERRAIN.cacheTiles) {
      const oldest = tiles.keys().next().value;
      if (oldest === undefined) break;
      tiles.delete(oldest);
    }
    pump();
  };

  /** A pixel's height at global pixel (px, py) of a zoom, from whichever loaded tile holds it. */
  const pixel = (z: number, px: number, py: number): number | null => {
    const n = 2 ** z;
    const size = n * TERRAIN.tilePx;
    const gx = ((Math.floor(px) % size) + size) % size;
    const gy = Math.max(0, Math.min(size - 1, Math.floor(py)));
    const tx = Math.floor(gx / TERRAIN.tilePx);
    const ty = Math.floor(gy / TERRAIN.tilePx);
    const entry = tiles.get(key(z, tx, ty));
    if (!entry || entry.state !== 'ready' || !entry.heights) return null;
    return entry.heights[(gy - ty * TERRAIN.tilePx) * TERRAIN.tilePx + (gx - tx * TERRAIN.tilePx)] ?? null;
  };

  /** Bilinear between the four pixel centres around a point, at one zoom; null if its own pixel is not loaded. */
  const sample = (z: number, latDeg: number, lonDeg: number): number | null => {
    const p = mercatorPixel(latDeg, lonDeg, z);
    const x = p.x - 0.5;
    const y = p.y - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const h00 = pixel(z, x0, y0);
    if (h00 === null) return null;
    // A neighbour across an edge whose tile has not arrived reads as its loaded side.
    const h10 = pixel(z, x0 + 1, y0) ?? h00;
    const h01 = pixel(z, x0, y0 + 1) ?? h00;
    const h11 = pixel(z, x0 + 1, y0 + 1) ?? h10;
    return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
  };

  const want = (latDeg: number, lonDeg: number, zoom: number): void => {
    const z = Math.max(0, Math.min(maxZoom, Math.round(zoom)));
    for (const zz of z > 0 ? [z - 1, z] : [z]) {
      // Every tile the interpolation reads: near an edge, the neighbour's too, so the ground has no seam.
      const p = mercatorPixel(latDeg, lonDeg, zz);
      const x0 = Math.floor(p.x - 0.5);
      const y0 = Math.floor(p.y - 0.5);
      const seen = new Set<string>();
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
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
      const z = Math.max(0, Math.min(maxZoom, Math.round(zoom)));
      want(latDeg, lonDeg, z);
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
    revision(zoom) {
      let n = 0;
      for (let z = 0; z <= Math.min(maxZoom, Math.round(zoom)); z += 1) n += arrivedAt[z] ?? 0;
      return n;
    },
    clear() {
      tiles.clear();
      queue.length = 0;
    },
  };
}

/** A terrarium-encoded PNG fetched, decoded without colour conversion, read back and decoded to heights (row-major from the top left), or null. */
export async function terrariumImage(url: string): Promise<{ width: number; height: number; heights: Float32Array } | null> {
  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { width: canvas.width, height: canvas.height, heights: decodeTerrarium(context.getImageData(0, 0, canvas.width, canvas.height).data) };
}

/** The browser's loader for the Earth's tiles: each tile's PNG decoded to heights. */
export function terrariumLoader(url: (z: number, x: number, y: number) => string): TileLoader {
  return async (z, x, y) => (await terrariumImage(url(z, x, y)))?.heights ?? null;
}
