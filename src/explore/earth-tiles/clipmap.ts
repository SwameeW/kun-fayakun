import { DataTexture, FloatType, NearestFilter, RGBAFormat, type WebGPURenderer } from 'three/webgpu';
import { createAtlas, type TileAtlas } from './atlas';
import { matrixSize, spanDeg, texelAngle, tileCoord, tileExists, wrapColumns, type TileCoord } from './grid';
import type { TileSource } from './sources';

/**
 * A clipmap of one streamed layer: a few zoom levels, each a window of kx x ky tiles centred on the
 * place the view is aimed at, the finest matched to the screen's footprint there and each next one
 * twice as coarse, so wherever the view looks there is imagery at about one texel per pixel and,
 * beyond the finest window, coarser imagery around it, down to the global map (the shader blends
 * them coarse to fine, ./sample).
 *
 * Each level is a layer of one atlas (./atlas) addressed toroidally: tile column x lives in atlas
 * column x mod kx, so when the window moves only the tiles that came into it are fetched and written.
 * A small index texture records which tile each atlas slot holds (each level's k rows of it, one level
 * under another); the shader reads only tiles the index confirms, so a slot still holding a tile from
 * before the window moved is never shown in the wrong place. Layers are tied to a zoom (zoom z lives
 * in layer z mod levels), so when the finest zoom steps by one only one layer is reassigned; ranks
 * (coarse to fine) are handed to the shader each frame as the layer each reads.
 *
 * One atlas and one index for every level, not a pair a level: a shader that reads the clipmap binds
 * two textures however many levels it keeps, whatever has streamed in when it is built. (three.js gives
 * texture nodes that hold the same texture when a material is built one binding, for good. With a pair
 * a level, a shader built before the levels were made, every rank on one placeholder, read the coarsest
 * rank's pair for all of them, so the finer ranks never showed; one built after bound a pair a level,
 * and the Earth's surface, three clipmaps beside its seven maps, came to 19 sampled textures, past the
 * 16 a stage may bind on WebGPU's default limits and on many phones and integrated GPUs: its pipeline
 * failed and the globe went undrawn.)
 *
 * Requests: a few at a time per host, nearest the aim first and coarse levels before fine ones, each
 * abandoned (AbortController) when its tile leaves its window. Decoded tiles (ImageBitmap, decoded off
 * the main thread) are kept in a small least-recently-used cache, so looking back costs no refetch,
 * and are written into the atlases a few per frame. A tile that fails or does not exist is recorded
 * as missing; the shader then shows the coarser imagery below it.
 */

export interface ClipmapOptions {
  /** Zoom levels kept (the finest and this many minus one coarser). */
  readonly levels: number;
  /** Tiles across and down each level's window. */
  readonly k: number;
  /** Decoded tiles kept in memory for reuse. */
  readonly cacheTiles: number;
  /** Tiles written to the GPU per frame at most. */
  readonly writesPerFrame: number;
  /** Requests in flight at once. */
  readonly concurrency: number;
  /** The coarsest zoom worth streaming (below it the global map is as sharp). */
  readonly fromZoom: number;
}

/** What a rank (coarse to fine) holds this frame, for the shader's uniforms. */
export interface RankState {
  /** Off: the rank holds nothing (the shader skips it). */
  on: boolean;
  /** Its level's layer of the atlas, and band of the index. */
  layer: number;
  zoom: number;
  /** Window: top-left tile (column normalised into the wrap), tiles per degree (geographic) or across (mercator), the wrap. */
  originX: number;
  originY: number;
  scale: number;
  wrap: number;
  /** The window's origin within the atlas (origin mod k), and radians per texel at the equator. */
  originModX: number;
  originModY: number;
  texel: number;
  /**
   * Where the aim falls in the window (tiles from its top-left, worked out in double precision) and
   * the tiles once round the globe at this zoom (the wrap where the grid wraps): the shader places a
   * pixel by its angle from the aim, so its tile coordinate is a small number, exact in single
   * precision at every longitude (./sample says why).
   */
  aimX: number;
  aimY: number;
  around: number;
}

export interface ClipmapStats {
  zoom: number;
  requested: number;
  loaded: number;
  failed: number;
  pending: number;
}

