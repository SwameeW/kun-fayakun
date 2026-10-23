/**
 * Decodes the explorer's raw planet files (KTX2 holding plain R8 or RGBA8 levels, zstd-supercompressed)
 * off the main thread. three's KTX2Loader transcodes Basis files in its workers but inflates these on
 * the main thread, which for the 4096 cloud map is a frame-dropping 30 ms or more (./raw-ktx2).
 *
 * In: { id, buffer } (the file). Out: { id, vkFormat, width, height, primaries, transfer, levels } with
 * each level's bytes transferred, or { id, error }.
 */

import { ZSTDDecoder } from 'three/addons/libs/zstddec.module.js';

interface Request {
  id: number;
  buffer: ArrayBuffer;
}

/** The KTX2 file identifier, and the supercompression schemes these files use. */
const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const SUPERCOMPRESSION = { none: 0, zstd: 2 } as const;

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

let decoder: Promise<ZSTDDecoder> | null = null;
const zstd = (): Promise<ZSTDDecoder> => {
  decoder ??= (async () => {
    const d = new ZSTDDecoder();
    await d.init();
    return d;
  })();
  return decoder;
};

async function decode({ id, buffer }: Request): Promise<void> {
  try {
    const head = new Uint8Array(buffer, 0, IDENTIFIER.length);
    if (!IDENTIFIER.every((b, i) => head[i] === b)) throw new Error('not a KTX2 file');
    const view = new DataView(buffer);
    const u32 = (offset: number): number => view.getUint32(offset, true);
    const u64 = (offset: number): number => Number(view.getBigUint64(offset, true));
    // Header (KTX2 section 3.3): vkFormat, typeSize, width, height, depth, layers, faces, levels, scheme.
    const vkFormat = u32(12);
    const width = u32(20);
    const height = u32(24);
    const levelCount = Math.max(1, u32(40));
    const scheme = u32(44);
    // The basic data format descriptor: colour primaries and transfer function (KHR DFD).
    const dfd = u32(48);
    const primaries = view.getUint8(dfd + 13);
    const transfer = view.getUint8(dfd + 14);
    const levels: Array<{ data: Uint8Array; width: number; height: number }> = [];
    for (let i = 0; i < levelCount; i += 1) {
      const entry = 80 + i * 24;
      const bytes = new Uint8Array(buffer, u64(entry), u64(entry + 8));
      let data: Uint8Array;
      if (scheme === SUPERCOMPRESSION.zstd) data = (await zstd()).decode(bytes, u64(entry + 16));
      else if (scheme === SUPERCOMPRESSION.none) data = bytes.slice();
      else throw new Error(`unsupported supercompression ${scheme}`);
      levels.push({ data, width: Math.max(1, width >> i), height: Math.max(1, height >> i) });
    }
    scope.postMessage(
      { id, vkFormat, width, height, primaries, transfer, levels },
      levels.map((l) => l.data.buffer),
    );
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) }, []);
  }
}

scope.onmessage = (event) => {
  void decode(event.data);
};
