/**
 * Tile grids of the imagery and terrain the explorer streams onto the Earth when the view closes in
 * (./clipmap): where a place falls in a grid at a zoom level, and which zoom level matches a
 * footprint on the ground. Pure arithmetic (no three.js), so the unit tests can check it.
 *
 * Two layouts:
 * - geographic (EPSG:4326, equirectangular): a tile at zoom z spans span0 / 2^z degrees of both
 *   longitude and latitude, counted from the grid's top-left corner at (-180, +90). Sentinel-2
 *   cloudless (EOX) uses 256 px tiles with span0 180 (two tiles at z0); NASA GIBS uses 512 px tiles
 *   with span0 288 (its 0.5625 degrees per pixel at z0), so its grids overhang the globe on the
 *   right and bottom, where no tiles exist.
 * - mercator (EPSG:3857, the web's usual grid): 2^z tiles across both ways, x from -180 and y from
 *   the top (about 85.05 degrees north), as the AWS Terrain Tiles are laid out.
 */

export type TileProjection = 'geographic' | 'mercator';

export interface TileGrid {
  readonly projection: TileProjection;
  /** Pixels across a tile. */
  readonly tilePx: number;
  /** Geographic grids: degrees a tile spans at zoom 0 (in both directions). Unused for mercator. */
  readonly span0Deg: number;
  readonly minZoom: number;
  readonly maxZoom: number;
}

/** A place in a grid at a zoom level: fractional tile column (x, east) and row (y, south) from the top-left. */
export interface TileCoord {
  x: number;
  y: number;
}

const DEG = 180 / Math.PI;

/** Degrees a tile of a geographic grid spans at zoom z. */
export function spanDeg(grid: TileGrid, z: number): number {
  return grid.span0Deg / 2 ** z;
}

/** Columns and rows of tiles that exist at zoom z (those that touch the globe). */
export function matrixSize(grid: TileGrid, z: number): { cols: number; rows: number } {
  if (grid.projection === 'mercator') return { cols: 2 ** z, rows: 2 ** z };
  const span = spanDeg(grid, z);
  return { cols: Math.ceil(360 / span - 1e-9), rows: Math.ceil(180 / span - 1e-9) };
}

/**
 * Tiles once around the globe at zoom z, when that is a whole number (the grid then wraps in
 * longitude: column cols + i is column i); 0 when it is not (GIBS at z0 and z1), where it never wraps.
 */
export function wrapColumns(grid: TileGrid, z: number): number {
  if (grid.projection === 'mercator') return 2 ** z;
  const around = 360 / spanDeg(grid, z);
  return Math.abs(around - Math.round(around)) < 1e-9 ? Math.round(around) : 0;
}

/** The latitude a mercator grid stops at (where its square world ends), radians. */
export const MERCATOR_LIMIT = Math.atan(Math.sinh(Math.PI));

/** Where a place (radians: east longitude in [-pi, pi), latitude) falls at zoom z. */
export function tileCoord(grid: TileGrid, z: number, latRad: number, lonRad: number, out: TileCoord = { x: 0, y: 0 }): TileCoord {
  if (grid.projection === 'mercator') {
    const n = 2 ** z;
    const lat = Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, latRad));
    out.x = ((lonRad + Math.PI) / (2 * Math.PI)) * n;
    out.y = ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * n;
    return out;
  }
  const span = spanDeg(grid, z);
  out.x = (lonRad * DEG + 180) / span;
  out.y = (90 - latRad * DEG) / span;
  return out;
}

/** Radians of the globe one texel spans at zoom z (on the equator; a mercator texel shrinks by cos(lat) away from it). */
export function texelAngle(grid: TileGrid, z: number): number {
  if (grid.projection === 'mercator') return (2 * Math.PI) / 2 ** z / grid.tilePx;
  return (spanDeg(grid, z) / DEG) / grid.tilePx;
}

/**
 * The zoom level whose texels best match `footprint` radians of the globe per screen pixel: the
 * coarsest level whose texel is no larger than `oversample` pixels, kept within the grid's range.
 */
export function zoomForFootprint(grid: TileGrid, footprint: number, oversample = 1): number {
  if (!(footprint > 0)) return grid.minZoom;
  const z = Math.ceil(Math.log2(texelAngle(grid, 0) / (footprint * oversample)) - 1e-9);
  return Math.max(grid.minZoom, Math.min(grid.maxZoom, z));
}

/**
 * Column `x` brought into the grid (wrapped in longitude where the grid wraps); null when the tile
 * does not exist (off a non-wrapping grid, or above or below the globe).
 */
export function tileExists(grid: TileGrid, z: number, x: number, y: number): { x: number; y: number } | null {
  const { cols, rows } = matrixSize(grid, z);
  if (y < 0 || y >= rows) return null;
  const wrap = wrapColumns(grid, z);
  const col = wrap > 0 ? ((x % wrap) + wrap) % wrap : x;
  if (col < 0 || col >= cols) return null;
  return { x: col, y };
}
