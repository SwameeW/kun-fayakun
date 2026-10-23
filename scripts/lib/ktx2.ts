/**
 * Reads the parts of a KTX2 header the asset checks rely on: size, mip levels, format and
 * supercompression, the colour model and transfer function of the data format descriptor, and
 * the KTXorientation metadata. Pure (bytes in, values out) so tests can use it too.
 * Layout: KTX 2.0 specification, sections 3.1 (header), 3.3 (index), 3.10 (key/value data).
 */

export interface Ktx2Header {
  vkFormat: number;
  pixelWidth: number;
  pixelHeight: number;
  levelCount: number;
  /** 0 none, 1 BasisLZ, 2 Zstandard, 3 ZLIB. */
  supercompressionScheme: number;
  /** KHR_DF_MODEL_*: 1 RGBSDA (raw formats), 163 ETC1S, 166 UASTC. */
  colorModel: number;
  colorPrimaries: number;
  /** KHR_DF_TRANSFER_*: 1 linear, 2 sRGB. */
  transferFunction: number;
  /** The KTXorientation value, e.g. "ru" for rows stored bottom-up, or null if absent. */
  orientation: string | null;
}

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

export const VK_FORMAT = { undefined: 0, r8Unorm: 9, r8g8b8a8Srgb: 43 } as const;
export const SUPERCOMPRESSION = { none: 0, basisLz: 1, zstd: 2 } as const;
export const COLOR_MODEL = { rgbsda: 1, etc1s: 163, uastc: 166 } as const;
export const TRANSFER = { linear: 1, srgb: 2 } as const;

function keyValues(bytes: Uint8Array, offset: number, length: number): Map<string, string> {
  const out = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let at = offset;
  while (at + 4 <= offset + length) {
    const size = view.getUint32(at, true);
    const entry = bytes.subarray(at + 4, at + 4 + size);
    const split = entry.indexOf(0);
    if (split > 0) {
      const value = entry.subarray(split + 1);
      const end = value.length > 0 && value[value.length - 1] === 0 ? value.length - 1 : value.length;
      out.set(decoder.decode(entry.subarray(0, split)), decoder.decode(value.subarray(0, end)));
    }
    at += 4 + size + ((4 - (size % 4)) % 4);
  }
  return out;
}

/** The header of a KTX2 file, or a message saying why the bytes are not one. */
export function readKtx2Header(bytes: Uint8Array): Ktx2Header | string {
  if (bytes.length < 80 || IDENTIFIER.some((b, i) => bytes[i] !== b)) return 'not a KTX2 file (identifier missing)';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number): number => view.getUint32(at, true);
  const dfdOffset = u32(48);
  const dfdLength = u32(52);
  if (dfdLength < 16 || dfdOffset + dfdLength > bytes.length) return 'data format descriptor out of range';
  const kvdOffset = u32(56);
  const kvdLength = u32(60);
  if (kvdOffset + kvdLength > bytes.length) return 'key/value data out of range';
  // The DFD starts with its total size; the first descriptor block's word 2 holds model, primaries, transfer, flags.
  const block = dfdOffset + 4;
  return {
    vkFormat: u32(12),
    pixelWidth: u32(20),
    pixelHeight: u32(24),
    levelCount: u32(40),
    supercompressionScheme: u32(44),
    colorModel: bytes[block + 8] ?? -1,
    colorPrimaries: bytes[block + 9] ?? -1,
    transferFunction: bytes[block + 10] ?? -1,
    orientation: kvdLength > 0 ? (keyValues(bytes, kvdOffset, kvdLength).get('KTXorientation') ?? null) : null,
  };
}
