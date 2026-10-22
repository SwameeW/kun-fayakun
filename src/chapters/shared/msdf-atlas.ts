/**
 * Calligraphy atlases (public/assets/calligraphy/<id>.json + .png, shape fixed in
 * docs/CONTRACTS.md): metadata parsing and the quad that shows the word.
 *
 * Orientation: the loader keeps three's default texture.flipY = true, so UV
 * (0, 0) is the bottom-left of the image as viewed. `bounds` are normalised in
 * that same frame (origin bottom-left, word upright). `flipY: true` in the JSON
 * means the PNG rows are stored bottom row first, so V is mirrored here.
 * Positions grow right (+x) and up (+y) with the camera on +z, so the word reads
 * right to left exactly as shaped, never mirrored.
 */
import { PlaneGeometry } from 'three/webgpu';

export interface MsdfBounds {
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
}

export interface MsdfAtlasMeta {
  readonly id: string;
  /** Atlas image file name, relative to the JSON file. */
  readonly atlas: string;
  /** Atlas size in pixels. */
  readonly width: number;
  readonly height: number;
  /** Distance range in atlas pixels (the field spans pxRange / 2 each side of the edge). */
  readonly pxRange: number;
  /** Atlas width / height: a quad aspect x 1 world units shows the whole atlas. */
  readonly aspect: number;
  /** Glyph-ink box inside the atlas, normalised, origin bottom-left. */
  readonly bounds: MsdfBounds;
  /** 'mtsdf' adds a true signed distance in alpha (used for the glow). */
  readonly type: 'msdf' | 'mtsdf';
  /** Rows stored bottom row first (see the note at the top of this file). */
  readonly flipY: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function positive(record: Record<string, unknown>, key: string, where: string): number {
  const v = record[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${where}: "${key}" must be a positive number`);
  return v;
}

function unit(record: Record<string, unknown>, key: string, where: string): number {
  const v = record[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new Error(`${where}: bounds.${key} must be in [0, 1]`);
  return v;
}

/** Validates an atlas JSON file; throws with a clear message on any malformed field. */
export function parseMsdfAtlasMeta(value: unknown, where = 'calligraphy atlas'): MsdfAtlasMeta {
  if (!isRecord(value)) throw new Error(`${where}: not a JSON object`);
  const { id, atlas, type, flipY, bounds } = value;
  if (typeof id !== 'string' || id === '') throw new Error(`${where}: "id" must be a non-empty string`);
  if (typeof atlas !== 'string' || !/^[\w.-]+\.(png|webp)$/.test(atlas)) throw new Error(`${where}: "atlas" must be a .png or .webp file name`);
  if (type !== 'msdf' && type !== 'mtsdf') throw new Error(`${where}: "type" must be "msdf" or "mtsdf"`);
  if (typeof flipY !== 'boolean') throw new Error(`${where}: "flipY" must be a boolean`);
  if (!isRecord(bounds)) throw new Error(`${where}: "bounds" must be an object`);
  const box: MsdfBounds = {
    left: unit(bounds, 'left', where),
    bottom: unit(bounds, 'bottom', where),
    right: unit(bounds, 'right', where),
    top: unit(bounds, 'top', where),
  };
  if (!(box.left < box.right && box.bottom < box.top)) throw new Error(`${where}: bounds are empty`);
  const width = positive(value, 'width', where);
  const height = positive(value, 'height', where);
  return {
    id,
    atlas,
    width,
    height,
    pxRange: positive(value, 'pxRange', where),
    aspect: positive(value, 'aspect', where),
    bounds: box,
    type,
    flipY,
  };
}

export interface MsdfQuad {
  readonly geometry: PlaneGeometry;
  /** The quad's extent in atlas pixels, origin bottom-left (for a glow field covering it). */
  readonly region: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  /** Size of the glyph ink in world units (the quad itself is larger by the margin). */
  readonly inkWidth: number;
  readonly inkHeight: number;
}

/**
 * A quad with the glyph ink centred on the origin, covering the ink plus at
 * least `marginPx` atlas pixels on every side for the glow; the extent is
 * rounded out to multiples of `alignPx` so a downsampled glow field fits it
 * exactly. UV set 0 ('uv') addresses the atlas (values outside [0, 1] are fine:
 * the border is empty and textures clamp to the edge); UV set 1 ('uv1') runs
 * 0..1 over the quad.
 *
 * @param atlasHeight world height the full atlas would have; the contract's
 *   "aspect x 1" quad is atlasHeight = 1.
 */
export function createMsdfQuad(meta: MsdfAtlasMeta, atlasHeight: number, marginPx: number, alignPx = 1): MsdfQuad {
  const { bounds, width, height } = meta;
  const worldPerPxX = (atlasHeight * meta.aspect) / width;
  const worldPerPxY = atlasHeight / height;
  const down = (v: number): number => Math.floor(v / alignPx) * alignPx;
  const up = (v: number): number => Math.ceil(v / alignPx) * alignPx;
  const region = {
    x0: down(bounds.left * width - marginPx),
    x1: up(bounds.right * width + marginPx),
    y0: down(bounds.bottom * height - marginPx),
    y1: up(bounds.top * height + marginPx),
  };
  const { x0, x1, y0, y1 } = region;

  const geometry = new PlaneGeometry((x1 - x0) * worldPerPxX, (y1 - y0) * worldPerPxY);
  const local = geometry.getAttribute('uv').clone();
  const uvs = geometry.getAttribute('uv');
  for (let i = 0; i < uvs.count; i += 1) {
    const u = (x0 + uvs.getX(i) * (x1 - x0)) / width;
    const v = (y0 + uvs.getY(i) * (y1 - y0)) / height;
    uvs.setXY(i, u, meta.flipY ? 1 - v : v);
  }
  uvs.needsUpdate = true;
  geometry.setAttribute('uv1', local);
  // Rounding can make the margins uneven; keep the ink itself on the origin.
  const inkCentreX = ((bounds.left + bounds.right) / 2) * width;
  const inkCentreY = ((bounds.bottom + bounds.top) / 2) * height;
  geometry.translate(((x0 + x1) / 2 - inkCentreX) * worldPerPxX, ((y0 + y1) / 2 - inkCentreY) * worldPerPxY, 0);

  return {
    geometry,
    region,
    inkWidth: (bounds.right - bounds.left) * width * worldPerPxX,
    inkHeight: (bounds.top - bounds.bottom) * height * worldPerPxY,
  };
}
