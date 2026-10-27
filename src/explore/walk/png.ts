/**
 * PNG pixels decoded in script, for the walk's height tiles (./terrain, ./equirect): no canvas is
 * drawn or read back. A browser's fingerprinting guard may alter what a canvas reads back (Brave's
 * does, by default: the lowest bit of a few hundred bytes of each read, which in a terrarium tile's red
 * byte is 256 m of height, so the ground grew spikes and pits); the bytes of the file cannot be
 * altered that way. The deflate stream is inflated by the browser's own DecompressionStream; the five
 * row filters are undone here (PNG, ISO/IEC 15948, section 9). 8 bits a sample, not interlaced: the
 * height tiles' kind (AWS Terrain Tiles and scripts/walk/heights.py both write 8-bit RGB). Anything
 * else returns null, and the caller decodes it another way.
 */

export interface PngPixels {
  width: number;
  height: number;
  /** Samples a pixel: 1 grey, 2 grey and alpha, 3 RGB, 4 RGBA (a palette's indices are expanded to RGB, or RGBA with transparency). */
  channels: number;
  /** Row-major from the top left, `channels` bytes a pixel. */
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
/** Samples a pixel by colour type (0 grey, 2 RGB, 3 palette, 4 grey and alpha, 6 RGBA). */
const SAMPLES: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Inflates a zlib stream with the browser's (or Node's) DecompressionStream. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The Paeth predictor (PNG section 9.4). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Undoes the row filters of `raw` (each row a filter byte then `stride` bytes) into `out`, `bpp` bytes
 * a pixel. Returns false on a filter type PNG does not define.
 */
export function unfilter(raw: Uint8Array, out: Uint8Array, rows: number, stride: number, bpp: number): boolean {
  for (let y = 0; y < rows; y += 1) {
    const type = raw[y * (stride + 1)] ?? 0;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prior = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const v = raw[src + x] ?? 0;
      const a = x >= bpp ? (out[row + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[prior + x] ?? 0) : 0;
      const c = x >= bpp && y > 0 ? (out[prior + x - bpp] ?? 0) : 0;
      let predicted: number;
      if (type === 0) predicted = 0;
      else if (type === 1) predicted = a;
      else if (type === 2) predicted = b;
      else if (type === 3) predicted = (a + b) >> 1;
      else if (type === 4) predicted = paeth(a, b, c);
      else return false;
      out[row + x] = (v + predicted) & 0xff;
    }
  }
  return true;
}

/** Decodes a PNG file's pixels, or null for what this decoder does not read (16-bit, fewer than 8 bits, interlaced, damaged). */
export async function decodePng(file: Uint8Array): Promise<PngPixels | null> {
  if (file.length < 8 || SIGNATURE.some((v, i) => file[i] !== v)) return null;
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let width = 0;
  let height = 0;
  let type = -1;
  let palette: Uint8Array | null = null;
  let alpha: Uint8Array | null = null;
  const parts: Uint8Array[] = [];
  let at = 8;
  while (at + 8 <= file.length) {
    const length = view.getUint32(at);
    const name = String.fromCharCode(file[at + 4] ?? 0, file[at + 5] ?? 0, file[at + 6] ?? 0, file[at + 7] ?? 0);
    const body = file.subarray(at + 8, at + 8 + length);
    if (body.length !== length) return null;
    if (name === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const depth = file[at + 16];
      type = file[at + 17] ?? -1;
      // 8 bits a sample, compression 0, filter method 0, not interlaced.
      if (depth !== 8 || file[at + 18] !== 0 || file[at + 19] !== 0 || file[at + 20] !== 0) return null;
    } else if (name === 'PLTE') palette = body;
    else if (name === 'tRNS') alpha = body;
    else if (name === 'IDAT') parts.push(body);
    else if (name === 'IEND') break;
    at += 12 + length;
  }
  const samples = SAMPLES[type];
  if (!samples || width === 0 || height === 0 || parts.length === 0 || (type === 3 && !palette)) return null;
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    joined.set(p, offset);
    offset += p.length;
  }
  let raw: Uint8Array;
  try {
    raw = await inflate(joined);
  } catch {
    return null;
  }
  const stride = width * samples;
  if (raw.length < height * (stride + 1)) return null;
  const pixels = new Uint8Array(height * stride);
  if (!unfilter(raw, pixels, height, stride, samples)) return null;
  if (type !== 3 || !palette) return { width, height, channels: samples, data: pixels };
  // A palette's indices, expanded (with its transparency, where it has one).
  const channels = alpha ? 4 : 3;
  const data = new Uint8Array(width * height * channels);
  for (let i = 0; i < pixels.length; i += 1) {
    const k = pixels[i] ?? 0;
    for (let c = 0; c < 3; c += 1) data[i * channels + c] = palette[k * 3 + c] ?? 0;
    if (alpha) data[i * channels + 3] = alpha[k] ?? 255;
  }
  return { width, height, channels, data };
}
