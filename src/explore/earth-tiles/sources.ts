import type { TileGrid } from './grid';

/**
 * The Earth's streamed layers, all public, keyless and served to browsers from other origins:
 *
 * - `clear`: Sentinel-2 cloudless 2016 by EOX (CC BY 4.0), a cloud-free mosaic of the whole land
 *   surface at about 10 m per pixel (its native detail is reached at z13; deeper levels are upsampled,
 *   so the grid stops there). The 2018 and later layers are non-commercial and are never used.
 * - `today`: NASA GIBS's daily true-colour mosaic from the VIIRS instrument on NOAA-20 (corrected
 *   reflectance, 250 m), the Earth as it looked on one day, clouds and all; black where no pass
 *   imaged it (night, gaps between swaths), which the explorer treats as missing.
 * - `relief`: AWS Terrain Tiles (terrarium encoding: height = R x 256 + G + B / 256 - 32768 m),
 *   merged from SRTM, GMTED, ETOPO, 3DEP and national models; the attribution list below is theirs.
 *
 * Credits are shown by the explorer's readout while a layer is on screen (EOX asks for its line,
 * with its link, legibly beside the imagery) and listed in full on the Sources page.
 */

export type TileSourceId = 'clear' | 'today' | 'relief';

export interface TileSource {
  readonly id: TileSourceId;
  readonly grid: TileGrid;
  /** True for colour imagery (sRGB, filtered); false for encoded data (heights: exact bytes, nearest). */
  readonly colour: boolean;
  /** The tile's URL (column x, row y, zoom z), for the given date where the layer has one (YYYY-MM-DD). */
  url(z: number, x: number, y: number, date: string): string;
  /** Host, for the per-host request limit. */
  readonly host: string;
  /** data/sources.json ids credited for it. */
  readonly sourceIds: readonly string[];
}

export const CLEAR: TileSource = {
  id: 'clear',
  grid: { projection: 'geographic', tilePx: 256, span0Deg: 180, minZoom: 0, maxZoom: 13 },
  colour: true,
  host: 'tiles.maps.eox.at',
  url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless/default/WGS84/${z}/${y}/${x}.jpg`,
  sourceIds: ['eox-s2cloudless-2016'],
};

/** NASA GIBS layer for the day's imagery (NOAA-20's VIIRS: the afternoon pass, about 13:30 local time). */
export const TODAY_LAYER = 'VIIRS_NOAA20_CorrectedReflectance_TrueColor';

export const TODAY: TileSource = {
  id: 'today',
  grid: { projection: 'geographic', tilePx: 512, span0Deg: 288, minZoom: 0, maxZoom: 8 },
  colour: true,
  host: 'gibs.earthdata.nasa.gov',
  url: (z, x, y, date) => `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${TODAY_LAYER}/default/${date}/250m/${z}/${y}/${x}.jpg`,
  sourceIds: ['nasa-gibs-viirs'],
};

export const RELIEF: TileSource = {
  id: 'relief',
  grid: { projection: 'mercator', tilePx: 256, span0Deg: 360, minZoom: 0, maxZoom: 12 },
  colour: false,
  host: 's3.amazonaws.com',
  url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  sourceIds: ['aws-terrain-tiles'],
};

export const TILE_SOURCES: Readonly<Record<TileSourceId, TileSource>> = { clear: CLEAR, today: TODAY, relief: RELIEF };

/** The UTC date (YYYY-MM-DD) of the last whole day before `unixMs`: the day's mosaic is complete by then. */
export function lastWholeDay(unixMs: number): string {
  const d = new Date(unixMs - 86_400_000);
  return d.toISOString().slice(0, 10);
}
