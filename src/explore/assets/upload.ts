/**
 * Texture uploads spread over frames by bytes (./streaming budgets them per frame).
 *
 * three.js uploads a texture whole: every mip level in one call, so a 4096 map (11 to 21 MiB with its
 * levels) costs one frame tens of milliseconds. Here a large map goes up in row bands instead:
 *
 * 1. The GPU texture is created at its full size and level count by three itself (initTexture), with
 *    each level's data cut down to its first block (compressed) or texel (raw): three writes only
 *    those, so creating it costs almost nothing. What it writes is the level's own data.
 * 2. Each later step writes whole rows of one level (coarsest level first), as many as the step's
 *    bytes allow, through the backend three already drives: GPUQueue.writeTexture on WebGPU,
 *    (compressed)TexSubImage2D through three's own state cache on WebGL2.
 * 3. The texture is complete once every level is written; the streamer binds it only after that.
 *
 * Anything this does not recognise (another backend, an uncompressed fallback for a compressed file,
 * a texture without level data, a small one) is uploaded whole by three, as before.
 */

import type { Texture, WebGPURenderer } from 'three/webgpu';

/** One texture's upload. */
export interface UploadJob {
  /** Bytes it writes in all. */
  readonly bytes: number;
  /** True once every level is on the GPU. */
  readonly done: boolean;
  /** Writes up to `budget` more bytes (always at least one band, so a job always advances); returns the bytes written. */
  step(budget: number): number;
}

/** Starts the upload of a texture (its GPU copy is made by the job's first step). */
export type Uploader = (texture: Texture) => UploadJob;

type LevelData = ArrayBufferView & { subarray(begin: number, end?: number): LevelData; readonly BYTES_PER_ELEMENT: number };

interface Level {
  data: LevelData;
  width: number;
  height: number;
}

/** Textures below this size go up whole (they fit any frame's budget). */
const BANDED_MIN_BYTES = 512 * 1024;
/** Block-compressed formats here are all 4 x 4 texels (BC, ETC2/EAC, ASTC 4x4). */
const BLOCK = 4;

function levelsOf(texture: Texture): Level[] | null {
  const mipmaps = (texture as { mipmaps?: unknown[] }).mipmaps;
  if (!Array.isArray(mipmaps) || mipmaps.length === 0) return null;
  const levels = mipmaps as Array<Partial<Level>>;
  return levels.every((l) => ArrayBuffer.isView(l.data) && typeof l.width === 'number' && typeof l.height === 'number') ? (levels as Level[]) : null;
}

/** Bytes a texture's levels hold (its mip chain, or its one image). */
export function levelBytes(texture: Texture): number {
  const mipmaps = (texture as { mipmaps?: Array<{ data?: ArrayBufferView }> }).mipmaps;
  if (mipmaps && mipmaps.length > 0) return mipmaps.reduce((sum, m) => sum + (m.data?.byteLength ?? 0), 0);
  const data = (texture.image as { data?: ArrayBufferView } | null)?.data;
  return data?.byteLength ?? 0;
}

/**
 * Lets go of a texture's CPU copy once it is on the GPU (a 4096 map is 11 to 21 MiB of it): its
 * levels keep their sizes but hold no data. Nothing re-uploads it (its version is never bumped again).
 */
export function releaseLevels(texture: Texture): void {
  const mipmaps = (texture as { mipmaps?: Array<{ data?: LevelData }> }).mipmaps;
  for (const m of mipmaps ?? []) if (m.data) m.data = m.data.subarray(0, 0);
  const image = texture.image as { data?: LevelData } | null;
  if (image?.data && ArrayBuffer.isView(image.data)) image.data = image.data.subarray(0, 0);
}

/** A job that has three upload the texture whole, in one step. */
export function wholeUpload(texture: Texture, upload: (t: Texture) => void): UploadJob {
  let done = false;
  const bytes = levelBytes(texture);
  return {
    bytes,
    get done() {
      return done;
    },
    step() {
      if (done) return 0;
      upload(texture);
      done = true;
      return bytes;
    },
  };
}

