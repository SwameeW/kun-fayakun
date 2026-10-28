/**
 * Texture uploads spread over frames by bytes (./streaming budgets them per frame).
 *
 * three.js uploads a texture whole: every mip level in one call, so a 4096 map (11 to 21 MiB with its
 * levels) costs one frame tens of milliseconds. Here a large map goes up in row bands instead:
 *
 * 1. The GPU texture is created at its full size and level count by three itself (initTexture). On
 *    WebGPU three writes nothing into it (its data is marked not ready while it is made); on WebGL2
 *    each level's data is cut down to its first block (compressed) or texel (raw) and three writes
 *    only those. Creating it is a step of its own: no frame creates two.
 * 2. Each later step writes whole rows of one level (coarsest level first), as many as the step's
 *    bytes allow. On WebGPU the rows go into a staging buffer (GPUQueue.writeBuffer) and, once the
 *    level is all there, one copy fills the whole level: a write to part of a level that holds nothing
 *    yet makes WebGPU clear all of it first (for a block-compressed 4096 map, tens of megabytes in one
 *    frame), and a write of all of it does not. Levels whose rows are narrower than a copy's 256-byte
 *    rows (the smallest) are written whole at once. On WebGL2 the rows go straight in through
 *    (compressed)TexSubImage2D and three's own state cache.
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
  /**
   * Writes up to `budget` more bytes (always at least one band, so a job always advances); returns the
   * bytes written. The step that creates the texture does only that and spends the whole budget.
   */
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

/** An empty array of the same kind (not a view of the old one, which would keep its whole buffer alive). */
const emptyLike = (data: LevelData): LevelData => new (data.constructor as new (length: number) => LevelData)(0);

/**
 * Lets go of a texture's CPU copy once it is on the GPU (a 4096 map is 11 to 21 MiB of it): its
 * levels keep their sizes but hold no data. Nothing re-uploads it (its version is never bumped again).
 */