interface Level {
  /** Its layer of the atlas, and its band of the index's data (k x k slots of four numbers). */
  layer: number;
  indexData: Float32Array;
  zoom: number;
  originX: number;
  originY: number;
  /** Tile identity per slot ("z/x/y") or null. */
  slots: Array<string | null>;
}

interface Pending {
  key: string;
  url: string;
  z: number;
  x: number;
  y: number;
  priority: number;
}

const keyOf = (z: number, x: number, y: number): string => `${z}/${x}/${y}`;
/** How much finer than one texel per pixel the finest level is chosen (log2 units), and the margin past a boundary before it changes. */
const FINER = 0.25;
const HYSTERESIS = 0.15;

export interface Clipmap {
  readonly source: TileSource;
  readonly options: ClipmapOptions;
  /** Ranks, coarse to fine (length options.levels), rewritten by update(). */
  readonly ranks: readonly RankState[];
  /** The place the clipmap was last aimed at (radians): every rank's aimX and aimY are this place's. */
  readonly aim: { readonly lat: number; readonly lon: number };
  /** Every level's tiles (a layer each) and the index of what each slot holds (k rows a level); null until first aimed close enough. */
  readonly atlas: TileAtlas | null;
  readonly index: DataTexture | null;
  /** Aims the clipmap: the place under the view's centre (radians) and the ground radians per screen pixel there. Null turns it off. */
  update(aim: { lat: number; lon: number; footprint: number } | null): void;
  /** The layer's date (for dated layers): changing it forgets every tile. */
  setDate(date: string): void;
  readonly stats: ClipmapStats;
  /** Drops pending requests (the explorer leaving); tiles already written stay until disposed. */
  suspend(): void;
  dispose(): void;
}