/** Writes texel rows [y0, y1) of one level (multiples of 4 for a compressed format, but for the level's last band). */
type WriteRows = (level: number, l: Level, y0: number, y1: number) => void;

interface BackendLike {
  isWebGPUBackend?: boolean;
  isWebGLBackend?: boolean;
  device?: { queue: { writeTexture(dst: unknown, data: ArrayBufferView, layout: unknown, size: unknown): void } };
  gl?: WebGL2RenderingContext;
  state?: { bindTexture(target: number, texture: unknown): void; pixelStorei(name: number, value: number | boolean): void };
  get(object: object): Record<string, unknown>;
}

const isBlockFormatWebGPU = (format: unknown): boolean => typeof format === 'string' && /^(bc\d|etc2|eac|astc-4x4)/.test(format);

/** Bytes in one row of a level: a row of blocks for a compressed format, a row of texels for a raw one. */
function rowBytesOf(l: Level, compressed: boolean): number {
  const rows = compressed ? Math.ceil(l.height / BLOCK) : l.height;
  return l.data.byteLength / Math.max(1, rows);
}

/** The level's data for texel rows [y0, y1) (a view, never a copy). */
function rowsView(l: Level, compressed: boolean, y0: number, y1: number): LevelData {
  const perRow = rowBytesOf(l, compressed);
  const unit = compressed ? BLOCK : 1;
  const start = Math.floor(y0 / unit) * perRow;
  const end = Math.ceil(y1 / unit) * perRow;
  return l.data.subarray(start / l.data.BYTES_PER_ELEMENT, end / l.data.BYTES_PER_ELEMENT);
}

/**
 * The band writer for a texture three has just created, or null where this backend or format is not
 * one this module knows how to write in bands.
 */
function rowWriter(backend: BackendLike, texture: Texture, compressed: boolean): WriteRows | null {
  const data = backend.get(texture);
  if (backend.isWebGPUBackend && backend.device) {
    const gpuTexture = data['texture'];
    const descriptor = data['textureDescriptorGPU'] as { format?: string } | undefined;
    if (!gpuTexture || !descriptor) return null;
    if (compressed !== isBlockFormatWebGPU(descriptor.format)) return null;
    const queue = backend.device.queue;
    return (level, l, y0, y1) => {
      const width = compressed ? Math.ceil(l.width / BLOCK) * BLOCK : l.width;
      const height = compressed ? Math.ceil(y1 / BLOCK) * BLOCK - y0 : y1 - y0;
      queue.writeTexture(
        { texture: gpuTexture, mipLevel: level, origin: { x: 0, y: y0, z: 0 } },
        rowsView(l, compressed, y0, y1),
        { offset: 0, bytesPerRow: rowBytesOf(l, compressed), rowsPerImage: compressed ? height / BLOCK : height },
        { width, height, depthOrArrayLayers: 1 },
      );
    };
  }
  if (backend.isWebGLBackend && backend.gl && backend.state) {
    const gl = backend.gl;
    const state = backend.state;
    const target = data['glTextureType'];
    const handle = data['textureGPU'];
    const format = data['glFormat'];
    const type = data['glType'];
    if (target !== gl.TEXTURE_2D || !handle || typeof format !== 'number') return null;
    // Compressed files only as real block formats; raw ones only as bytes of one or four channels.
    if (compressed && (format === gl.RGBA || format === gl.RGB || format === gl.RED)) return null;
    if (!compressed && (type !== gl.UNSIGNED_BYTE || (format !== gl.RED && format !== gl.RGBA))) return null;
    return (level, l, y0, y1) => {
      const view = rowsView(l, compressed, y0, y1);
      const height = Math.min(y1, l.height) - y0;
      state.bindTexture(gl.TEXTURE_2D, handle);
      if (compressed) {
        gl.compressedTexSubImage2D(gl.TEXTURE_2D, level, 0, y0, l.width, height, format, view);
      } else {
        state.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texSubImage2D(gl.TEXTURE_2D, level, 0, y0, l.width, height, format, gl.UNSIGNED_BYTE, view);
      }
    };
  }
  return null;
}