export function releaseLevels(texture: Texture): void {
  const mipmaps = (texture as { mipmaps?: Array<{ data?: LevelData }> }).mipmaps;
  for (const m of mipmaps ?? []) if (m.data) m.data = emptyLike(m.data);
  const image = texture.image as { data?: LevelData } | null;
  if (image?.data && ArrayBuffer.isView(image.data)) image.data = emptyLike(image.data);
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

/** How a backend's texture takes its levels: band by band, or (`whole`) a level in one write. */
interface LevelWriter {
  write: WriteRows;
  /** True for a level this writer takes in one write, all its rows at once. */
  whole(l: Level): boolean;
  /** Frees what a write under way holds (an abandoned upload). */
  dispose(): void;
}

interface BackendLike {
  isWebGPUBackend?: boolean;
  isWebGLBackend?: boolean;
  device?: GPUDevice;
  gl?: WebGL2RenderingContext;
  state?: { bindTexture(target: number, texture: unknown): void; pixelStorei(name: number, value: number | boolean): void };
  get(object: object): Record<string, unknown>;
}

/** A buffer-to-texture copy's rows are a multiple of this many bytes (WebGPU). */
const COPY_ROW_BYTES = 256;

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
 * WebGPU's writer: a level's bands into a staging buffer, then one copy of the whole level into the
 * texture (so the level is never written in part: see the header); levels whose rows are narrower
 * than a copy's row alignment are written whole, at once. One level is staged at a time.
 */
function stagingWriter(device: GPUDevice, gpuTexture: GPUTexture, compressed: boolean): LevelWriter {
  let staged: { level: number; buffer: GPUBuffer } | null = null;
  const unit = compressed ? BLOCK : 1;
  /** The level's full extent (its physical size, whole blocks, for a compressed format). */
  const extent = (l: Level): GPUExtent3DDict => ({ width: Math.ceil(l.width / unit) * unit, height: Math.ceil(l.height / unit) * unit, depthOrArrayLayers: 1 });
  const whole = (l: Level): boolean => rowBytesOf(l, compressed) % COPY_ROW_BYTES !== 0;
  return {
    whole,
    write(level, l, y0, y1) {
      const perRow = rowBytesOf(l, compressed);
      const rows = Math.ceil(l.height / unit);
      if (whole(l)) {
        device.queue.writeTexture({ texture: gpuTexture, mipLevel: level }, l.data, { offset: 0, bytesPerRow: perRow, rowsPerImage: rows }, extent(l));
        return;
      }
      if (staged?.level !== level) {
        staged?.buffer.destroy();
        staged = { level, buffer: device.createBuffer({ size: perRow * rows, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, label: `${gpuTexture.label} level ${level}` }) };
      }
      device.queue.writeBuffer(staged.buffer, Math.floor(y0 / unit) * perRow, rowsView(l, compressed, y0, y1));
      if (Math.ceil(y1 / unit) < rows) return;
      // The level is all there: one copy fills it (queued after the writes, so it sees them).
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToTexture({ buffer: staged.buffer, bytesPerRow: perRow, rowsPerImage: rows }, { texture: gpuTexture, mipLevel: level }, extent(l));
      device.queue.submit([encoder.finish()]);
      // Freed once the copy has run.
      staged.buffer.destroy();
      staged = null;
    },
    dispose() {
      staged?.buffer.destroy();
      staged = null;
    },
  };
}

/**
 * The band writer for a texture three has just created, or null where this backend or format is not
 * one this module knows how to write in bands.
 */
function rowWriter(backend: BackendLike, texture: Texture, compressed: boolean): LevelWriter | null {
  const data = backend.get(texture);
  if (backend.isWebGPUBackend && backend.device) {
    const gpuTexture = data['texture'] as GPUTexture | undefined;
    const descriptor = data['textureDescriptorGPU'] as { format?: string } | undefined;
    if (!gpuTexture || !descriptor) return null;
    if (compressed !== isBlockFormatWebGPU(descriptor.format)) return null;
    return stagingWriter(backend.device, gpuTexture, compressed);
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
    const write: WriteRows = (level, l, y0, y1) => {
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
    return { write, whole: () => false, dispose: () => undefined };
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

    // WebGPU writes every level itself. On WebGL2, levels small enough go up whole when the texture is
    // created (a block, or a texel); the others' first block or texel with them.
    const webgpu = backend.isWebGPUBackend === true;
    const small = levels.map((l) => !webgpu && (compressed ? l.width <= BLOCK && l.height <= BLOCK : l.width * l.height <= 1));
    let writer: LevelWriter | null = null;
    let fallback: UploadJob | null = null;
    let created = false;
    let done = false;
    // Coarsest level first; `row` is the next texel row of `level` to write.
    let level = levels.length - 1;
    let row = 0;
    // An upload abandoned partway (its texture disposed) lets go of what its writer holds.
    const abandon = (): void => {
      writer?.dispose();
    };

    const create = (): void => {
      if (webgpu) {
        // Made at its full size with nothing written into it: every level is written whole later.
        texture.source.dataReady = false;
        try {
          renderer.initTexture(texture);
        } finally {
          texture.source.dataReady = true;
        }
      } else {
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
      }
      writer = rowWriter(backend, texture, compressed);
      if (writer) texture.addEventListener('dispose', abandon);
      created = true;
    };

    const toWhole = (spent: number, budget: number): number => {
      abandon();
      writer = null;
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
            create();
          } catch (err) {
            console.warn('explore: a banded upload could not start; uploading whole', err);
            writer = null;
          }
          if (!writer) return toWhole(spent, budget);
          // Creating it is this step's work, so no frame creates two (it costs the device more than its few bytes).
          return budget;
        }
        const levelWriter: LevelWriter | null = writer;
        if (!levelWriter) return spent;
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
          // As many whole (block) rows as the budget left allows; at least one block row (all of them for a level written whole).
          const fit = Math.floor(Math.max(0, budget - spent) / Math.max(perTexelRow * unit, 1)) * unit;
          const end = levelWriter.whole(l) ? rows : Math.min(rows, row + Math.max(unit, fit));
          try {
            levelWriter.write(level, l, row, end);
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
        if (level < 0) {
          done = true;
          texture.removeEventListener('dispose', abandon);
        }
        return spent;
      },
    };
  };
}