export function createClipmap(renderer: WebGPURenderer, source: TileSource, options: ClipmapOptions, date = ''): Clipmap {
  const { grid } = source;
  const { k, levels: count } = options;
  const size = k * grid.tilePx;
  let currentDate = date;
  const levels: Level[] = [];
  // Made on first need (the whole stack at once: once one level is wanted, the others are within moments).
  let atlas: TileAtlas | null = null;
  let index: DataTexture | null = null;
  const indexData = new Float32Array(k * k * count * 4).fill(-1);
  const makeLevel = (i: number): Level => {
    if (!atlas) atlas = createAtlas(renderer, size, size, count, source.colour, `earth-${source.id}`);
    if (!index) {
      index = new DataTexture(indexData, k, k * count, RGBAFormat, FloatType);
      index.magFilter = NearestFilter;
      index.minFilter = NearestFilter;
      index.needsUpdate = true;
    }
    return { layer: i, indexData: indexData.subarray(i * k * k * 4, (i + 1) * k * k * 4), zoom: -1, originX: 0, originY: 0, slots: new Array<string | null>(k * k).fill(null) };
  };
  const indexChanged = (): void => {
    if (index) index.needsUpdate = true;
  };

  const ranks: RankState[] = Array.from({ length: count }, () => ({
    on: false,
    layer: 0,
    zoom: -1,
    originX: 0,
    originY: 0,
    scale: 1,
    wrap: 0,
    originModX: 0,
    originModY: 0,
    texel: 1,
    aimX: 0,
    aimY: 0,
    around: 1,
  }));
  const aimed = { lat: 0, lon: 0 };

  const stats: ClipmapStats = { zoom: -1, requested: 0, loaded: 0, failed: 0, pending: 0 };
  const cache = new Map<string, ImageBitmap>();
  const missing = new Set<string>();
  const inflight = new Map<string, AbortController>();
  const ready: Array<{ key: string; z: number; x: number; y: number; image: ImageBitmap }> = [];
  let queue: Pending[] = [];
  let fineZoom = -1;

  const remember = (key: string, image: ImageBitmap): void => {
    cache.delete(key);
    cache.set(key, image);
    while (cache.size > options.cacheTiles) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      const img = cache.get(oldest);
      cache.delete(oldest);
      // A bitmap still waiting to be written is closed by its writer instead.
      if (img && !ready.some((r) => r.image === img)) img.close();
    }
  };

  const levelFor = (z: number): Level => {
    const i = ((z % count) + count) % count;
    let level = levels[i];
    if (!level) {
      level = makeLevel(i);
      levels[i] = level;
    }
    return level;
  };

  /** Clears a level's slots that no longer hold a tile of its window (or any, on a new zoom). */
  const retarget = (level: Level, z: number, originX: number, originY: number): void => {
    const wrap = wrapColumns(grid, z);
    let changed = false;
    for (let s = 0; s < k * k; s += 1) {
      const id = level.slots[s];
      if (!id) continue;
      const [tz, tx, ty] = id.split('/').map(Number) as [number, number, number];
      let keep = tz === z;
      if (keep) {
        let dx = tx - originX;
        if (wrap > 0) dx = ((dx % wrap) + wrap) % wrap;
        const dy = ty - originY;
        keep = dx >= 0 && dx < k && dy >= 0 && dy < k;
      }
      if (!keep) {
        level.slots[s] = null;
        level.indexData.fill(-1, s * 4, s * 4 + 4);
        changed = true;
      }
    }
    if (changed) indexChanged();
    level.zoom = z;
    level.originX = originX;
    level.originY = originY;
  };

  const write = (z: number, x: number, y: number, image: ImageBitmap): void => {
    const level = levels[((z % count) + count) % count];
    if (!level || level.zoom !== z) return;
    const wrap = wrapColumns(grid, z);
    let dx = x - level.originX;
    if (wrap > 0) dx = ((dx % wrap) + wrap) % wrap;
    const dy = y - level.originY;
    if (dx < 0 || dx >= k || dy < 0 || dy >= k) return;
    // The slot of the tile's unwrapped column (so neighbours in the window are neighbours in the atlas).
    const sx = (((level.originX + dx) % k) + k) % k;
    const sy = (((level.originY + dy) % k) + k) % k;
    if (!atlas?.write(image, sx * grid.tilePx, sy * grid.tilePx, level.layer)) return;
    const s = sy * k + sx;
    level.slots[s] = keyOf(z, x, y);
    level.indexData.set([x, y, z, 1], s * 4);
    indexChanged();
    stats.loaded += 1;
  };

  const markMissing = (z: number, x: number, y: number): void => {
    missing.add(keyOf(z, x, y));
    stats.failed += 1;
  };

  const fetchTile = (p: Pending): void => {
    const controller = new AbortController();
    inflight.set(p.key, controller);
    stats.requested += 1;
    const dated = currentDate;
    fetch(p.url, { mode: 'cors', credentials: 'omit', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: source.colour ? 'default' : 'none', imageOrientation: 'none' });
      })
      .then((image) => {
        inflight.delete(p.key);
        if (dated !== currentDate) {
          image.close();
          return;
        }
        remember(p.key, image);
        ready.push({ key: p.key, z: p.z, x: p.x, y: p.y, image });
      })
      .catch((err: unknown) => {
        inflight.delete(p.key);
        if (controller.signal.aborted || dated !== currentDate) return;
        markMissing(p.z, p.x, p.y);
        if (stats.failed <= 3) console.warn(`explore: tile ${source.id} ${p.key} unavailable`, err);
      });
  };

  const wanted = new Set<string>();
  const aimAt: TileCoord = { x: 0, y: 0 };

  const update = (aim: { lat: number; lon: number; footprint: number } | null): void => {
    // Write what arrived (a few a frame; the rest wait).
    let writes = 0;
    while (ready.length > 0 && writes < options.writesPerFrame) {
      const r = ready.shift();
      if (!r) break;
      write(r.z, r.x, r.y, r.image);
      writes += 1;
    }

    if (!aim) {
      for (const r of ranks) r.on = false;
      stats.zoom = -1;
      return;
    }

    // The finest zoom: texels a little under a pixel (FINER), switching only once the footprint is a
    // margin past a level's boundary (HYSTERESIS), so a footprint on a boundary does not flip it.
    const exact = Math.log2(texelAngle(grid, 0) / Math.max(aim.footprint, 1e-12)) + FINER;
    if (fineZoom < 0 || exact > fineZoom + HYSTERESIS || exact < fineZoom - 1 - HYSTERESIS) {
      fineZoom = Math.max(grid.minZoom, Math.min(grid.maxZoom, Math.ceil(exact - 1e-9)));
    }
    stats.zoom = fineZoom;
    if (fineZoom < options.fromZoom) {
      for (const r of ranks) r.on = false;
      return;
    }
    aimed.lat = aim.lat;
    aimed.lon = aim.lon;

    wanted.clear();
    const next: Pending[] = [];
    for (let rank = 0; rank < count; rank += 1) {
      const z = fineZoom - (count - 1 - rank);
      const state = ranks[rank];
      if (!state) continue;
      if (z < Math.max(grid.minZoom, options.fromZoom - 2)) {
        state.on = false;
        continue;
      }
      const level = levelFor(z);
      const { cols, rows } = matrixSize(grid, z);
      const wrap = wrapColumns(grid, z);
      tileCoord(grid, z, aim.lat, aim.lon, aimAt);
      let originX = Math.floor(aimAt.x) - Math.floor(k / 2);
      let originY = Math.floor(aimAt.y) - Math.floor(k / 2);
      originY = rows > k ? Math.max(0, Math.min(rows - k, originY)) : 0;
      if (wrap <= 0) originX = cols > k ? Math.max(0, Math.min(cols - k, originX)) : 0;
      // The aim within the window, from the origin before it is brought into the wrap (so a window
      // across the antimeridian still has the aim a few tiles in).
      const aimX = aimAt.x - originX;
      const aimY = aimAt.y - originY;
      if (wrap > 0) originX = ((originX % wrap) + wrap) % wrap;
      if (level.zoom !== z || level.originX !== originX || level.originY !== originY) retarget(level, z, originX, originY);

      Object.assign(state, {
        on: true,
        layer: level.layer,
        zoom: z,
        originX,
        originY,
        scale: grid.projection === 'mercator' ? 2 ** z : 1 / (grid.span0Deg / 2 ** z),
        wrap,
        originModX: originX % k,
        originModY: originY % k,
        texel: texelAngle(grid, z),
        aimX,
        aimY,
        around: wrap > 0 ? wrap : grid.projection === 'mercator' ? 2 ** z : 360 / spanDeg(grid, z),
      } satisfies RankState);

      // Every tile of the window not already written, nearest the aim first, coarser ranks first.
      for (let dy = 0; dy < k; dy += 1) {
        for (let dx = 0; dx < k; dx += 1) {
          const tile = tileExists(grid, z, originX + dx, originY + dy);
          if (!tile) continue;
          const key = keyOf(z, tile.x, tile.y);
          wanted.add(key);
          const sx = (originX + dx) % k;
          const sy = (originY + dy) % k;
          if (level.slots[sy * k + sx] === key || missing.has(key) || inflight.has(key)) continue;
          const cached = cache.get(key);
          if (cached) {
            if (!ready.some((r) => r.key === key)) ready.push({ key, z, x: tile.x, y: tile.y, image: cached });
            continue;
          }
          const cx = originX + dx + 0.5 - aimAt.x;
          const cy = originY + dy + 0.5 - aimAt.y;
          next.push({ key, url: source.url(z, tile.x, tile.y, currentDate), z, x: tile.x, y: tile.y, priority: rank * 1000 + Math.hypot(cx, cy) });
        }
      }
    }
    // Requests for tiles that left every window are abandoned.
    for (const [key, controller] of inflight) {
      if (!wanted.has(key)) {
        controller.abort();
        inflight.delete(key);
      }
    }
    next.sort((a, b) => a.priority - b.priority);
    queue = next;
    while (inflight.size < options.concurrency && queue.length > 0) {
      const p = queue.shift();
      if (p) fetchTile(p);
    }
    stats.pending = inflight.size + queue.length + ready.length;
  };

  const forgetAll = (): void => {
    for (const c of inflight.values()) c.abort();
    inflight.clear();
    queue = [];
    for (const r of ready.splice(0)) if (!cache.has(r.key)) r.image.close();
    for (const img of cache.values()) img.close();
    cache.clear();
    missing.clear();
    for (const level of levels) {
      level.slots.fill(null);
      level.zoom = -1;
    }
    indexData.fill(-1);
    indexChanged();
    fineZoom = -1;
  };

  return {
    source,
    options,
    ranks,
    aim: aimed,
    get atlas() {
      return atlas;
    },
    get index() {
      return index;
    },
    update,
    stats,
    setDate(d) {
      if (d === currentDate) return;
      currentDate = d;
      forgetAll();
    },
    suspend() {
      for (const c of inflight.values()) c.abort();
      inflight.clear();
      queue = [];
    },
    dispose() {
      forgetAll();
      atlas?.dispose();
      index?.dispose();
      atlas = null;
      index = null;
      levels.length = 0;
    },
  };
}