/**
 * The renderer's uploader: large textures in row bands as described above, small ones (and anything
 * not recognised) whole.
 */
export function createUploader(renderer: WebGPURenderer): Uploader {
  const backend = renderer.backend as unknown as BackendLike;
  const whole = (t: Texture): void => {
    renderer.initTexture(t);
  };
  return (texture) => {
    const levels = levelsOf(texture);
    const bytes = levelBytes(texture);
    const compressed = (texture as { isCompressedTexture?: boolean }).isCompressedTexture === true;
    if (!levels || bytes < BANDED_MIN_BYTES || !(backend.isWebGPUBackend || backend.isWebGLBackend)) return wholeUpload(texture, whole);

    // Levels small enough to go up whole when the texture is created (a block, or a texel).
    const small = levels.map((l) => (compressed ? l.width <= BLOCK && l.height <= BLOCK : l.width * l.height <= 1));
    let writer: WriteRows | null = null;
    let fallback: UploadJob | null = null;
    let created = false;
    let done = false;
    // Coarsest level first; `row` is the next texel row of `level` to write.
    let level = levels.length - 1;
    let row = 0;

    const create = (): number => {
      const stubs = levels.map((l, i) => {
        if (small[i]) return l;
        const unit = rowBytesOf(l, compressed) / (compressed ? Math.ceil(l.width / BLOCK) : l.width);
        return { data: l.data.subarray(0, unit / l.data.BYTES_PER_ELEMENT), width: compressed ? BLOCK : 1, height: compressed ? BLOCK : 1 };
      });
      const mipmaps = texture.mipmaps;
      texture.mipmaps = stubs as unknown as typeof mipmaps;
      try {
        renderer.initTexture(texture);
      } finally {
        texture.mipmaps = mipmaps;
      }
      writer = rowWriter(backend, texture, compressed);
      created = true;
      return stubs.reduce((sum, s) => sum + s.data.byteLength, 0);
    };

    const toWhole = (spent: number, budget: number): number => {
      // Let three write every level itself (its version is bumped so that it does).
      texture.needsUpdate = true;
      fallback = wholeUpload(texture, whole);
      return spent + fallback.step(budget);
    };

    return {
      bytes,
      get done() {
        return done || (fallback?.done ?? false);
      },
      step(budget) {
        if (done) return 0;
        if (fallback) return fallback.step(budget);
        let spent = 0;
        if (!created) {
          try {
            spent += create();
          } catch (err) {
            console.warn('explore: a banded upload could not start; uploading whole', err);
            writer = null;
          }
          if (!writer) return toWhole(spent, budget);
        }
        const write: WriteRows | null = writer;
        if (!write) return spent;
        while (level >= 0) {
          const l = levels[level];
          if (!l || small[level]) {
            level -= 1;
            row = 0;
            continue;
          }
          const unit = compressed ? BLOCK : 1;
          const rows = compressed ? Math.ceil(l.height / BLOCK) * BLOCK : l.height;
          const perTexelRow = rowBytesOf(l, compressed) / unit;
          // As many whole (block) rows as the budget left allows; at least one block row.
          const fit = Math.floor(Math.max(0, budget - spent) / Math.max(perTexelRow * unit, 1)) * unit;
          const end = Math.min(rows, row + Math.max(unit, fit));
          try {
            write(level, l, row, end);
          } catch (err) {
            console.warn('explore: a banded upload failed; uploading whole', err);
            return toWhole(spent, budget);
          }
          spent += (end - row) * perTexelRow;
          row = end;
          if (row >= rows) {
            level -= 1;
            row = 0;
          }
          if (spent >= budget) break;
        }
        if (level < 0) done = true;
        return spent;
      },
    };
  };
}
