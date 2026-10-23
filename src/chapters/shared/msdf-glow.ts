/**
 * A smooth glow field for a calligraphy quad, computed once on the CPU from the
 * atlas: the ink coverage, downsampled and Gaussian-blurred at three widths. It
 * covers the whole quad (ink plus margin), so the halo is not limited by the
 * atlas border, and blurred mip levels' blockiness never shows.
 *
 * Channels: R = near, G = far, B = widest glow, each normalised to a peak of 1.
 * Half-float, so the long dim tail of the glow does not band.
 */
import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  type Texture,
} from 'three/webgpu';
import type { MsdfAtlasMeta } from './msdf-atlas';

/** A rectangle in atlas pixels, origin bottom-left (the word upright). */
export interface AtlasRegion {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface GlowFieldOptions {
  /** Atlas pixels per glow texel. */
  readonly downsample: number;
  /** Gaussian sigmas of the near, far and widest glow, in atlas pixels. */
  readonly nearSigmaPx: number;
  readonly farSigmaPx: number;
  readonly widestSigmaPx: number;
  /**
   * Light rays (alpha channel): radial light scattering from the ink outward, as light
   * through still air. Off when absent (alpha = 1, unused).
   */
  readonly rays?: { readonly samples: number; readonly reach: number; readonly decay: number };
}

type Drawable = HTMLImageElement | ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

function isDrawable(image: unknown): image is Drawable {
  return (
    image instanceof HTMLImageElement ||
    image instanceof HTMLCanvasElement ||
    (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) ||
    (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas)
  );
}

/** RGBA pixels of the atlas image, rows top first as stored. */
function readPixels(image: Drawable, width: number, height: number): Uint8ClampedArray {
  const context =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
      : Object.assign(document.createElement('canvas'), { width, height }).getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('msdf glow: 2D canvas unavailable');
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}

/** Ink coverage per atlas pixel (display orientation, row 0 = bottom), from the distance field. */
function coverage(pixels: Uint8ClampedArray, meta: MsdfAtlasMeta): Float32Array {
  const { width, height, pxRange } = meta;
  const out = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const y = meta.flipY ? row : height - 1 - row;
    for (let x = 0; x < width; x += 1) {
      const i = (row * width + x) * 4;
      const r = pixels[i] ?? 0;
      const g = pixels[i + 1] ?? 0;
      const b = pixels[i + 2] ?? 0;
      const field = (meta.type === 'mtsdf' ? (pixels[i + 3] ?? 0) : Math.max(Math.min(r, g), Math.min(Math.max(r, g), b))) / 255;
      // Signed distance in atlas pixels -> coverage of a one-pixel-wide edge.
      out[y * width + x] = Math.min(1, Math.max(0, (field - 0.5) * pxRange + 0.5));
    }
  }
  return out;
}

/** Box-averages the region into a gw x gh grid; outside the atlas counts as empty. */
function downsample(cover: Float32Array, meta: MsdfAtlasMeta, region: AtlasRegion, d: number, gw: number, gh: number): Float32Array {
  const grid = new Float32Array(gw * gh);
  const x0 = Math.floor(region.x0);
  const y0 = Math.floor(region.y0);
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      let sum = 0;
      for (let sy = 0; sy < d; sy += 1) {
        const y = y0 + gy * d + sy;
        if (y < 0 || y >= meta.height) continue;
        for (let sx = 0; sx < d; sx += 1) {
          const x = x0 + gx * d + sx;
          if (x >= 0 && x < meta.width) sum += cover[y * meta.width + x] ?? 0;
        }
      }
      grid[gy * gw + gx] = sum / (d * d);
    }
  }
  return grid;
}

/** Widths of three box blurs that together approximate a Gaussian of `sigma` (Kovesi's method). */
function boxWidths(sigma: number): number[] {
  const n = 3;
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower -= 1;
  lower = Math.max(1, lower);
  const m = Math.round((12 * sigma * sigma - n * lower * lower - 4 * n * lower - 3 * n) / (-4 * lower - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? lower : lower + 2));
}

/**
 * One box blur pass along rows (stride 1) or columns (stride w), zero outside
 * the grid; a running sum keeps it O(1) per texel whatever the width.
 */
function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, width: number, vertical: boolean): void {
  const r = (width - 1) / 2;
  const lines = vertical ? w : h;
  const length = vertical ? h : w;
  const step = vertical ? w : 1;
  for (let line = 0; line < lines; line += 1) {
    const base = vertical ? line : line * w;
    let sum = 0;
    for (let i = 0; i <= r && i < length; i += 1) sum += src[base + i * step] ?? 0;
    for (let i = 0; i < length; i += 1) {
      dst[base + i * step] = sum / width;
      if (i + r + 1 < length) sum += src[base + (i + r + 1) * step] ?? 0;
      if (i - r >= 0) sum -= src[base + (i - r) * step] ?? 0;
    }
  }
}

/** Approximate Gaussian blur (three box passes per axis), normalised to a peak of 1. */
function blur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const out = Float32Array.from(src);
  const tmp = new Float32Array(w * h);
  for (const width of boxWidths(sigma)) {
    boxPass(out, tmp, w, h, width, false);
    boxPass(tmp, out, w, h, width, true);
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, v);
  if (peak > 0) for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) / peak;
  return out;
}

/** Ink-weighted centroid of the grid (texel units), the point the rays stream away from. */
function centroid(grid: Float32Array, w: number, h: number): [number, number] {
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = grid[y * w + x] ?? 0;
      sum += v;
      sx += v * x;
      sy += v * y;
    }
  }
  return sum > 0 ? [sx / sum, sy / sum] : [w / 2, h / 2];
}

function bilinear(grid: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = (grid[y0 * w + x0] ?? 0) * (1 - fx) + (grid[y0 * w + x1] ?? 0) * fx;
  const b = (grid[y1 * w + x0] ?? 0) * (1 - fx) + (grid[y1 * w + x1] ?? 0) * fx;
  return a * (1 - fy) + b * fy;
}

/**
 * Radial light scattering (the screen-space "god rays" integral, done once here): each
 * texel gathers the light of the ink lying between it and the centroid, weighted down with
 * distance, so beams stream outward along the strokes' own shapes. Normalised to a peak of 1.
 */
function rayField(source: Float32Array, w: number, h: number, rays: NonNullable<GlowFieldOptions['rays']>): Float32Array {
  const [cx, cy] = centroid(source, w, h);
  const out = new Float32Array(w * h);
  const n = Math.max(4, Math.round(rays.samples));
  let peak = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = cx - x;
      const dy = cy - y;
      let sum = 0;
      let weight = 1;
      let norm = 0;
      for (let k = 0; k < n; k += 1) {
        const s = (k / n) * rays.reach;
        sum += weight * bilinear(source, w, h, x + dx * s, y + dy * s);
        norm += weight;
        weight *= rays.decay;
      }
      const v = sum / norm;
      out[y * w + x] = v;
      peak = Math.max(peak, v);
    }
  }
  if (peak > 0) for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) / peak;
  return out;
}

/**
 * Builds the glow texture for `region` (the quad's extent in atlas pixels).
 * Texel (0, 0) is the region's bottom-left, matching the quad's 0..1 UVs.
 */
export function createMsdfGlowField(atlas: Texture, meta: MsdfAtlasMeta, region: AtlasRegion, options: GlowFieldOptions): DataTexture {
  const image: unknown = atlas.image;
  if (!isDrawable(image)) throw new Error(`msdf glow: atlas ${meta.id} has no readable image`);
  const d = Math.max(1, Math.round(options.downsample));
  const gw = Math.ceil((region.x1 - region.x0) / d);
  const gh = Math.ceil((region.y1 - region.y0) / d);

  const grid = downsample(coverage(readPixels(image, meta.width, meta.height), meta), meta, region, d, gw, gh);
  const near = blur(grid, gw, gh, options.nearSigmaPx / d);
  const far = blur(grid, gw, gh, options.farSigmaPx / d);
  const widest = blur(grid, gw, gh, options.widestSigmaPx / d);
  // Rays scatter from the crisp ink, so fine beams follow the strokes.
  const rays = options.rays ? rayField(grid, gw, gh, options.rays) : null;

  const data = new Uint16Array(gw * gh * 4);
  const one = DataUtils.toHalfFloat(1);
  for (let i = 0; i < gw * gh; i += 1) {
    data[i * 4] = DataUtils.toHalfFloat(near[i] ?? 0);
    data[i * 4 + 1] = DataUtils.toHalfFloat(far[i] ?? 0);
    data[i * 4 + 2] = DataUtils.toHalfFloat(widest[i] ?? 0);
    data[i * 4 + 3] = rays ? DataUtils.toHalfFloat(rays[i] ?? 0) : one;
  }
  const texture = new DataTexture(data, gw, gh, RGBAFormat, HalfFloatType);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.colorSpace = NoColorSpace;
  texture.name = `msdf-glow:${meta.id}`;
  texture.needsUpdate = true;
  return texture;
}
